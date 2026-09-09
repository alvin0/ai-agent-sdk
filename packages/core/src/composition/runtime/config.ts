import type { DeliveryMode } from '../../observation/index.ts'
import type { LogLevel } from '../../logging/types.ts'
import { timeoutValue } from '../../platform/config.ts'
import { objectValue, optionalAbortSignal, ownData } from '../common/data.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import type { RuntimeObservationResourceInput, RuntimeOwnerObservabilityOptions, RuntimeOwnerOptions } from './types.ts'
import { captureOpenSpan, captureProcessors, captureRedactors } from '../observation/extensions.ts'

export const RUNTIME_OWNER_DEFAULTS = Object.freeze({ startupTimeoutMs: 30_000, closeTimeoutMs: 30_000 })
const ROOT_KEYS = new Set(['providers', 'defaultProvider', 'signal', 'resource', 'observability',
  'closeTimeoutMs', 'startupTimeoutMs', 'diagnosticMaxEvents', 'diagnosticMaxBytes'])
const OBSERVABILITY_KEYS = new Set(['mode', 'content', 'minimumLogLevel', 'exporters', 'maxQueueEvents',
  'maxQueueBytes', 'maxBatchEvents', 'maxBatchBytes', 'flushTimeoutMs', 'shutdownTimeoutMs',
  'processors', 'redactors', 'includeErrorStacks', 'openSpan'])
const MODES = new Set<unknown>(['operational', 'reliable', 'audit'] satisfies DeliveryMode[])
const LEVELS = new Set<unknown>(['trace', 'debug', 'info', 'warn', 'error', 'fatal'] satisfies LogLevel[])

export interface CapturedRuntimeOwnerOptions extends RuntimeOwnerOptions {
  readonly closeTimeoutMs: number
  readonly startupTimeoutMs: number
  readonly observability: RuntimeOwnerObservabilityOptions & {
    readonly mode: DeliveryMode
    readonly exporters: readonly import('../exporter/types.ts').RuntimeObservationExporterRegistration[]
  }
}

function optional(source: object, key: string): unknown { return ownData(source, key, false) }
function ownKeys(source: object, allowed: ReadonlySet<string>): void {
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('Runtime options contain unsupported fields')
  }
}
function optionalPositive(source: object, key: string): number | undefined {
  const value = optional(source, key)
  return value === undefined ? undefined : timeoutValue(value as number)
}

/** Capture option data once without invoking getters; executable capability capture follows identity preflight. */
export function captureRuntimeOwnerOptions(input: unknown): CapturedRuntimeOwnerOptions {
  const source = objectValue(input)
  ownKeys(source, ROOT_KEYS)
  const observabilityValue = optional(source, 'observability')
  const observation = observabilityValue === undefined ? {} : objectValue(observabilityValue)
  ownKeys(observation, OBSERVABILITY_KEYS)
  const mode = optional(observation, 'mode') ?? 'operational'
  const content = optional(observation, 'content')
  const minimumLogLevel = optional(observation, 'minimumLogLevel')
  const includeErrorStacks = optional(observation, 'includeErrorStacks')
  if (!MODES.has(mode)) throw new TypeError('Invalid observation delivery mode')
  if (content !== undefined && content !== 'none' && content !== 'metadata') throw new TypeError('Invalid observation content policy')
  if (minimumLogLevel !== undefined && !LEVELS.has(minimumLogLevel)) throw new TypeError('Invalid minimum log level')
  if (includeErrorStacks !== undefined && typeof includeErrorStacks !== 'boolean') throw new TypeError('Invalid error-stack policy')
  const exporters = (optional(observation, 'exporters') ?? []) as readonly RuntimeObservationExporterRegistration[]
  const processors = captureProcessors(optional(observation, 'processors'))
  const redactors = captureRedactors(optional(observation, 'redactors'))
  const openSpan = captureOpenSpan(observation, optional(observation, 'openSpan'))
  const defaultProvider = optional(source, 'defaultProvider')
  const signal = optionalAbortSignal(optional(source, 'signal'))
  const resource = optional(source, 'resource')
  const capturedObservation = Object.freeze({ mode: mode as DeliveryMode, exporters,
    ...(content === undefined ? {} : { content: content as 'none' | 'metadata' }),
    ...(minimumLogLevel === undefined ? {} : { minimumLogLevel: minimumLogLevel as LogLevel }),
    ...(processors.length === 0 ? {} : { processors }),
    ...(redactors.length === 0 ? {} : { redactors }),
    ...(includeErrorStacks === undefined ? {} : { includeErrorStacks }),
    ...(openSpan === undefined ? {} : { openSpan }),
    ...copyPositive(observation, ['maxQueueEvents', 'maxQueueBytes', 'maxBatchEvents', 'maxBatchBytes',
      'flushTimeoutMs', 'shutdownTimeoutMs']),
  })
  return Object.freeze({ providers: ownData(source, 'providers') as RuntimeOwnerOptions['providers'],
    ...(defaultProvider === undefined ? {} : { defaultProvider: defaultProvider as string }),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
    ...(resource === undefined ? {} : { resource: resource as RuntimeObservationResourceInput }),
    observability: capturedObservation,
    closeTimeoutMs: optionalPositive(source, 'closeTimeoutMs') ?? RUNTIME_OWNER_DEFAULTS.closeTimeoutMs,
    startupTimeoutMs: optionalPositive(source, 'startupTimeoutMs') ?? RUNTIME_OWNER_DEFAULTS.startupTimeoutMs,
    ...copyPositive(source, ['diagnosticMaxEvents', 'diagnosticMaxBytes']),
  })
}

function copyPositive(source: object, keys: readonly string[]): Record<string, number> {
  const output: Record<string, number> = Object.create(null) as Record<string, number>
  for (const key of keys) {
    const value = optionalPositive(source, key)
    if (value !== undefined) output[key] = value
  }
  return output
}

export function captureCloseSignal(input: unknown): AbortSignal | undefined {
  if (input === undefined) return undefined
  const source = objectValue(input)
  ownKeys(source, new Set(['signal']))
  return optionalAbortSignal(optional(source, 'signal'))
}
