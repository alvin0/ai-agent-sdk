import { runAgent } from '../mode/run-agent.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { AgentInvocationOptions, AgentSession } from './session.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { UserInputBroker } from '../mode/user-input.ts'


function optional(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value }
}

type SessionDefinitionHost = Pick<AgentSession,
  'definition' | 'options' | 'runtimeLimits' | 'history' | 'activeAdditionalInstructions'
  | 'currentConversationId' | 'contextSections' | 'combinedHooks' | 'effectiveCatalog'
  | 'callConfig' | 'systemInstructions'>

function sessionBounds(host: SessionDefinitionHost): Record<string, unknown> {
  const limits = host.runtimeLimits
  return {
    maxToolCalls: host.definition.maxToolCalls,
    ...optional('maxParallel', limits.maxParallelToolCalls),
    ...optional('maxConsecutiveToolErrors', limits.maxConsecutiveToolErrors),
    ...optional('repeatToolWarningAt', limits.repeatToolWarningAt),
    ...optional('repeatToolLimit', limits.repeatToolLimit),
    ...optional('toolCycleWarningAt', limits.toolCycleWarningAt),
    ...optional('toolCycleLimit', limits.toolCycleLimit),
    ...optional('onExhausted', limits.onExhausted),
    ...optional('maxToolResultTokens', limits.maxToolResultTokens),
    ...optional('toolResultOverflow', limits.toolResultOverflow),
    ...optional('maxToolCycleLength', limits.maxToolCycleLength),
    ...optional('finalReportReserveTokens', limits.finalReportReserveTokens),
    ...optional('finalizeSteps', limits.finalizeSteps),
    ...optional('maxTurnDurationMs', limits.maxTurnDurationMs),
    ...optional('maxTotalTokens', limits.maxTotalTokens),
    ...optional('maxToolResultBytes', limits.maxToolResultBytes),
    ...optional('maxToolDurationMs', limits.maxToolDurationMs),
    ...optional('toolTeardownTimeoutMs', limits.toolTeardownTimeoutMs),
  }
}

function sessionCommon(
  host: SessionDefinitionHost,
  invocation: AgentInvocationOptions,
  accounting: RunAccountingPort | undefined,
) {
  const definition = host.definition
  const catalog = host.effectiveCatalog()
  const outputFormat = invocation.outputFormat ?? definition.outputFormat
  const limits = host.runtimeLimits
  return {
    registry: host.options.registry,
    config: host.callConfig(invocation), history: host.history,
    ...optional('tools', catalog),
    ...(definition.nativeTools.length === 0 ? {} : { nativeTools: definition.nativeTools }),
    ...optional('toolChoice', definition.toolChoice),
    ...optional('imagePolicy', invocation.imagePolicy),
    ...optional('documentPolicy', invocation.documentPolicy),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    ...optional('validateOutput', invocation.validateOutput),
    system: host.systemInstructions(host.activeAdditionalInstructions), maxTurns: definition.maxTurns,
    bounds: sessionBounds(host), commentary: definition.commentary,
    ...optional('teardownTimeoutMs', limits.teardownTimeoutMs),
    ...optional('modelTimeoutMs', limits.modelTimeoutMs),
    ...optional('maxModelRequestBytes', limits.maxModelRequestBytes),
    ...optional('maxModelResponseBytes', limits.maxModelResponseBytes),
    ...optional('maxModelStreamEvents', limits.maxModelStreamEvents),
    ...optional('hookTimeoutMs', limits.hookTimeoutMs),
    ...optional('hookTeardownTimeoutMs', limits.hookTeardownTimeoutMs),
    ...optional('approvals', host.options.approvals),
    ...optional('spillStore', host.options.spillStore),
    ...optional('experimentalPrograms', host.options.experimentalPrograms),
    ...optional('interceptors', host.options.interceptors),
    ...optional('contextSections', host.contextSections),
    ...optional('hooks', host.combinedHooks(accounting)),
    ...optional('signal', invocation.signal),
    ...optional('accounting', accounting),
    ...optional('logger', accounting?.modelInvocation.logger),
    trace: {
      ...host.options.trace, conversationId: host.currentConversationId,
      agentId: definition.id, agentName: definition.name,
    },
  }
}

export function runSessionDefinition(
  host: SessionDefinitionHost,
  invocation: AgentInvocationOptions,
  accounting?: RunAccountingPort,
): AsyncIterable<AgentRunEvent> {
  const common = sessionCommon(host, invocation, accounting)
  const { definition } = host
  if (definition.mode === 'deep-human-in-loop') {
    return runAgent({ ...common, mode: definition.mode, userInput: host.options.userInput as UserInputBroker,
      ...optional('userInputTimeoutMs', host.runtimeLimits.userInputTimeoutMs) })
  }
  if (definition.mode === 'deep') {
    return runAgent({ ...common, mode: definition.mode,
      ...optional('userInput', host.options.userInput),
      ...optional('userInputTimeoutMs', host.runtimeLimits.userInputTimeoutMs) })
  }
  return runAgent({ ...common, mode: 'basic' })
}
