import {
  deepFreeze,
  type JsonObject,
  type JsonValue,
} from '../primitives/index.ts'
import {
  isSpanId,
  isTraceId,
  safeErrorRecord,
  type ObservationEvent,
  type ObservationEventName,
  type ObservationPhase,
  type ObservationPriority,
} from '../observation/index.ts'
import type { ContentRedactor, ObservationContentPolicy } from './telemetry-types.ts'

const MAX_TOP_LEVEL_FIELDS = 64
const MAX_KEY_LENGTH = 128
const MAX_STRING_LENGTH = 2_048
const MAX_ARRAY_LENGTH = 100
const MAX_DEPTH = 8
export const MAX_EVENT_BYTES = 64 * 1024
const REDACTED = '[REDACTED]'

const EVENT_NAMES = new Set<ObservationEventName>([
  'sdk.agent.run', 'sdk.agent.turn', 'sdk.model.call', 'sdk.provider.attempt',
  'sdk.provider.retry.scheduled', 'sdk.tool.call', 'sdk.compaction', 'sdk.hook.call',
  'sdk.user.input.wait', 'sdk.skill.operation', 'sdk.memory.operation',
  'sdk.credential.operation', 'sdk.integration.request', 'sdk.observer.failure',
  'sdk.exporter.state', 'sdk.log',
])
const PHASES = new Set<ObservationPhase>(['start', 'end', 'point'])
const PRIORITIES = new Set<ObservationPriority>(['critical', 'normal', 'verbose'])
const CONTENT_KEYS = new Set([
  'answer', 'arguments', 'body', 'completion', 'content', 'document', 'filecontent', 'filedata', 'image',
  'input', 'messages', 'output', 'prompt', 'reasoning', 'requestbody', 'responsebody',
  'result', 'text', 'toolarguments', 'toolresult',
])
const SAFE_HEADER_NAMES = new Set(['accept', 'content-type', 'request-id', 'traceparent', 'user-agent'])
const OPTIONAL_CORRELATION_KEYS = [
  'conversationId', 'turnId', 'modelCallId', 'attemptId', 'toolCallId',
  'providerRequestId', 'sessionId',
] as const

interface PrivacyOptions {
  readonly content: ObservationContentPolicy
  readonly redactors: readonly ContentRedactor[]
  readonly includeErrorStacks: boolean
}

function safeRead(source: unknown, key: PropertyKey): unknown {
  try { return Reflect.get(source as object, key) } catch { return undefined }
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return normalized === 'authorization' || normalized === 'proxyauthorization'
    || normalized === 'cookie' || normalized === 'setcookie'
    || normalized.includes('apikey') || normalized.includes('accesstoken')
    || normalized.includes('refreshtoken') || normalized.includes('idtoken')
    || normalized.includes('clientsecret') || normalized.includes('password')
    || normalized.includes('sessionsecret')
}

function contentMetadata(value: unknown): JsonObject {
  if (typeof value === 'string') return { kind: 'string', length: value.length }
  if (Array.isArray(value)) return { kind: 'array', length: value.length }
  if (value !== null && typeof value === 'object') return { kind: 'object' }
  return { kind: typeof value }
}

function redactContent(value: string, path: readonly string[], redactors: readonly ContentRedactor[]): string {
  let current = value
  for (const redactor of redactors) {
    try { current = redactor.redact(current, path) } catch { return '[REDACTION_FAILED]' }
  }
  return current
}

export function redactInlineSecrets(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|session[-_]?secret)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]',
    )
}

interface CloneState {
  readonly options: PrivacyOptions
  readonly seen: WeakSet<object>
  truncated: boolean
}

/** Internal composition helper: apply the same recursive content/secret policy before retaining logger child fields. */
export function sanitizeObservationData(value: unknown, options: PrivacyOptions): JsonObject {
  const state: CloneState = { options, seen: new WeakSet(), truncated: false }
  const cloned = cloneValue(value, ['data'], 0, state)
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== 'object') throw new TypeError('observation data must be an object')
  const data: Record<string, JsonValue> = { ...(cloned as Record<string, JsonValue>) }
  if (state.truncated) data['observability.truncated'] = true
  return deepFreeze(data)
}

