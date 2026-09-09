import { COMPOSITION_LIMITS } from '../../../capability/common/config.ts'
import { arrayData, boundedText, objectValue, ownData } from '../../../capability/common/data.ts'
import {
  isSpanId, isTraceId, type AttemptUsageReport, type ModelCallReport,
  type ObservationDeliverySummary, type SafeErrorRecord, type UsageCounters,
} from '../../../observation/index.ts'
import { EXPORTER_BOUNDARIES } from '../../../observation/boundaries.ts'
import { COUNTER_KEYS } from '../usage.ts'
import type { RunUsageReport, UsageCoverageSummary } from '../report.ts'
import { DELIVERY_LIMITS } from './config.ts'
import {
  bytes, choice, count, DeliveryDataError, duration, flag, identity,
  numericFields, optional, safeCode, timestamp,
} from './data.ts'

export const OPERATION_STATUSES = Object.freeze(['success', 'error', 'aborted', 'rejected', 'unknown'] as const)
const COVERAGE = Object.freeze(['complete', 'partial', 'estimated', 'missing', 'not-applicable'] as const)
const COVERAGE_KEYS = Object.freeze([
  'logicalCalls', 'attempts', 'complete', 'partial', 'estimated', 'missing',
  'notApplicable', 'possiblyBilledAttemptsWithoutUsage',
] as const)

export function safeRecordError(value: unknown): SafeErrorRecord {
  const source = objectValue(value)
  return Object.freeze({
    type: 'Error', message: 'Agent operation failed', code: safeCode(ownData(source, 'code', false)),
    ...optional(source, 'retryable', flag), ...optional(source, 'status', count),
  })
}

function trace(value: unknown): ModelCallReport['traceId'] {
  if (!isTraceId(value)) throw new DeliveryDataError()
  return value
}

function span(value: unknown): ModelCallReport['spanId'] {
  if (!isSpanId(value)) throw new DeliveryDataError()
  return value
}

function counters(value: unknown): UsageCounters {
  const source = objectValue(value)
  return Object.freeze(Object.assign({}, ...COUNTER_KEYS.map(key => optional(source, key, count)))) as UsageCounters
}

export function coverageSummary(value: unknown): UsageCoverageSummary {
  return numericFields(value, COVERAGE_KEYS)
}

export function runUsage(value: unknown): RunUsageReport {
  const source = objectValue(value)
  return Object.freeze({
    reported: counters(ownData(source, 'reported')),
    ...optional(source, 'estimated', counters),
    ...optional(source, 'budgetTokens', count),
    coverage: coverageSummary(ownData(source, 'coverage')),
    authoritative: flag(ownData(source, 'authoritative')),
  })
}

export function deliverySummary(value: unknown): ObservationDeliverySummary {
  const source = objectValue(value)
  return Object.freeze({
    mode: choice(ownData(source, 'mode'), ['operational', 'reliable', 'audit']),
    requiredBoundary: choice(ownData(source, 'requiredBoundary'), EXPORTER_BOUNDARIES),
    reachedBoundary: choice(ownData(source, 'reachedBoundary'), EXPORTER_BOUNDARIES),
    complete: flag(ownData(source, 'complete')),
    acceptedCritical: count(ownData(source, 'acceptedCritical')),
    rejectedCritical: count(ownData(source, 'rejectedCritical')),
    pendingCritical: count(ownData(source, 'pendingCritical')),
    ...optional(source, 'lastFailure', safeRecordError),
  })
}

function attempt(value: unknown): AttemptUsageReport {
  const source = objectValue(value)
  const attemptNumber = count(ownData(source, 'attemptNumber'))
  if (attemptNumber === 0) throw new DeliveryDataError()
  return Object.freeze({
    attemptId: identity(ownData(source, 'attemptId')), spanId: span(ownData(source, 'spanId')), attemptNumber,
    status: choice(ownData(source, 'status'), OPERATION_STATUSES),
    startedAt: timestamp(ownData(source, 'startedAt')), endedAt: timestamp(ownData(source, 'endedAt')),
    durationMs: duration(ownData(source, 'durationMs')),
    dispatchState: choice(ownData(source, 'dispatchState'), ['not-sent', 'sent', 'unknown']),
    coverage: choice(ownData(source, 'coverage'), COVERAGE), reported: counters(ownData(source, 'reported')),
    ...optional(source, 'estimated', counters), ...optional(source, 'origin', identity),
    ...optional(source, 'httpStatus', count),
    ...optional(source, 'providerRequestId', identity), ...optional(source, 'error', safeRecordError),
  })
}

export function modelCall(
  value: unknown,
  runId: string,
  traceId: string,
  remainingBytes: number,
): ModelCallReport {
  const source = objectValue(value)
  if (ownData(source, 'runId') !== runId || ownData(source, 'traceId') !== traceId) throw new DeliveryDataError()
  let usedBytes = 0
  const attempts = arrayData(ownData(source, 'attempts'), DELIVERY_LIMITS.attemptsPerCall).map(value => {
    const row = attempt(value)
    usedBytes += bytes(row)
    if (usedBytes > remainingBytes) throw new DeliveryDataError()
    return row
  })
  if (new Set(attempts.map(row => row.attemptId)).size !== attempts.length
    || new Set(attempts.map(row => row.attemptNumber)).size !== attempts.length) throw new DeliveryDataError()
  return Object.freeze({
    runId, traceId: trace(traceId), modelCallId: identity(ownData(source, 'modelCallId')),
    spanId: span(ownData(source, 'spanId')),
    provider: identity(ownData(source, 'provider')),
    ...optional(source, 'providerFamily', identity),
    ...optional(source, 'providerPluginId', identity),
    model: boundedText(ownData(source, 'model'), COMPOSITION_LIMITS.modelIdBytes),
    status: choice(ownData(source, 'status'), OPERATION_STATUSES),
    startedAt: timestamp(ownData(source, 'startedAt')), endedAt: timestamp(ownData(source, 'endedAt')),
    durationMs: duration(ownData(source, 'durationMs')),
    ...optional(source, 'finishReason', identity),
    ...optional(source, 'dispatchState', value => choice(value, ['not-sent', 'sent', 'unknown'])),
    coverage: choice(ownData(source, 'coverage'), COVERAGE),
    reported: counters(ownData(source, 'reported')), ...optional(source, 'estimated', counters),
    attempts: Object.freeze(attempts),
    possiblyBilledAttemptsWithoutUsage: count(ownData(source, 'possiblyBilledAttemptsWithoutUsage')),
    authoritative: flag(ownData(source, 'authoritative')),
    delivery: deliverySummary(ownData(source, 'delivery')),
    ...optional(source, 'error', safeRecordError),
  })
}
