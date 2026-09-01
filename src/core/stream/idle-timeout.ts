/**
 * An idle watchdog for streaming responses.
 *
 * The failure this guards against is specific and nasty: a provider accepts the
 * request, returns 200, sends some or none of the body, and then simply stops
 * without closing the connection. No error is ever delivered, so a plain
 * `for await` waits forever and the caller's request hangs with no diagnostic.
 *
 * The bound is on IDLE time between chunks, not on total duration, because a
 * legitimately long generation can take minutes while never being idle.
 *
 * @module ai-agent-sdk/core/stream/idle-timeout
 */

/**
 * Wrap an async iterable so that any gap longer than `timeoutMs` between values
 * fails instead of hanging.
 *
 * The timer is armed per pending read and cleared as soon as a value arrives, so
 * a stream that keeps producing never accumulates timers. On expiry the source
 * iterator is closed, which is what actually aborts the underlying request.
 * @param iterable - the source stream.
 * @param timeoutMs - maximum idle interval; non-finite or non-positive disables the watchdog.
 * @param onTimeout - builds the error to throw, so callers keep their own taxonomy.
 * @returns the same values, with an idle bound applied.
 */
export async function* withIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  teardownTimeoutMs = 30_000,
): AsyncGenerator<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    yield* iterable
    return
  }
  const iterator = iterable[Symbol.asyncIterator]()
  let exhausted = false
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs)
      })
      let result: IteratorResult<T>
      try {
        // Both branches settle: `iterator.next()` on data or source failure, the
        // timer on silence. Whichever loses the race is discarded, and the timer
        // is always cleared so a resolved read cannot leave the process alive.
        result = await Promise.race([iterator.next(), expiry])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        // The losing `expiry` promise rejects later with nothing awaiting it.
        // Attach a no-op handler so that rejection is never "unhandled".
        void expiry.catch(() => {})
      }
      if (result.done === true) {
        exhausted = true
        return
      }
      yield result.value
    }
  } finally {
    if (!exhausted) {
      if (!Number.isFinite(teardownTimeoutMs) || teardownTimeoutMs <= 0) {
        throw new RangeError('teardownTimeoutMs must be a positive finite number')
      }
      const close = iterator.return?.bind(iterator)
      if (close !== undefined) {
        const closing = Promise.resolve().then(async () => { await close() })
        if (!await waitForSettlement(closing, teardownTimeoutMs)) {
          throw new Error(`stream source ignored cancellation for more than ${teardownTimeoutMs}ms`)
        }
      }
    }
  }
}
import { waitForSettlement } from '../runtime/settlement.ts'
