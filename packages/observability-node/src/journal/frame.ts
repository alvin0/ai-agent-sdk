import { createHash } from 'node:crypto'
import {
  isSpanId,
  isTraceId,
  type ObservationEvent,
  type ObservationEventName,
} from '@alvin0/ai-agent-sdk-core'

const EVENT_NAMES = new Set<ObservationEventName>([
  'sdk.agent.run', 'sdk.agent.turn', 'sdk.model.call', 'sdk.provider.attempt',
  'sdk.embedding.call', 'sdk.embedding.batch',
  'sdk.provider.retry.scheduled', 'sdk.tool.call', 'sdk.compaction', 'sdk.hook.call',
  'sdk.user.input.wait', 'sdk.skill.operation', 'sdk.memory.operation',
  'sdk.credential.operation', 'sdk.integration.request', 'sdk.observer.failure',
  'sdk.exporter.state', 'sdk.log',
])

export function journalChecksum(payloadJson: string): string {
  return createHash('sha256').update(payloadJson, 'utf8').digest('hex')
}

export function validObservationEvent(value: unknown, eventId: string): value is ObservationEvent {
  if (typeof value !== 'object' || value === null) return false
  try {
    const sequence = Reflect.get(value, 'sequence')
    const monotonicMs = Reflect.get(value, 'monotonicMs')
    const occurredAt = Reflect.get(value, 'occurredAt')
    const resource = Reflect.get(value, 'resource') as unknown
    const correlation = Reflect.get(value, 'correlation') as unknown
    const name = Reflect.get(value, 'name') as ObservationEventName
    const optionalCorrelation = [
      'conversationId', 'turnId', 'modelCallId', 'attemptId', 'toolCallId',
      'providerRequestId', 'sessionId',
    ].every(key => {
      const field = Reflect.get(correlation as object, key)
      return field === undefined || (typeof field === 'string' && field.length > 0)
    })
    return validEventIdentity(value, eventId, sequence, name)
      && validEventTiming(occurredAt, monotonicMs)
      && validResource(resource)
      && validCorrelation(correlation)
      && optionalCorrelation
      && validEventData(value)

  } catch { return false }
}

function validEventIdentity(value: object, eventId: string, sequence: number, name: ObservationEventName): boolean {
  return Reflect.get(value, 'schemaVersion') === 1
    && Reflect.get(value, 'eventId') === eventId && /^[0-9a-f]{32}$/.test(eventId) && !/^0+$/.test(eventId)
    && Number.isSafeInteger(sequence) && sequence > 0
    && EVENT_NAMES.has(name)
    && ['start', 'end', 'point'].includes(Reflect.get(value, 'phase'))
    && ['critical', 'normal', 'verbose'].includes(Reflect.get(value, 'priority'))
}

function validEventTiming(occurredAt: unknown, monotonicMs: unknown): boolean {
  return typeof occurredAt === 'string' && !Number.isNaN(Date.parse(occurredAt))
    && new Date(occurredAt).toISOString() === occurredAt
    && typeof monotonicMs === 'number' && Number.isFinite(monotonicMs) && monotonicMs >= 0
}

function validResource(resource: unknown): boolean {
  return typeof resource === 'object' && resource !== null
    && Reflect.get(resource, 'sdkName') === 'ai-agent-sdk'
    && typeof Reflect.get(resource, 'sdkVersion') === 'string'
    && Reflect.get(resource, 'sdkVersion').length > 0
    && ['browser', 'edge', 'node', 'unknown'].includes(Reflect.get(resource, 'runtime'))
}

function validCorrelation(correlation: unknown): boolean {
  return typeof correlation === 'object' && correlation !== null
    && isTraceId(Reflect.get(correlation, 'traceId')) && isSpanId(Reflect.get(correlation, 'spanId'))
    && (Reflect.get(correlation, 'parentSpanId') === null || isSpanId(Reflect.get(correlation, 'parentSpanId')))
    && typeof Reflect.get(correlation, 'runId') === 'string' && Reflect.get(correlation, 'runId').length > 0
}

function validEventData(value: object): boolean {
  return typeof Reflect.get(value, 'data') === 'object' && Reflect.get(value, 'data') !== null
    && !Array.isArray(Reflect.get(value, 'data'))
}
