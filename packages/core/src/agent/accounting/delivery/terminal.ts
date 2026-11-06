import { arrayData, objectValue, ownData } from '../../../capability/common/data.ts'
import { isTraceId } from '../../../observation/index.ts'
import { OPERATION_KINDS } from '../config.ts'
import type { LegacyRunReport } from '../report.ts'
import type { RunReport, RunTerminalRecord, ToolSourceRunReference } from '../delivery-types.ts'
import { deliverySummary, modelCall, OPERATION_STATUSES, runUsage } from './accounting-data.ts'
import { DELIVERY_LIMITS } from './config.ts'
import {
  bytes, choice, DeliveryDataError, duration, identity, numericFields, timestamp,
} from './data.ts'
import { supportSafeErrors } from './support-errors.ts'

/** Prepared records and their serialized UTF-8 size, measured once at creation. */
const prepared = new WeakMap<RunTerminalRecord, number>()
const COUNT_KEYS = Object.freeze(['total', 'success', 'error', 'aborted', 'rejected', 'unknown'] as const)

export function isPreparedTerminal(record: RunTerminalRecord): boolean { return prepared.has(record) }

/** Serialized size of a prepared (frozen) record, so queueing and batching never re-serialize it. */
export function preparedTerminalBytes(record: RunTerminalRecord): number {
  const size = prepared.get(record)
  if (size === undefined) throw new DeliveryDataError()
  return size
}

export function createRunTerminalRecord(
  report: LegacyRunReport | RunReport,
  sources: readonly ToolSourceRunReference[] = [],
): RunTerminalRecord {
  try {
    const input = objectValue(report)
    const runId = identity(ownData(input, 'runId')), traceId = ownData(input, 'traceId')
    if (!isTraceId(traceId)) throw new DeliveryDataError()
    const usage = runUsage(ownData(input, 'usage'))
    let usedBytes = 0
    const calls = arrayData(ownData(input, 'modelCalls'), DELIVERY_LIMITS.modelCalls).map(value => {
      const call = modelCall(value, runId, traceId, DELIVERY_LIMITS.recordBytes - usedBytes)
      usedBytes += bytes(call)
      if (usedBytes > DELIVERY_LIMITS.recordBytes) throw new DeliveryDataError()
      return call
    })
    if (new Set(calls.map(call => call.modelCallId)).size !== calls.length) throw new DeliveryDataError()
    const counts = objectValue(ownData(input, 'operationCounts'))
    const operationCounts = Object.freeze(Object.fromEntries(OPERATION_KINDS.map(kind => (
      [kind, numericFields(ownData(counts, kind), COUNT_KEYS)]
    )))) as RunTerminalRecord['operationCounts']
    const toolSourceSnapshots = arrayData(sources, DELIVERY_LIMITS.toolSources).map(value => {
      const source = objectValue(value)
      return Object.freeze({
        sourceId: identity(ownData(source, 'sourceId')),
        revision: identity(ownData(source, 'revision')),
      })
    })
    if (new Set(toolSourceSnapshots.map(source => source.sourceId)).size !== toolSourceSnapshots.length) {
      throw new DeliveryDataError()
    }
    const errors = supportSafeErrors(
      arrayData(ownData(input, 'errors'), DELIVERY_LIMITS.errors), calls,
      { usageCoverage: usage.coverage, possiblyBilled: usage.coverage.possiblyBilledAttemptsWithoutUsage,
        limit: DELIVERY_LIMITS.errors },
    )
    const record: RunTerminalRecord = Object.freeze({
      kind: 'run-terminal-record', runId, traceId,
      startedAt: timestamp(ownData(input, 'startedAt')), endedAt: timestamp(ownData(input, 'endedAt')),
      durationMs: duration(ownData(input, 'durationMs')),
      status: choice(ownData(input, 'status'), OPERATION_STATUSES),
      usage, modelCalls: Object.freeze(calls), operationCounts,
      toolSourceSnapshots: Object.freeze(toolSourceSnapshots), errors: Object.freeze(errors),
    })
    const size = bytes(record)
    if (size > DELIVERY_LIMITS.recordBytes) throw new DeliveryDataError()
    prepared.set(record, size)
    return record
  } catch { throw new DeliveryDataError() }
}

export function withTerminalDelivery(
  record: RunTerminalRecord,
  delivery: RunReport['delivery'],
): RunReport {
  if (!prepared.has(record)) throw new DeliveryDataError()
  try { return Object.freeze({ ...record, delivery: deliverySummary(delivery) }) }
  catch { throw new DeliveryDataError() }
}
