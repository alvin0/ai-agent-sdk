import type { ResolvedTurnBounds, TurnBounds } from '../types.ts'
import { type RunTurnOptions } from './types.ts'

export const DEFAULT_BOUNDS: TurnBounds = Object.freeze({
  // Nothing that counts work stops a turn by default. Hosts opt in to each ceiling.
  maxSteps: 'auto',
  maxToolCalls: 'auto',
  // Halfway, a quarter left, and nearly gone. Three notices, spaced so the
  // first is still early enough to change the plan and the last is impossible
  // to ignore.
  toolBudgetRemindAt: Object.freeze([32, 16, 6]),
  onExhausted: 'force-final-answer',
  maxConsecutiveToolErrors: 'auto',
  consecutiveToolErrorWarningAt: 4,
  repeatToolWarningAt: 3,
  repeatToolLimit: 'auto',
  toolCycleWarningAt: 2,
  toolCycleLimit: 'auto',
  maxToolCycleLength: 4,
  maxTotalTokens: 'auto',
  finalReportReserveTokens: 0,
  finalizeSteps: 0,
  maxTurnDurationMs: 'auto',
  maxParallel: 8,
  maxToolResultBytes: 4 * 1024 * 1024,
  // Codex's own default for a shell call. Large enough for a real build log,
  // small enough that a handful of them cannot spend a context window.
  maxToolResultTokens: 10_000,
  toolResultOverflow: 'auto',
  maxToolDurationMs: 'auto',
  toolTeardownTimeoutMs: 30_000,
})
function validateTokenBounds(bounds: TurnBounds): void {
  if (bounds.maxTotalTokens !== 'auto' && (!Number.isSafeInteger(bounds.maxTotalTokens) || bounds.maxTotalTokens < 1)) {
    throw new RangeError("maxTotalTokens must be a positive safe integer or 'auto'")
  }
  if (!Number.isSafeInteger(bounds.finalReportReserveTokens) || bounds.finalReportReserveTokens < 0
    || (bounds.maxTotalTokens !== 'auto' && bounds.finalReportReserveTokens >= bounds.maxTotalTokens)) {
    throw new RangeError('finalReportReserveTokens must be a non-negative safe integer below maxTotalTokens')
  }
}

function validateAutomaticBound(value: number | 'auto', name: string): void {
  if (value !== 'auto' && (!Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError(`${name} must be a positive safe integer or 'auto'`)
  }
}

function validateStepBounds(bounds: TurnBounds): void {
  if (!Number.isSafeInteger(bounds.finalizeSteps) || bounds.finalizeSteps < 0 || bounds.finalizeSteps > 8) {
    throw new RangeError('finalizeSteps must be a safe integer from 0 to 8')
  }
}

const UNLIMITED_KEYS = ['maxToolCalls', 'maxConsecutiveToolErrors', 'repeatToolLimit', 'toolCycleLimit',
  'maxToolDurationMs'] as const

function numericLimit(value: number | 'auto'): number { return value === 'auto' ? Infinity : value }

function validateLoopLimits(bounds: TurnBounds): void {
  if (numericLimit(bounds.repeatToolLimit) < bounds.repeatToolWarningAt) {
    throw new RangeError('repeatToolLimit must be >= repeatToolWarningAt')
  }
  if (numericLimit(bounds.toolCycleLimit) < bounds.toolCycleWarningAt) {
    throw new RangeError('toolCycleLimit must be >= toolCycleWarningAt')
  }
}

export function resolveBounds(input: Partial<TurnBounds> | undefined): ResolvedTurnBounds {
  const bounds = { ...DEFAULT_BOUNDS, ...input }
  validateTokenBounds(bounds)
  validateAutomaticBound(bounds.maxTurnDurationMs, 'maxTurnDurationMs')
  validateStepBounds(bounds)
  validateAutomaticBound(bounds.maxSteps, 'maxSteps')
  for (const key of UNLIMITED_KEYS) validateAutomaticBound(bounds[key], key)
  if (bounds.maxToolDurationMs !== 'auto') timerMs(bounds.maxToolDurationMs, 'maxToolDurationMs')
  for (const key of [
    'consecutiveToolErrorWarningAt', 'repeatToolWarningAt', 'toolCycleWarningAt', 'maxToolCycleLength',
    'maxParallel', 'maxToolResultBytes', 'maxToolResultTokens', 'toolTeardownTimeoutMs',
  ] as const) {
    if (!Number.isSafeInteger(bounds[key])
      || bounds[key] < 1) throw new RangeError(`${key} must be a positive safe integer`)
  }
  if (!['auto', 'truncate', 'spill'].includes(bounds.toolResultOverflow)) {
    throw new RangeError("toolResultOverflow must be 'auto', 'truncate', or 'spill'")
  }
  if (!['force-final-answer', 'stop', 'continue'].includes(bounds.onExhausted)) {
    throw new RangeError("onExhausted must be 'force-final-answer', 'stop', or 'continue'")
  }
  validateLoopLimits(bounds)
  if (!Array.isArray(bounds.toolBudgetRemindAt)
    || bounds.toolBudgetRemindAt.some(value => !Number.isSafeInteger(value) || value < 1)) {
    // Out-of-range thresholds are dropped rather than rejected, but a
    // fractional or negative one is a mistake worth naming: silently ignoring
    // `0.25` would leave a host believing it had asked for a reminder.
    throw new RangeError('toolBudgetRemindAt must contain only positive safe integers')
  }
  return Object.freeze({ ...bounds, ...Object.fromEntries(UNLIMITED_KEYS.map(key =>
    [key, numericLimit(bounds[key])])) } as ResolvedTurnBounds)
}
export function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}
/** Timers clamp delays above 2^31-1 ms to 1 ms, so a long opt-in deadline must stay in range. */
export function timerMs(value: number, name: string): number {
  positiveFinite(value, name)
  if (value > 2_147_483_647) throw new RangeError(`${name} must not exceed 2147483647ms`)
  return value
}
export function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}
function snapshotRunConfiguration(options: RunTurnOptions): RunTurnOptions['config'] {
  return Object.freeze({
    provider: options.config.provider,
    model: options.config.model,
    ...(options.config.reasoningEffort === undefined ? {} : { reasoningEffort: options.config.reasoningEffort }),
    ...(options.config.temperature === undefined ? {} : { temperature: options.config.temperature }),
    ...(options.config.topP === undefined ? {} : { topP: options.config.topP }),
    ...(options.config.maxTokens === undefined ? {} : { maxTokens: options.config.maxTokens }),
    ...(options.config.contextWindow === undefined ? {} : { contextWindow: options.config.contextWindow }),
    ...(options.config.inputModalities === undefined ? {} : {
      inputModalities: Object.freeze([...options.config.inputModalities]),
    }),
    ...(options.config.stop === undefined ? {} : { stop: Object.freeze([...options.config.stop]) }),
  })
}

export function snapshotRunTurnOptions(options: RunTurnOptions): RunTurnOptions {
  const config = snapshotRunConfiguration(options)
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
