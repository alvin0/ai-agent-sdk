import { OBSERVATION_ERROR_CODES, hasUsageCounters, validateUsageCounters, type ModelCallReport,
  type SafeErrorRecord } from '../../observation/index.ts'
import { deepFreeze } from '../../primitives/index.ts'
import type { GenerateOptions } from '../../contract/index.ts'
import type { ModelCallPolicyDecision } from './contracts.ts'
import type { ResolvedUsagePolicy } from './ledger-support.ts'
import { accountingError } from './common.ts'
import { estimateUsage } from './estimate.ts'
import { missingCounters } from './usage.ts'

interface UsagePolicyInput {
  report: ModelCallReport
  request: GenerateOptions
  incomplete: boolean
  usagePolicy: ResolvedUsagePolicy
  runId: string
  signal: AbortSignal
  closed: () => boolean
  errors: SafeErrorRecord[]
  policyErrorIndex: number
  finish: (result: UsagePolicyResult) => ModelCallPolicyDecision
}
export interface UsagePolicyResult {
  accepted: ModelCallReport
  usageRequired: boolean
  closed: boolean
}

export function applyModelCallUsagePolicy(
  input: UsagePolicyInput,
): ModelCallPolicyDecision | Promise<ModelCallPolicyDecision> {
  const { report, incomplete, usagePolicy, errors, policyErrorIndex } = input
  const accepted = report
  let usageRequired = false
  if (incomplete && usagePolicy.onMissing === 'estimate') {
    return estimateModelCallUsage(input)
  } else if (incomplete && usagePolicy.onMissing === 'fail') {
    usageRequired = true
    errors.splice(policyErrorIndex, 0, accountingError(
      'provider usage is required by the configured run policy',
      OBSERVATION_ERROR_CODES.USAGE_REQUIRED,
    ))
  } else if (incomplete && report.error?.code !== OBSERVATION_ERROR_CODES.USAGE_MISSING) {
    errors.splice(policyErrorIndex, 0, accountingError(
      'model call completed without authoritative provider usage',
      OBSERVATION_ERROR_CODES.USAGE_MISSING,
    ))
  }

  return input.finish({ accepted, usageRequired, closed: false })
}

async function estimateModelCallUsage(input: UsagePolicyInput): Promise<ModelCallPolicyDecision> {
  const { report, request, usagePolicy, runId, signal, closed, errors, policyErrorIndex } = input
  let result: UsagePolicyResult = { accepted: report, usageRequired: true, closed: false }
  try {
    const estimator = usagePolicy.estimator
    if (estimator === undefined) throw new TypeError('estimate usage policy requires an estimator')
    const raw = await estimateUsage(estimator, {
      runId,
      modelCallId: report.modelCallId,
      provider: report.provider,
      model: report.model,
      request,
      report,
    }, signal, usagePolicy.estimateTimeoutMs)
    if (closed()) return input.finish({ accepted: report, usageRequired: true, closed: true })
    const validation = validateUsageCounters(raw)
    if (validation.invalidFields.length > 0 || validation.overflow || !hasUsageCounters(validation.reported)) {
      throw new TypeError('usage estimator returned invalid or empty counters')
    }
    const estimated = missingCounters(validation.reported, report.reported)
    if (!hasUsageCounters(estimated)) throw new TypeError('usage estimator did not cover a missing counter')
    const accepted = deepFreeze({
      ...report,
      coverage: hasUsageCounters(report.reported) ? 'partial' as const : 'estimated' as const,
      estimated,
      authoritative: false,
    })
    result = { accepted, usageRequired: false, closed: false }
  } catch (estimatorError) {
    if (closed()) return input.finish({ accepted: report, usageRequired: true, closed: true })
    errors.splice(policyErrorIndex, 0, accountingError(
      'usage estimation failed after a provider response',
      OBSERVATION_ERROR_CODES.USAGE_REQUIRED,
      estimatorError,
    ))
  }
  return input.finish(result)
}

export function modelCallPolicyDecision(input: {
  accepted: ModelCallReport
  usageRequired: boolean
  incomplete: boolean
  usagePolicy: ResolvedUsagePolicy
  cumulativeTokenBudget: boolean
}): ModelCallPolicyDecision {
  const { accepted, usageRequired, incomplete, usagePolicy, cumulativeTokenBudget } = input
  return Object.freeze({
    report: accepted, usageRequired,
    usageUnavailable: !usageRequired && incomplete && usagePolicy.onMissing === 'warn'
      && cumulativeTokenBudget && accepted.possiblyBilledAttemptsWithoutUsage > 0,
  })
}
