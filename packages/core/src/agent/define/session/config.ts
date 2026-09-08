import { type AgentRuntimeLimits } from './types.ts'
import { timeoutValue } from '../../../platform/config.ts'

export function resolveRuntimeLimits(input: AgentRuntimeLimits | undefined): Readonly<AgentRuntimeLimits> {
  if (input === undefined) return Object.freeze({})
  const values = { ...input }
  for (const key of [
    'teardownTimeoutMs', 'modelTimeoutMs', 'maxModelRequestBytes',
    'maxModelResponseBytes', 'maxModelStreamEvents', 'maxToolResultBytes',
    'maxToolDurationMs', 'toolTeardownTimeoutMs', 'maxParallelToolCalls',
    'maxConsecutiveToolErrors', 'repeatToolWarningAt', 'repeatToolLimit',
    'toolCycleWarningAt', 'toolCycleLimit', 'maxToolCycleLength', 'maxToolResultTokens',
    'maxTotalTokens',
    'hookTimeoutMs', 'hookTeardownTimeoutMs', 'memoryOperationTimeoutMs',
    'observerTimeoutMs',
  ] as const) {
    const value = values[key]
    if (value !== undefined && key.endsWith('Ms')) timeoutValue(value)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`agent runtimeLimits.${key} must be a positive safe integer`)
    }
  }
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
  if ((values.repeatToolLimit ?? 6) < (values.repeatToolWarningAt ?? 3)) {
    throw new RangeError('agent runtimeLimits.repeatToolLimit must be >= repeatToolWarningAt')
  }
  if ((values.toolCycleLimit ?? 3) < (values.toolCycleWarningAt ?? 2)) {
    throw new RangeError('agent runtimeLimits.toolCycleLimit must be >= toolCycleWarningAt')
  }
  return Object.freeze(values)
}
