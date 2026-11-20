import { RuntimeResources } from '../../platform/resources.ts'

export class BoundaryFailure extends Error {
  constructor(readonly reason: 'failed' | 'timed-out' | 'aborted', safeCause?: Error) {
    super('Capability operation did not complete', safeCause === undefined ? undefined : { cause: safeCause })
    this.name = 'BoundaryFailure'
  }
}

/** One absolute deadline across sequential work; detached late promises stay observed. */
export async function atDeadline<T>(
  resources: RuntimeResources,
  deadlineAt: number,
  work: (signal: AbortSignal) => T | Promise<T>,
  options?: { caller?: AbortSignal | undefined; sanitizeFailure?: (error: unknown) => Error | undefined },
): Promise<T> {
  const caller = options?.caller
  const remaining = deadlineAt - resources.platform.monotonicNow()
  if (caller?.aborted) throw new BoundaryFailure('aborted')
  if (!Number.isFinite(remaining) || remaining <= 0) throw new BoundaryFailure('timed-out')
  const scope = resources.cancellation(caller === undefined ? [] : [caller], Math.ceil(remaining))
  const reason = (): BoundaryFailure['reason'] => {
    if (caller?.aborted) return 'aborted'
    if (scope.signal.aborted || resources.platform.monotonicNow() >= deadlineAt) return 'timed-out'
    return 'failed'
  }
  const checkDeadline = (): void => {
    if (resources.platform.monotonicNow() >= deadlineAt) scope.cancel()
    if (scope.signal.aborted) throw new BoundaryFailure(reason())
  }
  let release = (): void => undefined
  try {
    const interrupted = new Promise<never>((_resolve, reject) => {
      release = resources.onAbort(scope.signal, () => reject(new BoundaryFailure(reason())))
    })
    const task = Promise.resolve().then(() => {
      checkDeadline()
      return work(scope.signal)
    }).then(value => {
      checkDeadline()
      return value
    }, error => {
      const end = reason()
      throw new BoundaryFailure(end, end === 'failed' ? options?.sanitizeFailure?.(error) : undefined)
    })
    return await Promise.race([task, interrupted])
  } finally { release(); scope.dispose() }
}
