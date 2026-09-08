import type { TurnBounds } from '../types.ts'
import { type RunTurnOptions } from './types.ts'

export const DEFAULT_BOUNDS: TurnBounds = Object.freeze({
  maxSteps: 16,
  maxToolCalls: 64,
  // Halfway, a quarter left, and nearly gone. Three notices, spaced so the
  // first is still early enough to change the plan and the last is impossible
  // to ignore.
  toolBudgetRemindAt: Object.freeze([32, 16, 6]),
  onExhausted: 'force-final-answer',
  maxConsecutiveToolErrors: 8,
  repeatToolWarningAt: 3,
  repeatToolLimit: 6,
  toolCycleWarningAt: 2,
  toolCycleLimit: 3,
  maxToolCycleLength: 4,
  maxTotalTokens: 'auto',
  finalReportReserveTokens: 0,
  maxParallel: 8,
  maxToolResultBytes: 4 * 1024 * 1024,
  // Codex's own default for a shell call. Large enough for a real build log,
  // small enough that a handful of them cannot spend a context window.
  maxToolResultTokens: 10_000,
  toolResultOverflow: 'auto',
  maxToolDurationMs: 10 * 60_000,
  toolTeardownTimeoutMs: 30_000,
})
export function resolveBounds(input: Partial<TurnBounds> | undefined): TurnBounds {
  const bounds = { ...DEFAULT_BOUNDS, ...input }
  if (bounds.maxTotalTokens !== 'auto' && (!Number.isSafeInteger(bounds.maxTotalTokens) || bounds.maxTotalTokens < 1)) {
    throw new RangeError("maxTotalTokens must be a positive safe integer or 'auto'")
  }
  if (!Number.isSafeInteger(bounds.finalReportReserveTokens) || bounds.finalReportReserveTokens < 0
    || (bounds.maxTotalTokens !== 'auto' && bounds.finalReportReserveTokens >= bounds.maxTotalTokens)) {
    throw new RangeError('finalReportReserveTokens must be a non-negative safe integer below maxTotalTokens')
  }
  if (bounds.maxSteps !== 'auto' && (!Number.isSafeInteger(bounds.maxSteps) || bounds.maxSteps < 1)) {
    throw new RangeError("maxSteps must be a positive safe integer or 'auto'")
  }
  for (const key of [
    'maxToolCalls', 'maxConsecutiveToolErrors', 'repeatToolWarningAt',
    'repeatToolLimit', 'toolCycleWarningAt', 'toolCycleLimit', 'maxToolCycleLength',
    'maxParallel', 'maxToolResultBytes', 'maxToolResultTokens',
    'maxToolDurationMs',
    'toolTeardownTimeoutMs',
  ] as const) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1) throw new RangeError(`${key} must be a positive safe integer`)
  }
  if (!['auto', 'truncate', 'spill'].includes(bounds.toolResultOverflow)) {
    throw new RangeError("toolResultOverflow must be 'auto', 'truncate', or 'spill'")
  }
  if (!['force-final-answer', 'stop', 'continue'].includes(bounds.onExhausted)) {
    throw new RangeError("onExhausted must be 'force-final-answer', 'stop', or 'continue'")
  }
  if (bounds.repeatToolLimit < bounds.repeatToolWarningAt) throw new RangeError('repeatToolLimit must be >= repeatToolWarningAt')
  if (bounds.toolCycleLimit < bounds.toolCycleWarningAt) {
    throw new RangeError('toolCycleLimit must be >= toolCycleWarningAt')
  }
  if (!Array.isArray(bounds.toolBudgetRemindAt)
    || bounds.toolBudgetRemindAt.some(value => !Number.isSafeInteger(value) || value < 1)) {
    // Out-of-range thresholds are dropped rather than rejected, but a
    // fractional or negative one is a mistake worth naming: silently ignoring
    // `0.25` would leave a host believing it had asked for a reminder.
    throw new RangeError('toolBudgetRemindAt must contain only positive safe integers')
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
