import { ModelAdapter, normalizeModelFailure, withRetry } from '../../packages/core/dist/index.js'
import type { GenerateOptions, ModelFailure, ModelInvocationContext, PreparedAdapterCall,
  RetryPolicyConfig, StreamChunk } from '../../packages/core/dist/index.js'
import type { Collector } from './metrics.ts'

export const retryPolicy = {
  mode: 'normal', maxRetries: 5,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED'],
  backoff: { initialDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.2 },
} satisfies RetryPolicyConfig
export const maxRunAttempts = 3
export const isInfraFailure = (failure: ModelFailure) =>
  ['RATE_LIMIT', 'AUTH', 'TRANSPORT', 'TIMEOUT', 'SERVER', 'STREAM_CLOSED'].includes(failure.code)
  || failure.status === 429 || failure.status === 401 || failure.status === 403
  || (failure.status !== undefined && failure.status >= 500)

export type Acquire = (signal?: AbortSignal) => Promise<() => void>

/** FIFO, abortable permits. The parent also uses this for every forked job. */
export class Semaphore {
  private active = 0
  private readonly queue: (() => void)[] = []
  readonly limit: number
  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Semaphore limit must be positive')
    this.limit = limit
  }
  acquire: Acquire = async signal => {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(grant)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal?.reason)
      }
      const grant = () => {
        signal?.removeEventListener('abort', abort)
        this.active++
        resolve()
      }
      if (this.active < this.limit) grant()
      else { this.queue.push(grant); signal?.addEventListener('abort', abort, { once: true }) }
    })
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.queue.shift()?.()
    }
  }
}
const localDispatch = new Semaphore(4)

type Dispatch = (options: GenerateOptions, context?: ModelInvocationContext) => AsyncIterable<StreamChunk>
type Transform = (dispatch: Dispatch) => Dispatch
/** Keep provider metadata and prepared-generation binding intact. */
class DecoratedAdapter extends ModelAdapter {
  private readonly inner: ModelAdapter
  private readonly transform: Transform
  constructor(inner: ModelAdapter, transform: Transform) { super(); this.inner = inner; this.transform = transform }
  override providerInfo(provider: string) { return this.inner.providerInfo(provider) }
  override listModels(provider: string) { return this.inner.listModels(provider) }
  override resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.inner.resolveModel(provider, model, signal)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal,
    context?: ModelInvocationContext): Promise<PreparedAdapterCall> {
    const call = await this.inner.prepareCall(provider, model, signal, context)
    return { model: call.model, stream: this.transform((options, invocation = context) =>
      call.stream(options, invocation)) }
  }
  override stream(options: GenerateOptions, context?: ModelInvocationContext) {
    return this.transform((request, invocation) => this.inner.stream(request, invocation))(options, context)
  }
}

function recordTerminalFailure(chunk: StreamChunk, waitingFailure: ModelFailure | undefined, collector: Collector) {
  if (chunk.type !== 'finish') return
  let failure: ModelFailure | undefined
  if (chunk.reason.kind === 'error') failure = chunk.reason.failure
  if (chunk.reason.kind === 'aborted') failure = waitingFailure
  if (failure) collector.recordInfraFailure(failure)
}

export function reliableAdapter(inner: ModelAdapter, collector: Collector,
  acquire: Acquire = localDispatch.acquire, policy: RetryPolicyConfig = retryPolicy): ModelAdapter {
  return new DecoratedAdapter(inner, dispatch => async function* (options, context) {
    let waiting: number | undefined
    let lastFailure: ModelFailure | undefined
    const endWait = () => {
      if (waiting !== undefined) collector.retryWaits.push([waiting, performance.now()])
      waiting = undefined
    }
    const guarded = new DecoratedAdapter(inner, () => async function* (request, invocation) {
      endWait()
      const release = await acquire(request.signal)
      try {
        request.signal?.throwIfAborted()
        for await (const chunk of dispatch(request, invocation)) yield chunk
      } finally { release() }
    })
    const retrying = withRetry(guarded, { policy, onRetry: retry => {
      collector.modelRetries++
      collector.retryScheduledWaitMs += retry.delayMs
      lastFailure = retry.failure
      waiting = performance.now()
    } })
    try {
      for await (const chunk of retrying.stream(options, context)) {
        recordTerminalFailure(chunk, waiting !== undefined ? lastFailure : undefined, collector)
        yield chunk
      }
    } catch (error) {
      const failure = normalizeModelFailure(error)
      collector.recordInfraFailure(failure)
      throw error
    } finally { endWait() }
  })
}

/** Sum and union differ when workers back off concurrently; subtract the union from wall time. */
export function retryWaitMetrics(waits: readonly (readonly [number, number])[]) {
  const sorted = [...waits].sort((a, b) => a[0] - b[0])
  let total = 0, union = 0, end = -Infinity
  for (const [start, stop] of sorted) {
    total += stop - start
    union += Math.max(0, stop - Math.max(start, end))
    end = Math.max(end, stop)
  }
  return { total, union }
}
