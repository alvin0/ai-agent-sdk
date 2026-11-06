import { IdleTimer, MODEL_ERROR_CODES, ModelError, waitForSettlement } from '@alvin0/ai-agent-sdk-core'

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
 * the same deadline lets comment-only heartbeats keep that read alive without
 * manufacturing protocol events. A primary timeout is never replaced by a
 * secondary iterator-cancellation failure.
 */
export function createStreamIdleDeadline(
  timeoutMs: number,
  displayName: string,
  teardownTimeoutMs: number,
): StreamIdleDeadline {
  const expiry = new IdleExpiry(timeoutMs, displayName)

  const guard = async function* <T>(source: AsyncIterable<T>): AsyncGenerator<T> {
    const iterator = source[Symbol.asyncIterator]()
    let exhausted = false
    let primaryFailure: unknown
    expiry.touch()
    try {
      while (true) {
        const result = await expiry.race(iterator.next())
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
      expiry.dispose()
      if (!exhausted) {
        await closeIdleIterator(iterator, { teardownTimeoutMs, displayName, primaryFailure })
      }
    }
  }

  return Object.freeze({ activity: expiry.touch, guard })
}

/**
 * The deadline itself. Both halves run once per streamed chunk, so neither
 * allocates per call: `touch` re-arms the shared core {@link IdleTimer}, which
 * only stamps the time. Each read races a promise of its own rather than one
 * long-lived expiry promise, which would collect one reaction per read for the
 * life of the stream.
 */
class IdleExpiry {
  private readonly timer: IdleTimer
  // Set once the deadline passes; a read that starts afterwards fails with it.
  private expired: ModelError | undefined
  private rejectPending: ((error: ModelError) => void) | undefined

  constructor(timeoutMs: number, displayName: string) {
    this.timer = new IdleTimer(timeoutMs, () => {
      this.expired = new ModelError(
        `${displayName} stream idle for more than ${timeoutMs}ms`,
        MODEL_ERROR_CODES.TIMEOUT,
      )
      this.rejectPending?.(this.expired)
    })
  }

  readonly touch = (): void => {
    if (this.expired === undefined) this.timer.arm()
  }

  race<T>(pending: Promise<T>): Promise<T> {
    if (this.expired !== undefined) {
      void pending.catch(() => undefined)
      return Promise.reject(this.expired)
    }
    return new Promise<T>((resolve, reject) => {
      this.rejectPending = reject
      pending.then(
        value => { this.rejectPending = undefined; resolve(value) },
        (error: unknown) => { this.rejectPending = undefined; reject(error) },
      )
    })
  }

  dispose(): void {
    this.rejectPending = undefined
    this.timer.dispose()
  }
}

async function closeIdleIterator(iterator: AsyncIterator<unknown>, cleanup: {
  teardownTimeoutMs: number; displayName: string; primaryFailure: unknown
}): Promise<void> {
  const { teardownTimeoutMs, displayName, primaryFailure } = cleanup
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
