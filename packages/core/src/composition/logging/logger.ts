import type { JsonObject } from '../../primitives/index.ts'
import { deepFreeze } from '../../primitives/index.ts'
import type { CorrelationContext, ObservationEvent, ObservationResource } from '../../observation/index.ts'
import type { LogLevel } from '../../logging/types.ts'
import type { ContentRedactor } from '../../observation/telemetry-types.ts'
import type { SdkLogger } from '../../logging/types.ts'
import { redactInlineSecrets, sanitizeObservationData } from '../../observation/privacy.ts'
import type { RuntimePlatform } from '../../platform/adapter.ts'
import {
  bindRuntimeLoggerPlatform,
  runtimePlatformForLogger as capturedRuntimePlatformForLogger,
} from '../../platform/logger-platform.ts'
import { cloneJsonObject } from '../common/json-data.ts'
import { boundedText, objectValue, ownData } from '../common/data.ts'
import { LOG_LEVEL_RANK, RUNTIME_LOG_LIMITS } from './config.ts'
import { validateIntegrationEvidence } from './integration.ts'

export interface RuntimeLoggerContext {
  readonly scope?: string
  readonly fields?: Readonly<JsonObject>
}
export interface RuntimeLoggerTarget {
  readonly resource: ObservationResource
  readonly platform: RuntimePlatform
  readonly content: 'none' | 'metadata'
  readonly minimumLevel: LogLevel
  readonly redactors: readonly ContentRedactor[]
  readonly includeErrorStacks: boolean
  isClosed(): boolean
  capture(event: ObservationEvent): { readonly status: 'accepted' | 'rejected' | 'disabled' }
  integration(outcome: 'accepted' | 'filtered' | 'rejected'): void
}

export { CLOSED_RUNTIME_LOGGER } from '../../logging/types.ts'

export function createRuntimeLogger(target: RuntimeLoggerTarget, context: RuntimeLoggerContext = {}): SdkLogger {
  return createLogger(target, context)
}

/** Internal capability instrumentation reuses the runtime's captured clock/entropy source. */
export function runtimePlatformForLogger(logger: SdkLogger): RuntimePlatform | undefined {
  return capturedRuntimePlatformForLogger(logger)
}

/** Internal run binding; public RuntimeLoggerContext deliberately cannot provide correlation IDs. */
export function createCorrelatedRuntimeLogger(
  target: RuntimeLoggerTarget,
  correlation: CorrelationContext,
  context: RuntimeLoggerContext = {},
): SdkLogger {
  return createLogger(target, context, deepFreeze({ ...correlation }))
}

function createLogger(
  target: RuntimeLoggerTarget, context: RuntimeLoggerContext,
  fixedCorrelation?: CorrelationContext,
): SdkLogger {
  const source = objectValue(context)
  const keys = Reflect.ownKeys(source)
  if (keys.some(key => typeof key !== 'string' || (key !== 'scope'
    && key !== 'fields'))) throw new TypeError('Invalid runtime logger context')
  const rawScope = ownData(source, 'scope', false), rawFields = ownData(source, 'fields', false)
  const scope = rawScope === undefined ? undefined : boundedText(rawScope, RUNTIME_LOG_LIMITS.scopeBytes)
  const fields = safeFields((rawFields ?? {}) as Readonly<JsonObject>, target)
  const origin = target.platform.monotonicNow()
  let sequence = 1
  const correlation = fixedCorrelation ?? deepFreeze<CorrelationContext>({
    traceId: target.platform.randomHex(16) as CorrelationContext['traceId'],
    spanId: target.platform.randomHex(8) as CorrelationContext['spanId'],
    parentSpanId: null,
    runId: target.platform.randomHex(16),
  })
  const nextSequence = (): number => {
    if (!Number.isSafeInteger(sequence)) throw new RangeError('Runtime logger sequence exhausted')
    return sequence++
  }
  return new RuntimeBoundLogger({ target, correlation, origin, nextSequence, scope, bound: fields })
}