function cloneValue(value: unknown, path: readonly string[], depth: number, state: CloneState): JsonValue {
  if (value === null) return null
  if (typeof value === 'string') {
    const redacted = redactInlineSecrets(value)
    if (redacted.length > MAX_STRING_LENGTH) state.truncated = true
    return redacted.slice(0, MAX_STRING_LENGTH)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function' || value === undefined) {
    state.truncated = true
    return `[${typeof value}]`
  }
  if (value instanceof Error) return cloneValue(
    safeErrorRecord(value, state.options.includeErrorStacks), path, depth, state,
  )
  if (depth >= MAX_DEPTH) { state.truncated = true; return '[MaxDepth]' }
  if (state.seen.has(value)) { state.truncated = true; return '[Circular]' }
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) state.truncated = true
      const output: JsonValue[] = []
      for (let index = 0; index < Math.min(value.length, MAX_ARRAY_LENGTH); index++) {
        output.push(cloneValue(safeRead(value, index), [...path, String(index)], depth + 1, state))
      }
      return output
    }
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    let keys: string[]
    try { keys = Object.keys(value) } catch { state.truncated = true; return '[Uninspectable]' }
    const headers = normalizedKey(path.at(-1) ?? '') === 'headers'
    for (const originalKey of keys) {
      if (Object.keys(output).length >= MAX_TOP_LEVEL_FIELDS) { state.truncated = true; break }
      const key = originalKey.slice(0, MAX_KEY_LENGTH)
      if (key !== originalKey) state.truncated = true
      if (headers && !SAFE_HEADER_NAMES.has(originalKey.toLowerCase())) {
        output[key] = REDACTED
        continue
      }
      const child = safeRead(value, originalKey)
      if (isSecretKey(originalKey)) {
        output[key] = REDACTED
        continue
      }
      const contentKey = CONTENT_KEYS.has(normalizedKey(originalKey))
      if (contentKey && state.options.content === 'none') continue
      if (contentKey && state.options.content === 'metadata') {
        output[key] = contentMetadata(child)
        continue
      }
      if (contentKey && state.options.content === 'redacted' && typeof child === 'string') {
        output[key] = cloneValue(
          redactContent(child, [...path, originalKey], state.options.redactors),
          [...path, originalKey], depth + 1, state,
        )
        continue
      }
      output[key] = cloneValue(child, [...path, originalKey], depth + 1, state)
    }
    return output
  } finally {
    state.seen.delete(value)
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`observation ${field} is invalid`)
  return value.slice(0, MAX_STRING_LENGTH)
}

function eventBytes(event: ObservationEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength
}

