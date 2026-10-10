import type { StreamChunk } from '../stream/chunk.ts'
import type { OperationStatus, SafeErrorRecord } from '../observation/event.ts'
import { OBSERVATION_ERROR_CODES, type EndProviderAttemptInput } from '../observation/report.ts'
import { classifyUsageCoverage, possiblyBilledAttemptsWithoutUsage, validateUsageCounters,
  type AttemptUsageReport, type UsageCoverage } from '../observation/usage.ts'

type ValidatedUsage = ReturnType<typeof validateUsageCounters>

export function attemptCoverage(input: EndProviderAttemptInput, validated: ValidatedUsage): UsageCoverage {
  if (input.dispatchState === 'not-sent') return 'not-applicable'
  if (validated.complete && input.usageFinal !== false) return 'complete'
  return Object.keys(validated.reported).length > 0 ? 'partial' : 'missing'
}

export function invalidAttemptUsage(validated: ValidatedUsage): SafeErrorRecord | undefined {
  if (validated.invalidFields.length > 0 || validated.overflow) return usageValidationError(validated, 'attempt')
  return undefined
}

export function usageValidationError(validated: ValidatedUsage, owner: 'call' | 'attempt'): SafeErrorRecord {
  const overflowMessage = owner === 'attempt'
    ? 'provider attempt usage counters overflowed safe integer validation'
    : 'provider usage counters overflowed safe integer aggregation'
  const invalidMessage = owner === 'attempt' ? 'provider attempt usage' : 'provider usage'
  return Object.freeze({
    type: 'UsageValidationError',
    message: validated.overflow
      ? overflowMessage
      : `${invalidMessage} contained invalid fields: ${validated.invalidFields.join(', ')}`,
    code: validated.overflow ? OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW : OBSERVATION_ERROR_CODES.USAGE_INVALID,
  })
}

export function modelCallCoverage(
  attempts: readonly AttemptUsageReport[], declared: boolean,
  validated: ValidatedUsage | undefined, preDispatch: boolean,
): UsageCoverage {
  if (attempts.length > 0 || declared) return classifyUsageCoverage(attempts)
  if (validated === undefined) return preDispatch ? 'not-applicable' : 'missing'
  return validated.complete ? 'complete' : 'partial'
}

export function billedAttemptsWithoutUsage(attempts: readonly AttemptUsageReport[], coverage: UsageCoverage): number {
  if (attempts.length > 0) return possiblyBilledAttemptsWithoutUsage(attempts)
  return coverage === 'missing' || coverage === 'partial' ? 1 : 0
}

export function finishStatus(chunk: Extract<StreamChunk, { type: 'finish' }>): OperationStatus {
  if (chunk.reason.kind === 'aborted') return 'aborted'
  return chunk.reason.kind === 'error' ? 'error' : 'success'
}