interface RuntimeBoundLoggerInput {
  readonly target: RuntimeLoggerTarget
  readonly correlation: CorrelationContext
  readonly origin: number
  readonly nextSequence: () => number
  readonly scope: string | undefined
  readonly bound: Readonly<JsonObject>
}

function validateMessage(message: string): void {
  if (typeof message !== 'string'
    || message.length > RUNTIME_LOG_LIMITS.messageCharacters) throw new TypeError('Invalid runtime log message')
}

function logPriority(level: LogLevel): ObservationEvent['priority'] {
  if (level === 'trace' || level === 'debug') return 'verbose'
  if (level === 'error' || level === 'fatal') return 'critical'
  return 'normal'
}

class RuntimeBoundLogger implements SdkLogger {
  private readonly target: RuntimeLoggerTarget
  private readonly correlation: CorrelationContext
  private readonly origin: number
  private readonly nextSequence: () => number
  private readonly scope: string | undefined
  private readonly bound: Readonly<JsonObject>

  constructor(input: RuntimeBoundLoggerInput) {
    this.target = input.target
    this.correlation = input.correlation
    this.origin = input.origin
    this.nextSequence = input.nextSequence
    this.scope = input.scope
    this.bound = input.bound
    bindRuntimeLoggerPlatform(this, input.target.platform)
  }

  child(fields: Readonly<JsonObject>): SdkLogger {
    if (this.target.isClosed()) return this
    return new RuntimeBoundLogger({ target: this.target, correlation: this.correlation, origin: this.origin,
      nextSequence: this.nextSequence, scope: this.scope,
      bound: safeFields({ ...this.bound, ...cloneJsonObject(fields) }, this.target) })
  }
  trace(message: string, fields?: Readonly<JsonObject>): void { this.write('trace', message, fields) }
  debug(message: string, fields?: Readonly<JsonObject>): void { this.write('debug', message, fields) }
  info(message: string, fields?: Readonly<JsonObject>): void { this.write('info', message, fields) }
  warn(message: string, fields?: Readonly<JsonObject>): void { this.write('warn', message, fields) }
  error(message: string, fields?: Readonly<JsonObject>): void { this.write('error', message, fields) }
  fatal(message: string, fields?: Readonly<JsonObject>): void { this.write('fatal', message, fields) }

  private write(level: LogLevel, message: string, fields: Readonly<JsonObject> = {}): void {
    if (this.target.isClosed()) return
    validateMessage(message)
    const merged = safeFields({ ...this.bound, ...cloneJsonObject(fields) }, this.target)
    let integration = false
    try { integration = validateIntegrationEvidence(merged) }
    catch (error) { this.target.integration('rejected'); throw error }
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[this.target.minimumLevel]) {
      if (integration) this.target.integration('filtered')
      return
    }
    const priority = logPriority(level)
    const result = this.target.capture(deepFreeze({
      schemaVersion: 1, eventId: this.target.platform.randomHex(16), sequence: this.nextSequence(), name: 'sdk.log',
        phase: 'point',
      occurredAt: new Date(this.target.platform.wallNow()).toISOString(),
      monotonicMs: Math.max(0, this.target.platform.monotonicNow() - this.origin), priority,
      resource: this.target.resource, correlation: this.correlation,
      data: { level, message: redactInlineSecrets(message),
        ...(this.scope === undefined ? {} : { scope: this.scope }), fields: merged },
    }))
    if (integration) this.target.integration(result.status === 'accepted' ? 'accepted' : 'rejected')
  }
}

function safeFields(
  fields: Readonly<JsonObject>,
  target: Pick<RuntimeLoggerTarget, 'content' | 'redactors' | 'includeErrorStacks'>,
): Readonly<JsonObject> {
  const cloned = cloneJsonObject(fields)
  const wrapped = sanitizeObservationData({ fields: cloned }, target)
  return wrapped.fields as Readonly<JsonObject>
}
