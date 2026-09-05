import type { TurnBounds } from '../types.ts'
import { type RunTurnOptions } from './types.ts'

export const DEFAULT_BOUNDS: TurnBounds = Object.freeze({
  maxSteps: 16,
  maxToolCalls: 64,
  onExhausted: 'force-final-answer',
  maxConsecutiveToolErrors: 8,
  repeatToolWarningAt: 3,
  repeatToolLimit: 6,
  toolCycleWarningAt: 2,
  toolCycleLimit: 3,
  maxToolCycleLength: 4,
  maxTotalTokens: 500_000,
  maxParallel: 8,
  maxToolResultBytes: 4 * 1024 * 1024,
  maxToolDurationMs: 10 * 60_000,
  toolTeardownTimeoutMs: 30_000,
})
export function resolveBounds(input: Partial<TurnBounds> | undefined): TurnBounds {
  const bounds = { ...DEFAULT_BOUNDS, ...input }
  for (const key of [
    'maxSteps', 'maxToolCalls', 'maxConsecutiveToolErrors', 'repeatToolWarningAt',
    'repeatToolLimit', 'toolCycleWarningAt', 'toolCycleLimit', 'maxToolCycleLength',
    'maxTotalTokens', 'maxParallel', 'maxToolResultBytes', 'maxToolDurationMs',
    'toolTeardownTimeoutMs',
  ] as const) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1) throw new RangeError(`${key} must be a positive safe integer`)
  }
  if (bounds.repeatToolLimit < bounds.repeatToolWarningAt) throw new RangeError('repeatToolLimit must be >= repeatToolWarningAt')
  if (bounds.toolCycleLimit < bounds.toolCycleWarningAt) {
    throw new RangeError('toolCycleLimit must be >= toolCycleWarningAt')
  }
  return Object.freeze(bounds)
}
export function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}
export function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}
export function snapshotRunTurnOptions(options: RunTurnOptions): RunTurnOptions {
  const config = Object.freeze({
    provider: options.config.provider,
    model: options.config.model,
    ...(options.config.reasoningEffort === undefined ? {} : { reasoningEffort: options.config.reasoningEffort }),
    ...(options.config.temperature === undefined ? {} : { temperature: options.config.temperature }),
    ...(options.config.topP === undefined ? {} : { topP: options.config.topP }),
    ...(options.config.maxTokens === undefined ? {} : { maxTokens: options.config.maxTokens }),
    ...(options.config.stop === undefined ? {} : { stop: Object.freeze([...options.config.stop]) }),
  })
  return Object.freeze({
    ...options,
    config,
    ...(options.bounds === undefined ? {} : { bounds: Object.freeze({ ...options.bounds }) }),
    ...(options.nativeTools === undefined ? {} : { nativeTools: Object.freeze([...options.nativeTools]) }),
    ...(options.interceptors === undefined ? {} : { interceptors: Object.freeze([...options.interceptors]) }),
    ...(options.hooks === undefined ? {} : { hooks: Object.freeze({ ...options.hooks }) }),
    ...(options.trace === undefined ? {} : { trace: Object.freeze({ ...options.trace }) }),
  })
}
