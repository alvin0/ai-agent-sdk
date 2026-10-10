import {
  deepFreeze,
  type JsonObject,
} from '../primitives/index.ts'
import {
  createCoreSpan,
  createObservationRunScope,
  createOperationId,
  type CorrelationContext,
  type ObservationEvent,
  type ObservationResource,
  type ObservationRunScope,
} from '../observation/index.ts'
import type { LoggerContext, LogLevel, SdkLogger } from './types.ts'

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5,
}

interface LoggerTarget {
  readonly minimumLevel: LogLevel
  readonly resource: ObservationResource
  emit(event: ObservationEvent): void
}

interface ResolvedLoggerContext {
  readonly correlation: CorrelationContext
  readonly resource: ObservationResource
  readonly scope: ObservationRunScope
}

function cloneFields(fields: Readonly<JsonObject>): Readonly<JsonObject> {
  try { return deepFreeze(structuredClone(fields)) }
  catch (error) { throw new TypeError('logger fields must be structured-cloneable JSON', { cause: error }) }
}

function resolveContext(target: LoggerTarget, input: LoggerContext | undefined): ResolvedLoggerContext {
  const options = input ?? {}
  const invocation = options.invocation
  const scope = invocation?.scope ?? createObservationRunScope()
  const supplied = options.correlation ?? invocation?.correlation
  return {
    correlation: resolveCorrelation(supplied, scope),
    resource: options.resource ?? invocation?.resource ?? target.resource,
    scope,
  }
}

function resolveCorrelation(
  supplied: Partial<CorrelationContext> | undefined, scope: ObservationRunScope,
): CorrelationContext {
  if (supplied?.traceId !== undefined && supplied.spanId !== undefined
    && supplied.parentSpanId !== undefined && supplied.runId !== undefined) {
    return supplied as CorrelationContext
  }
  const runId = supplied?.runId ?? createOperationId()
  return createCoreSpan({
    name: 'sdk.integration.request', runId,
    startedAt: new Date().toISOString(), monotonicMs: scope.monotonicMs(),
  }).correlation
}

function logPriority(level: LogLevel): ObservationEvent['priority'] {
  if (level === 'trace' || level === 'debug') return 'verbose'
  if (level === 'error' || level === 'fatal') return 'critical'
  return 'normal'
}

class BusLogger implements SdkLogger {
  constructor(
    private readonly target: LoggerTarget,
    private readonly context: ResolvedLoggerContext,
    private readonly boundFields: Readonly<JsonObject>,
  ) {}

  child(fields: Readonly<JsonObject>): SdkLogger {
    return new BusLogger(this.target, this.context, cloneFields({ ...this.boundFields, ...fields }))
  }

  trace(message: string, fields?: Readonly<JsonObject>): void { this.log('trace', message, fields) }
  debug(message: string, fields?: Readonly<JsonObject>): void { this.log('debug', message, fields) }
  info(message: string, fields?: Readonly<JsonObject>): void { this.log('info', message, fields) }
  warn(message: string, fields?: Readonly<JsonObject>): void { this.log('warn', message, fields) }
  error(message: string, fields?: Readonly<JsonObject>): void { this.log('error', message, fields) }
  fatal(message: string, fields?: Readonly<JsonObject>): void { this.log('fatal', message, fields) }

  private log(level: LogLevel, message: string, fields: Readonly<JsonObject> = {}): void {
    if (typeof message !== 'string') throw new TypeError('logger message must be a string')
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.target.minimumLevel]) return
    const priority = logPriority(level)
    this.target.emit({
      schemaVersion: 1,
      eventId: createOperationId(),
      sequence: this.context.scope.nextSequence(),
      name: 'sdk.log',
      phase: 'point',
      occurredAt: new Date().toISOString(),
      monotonicMs: this.context.scope.monotonicMs(),
      priority,
      resource: this.context.resource,
      correlation: this.context.correlation,
      data: { level, message, fields: cloneFields({ ...this.boundFields, ...fields }) },
    })
  }
}

export function createBusLogger(target: LoggerTarget, context?: LoggerContext): SdkLogger {
  return new BusLogger(target, resolveContext(target, context), cloneFields({ ...(context?.fields ?? {}) }))
}
