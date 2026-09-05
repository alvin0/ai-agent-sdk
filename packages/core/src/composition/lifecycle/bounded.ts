import { RuntimeResources } from '../../platform/resources.ts'

export class BoundaryFailure extends Error {
  constructor(readonly reason: 'failed' | 'timed-out' | 'aborted') {
    super('Capability operation did not complete')
    this.name = 'BoundaryFailure'
  }
}

/** One absolute deadline across sequential work; detached late promises stay observed. */
export async function atDeadline<T>(
  resources: RuntimeResources,
  deadlineAt: number,
  work: (signal: AbortSignal) => T | Promise<T>,
  caller?: AbortSignal,
): Promise<T> {
  const remaining = deadlineAt - resources.platform.monotonicNow()
  if (caller?.aborted) throw new BoundaryFailure('aborted')
  if (!Number.isFinite(remaining) || remaining <= 0) throw new BoundaryFailure('timed-out')
  const scope = resources.cancellation(caller === undefined ? [] : [caller], Math.ceil(remaining))
  const reason = (): BoundaryFailure['reason'] => caller?.aborted ? 'aborted'
    : scope.signal.aborted || resources.platform.monotonicNow() >= deadlineAt ? 'timed-out' : 'failed'
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
    }, () => { throw new BoundaryFailure(reason()) })
    return await Promise.race([task, interrupted])
  } finally { release(); scope.dispose() }
}