/** Validate, privacy-process, bound, and deeply freeze one untrusted event. */
export function sanitizeObservationEvent(event: unknown, options: PrivacyOptions): ObservationEvent {
  if (typeof event !== 'object' || event === null) throw new TypeError('observation event must be an object')
  if (safeRead(event, 'schemaVersion') !== 1) throw new TypeError('observation schemaVersion is invalid')
  const name = safeRead(event, 'name')
  const phase = safeRead(event, 'phase')
  const priority = safeRead(event, 'priority')
  if (!EVENT_NAMES.has(name as ObservationEventName)) throw new TypeError('observation name is invalid')
  if (!PHASES.has(phase as ObservationPhase)) throw new TypeError('observation phase is invalid')
  if (!PRIORITIES.has(priority as ObservationPriority)) throw new TypeError('observation priority is invalid')
  const sequence = safeRead(event, 'sequence')
  const monotonicMs = safeRead(event, 'monotonicMs')
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) throw new TypeError('observation sequence is invalid')
  if (typeof monotonicMs !== 'number' || !Number.isFinite(monotonicMs) || monotonicMs < 0) {
    throw new TypeError('observation monotonicMs is invalid')
  }
  const resource = safeRead(event, 'resource')
  const correlation = safeRead(event, 'correlation')
  if (typeof resource !== 'object' || resource === null || safeRead(resource, 'sdkName') !== 'ai-agent-sdk') {
    throw new TypeError('observation resource is invalid')
  }
  if (typeof correlation !== 'object' || correlation === null
    || !isTraceId(safeRead(correlation, 'traceId')) || !isSpanId(safeRead(correlation, 'spanId'))) {
    throw new TypeError('observation correlation is invalid')
  }
  const parentSpanId = safeRead(correlation, 'parentSpanId')
  if (parentSpanId !== null && !isSpanId(parentSpanId)) throw new TypeError('observation parentSpanId is invalid')
  if (typeof safeRead(correlation, 'runId') !== 'string' || String(safeRead(correlation, 'runId')).length === 0) {
    throw new TypeError('observation runId is invalid')
  }
  for (const key of OPTIONAL_CORRELATION_KEYS) {
    const value = safeRead(correlation, key)
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new TypeError(`observation ${key} is invalid`)
    }
  }
  const occurredAt = requiredString(safeRead(event, 'occurredAt'), 'occurredAt')
  if (Number.isNaN(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt) {
    throw new TypeError('observation occurredAt must be UTC ISO 8601')
  }
  const eventId = requiredString(safeRead(event, 'eventId'), 'eventId')
  if (!/^[0-9a-f]{32}$/.test(eventId) || /^0+$/.test(eventId)) throw new TypeError('observation eventId is invalid')
  const sdkVersion = requiredString(safeRead(resource, 'sdkVersion'), 'resource.sdkVersion')
  const runtime = safeRead(resource, 'runtime')
  if (!['browser', 'edge', 'node', 'unknown'].includes(String(runtime))) {
    throw new TypeError('observation resource runtime is invalid')
  }

  const state: CloneState = { options, seen: new WeakSet(), truncated: false }
  const clonedData = cloneValue(safeRead(event, 'data'), ['data'], 0, state)
  if (clonedData === null || Array.isArray(clonedData) || typeof clonedData !== 'object') {
    throw new TypeError('observation data must be an object')
  }
  const data: Record<string, JsonValue> = { ...(clonedData as Record<string, JsonValue>) }
  if (state.truncated) data['observability.truncated'] = true
  const safe: ObservationEvent = {
    schemaVersion: 1,
    eventId,
    sequence: sequence as number,
    name: name as ObservationEventName,
    phase: phase as ObservationPhase,
    occurredAt,
    monotonicMs,
    priority: priority as ObservationPriority,
    resource: {
      sdkName: 'ai-agent-sdk',
      sdkVersion,
      ...typeof safeRead(resource, 'serviceName') === 'string'
        ? { serviceName: String(safeRead(resource, 'serviceName')).slice(0, MAX_STRING_LENGTH) }
        : {},
      ...typeof safeRead(resource, 'serviceVersion') === 'string'
        ? { serviceVersion: String(safeRead(resource, 'serviceVersion')).slice(0, MAX_STRING_LENGTH) }
        : {},
      runtime: runtime as 'browser' | 'edge' | 'node' | 'unknown',
    },
    correlation: cloneValue(correlation, ['correlation'], 0, state) as unknown as ObservationEvent['correlation'],
    data,
  }
  if (eventBytes(safe) > MAX_EVENT_BYTES) {
    const keys = Object.keys(data)
    while (keys.length > 0 && eventBytes(safe) > MAX_EVENT_BYTES) {
      const key = keys.pop()
      if (key !== undefined && key !== 'observability.truncated') delete data[key]
    }
    data['observability.truncated'] = true
  }
  if (eventBytes(safe) > MAX_EVENT_BYTES) throw new RangeError('observation event exceeds the 64 KiB hard limit')
  return deepFreeze(safe)
}

export function serializedEventBytes(event: ObservationEvent): number {
  return eventBytes(event)
}
