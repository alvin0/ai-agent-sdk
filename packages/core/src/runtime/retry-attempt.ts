import type { GenerateOptions } from '../contract/generate-options.ts'
import { normalizeModelFailure, type ModelFailure } from '../errors/failure.ts'
import { MODEL_ERROR_CODES, ModelError } from '../errors/model-error.ts'
import type { StreamChunk } from '../stream/chunk.ts'
import { waitForSettlement } from '../async/settlement.ts'
import type { WithRetryOptions } from './with-retry.ts'

type AttemptResult =
  | { kind: 'forward'; chunks: AsyncIterable<StreamChunk> }
  | { kind: 'retryable'; failure: ModelFailure }

export class RetryAttemptRunner {
  private readonly options: WithRetryOptions

  constructor(options: WithRetryOptions) {
    this.options = options
  }

  /**
   * Run one attempt, forwarding only provisional usage before committing content.
   *
   * Buffering is what makes retry safe: until the attempt either produces its
   * first non-progress chunk or fails, no content has been committed. Once that
   * chunk exists the attempt is no longer retryable, so it switches to
   * `forward` and streams the rest through untouched.
   */
  async *runAttempt(
    options: GenerateOptions,
    dispatch: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk,
    | { kind: 'forward'; chunks: AsyncIterable<StreamChunk> }
    | { kind: 'retryable'; failure: ModelFailure }
  > {
    const cap = reasoningBufferCap(this.options.bufferReasoningPrefix)
    let iterator: AsyncIterator<StreamChunk>
    try {
      iterator = dispatch(options)[Symbol.asyncIterator]()
    } catch (error: unknown) {
      return { kind: 'retryable', failure: normalizeModelFailure(error) }
    }

    let first: IteratorResult<StreamChunk>
    try {
      first = yield* this.readProgress(iterator)
    } catch (error: unknown) {
      await this.close(iterator)
      return { kind: 'retryable', failure: normalizeModelFailure(error) }
    }

    // A stream that ends with no chunks at all told us nothing; treat it as the
    // degenerate empty response rather than a silently successful turn.
    if (first.done === true) {
      return {
        kind: 'retryable',
        failure: {
          message: 'the adapter produced no chunks',
          code: MODEL_ERROR_CODES.UNKNOWN,
        },
      }
    }

    // An adapter behind the registry's funnel reports failure as a terminal
    // error finish rather than a throw. As the FIRST chunk, that is still a
    // clean nothing-emitted failure and remains retryable.
    const chunk = first.value
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      await this.close(iterator)
      return { kind: 'retryable', failure: chunk.reason.failure }
    }

    return yield* this.readPrefix(iterator, chunk, cap)
  }

  private async *readProgress(
    iterator: AsyncIterator<StreamChunk>,
  ): AsyncGenerator<StreamChunk, IteratorResult<StreamChunk>> {
    let next = await iterator.next()
    while (!next.done && next.value.type === 'usage-progress') {
      let resumed = false
      try {
        yield next.value
        resumed = true
      } finally {
        if (!resumed) await this.close(iterator)
      }
      next = await iterator.next()
    }
    return next
  }

  private async *readPrefix(
    iterator: AsyncIterator<StreamChunk>,
    chunk: StreamChunk,
    cap: number,
  ): AsyncGenerator<StreamChunk, AttemptResult> {
    const held: StreamChunk[] = []
    if (cap > 0) {
      const reasoningBlocks = new Set<number>()
      let ended = false
      try {
        while (isReasoningChunk(chunk, reasoningBlocks) && held.length < cap) {
          held.push(chunk)
          const next = yield* this.readProgress(iterator)
          if (next.done === true) { ended = true; break }
          chunk = next.value
          // Still only thinking when it failed: nothing was shown, so retry.
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            await this.close(iterator)
            return { kind: 'retryable', failure: chunk.reason.failure }
          }
        }
      } catch (error: unknown) {
        await this.close(iterator)
        return { kind: 'retryable', failure: normalizeModelFailure(error) }
      }
      // A stream that only reasoned and then ended releases what it held.
      if (ended) {
        return this.forward(held, undefined, iterator)
      }
    }

    return this.forward(held, chunk, iterator)
  }
  private close(iterator: AsyncIterator<StreamChunk>): Promise<void> {
    return closeIterator(iterator, this.options.teardownTimeoutMs ?? 30_000)
  }

  private forward(
    held: readonly StreamChunk[],
    chunk: StreamChunk | undefined,
    iterator: AsyncIterator<StreamChunk>,
  ): AttemptResult {
    return {
      kind: 'forward',
      chunks: resume(held, chunk, iterator, this.options.teardownTimeoutMs ?? 30_000),
    }
  }

}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}

function reasoningBufferCap(option: WithRetryOptions['bufferReasoningPrefix']): number {
  if (option === undefined || option === false) return 0
  if (option === true) return 4096
  if (!Number.isSafeInteger(option.maxChunks) || option.maxChunks < 1) {
    throw new RangeError('bufferReasoningPrefix.maxChunks must be a positive safe integer')
  }
  return option.maxChunks
}

/** Whether a chunk only carries reasoning, tracking which block indexes are reasoning. */
function isReasoningChunk(chunk: StreamChunk, reasoningBlocks: Set<number>): boolean {
  if (chunk.type === 'reasoning-delta') return true
  if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
    reasoningBlocks.add(chunk.index)
    return true
  }
  return chunk.type === 'block-end' && (chunk.block.type === 'reasoning' || reasoningBlocks.has(chunk.index))
}

/** Re-attach already-read chunks to the front of their iterator. */
async function* resume(
  held: readonly StreamChunk[],
  first: StreamChunk | undefined,
  iterator: AsyncIterator<StreamChunk>,
  teardownTimeoutMs: number,
): AsyncGenerator<StreamChunk> {
  let exhausted = false
  try {
    for (const chunk of held) yield chunk
    if (first !== undefined) yield first
    while (true) {
      const next = await iterator.next()
      if (next.done === true) {
        exhausted = true
        return
      }
      yield next.value
    }
  } finally {
    if (!exhausted) await closeIterator(iterator, teardownTimeoutMs)
  }
}

async function closeIterator(iterator: AsyncIterator<StreamChunk>, timeoutMs: number): Promise<void> {
  const closing = iterator.return?.()
  if (closing === undefined) return
  const settled = await waitForSettlement(
    Promise.resolve(closing),
    positiveFinite(timeoutMs, 'withRetry teardownTimeoutMs'),
  )
  if (!settled) {
    throw new ModelError(
      `retry attempt teardown exceeded ${timeoutMs}ms`,
      MODEL_ERROR_CODES.TEARDOWN_TIMEOUT,
    )
  }
}

