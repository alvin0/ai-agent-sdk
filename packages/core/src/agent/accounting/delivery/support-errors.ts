import { objectValue, ownData } from '../../../capability/common/data.ts'
import type { ModelCallReport, SafeErrorRecord } from '../../../observation/index.ts'
import type { SupportSafeError, UsageCoverageSummary } from '../../../support-safe/error.ts'
import { flag, safeCode } from './data.ts'

interface ProviderFailureCandidate {
  readonly code: string
  readonly value: SupportSafeError
}

/** Project already-sanitized call/attempt facts into the public support envelope. */
function providerCandidates(
  calls: readonly ModelCallReport[],
  usageCoverage: UsageCoverageSummary,
  possiblyBilled: number,
): ProviderFailureCandidate[] {
  const candidates: ProviderFailureCandidate[] = []
  for (const call of calls) {
    const attempts = call.attempts
    const lastAttempt = attempts.at(-1)
    if (call.error !== undefined) {
      candidates.push(candidate(call, call.error, { stage: 'model-call', attempt: lastAttempt },
        { usageCoverage, possiblyBilled }))
    }
    for (const attempt of attempts) {
      if (attempt.error === undefined) continue
      candidates.push(candidate(call, attempt.error, { stage: 'provider-attempt', attempt },
        { usageCoverage, possiblyBilled }))
    }
  }
  return candidates
}

function candidate(
  call: ModelCallReport,
  error: SafeErrorRecord,
  failure: { stage: 'model-call' | 'provider-attempt'; attempt: ModelCallReport['attempts'][number] | undefined },
  coverage: { usageCoverage: UsageCoverageSummary; possiblyBilled: number },
): ProviderFailureCandidate {
  const { stage, attempt } = failure
  const { usageCoverage, possiblyBilled } = coverage
  const code = safeCode(error.code)
  const status = validHttpStatus(error.status) ? error.status : fallbackStatus(attempt?.httpStatus)
  return {
    code,
    value: Object.freeze({
      code,
      stage,
      message: 'Provider operation failed',
      provider: call.providerFamily ?? call.provider,
      route: call.provider,
      ...(attempt?.origin === undefined ? {} : { origin: attempt.origin }),
      ...(status === undefined ? {} : { status }),
      ...(attempt?.providerRequestId === undefined ? {} : { requestId: attempt.providerRequestId }),
      ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
      ...dispatchFields(call, attempt),
      usageCoverage,
      possiblyBilledAttemptsWithoutUsage: possiblyBilled,
    }),
  }
}

function dispatchFields(call: ModelCallReport, attempt: ModelCallReport['attempts'][number] | undefined) {
  return {
    ...(attempt?.dispatchState === undefined && call.dispatchState === undefined
      ? {}
      : { dispatchState: attempt?.dispatchState ?? call.dispatchState }),
  }
}

function fallbackStatus(status: number | undefined): number | undefined {
  return validHttpStatus(status) ? status : undefined
}

function genericError(
  raw: unknown,
  usageCoverage: UsageCoverageSummary,
  possiblyBilled: number,
): SupportSafeError {
  const source = objectValue(raw)
  const status = ownData(source, 'status', false)
  const retryable = ownData(source, 'retryable', false)
  return Object.freeze({
    code: safeCode(ownData(source, 'code', false)),
    stage: 'agent-run',
    message: 'Agent operation failed',
    ...(validHttpStatus(status) ? { status } : {}),
    ...(retryable === undefined ? {} : { retryable: flag(retryable) }),
    usageCoverage,
    possiblyBilledAttemptsWithoutUsage: possiblyBilled,
  })
}

function validHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
}

/** Match ledger errors to call/attempt facts without retaining any raw error text. */
export function supportSafeErrors(
  rawErrors: readonly unknown[],
  calls: readonly ModelCallReport[],
  options: { usageCoverage: UsageCoverageSummary; possiblyBilled: number; limit: number },
): readonly SupportSafeError[] {
  const { usageCoverage, possiblyBilled, limit } = options
  const candidates = providerCandidates(calls, usageCoverage, possiblyBilled)
  const used = new Set<number>()
  const projected = rawErrors.map(raw => {
    const source = objectValue(raw)
    const code = safeCode(ownData(source, 'code', false))
    const index = candidates.findIndex((row, candidateIndex) => !used.has(candidateIndex) && row.code === code)
    if (index < 0) return genericError(raw, usageCoverage, possiblyBilled)
    used.add(index)
    return candidates[index]?.value ?? genericError(raw, usageCoverage, possiblyBilled)
  })
  for (const [index, row] of candidates.entries()) {
    if (projected.length >= limit) break
    if (!used.has(index)) projected.push(row.value)
  }
  return Object.freeze(projected)
}
