import { AGENT_CONTROL_TOOLS } from './control-tools.ts'
import { UNCHANGED_ANSWER_MARKER } from '../loop/control-text.ts'
import type { RunTurnOptions } from '../loop/run-turn.ts'
import type { RunAgentOptions, AgentMode, DeepState } from './run-agent.ts'
import type { UserInputBroker } from './user-input.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import type { TurnHooks } from '../loop/types.ts'
import { createUserMessage } from '../../message/index.ts'

import { shieldControlTools } from './run-agent-support.ts'
import { joinSystem, modeSystem } from './run-agent-support.ts'

export type AgentTurnSetup = {
  options: RunAgentOptions; signal: AbortSignal; mode: AgentMode; deep: boolean
  broker: UserInputBroker | undefined; tools: ToolCatalog | undefined; hooks: TurnHooks | undefined
  state: DeepState; maxTurns: number | 'auto'
}

function optionalTurnProperty(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value }
}

export function buildAgentTurnOptions(setup: AgentTurnSetup): RunTurnOptions {
  const { options, signal, mode, deep, broker, tools, hooks, state, maxTurns } = setup
  return {
    registry: options.registry,
    config: options.config,
    history: options.history,
    ...optionalTurnProperty('tools', tools),
    ...optionalTurnProperty('nativeTools', options.nativeTools),
    ...optionalTurnProperty('toolChoice', options.toolChoice),
    ...optionalTurnProperty('imagePolicy', options.imagePolicy),
    ...optionalTurnProperty('documentPolicy', options.documentPolicy),
    ...optionalTurnProperty('validateOutput', options.validateOutput),
    ...optionalTurnProperty('outputFormat', options.outputFormat),
    system: joinSystem(options.system, modeSystem(mode, broker !== undefined)),
    ...optionalTurnProperty(
      'interceptors', options.interceptors === undefined ? undefined : shieldControlTools(options.interceptors),
    ),
    ...optionalTurnProperty('approvals', options.approvals),
    // Deep mode must confirm its answer; a budget that forces the answer on the
    // last step leaves two exempt-only steps to submit it rather than failing.
    bounds: { ...options.bounds, maxSteps: maxTurns,
      finalizeSteps: options.bounds?.finalizeSteps ?? (deep ? 2 : 0) },
    // A deep run must confirm its answer. When the budget forced that answer
    // before a submission, a short window lets the model submit it; only the
    // submission can run there, never more work or a question to a person.
    ...deep ? { finalize: {
      tools: [AGENT_CONTROL_TOOLS.complete],
      prompt: (forced: { readonly text: string }) => {
        if (state.completion !== undefined || state.userAborted) return undefined
        if (forced.text.trim() !== UNCHANGED_ANSWER_MARKER) {
          state.draftAnswer = forced.text
          state.draftSeq = options.history.entries().length
        }
        return createUserMessage({
          source: { kind: 'app', producer: 'deep-mode-self-check' },
          content: [{ type: 'text',
            text: `The work budget for this run is spent, and your answer above has no accepted self-check. `
              + `No research or work tool will run now; only ${AGENT_CONTROL_TOOLS.complete} can. `
              + `If the answer is supported by the evidence already gathered, call `
              + `${AGENT_CONTROL_TOOLS.complete} alone with that self-check, `
              + `stating any gaps honestly, then deliver the answer in its requested format. `
              + `If it is not supported, do not submit; your answer above stands as an unconfirmed result.` }],
        })
      },
      confirmed: () => state.completion !== undefined,
    } } : {},
    ...optionalTurnProperty('hooks', hooks),
    signal,
    ...optionalTurnProperty('logger', options.logger),
    commentary: options.commentary ?? 'auto',
    teardownTimeoutMs: options.teardownTimeoutMs ?? 30_000,
    ...optionalTurnProperty('modelTimeoutMs', options.modelTimeoutMs),
    ...optionalTurnProperty('maxModelRequestBytes', options.maxModelRequestBytes),
    ...optionalTurnProperty('maxModelResponseBytes', options.maxModelResponseBytes),
    ...optionalTurnProperty('maxModelStreamEvents', options.maxModelStreamEvents),
    ...optionalTurnProperty('hookTimeoutMs', options.hookTimeoutMs),
    ...optionalTurnProperty('hookTeardownTimeoutMs', options.hookTeardownTimeoutMs),
    ...optionalTurnProperty('trace', options.trace),
    ...optionalTurnProperty('accounting', options.accounting),
    ...optionalTurnProperty('spillStore', options.spillStore),
    ...optionalTurnProperty('experimentalPrograms', options.experimentalPrograms),
    ...optionalTurnProperty('contextSections', options.contextSections),
  }
}
