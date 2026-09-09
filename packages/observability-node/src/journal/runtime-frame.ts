import { isTraceId, type ObservationEvent, type RunTerminalRecord } from '@alvin0/ai-agent-sdk-core'
import type { ObservationExportItem } from '@alvin0/ai-agent-sdk-core/observability'
import { journalChecksum, validObservationEvent } from './frame.ts'

export type RuntimeFrameKind = 'event' | 'run-terminal-record'

export interface RuntimeJournalRecord {
  readonly segment: string
  readonly line: number
  readonly kind: RuntimeFrameKind
  readonly id: string
  readonly key: string
  readonly item: ObservationExportItem
  readonly payloadJson: string
}

export function runtimeItemIdentity(item: ObservationExportItem): {
  readonly kind: RuntimeFrameKind
  readonly id: string
  readonly key: string
} {
  const kind = 'kind' in item && item.kind === 'run-terminal-record' ? 'run-terminal-record' : 'event'
  const id = kind === 'event' ? (item as ObservationEvent).eventId : (item as RunTerminalRecord).runId
  return { kind, id, key: `${kind}:${id}` }
}

export function runtimeJournalLine(item: ObservationExportItem, payloadJson: string): string {
  const identity = runtimeItemIdentity(item)
  return `${JSON.stringify({
    schemaVersion: 1,
    itemKind: identity.kind,
    itemId: identity.id,
    payloadJson,
    sha256: journalChecksum(payloadJson),
  })}\n`
}

export function parseRuntimeJournalLine(line: string, segment: string, lineNumber: number): RuntimeJournalRecord {
  const envelope = JSON.parse(line) as Record<string, unknown>
  if (envelope.schemaVersion !== 1
    || (envelope.itemKind !== 'event' && envelope.itemKind !== 'run-terminal-record')
    || typeof envelope.itemId !== 'string'
    || typeof envelope.payloadJson !== 'string'
    || typeof envelope.sha256 !== 'string'
    || envelope.sha256 !== journalChecksum(envelope.payloadJson)) throw new Error('invalid frame')
  const parsed = JSON.parse(envelope.payloadJson) as unknown
  let item: ObservationExportItem
  if (envelope.itemKind === 'event') {
    if (!validObservationEvent(parsed, envelope.itemId)) throw new Error('invalid journal item')
    item = parsed
  } else {
    if (!validTerminalRecord(parsed, envelope.itemId)) throw new Error('invalid journal item')
    item = parsed
  }
  return {
    segment,
    line: lineNumber,
    kind: envelope.itemKind,
    id: envelope.itemId,
    key: `${envelope.itemKind}:${envelope.itemId}`,
    item,
    payloadJson: envelope.payloadJson,
  }
}

function validTerminalRecord(value: unknown, runId: string): value is RunTerminalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const startedAt = Reflect.get(value, 'startedAt')
    const endedAt = Reflect.get(value, 'endedAt')
    const durationMs = Reflect.get(value, 'durationMs')
    return Reflect.get(value, 'kind') === 'run-terminal-record'
      && Reflect.get(value, 'runId') === runId && runId.length > 0 && runId.length <= 128
      && isTraceId(Reflect.get(value, 'traceId'))
      && validIsoDate(startedAt) && validIsoDate(endedAt)
      && typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      && ['success', 'error', 'aborted', 'rejected', 'unknown'].includes(Reflect.get(value, 'status'))
      && objectRecord(Reflect.get(value, 'usage'))
      && Array.isArray(Reflect.get(value, 'modelCalls'))
      && Array.isArray(Reflect.get(value, 'toolSourceSnapshots'))
      && objectRecord(Reflect.get(value, 'operationCounts'))
      && Array.isArray(Reflect.get(value, 'errors'))
      && !Object.prototype.hasOwnProperty.call(value, 'delivery')
  } catch { return false }
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
