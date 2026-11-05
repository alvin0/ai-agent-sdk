/**
 * Race each read of a stream against one abort signal.
 *
 * @module ai-agent-sdk/core/stream/abort-race
 */

/**
 * Races reads of one stream against an abort signal with a single listener for
 * the whole loop. Racing every read with its own listener (or `AbortSignal.any`)
 * costs a registration per chunk; racing all reads against one long-lived
 * promise collects a reaction per read for the life of the stream.
 *
 * Call {@link AbortRace.dispose} when the loop ends.
 */
export class AbortRace {
  private aborted: boolean
  private rejectPending: ((error: unknown) => void) | undefined
  private readonly onAbort = (): void => {
    this.aborted = true
    this.rejectPending?.(this.toError(this.signal.reason))
  }

  /**
   * @param signal - the signal that stops the loop.
   * @param toError - the rejection for a read cut off by the abort; by default
   *   the signal's reason.
   */
  constructor(
    private readonly signal: AbortSignal,
    private readonly toError: (reason: unknown) => unknown = defaultAbortError,
  ) {
    this.aborted = signal.aborted
    if (!this.aborted) signal.addEventListener('abort', this.onAbort, { once: true })
  }

  /**
   * Settle with `pending`, or reject once the signal aborts, whichever is first.
   * After an abort every read rejects at once, and a late failure of `pending`
   * is observed rather than left unhandled.
   */
  async next<T>(pending: Promise<T>): Promise<T> {
    if (this.aborted) {
      void pending.catch(() => undefined)
      throw this.toError(this.signal.reason)
    }
    return await new Promise<T>((resolve, reject) => {
      this.rejectPending = reject
      pending.then(
        (value) => { this.rejectPending = undefined; resolve(value) },
        (error: unknown) => { this.rejectPending = undefined; reject(error) },
      )
    })
  }

  /** Remove the listener; later reads still race nothing but their own source. */
  dispose(): void {
    this.rejectPending = undefined
    this.signal.removeEventListener('abort', this.onAbort)
  }
}

function defaultAbortError(reason: unknown): unknown {
  return reason ?? new Error('operation aborted')
}
