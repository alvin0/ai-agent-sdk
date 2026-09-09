import type { RunAccountingPort } from '../../accounting/contracts.ts'
import type { TurnEndReason } from '../types.ts'

/** Maintenance and main model calls share mandatory usage policy, not token caps. */
export function accountingUsageStop(accounting: RunAccountingPort | undefined): TurnEndReason | undefined {
  const stop = accounting?.usageStop
  if (stop?.usageRequired) return { kind: 'error', failure: {
    code: 'USAGE_REQUIRED', message: 'provider usage is required by the configured run policy',
  } }
  if (stop?.usageUnavailable) return { kind: 'usage-unavailable', modelCallId: stop.report.modelCallId }
  return undefined
}
