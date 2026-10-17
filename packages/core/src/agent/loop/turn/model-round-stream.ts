import type { ModelCallReport } from '../../../observation/index.ts'
import type { GenerateOptions } from '../../../contract/index.ts'
import { BlockAssembler, type StreamChunk } from '../../../stream/index.ts'
import { positiveFinite, positiveSafeInteger } from './config.ts'
import { serializedBytes, modelFailureFinish, modelAbortedFinish, messageOf } from './common.ts'
import { validateStreamChunk } from './validation.ts'
import { StreamAbortError, nextWithAbort, closeIterator } from './cancellation.ts'
import type { ModelRoundContext, ModelStreamResult } from './model-round-types.ts'

function abortedStreamFinish(
  signal: AbortSignal, timeout: string | undefined, error: StreamAbortError,
): ReturnType<typeof modelFailureFinish> {
  if (signal.aborted) return modelAbortedFinish(messageOf(signal.reason ?? error))
  if (timeout !== undefined) return modelFailureFinish(timeout, 'MODEL_TIMEOUT')
  return modelFailureFinish(messageOf(error.cause ?? error), 'MODEL_STREAM_ABORTED')
}

interface StreamLimits {
  /** Total wall-clock cap; undefined (the default) never cuts a model call that is still streaming. */
  readonly modelTimeoutMs: number | undefined
  /** Longest wait for the next chunk; a silent (hung) connection is the only default cut. */
  readonly modelIdleTimeoutMs: number
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly maxStreamEvents: number
  readonly teardownTimeoutMs: number
}
interface StreamState {
  readonly assembler: BlockAssembler
  readonly owned: AbortController
  readonly signal: AbortSignal
  readonly limits: StreamLimits
  readonly closedBlockIndexes: Set<number>
  readonly idle: IdleTimer
  events: number
  responseBytes: number
  sawFinish: boolean
}

