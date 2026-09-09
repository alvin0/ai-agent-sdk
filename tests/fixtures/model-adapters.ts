import { ModelAdapter } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk, TokenUsage } from '@alvin0/ai-agent-sdk-core'

export type FixtureAttempt = (
  options: GenerateOptions,
  attemptNumber: number,
) => AsyncIterable<StreamChunk>

/** Scriptable provider adapter shared by migration/accounting contract tests. */
export class FixtureModelAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly attempts: readonly FixtureAttempt[]

  constructor(attempts: readonly FixtureAttempt[]) {
    super()
    if (attempts.length === 0) throw new RangeError('fixture adapter requires at least one attempt')
    this.attempts = Object.freeze([...attempts])
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const attemptNumber = this.requests.length
    const attempt = this.attempts[Math.min(attemptNumber - 1, this.attempts.length - 1)]
    if (attempt === undefined) throw new Error('fixture attempt selection failed')
    return attempt(options, attemptNumber)
  }
}

export function successfulAttempt(
  text = 'fixture response',
  usage: TokenUsage = { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
): FixtureAttempt {
  return async function* success(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function missingUsageAttempt(text = 'missing usage'): FixtureAttempt {
  return async function* missing(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function retryableFailureBeforeOutputAttempt(): FixtureAttempt {
  return async function* retryable(): AsyncIterable<StreamChunk> {
    throw new ModelError('fixture transport failure', MODEL_ERROR_CODES.TRANSPORT)
  }
}

export function partialStreamFailureAttempt(text = 'partial'): FixtureAttempt {
  return async function* partial(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    throw new ModelError('fixture stream closed', MODEL_ERROR_CODES.STREAM_CLOSED)
  }
}

export function abortBeforeDispatchAttempt(onDispatch?: () => void): FixtureAttempt {
  return async function* abortBefore(options): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new ModelError('fixture aborted', MODEL_ERROR_CODES.ABORTED)
    }
    onDispatch?.()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function abortAfterDispatchAttempt(onDispatch?: () => void): FixtureAttempt {
  return async function* abortAfter(options): AsyncIterable<StreamChunk> {
    onDispatch?.()
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new ModelError('fixture aborted', MODEL_ERROR_CODES.ABORTED)
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onAbort = (): void => finish(
        options.signal?.reason ?? new ModelError('fixture aborted', MODEL_ERROR_CODES.ABORTED),
      )
      const timer = setTimeout(finish, 30_000)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
