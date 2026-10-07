import { type AgentRuntimeLimits, type AgentSessionOptions } from './types.ts'
import { History } from '../../history/history.ts'
import { timeoutValue } from '../../../platform/config.ts'

export function resolveRuntimeLimits(input: AgentRuntimeLimits | undefined): Readonly<AgentRuntimeLimits> {
  if (input === undefined) return Object.freeze({})
  const values = { ...input }
  validateTokenBudget(values)
  validateFinalizationBudget(values)
  validateRunTimeouts(values)
  validateNumericLimits(values)
  validateLimitModes(values)
  validateRepeatLimits(values)
  return Object.freeze(values)
}

function validateTokenBudget(values: AgentRuntimeLimits): void {
  if (values.maxTotalTokens !== undefined && values.maxTotalTokens !== 'auto'
    && (!Number.isSafeInteger(values.maxTotalTokens) || values.maxTotalTokens < 1)) {
    throw new RangeError("agent runtimeLimits.maxTotalTokens must be a positive safe integer or 'auto'")
  }
}

function validateFinalizationBudget(values: AgentRuntimeLimits): void {
  if (values.finalReportReserveTokens !== undefined
    && (!Number.isSafeInteger(values.finalReportReserveTokens) || values.finalReportReserveTokens < 0
      || (typeof values.maxTotalTokens === 'number' && values.finalReportReserveTokens >= values.maxTotalTokens))) {
    throw new RangeError(
      'agent runtimeLimits.finalReportReserveTokens must be a non-negative safe integer below maxTotalTokens',
    )
  }
  if (values.finalizeSteps !== undefined
    && (!Number.isSafeInteger(values.finalizeSteps) || values.finalizeSteps < 0 || values.finalizeSteps > 8)) {
    throw new RangeError('agent runtimeLimits.finalizeSteps must be a safe integer from 0 to 8')
  }
}

function validateRunTimeouts(values: AgentRuntimeLimits): void {
  if (values.maxTurnDurationMs !== undefined && values.maxTurnDurationMs !== 'auto'
    && (!Number.isSafeInteger(values.maxTurnDurationMs) || values.maxTurnDurationMs < 1)) {
    throw new RangeError("agent runtimeLimits.maxTurnDurationMs must be a positive safe integer or 'auto'")
  }
  if (values.userInputTimeoutMs !== undefined
    && (!Number.isSafeInteger(values.userInputTimeoutMs) || values.userInputTimeoutMs < 1)) {
    throw new RangeError('agent runtimeLimits.userInputTimeoutMs must be a positive safe integer')
  }
}

function validateNumericLimits(values: AgentRuntimeLimits): void {
  for (const key of [
    'teardownTimeoutMs', 'modelTimeoutMs', 'maxModelRequestBytes',
    'maxModelResponseBytes', 'maxModelStreamEvents', 'maxToolResultBytes',
    'maxToolDurationMs', 'toolTeardownTimeoutMs', 'maxParallelToolCalls',
    'maxConsecutiveToolErrors', 'repeatToolWarningAt', 'repeatToolLimit',
    'toolCycleWarningAt', 'toolCycleLimit', 'maxToolCycleLength', 'maxToolResultTokens',
    'hookTimeoutMs', 'hookTeardownTimeoutMs', 'memoryOperationTimeoutMs',
    'observerTimeoutMs',
  ] as const) {
    const value = values[key]
    if (value !== undefined && key.endsWith('Ms')) timeoutValue(value)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`agent runtimeLimits.${key} must be a positive safe integer`)
    }
  }
}

function validateLimitModes(values: AgentRuntimeLimits): void {
  if (values.toolResultOverflow !== undefined
    && !['auto', 'truncate', 'spill'].includes(values.toolResultOverflow)) {
    throw new RangeError(
      "agent runtimeLimits.toolResultOverflow must be 'auto', 'truncate', or 'spill'",
    )
  }
  if (values.onExhausted !== undefined
    && !['force-final-answer', 'stop', 'continue'].includes(values.onExhausted)) {
    throw new RangeError(
      "agent runtimeLimits.onExhausted must be 'force-final-answer', 'stop', or 'continue'",
    )
  }
}

function validateRepeatLimits(values: AgentRuntimeLimits): void {
  if ((values.repeatToolLimit ?? 6) < (values.repeatToolWarningAt ?? 3)) {
    throw new RangeError('agent runtimeLimits.repeatToolLimit must be >= repeatToolWarningAt')
  }
  if ((values.toolCycleLimit ?? 3) < (values.toolCycleWarningAt ?? 2)) {
    throw new RangeError('agent runtimeLimits.toolCycleLimit must be >= toolCycleWarningAt')
  }
}

export function normalizeSessionOptions(options: AgentSessionOptions): AgentSessionOptions {
  const historyLimits = freezeObject(options.historyLimits)
  if (options.history !== undefined && historyLimits !== undefined) void new History(historyLimits)
  const compaction = options.compaction === false ? false : freezeObject(options.compaction)
  const trace = freezeObject(options.trace)
  const team = freezeObject(options.team)
  const ledgerLimits = freezeObject(options.ledgerLimits)
  const eventBufferLimits = freezeObject(options.eventBufferLimits)
  return Object.freeze({
    ...options,
    ...optional('historyLimits', historyLimits), ...optional('compaction', compaction),
    ...optional('trace', trace), ...optional('team', team), ...optional('ledgerLimits', ledgerLimits),
    ...optional('eventBufferLimits', eventBufferLimits),
    ...(options.skills === undefined ? {} : { skills: Object.freeze([...options.skills]) }),
    ...(Array.isArray(options.tools) ? { tools: Object.freeze([...options.tools]) } : {}),
    ...(options.interceptors === undefined ? {} : { interceptors: Object.freeze([...options.interceptors]) }),
  })
}

function freezeObject<T extends object>(value: T | undefined): Readonly<T> | undefined {
  return value === undefined ? undefined : Object.freeze({ ...value })
}

function optional(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value }
}