function streamLimits(context: ModelRoundContext): StreamLimits {
  const { options } = context
  const modelTimeoutMs = options.modelTimeoutMs === undefined || options.modelTimeoutMs === 'auto'
    ? undefined : positiveFinite(options.modelTimeoutMs, 'modelTimeoutMs')
  const modelIdleTimeoutMs = positiveFinite(options.modelIdleTimeoutMs ?? 10 * 60_000, 'modelIdleTimeoutMs')
  const maxRequestBytes = positiveSafeInteger(options.maxModelRequestBytes ?? 32 * 1024 * 1024, 'maxModelRequestBytes')
  const maxResponseBytes = positiveSafeInteger(options.maxModelResponseBytes ?? 32 * 1024 * 1024,
    'maxModelResponseBytes')
  // Event count is opt-in; response bytes already bound memory for long streamed answers.
  const maxStreamEvents = options.maxModelStreamEvents === undefined
    ? Infinity : positiveSafeInteger(options.maxModelStreamEvents, 'maxModelStreamEvents')
  const teardownTimeoutMs = positiveFinite(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
  return { modelTimeoutMs, modelIdleTimeoutMs, maxRequestBytes, maxResponseBytes, maxStreamEvents, teardownTimeoutMs }
}

export async function streamModelRound(
  context: ModelRoundContext, requestBase: GenerateOptions,
): Promise<ModelStreamResult> {
  const assembler = new BlockAssembler()
  const limits = streamLimits(context)
  if (!validateRequest(assembler, requestBase, limits.maxRequestBytes)) {
    return { assembler, usageRequired: false, usageUnavailable: false }
  }
  return consumeModelStream(context, requestBase, assembler, limits)
}

function validateRequest(assembler: BlockAssembler, request: GenerateOptions, maxRequestBytes: number): boolean {
  let requestBytes: number
  try { requestBytes = serializedBytes(request) }
  catch (error: unknown) {
    assembler.push(modelFailureFinish(
      `model request is not serializable: ${messageOf(error)}`, 'INVALID_MODEL_REQUEST',
    ))
    return false
  }
  if (requestBytes > maxRequestBytes) {
    assembler.push(modelFailureFinish(
      `model request exceeds the ${maxRequestBytes}-byte limit`, 'MODEL_REQUEST_TOO_LARGE',
    ))
    return false
  }
  return requestBytes >= 0
}

async function consumeModelStream(
  context: ModelRoundContext, requestBase: GenerateOptions, assembler: BlockAssembler, limits: StreamLimits,
): Promise<ModelStreamResult> {
  const { options, signal } = context
  const owned = new AbortController()
  const roundSignal = AbortSignal.any([signal, owned.signal])
  let timedOut: string | undefined
  const expire = (message: string) => { timedOut ??= message; owned.abort(new Error(message)) }
  const timeout = limits.modelTimeoutMs === undefined ? undefined
    : setTimeout(() => { expire(`model stream exceeded ${limits.modelTimeoutMs}ms`) }, limits.modelTimeoutMs)
  const idle = new IdleTimer(limits.modelIdleTimeoutMs,
    () => { expire(`model stream sent no data for ${limits.modelIdleTimeoutMs}ms`) })
  const handle = options.registry.stream({ ...requestBase, signal: roundSignal }, options.accounting?.modelInvocation)
  const iterator = handle[Symbol.asyncIterator]()
  const state: StreamState = { assembler, owned, signal: roundSignal, limits,
    closedBlockIndexes: new Set(), idle, events: 0, responseBytes: 0, sawFinish: false }
  let exhausted = false
  try { exhausted = await pumpStream(context, iterator, state) }
  catch (error: unknown) {
    if (!(error instanceof StreamAbortError)) throw error
    assembler.push(abortedStreamFinish(signal, timedOut, error))
  } finally {
    clearTimeout(timeout)
    idle.stop()
    if (!exhausted) await teardownStream(iterator, state)
  }
  const report = await handle.report
  return { assembler, ...await recordReport(context, requestBase, report) }
}

async function recordReport(context: ModelRoundContext, requestBase: GenerateOptions, report: ModelCallReport) {
  const { options, signal } = context
  const decision = options.accounting === undefined
    ? undefined : await options.accounting.recordModelCall(report, { ...requestBase, signal })
  return { modelCallReport: decision?.report ?? report,
    usageRequired: decision?.usageRequired ?? false, usageUnavailable: decision?.usageUnavailable ?? false }
}

async function teardownStream(iterator: AsyncIterator<StreamChunk>, state: StreamState): Promise<void> {
  state.owned.abort(new Error('model stream closed before exhaustion'))
  const settled = await closeIterator(iterator, state.limits.teardownTimeoutMs)
  if (!settled) {
    state.assembler.push(modelFailureFinish(
      `model stream ignored cancellation for more than ${state.limits.teardownTimeoutMs}ms; `
      + 'the adapter operation may still be running', 'MODEL_TEARDOWN_TIMEOUT',
    ))
  }
}

async function pumpStream(
  context: ModelRoundContext, iterator: AsyncIterator<StreamChunk>, state: StreamState,
): Promise<boolean> {
  while (true) {
    // Only the wait on the adapter counts as idle; slow event consumers never trip it.
    state.idle.arm()
    const next = await nextWithAbort(iterator.next(), state.signal).finally(() => { state.idle.stop() })
    if (next.done === true) return true
    if (!validateChunk(next.value, state)) return false
    await publishChunk(next.value, context, state)
  }
}

function validateChunk(chunk: StreamChunk, state: StreamState): boolean {
  const { assembler, owned } = state
  const { maxStreamEvents, maxResponseBytes } = state.limits
  try {
    validateStreamChunk(chunk, maxStreamEvents)
  } catch (error: unknown) {
    assembler.push(modelFailureFinish(
      `model adapter emitted an invalid stream chunk: ${messageOf(error)}`,
      'INVALID_MODEL_STREAM',
    ))
    owned.abort(new Error('invalid model stream chunk'))
    return false
  }
  state.events++
  try {
    state.responseBytes += serializedBytes(chunk)
  } catch (error: unknown) {
    assembler.push(modelFailureFinish(
      `model adapter emitted a non-serializable stream chunk: ${messageOf(error)}`,
      'INVALID_MODEL_STREAM',
    ))
    owned.abort(new Error('non-serializable model stream chunk'))
    return false
  }
  if (state.events > maxStreamEvents || state.responseBytes > maxResponseBytes) {
    const dimension = state.events > maxStreamEvents
      ? `${maxStreamEvents}-event`
      : `${maxResponseBytes}-byte`
    assembler.push(modelFailureFinish(
      `model response exceeds the ${dimension} limit`,
      'MODEL_RESPONSE_TOO_LARGE',
    ))
    owned.abort(new Error('model response resource limit exceeded'))
    return false
  }
  if (state.sawFinish) {
    assembler.push(modelFailureFinish(
      'model adapter emitted data after its terminal finish chunk',
      'INVALID_MODEL_STREAM',
    ))
    owned.abort(new Error('invalid model stream'))
    return false
  }
  return true
}

async function publishChunk(chunk: StreamChunk, context: ModelRoundContext, state: StreamState): Promise<void> {
  const { assembler } = state
  assembler.push(chunk)
  // The assembler ignores deltas after the first close. The visible
  // stream must do the same or UI text can disagree with stored history.
  if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta')
    && state.closedBlockIndexes.has(chunk.index)) return
  if (chunk.type === 'block-end') state.closedBlockIndexes.add(chunk.index)
  if (chunk.type === 'finish') state.sawFinish = true
  await publishVisibleChunk(chunk, context)
}

async function publishVisibleChunk(chunk: StreamChunk, context: ModelRoundContext): Promise<void> {
  const { emit, trace, phase } = context
  if (chunk.type === 'text-delta') await emit({
    type: 'text-delta', index: chunk.index, text: chunk.text,
    phase: phase === 'process' ? 'commentary' : chunk.phase ?? 'unknown', trace,
  })
  else if (chunk.type === 'reasoning-delta') await emit({
    type: 'reasoning-delta', index: chunk.index, text: chunk.text, reasoningKind: chunk.kind ?? 'unknown', trace,
  })
  else if (chunk.type === 'image-delta') await emit({
    type: 'image-delta', itemId: chunk.itemId, data: chunk.data,
    mediaType: chunk.mediaType,
      ...chunk.partialIndex === undefined ? {} : { partialIndex: chunk.partialIndex }, trace,
  })
  else if (chunk.type === 'usage') await emit({ type: 'usage', usage: chunk.usage, trace })
  else if (chunk.type === 'usage-progress') await emit({ ...chunk, trace })
}

class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly ms: number, private readonly onIdle: () => void) {}
  arm(): void { this.stop(); this.timer = setTimeout(this.onIdle, this.ms) }
  stop(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
}
