import type { JsonObject, JsonValue } from '../primitives/json.ts'
import type { CorrelationContext } from './context.ts'

export type ObservationPriority = 'critical' | 'normal' | 'verbose'
export type ObservationPhase = 'start' | 'end' | 'point'
export type OperationStatus = 'success' | 'error' | 'aborted' | 'rejected' | 'unknown'

export interface ObservationResourceInput {
  readonly serviceName?: string
  readonly serviceVersion?: string
  readonly environment?: string
  readonly attributes?: Readonly<Record<string, JsonValue>>
}

export interface ObservationResource {
  readonly sdkName: 'ai-agent-sdk'
  readonly sdkVersion: string
  readonly serviceName?: string
  readonly serviceVersion?: string
  readonly runtime: 'browser' | 'edge' | 'node' | 'unknown'
  readonly runtimeId?: string
  readonly environment?: string
  readonly attributes?: Readonly<Record<string, JsonValue>>
}

export type ObservationEventName =
  | 'sdk.agent.run'
  | 'sdk.agent.turn'
  | 'sdk.model.call'
  | 'sdk.provider.attempt'
  | 'sdk.provider.retry.scheduled'
  | 'sdk.tool.call'
  | 'sdk.compaction'
  | 'sdk.hook.call'
  | 'sdk.user.input.wait'
  | 'sdk.skill.operation'
  | 'sdk.memory.operation'
  | 'sdk.credential.operation'
  | 'sdk.integration.request'
  | 'sdk.observer.failure'
  | 'sdk.exporter.state'
  | 'sdk.log'

export interface ObservationEvent<
  Name extends ObservationEventName = ObservationEventName,
  Data extends JsonObject = JsonObject,
> {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly sequence: number
  readonly name: Name
  readonly phase: ObservationPhase
  readonly occurredAt: string
  readonly monotonicMs: number
  readonly priority: ObservationPriority
  readonly resource: ObservationResource
  readonly correlation: CorrelationContext
  readonly data: Data
}

export interface SafeErrorRecord {
  readonly type: string
  readonly message: string
  readonly code?: string
  readonly retryable?: boolean
  readonly status?: number
  readonly causeTypes?: readonly string[]
  readonly stack?: string
}

function boundedUnknownMessage(value: unknown): string {
  try {
    const rendered = typeof value === 'string' ? value : String(value)
    return rendered.slice(0, 2_048)
  } catch {
    return '<unrenderable value>'
  }
}

function safeRead(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

function isError(value: unknown): value is Error {
  try {
    return value instanceof Error
  } catch {
    return false
  }
}

/** Converts thrown values without retaining bodies, credentials, or stacks by default. */
export function safeErrorRecord(value: unknown, includeStack = false): SafeErrorRecord {
  if (!isError(value)) return Object.freeze({ type: typeof value, message: boundedUnknownMessage(value) })
  const source = value as object
  const causeTypes: string[] = []
  let cause = safeRead(source, 'cause')
  const seen = new Set<unknown>()
  while (cause !== undefined && cause !== null && !seen.has(cause)) {
    seen.add(cause)
    const causeIsError = isError(cause)
    const causeName = causeIsError ? safeRead(cause, 'name') : undefined
    causeTypes.push(typeof causeName === 'string' && causeName.length > 0 ? causeName : causeIsError ? 'Error' : typeof cause)
    cause = causeIsError ? safeRead(cause, 'cause') : undefined
  }
  const name = safeRead(source, 'name')
  const message = safeRead(source, 'message')
  const code = safeRead(source, 'code')
  const retryable = safeRead(source, 'retryable')
  const status = safeRead(source, 'status')
  const stack = includeStack ? safeRead(source, 'stack') : undefined
  return Object.freeze({
    type: typeof name === 'string' && name.length > 0 ? name : 'Error',
    message: boundedUnknownMessage(message),
    ...typeof code === 'string' && code.length > 0 ? { code } : {},
    ...typeof retryable === 'boolean' ? { retryable } : {},
    ...typeof status === 'number' && Number.isInteger(status) ? { status } : {},
    ...causeTypes.length > 0 ? { causeTypes: Object.freeze(causeTypes) } : {},
    ...typeof stack === 'string' ? { stack } : {},
  })
}
