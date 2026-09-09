import type { UsageCounters } from '../../observation/index.ts'
import type { UsageEstimationInput, UsageEstimator } from './report.ts'

/** Observe late rejection without allowing late results to publish into a ledger. */
export async function estimateUsage(
  estimator: UsageEstimator,
  input: Omit<UsageEstimationInput, 'signal'>,
  closed: AbortSignal,
  timeoutMs: number,
): Promise<UsageCounters> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([closed, deadline.signal, ...input.request.signal === undefined ? [] : [input.request.signal]])
  const timer = setTimeout(() => deadline.abort(new Error('usage estimation deadline exceeded')), timeoutMs)
  try {
    signal.throwIfAborted()
    return await new Promise<UsageCounters>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void Promise.resolve().then(() => {
        signal.throwIfAborted()
        return estimator.estimate({ ...input, signal })
      }).then(
        value => { signal.removeEventListener('abort', abort); resolve(value) },
        error => { signal.removeEventListener('abort', abort); reject(error) },
      )
    })
  } finally {
    clearTimeout(timer)
    deadline.abort(new Error('usage estimation scope closed'))
  }
}
