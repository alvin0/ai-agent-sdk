import { MODEL_ERROR_CODES, ModelError, waitForSettlement } from '@ai-agent-sdk/core'

/** One resettable deadline shared by every body read in one physical attempt. */
export interface StreamIdleDeadline {
  /** Reset the deadline after a non-empty response-body read or SSE heartbeat. */
  readonly activity: () => void
  /** Race source progress against the deadline and bound source teardown. */
  readonly guard: <T>(source: AsyncIterable<T>) => AsyncGenerator<T>
}

/**
 * Create one idle timer for a physical provider attempt.
 *
 * The parser calls `activity` while one `iterator.next()` is pending. Resetting
 * the same timer lets comment-only heartbeats keep that read alive without
 * manufacturing protocol events. A primary timeout is never replaced by a
 * secondary iterator-cancellation failure.
 */
export function createStreamIdleDeadline(
  timeoutMs: number,
  displayName: string,
  teardownTimeoutMs: number,
): StreamIdleDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  let rejectExpiry: ((error: Error) => void) | undefined
  const expiry = new Promise<never>((_resolve, reject) => { rejectExpiry = reject })
  // The deadline may expire while the consumer is between reads. Keep that
  // rejection observed; the next guarded read still receives the same error.
  void expiry.catch(() => undefined)

  const activity = () => {
    if (expired) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      expired = true
      rejectExpiry?.(new ModelError(
        `${displayName} stream idle for more than ${timeoutMs}ms`,
        MODEL_ERROR_CODES.TIMEOUT,
      ))
    }, timeoutMs)
  }

  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const guard = async function* <T>(source: AsyncIterable<T>): AsyncGenerator<T> {
    const iterator = source[Symbol.asyncIterator]()
    let exhausted = false
    let primaryFailure: unknown
    activity()
    try {
      while (true) {
        const result = await Promise.race([iterator.next(), expiry])
        if (result.done === true) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      primaryFailure = error
      throw error
    } finally {
      dispose()
      if (!exhausted) {
        const close = iterator.return?.bind(iterator)
        if (close !== undefined) {
          let closeFailure: unknown
          const closing = Promise.resolve().then(async () => { await close() })
            .catch((error: unknown) => { closeFailure = error })
          const settled = await waitForSettlement(closing, teardownTimeoutMs)
          if (primaryFailure === undefined) {
            if (!settled) {
              throw new ModelError(
                `${displayName} stream teardown exceeded ${teardownTimeoutMs}ms`,
                MODEL_ERROR_CODES.TEARDOWN_TIMEOUT,
              )
            }
            if (closeFailure !== undefined) throw closeFailure
          }
        }
      }
    }
  }

  return Object.freeze({ activity, guard })
}
