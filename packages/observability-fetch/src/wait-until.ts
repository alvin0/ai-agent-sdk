import type { FlushResult, Observability } from '@ai-agent-sdk/observability'

export type WaitUntil = (pending: Promise<unknown>) => void

/** Start one flush and explicitly attach it to an Edge host's lifetime. */
export function flushObservabilityWithWaitUntil(
  observation: Pick<Observability, 'flush'>,
  waitUntil: WaitUntil,
  signal?: AbortSignal,
): Promise<FlushResult> {
  if (typeof waitUntil !== 'function') throw new TypeError('waitUntil must be a function')
  const pending = observation.flush(signal)
  waitUntil(pending)
  return pending
}
