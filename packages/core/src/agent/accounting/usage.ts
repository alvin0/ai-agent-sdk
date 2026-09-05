import {
  OBSERVATION_ERROR_CODES, addUsageCounters, type ModelCallReport, type SafeErrorRecord,
  type UsageCounters,
} from '../../observation/index.ts'
import { deepFreeze } from '../../primitives/index.ts'
import type { RunUsageReport } from './report.ts'
import type { TokenUsage } from '../../stream/index.ts'
import { accountingError } from './common.ts'

export const COUNTER_KEYS = [
  'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens',
  'cacheWriteTokens', 'reasoningTokens',
] as const satisfies readonly (keyof UsageCounters)[]

export function aggregateUsage(reports: readonly ModelCallReport[], errors: SafeErrorRecord[]): RunUsageReport {
  const coverage = {
    logicalCalls: reports.length,
    attempts: reports.reduce((total, report) => total + report.attempts.length, 0),
    complete: reports.filter(report => report.coverage === 'complete').length,
    partial: reports.filter(report => report.coverage === 'partial').length,
    estimated: reports.filter(report => report.coverage === 'estimated').length,
    missing: reports.filter(report => report.coverage === 'missing').length,
    notApplicable: reports.filter(report => report.coverage === 'not-applicable').length,
    possiblyBilledAttemptsWithoutUsage: reports.reduce(
      (total, report) => saturating(total, report.possiblyBilledAttemptsWithoutUsage).value,
      0,
    ),
  }
  if (reports.length === 0) {
    return deepFreeze({
      reported: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      coverage,
      authoritative: true,
    })
  }
  const reported = aggregateCounterSets(reports.map(report => report.reported), errors)
  const estimatedValues = reports.flatMap(report => report.estimated === undefined ? [] : [report.estimated])
  const estimated = estimatedValues.length === 0 ? undefined : aggregateCounterSets(estimatedValues, errors)
  const authoritative = reports.every(report => report.authoritative)
    && !errors.some(error => error.code === OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW
      || error.code === OBSERVATION_ERROR_CODES.USAGE_INVALID)
  return deepFreeze({
    reported,
    ...(estimated === undefined ? {} : { estimated }),
    coverage,
    authoritative,
  })
}

/** Deterministic public projection used by turn outcomes and the canonical ledger. */
export function summarizeModelCallUsage(reports: readonly ModelCallReport[]): RunUsageReport {
  return aggregateUsage(reports, [])
}

/** Legacy exact usage exists only when every logical call is authoritative. */
export function authoritativeTokenUsage(report: RunUsageReport): TokenUsage | undefined {
  if (!report.authoritative) return undefined
  const inputTokens = report.reported.inputTokens
  const outputTokens = report.reported.outputTokens
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return Object.freeze({
    inputTokens,
    outputTokens,
    ...(report.reported.totalTokens === undefined ? {} : { totalTokens: report.reported.totalTokens }),
    ...(report.reported.cacheReadTokens === undefined ? {} : { cacheReadTokens: report.reported.cacheReadTokens }),
    ...(report.reported.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: report.reported.cacheWriteTokens }),
    ...(report.reported.reasoningTokens === undefined ? {} : { reasoningTokens: report.reported.reasoningTokens }),
  })
}

/** Budget projection: reported buckets plus estimates only where reporting is absent. */
export function budgetTokenTotal(report: RunUsageReport): number | undefined {
  if (report.authoritative) return report.reported.totalTokens ?? disjointTotal(report.reported)
  const combined: UsageCounters = Object.freeze({
    ...counterValue(report, 'inputTokens'),
    ...counterValue(report, 'cacheReadTokens'),
    ...counterValue(report, 'cacheWriteTokens'),
    ...counterValue(report, 'outputTokens'),
  })
  const bucketTotal = disjointTotal(combined)
  if (bucketTotal !== undefined) return bucketTotal
  return report.reported.totalTokens ?? report.estimated?.totalTokens
}

export function counterValue(
  report: RunUsageReport,
  key: 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens',
): Partial<Record<typeof key, number>> {
  const value = report.reported[key] ?? report.estimated?.[key]
  return value === undefined ? {} : { [key]: value }
}

export function aggregateCounterSets(values: readonly UsageCounters[], errors: SafeErrorRecord[]): UsageCounters {
  const normalized = values.map(value => {
    if (value.totalTokens !== undefined) return value
    const total = disjointTotal(value)
    return total === undefined ? value : { ...value, totalTokens: total }
  })
  const result = addUsageCounters(normalized)
  if (result.overflow) errors.push(accountingError(
    'usage aggregation saturated at Number.MAX_SAFE_INTEGER',
    OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW,
  ))
  return result.counters
}

export function disjointTotal(value: UsageCounters): number | undefined {
  const parts = [value.inputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.outputTokens]
  if (parts.every(part => part === undefined)) return undefined
  let total = 0
  for (const part of parts) total = saturating(total, part ?? 0).value
  return total
}

export function missingCounters(estimated: UsageCounters, reported: UsageCounters): UsageCounters {
  const output: Partial<Record<keyof UsageCounters, number>> = {}
  for (const key of COUNTER_KEYS) {
    if (reported[key] === undefined && estimated[key] !== undefined) output[key] = estimated[key]
  }
  return Object.freeze({ ...output })
}

export function saturating(left: number, right: number): { value: number; overflow: boolean } {
  const total = left + right
  return !Number.isSafeInteger(total)
    ? { value: Number.MAX_SAFE_INTEGER, overflow: true }
    : { value: total, overflow: false }
}
