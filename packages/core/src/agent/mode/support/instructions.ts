import { AGENT_CONTROL_TOOLS  } from '../control-tools.ts'
import { type AgentMode } from '../run-agent.ts'

export function modeSystem(mode: AgentMode, canAskUser: boolean): string {
  if (mode === 'basic') return [
    'Work as a bounded tool-using agent. Use available tools proactively when they materially improve correctness.',
    'Stay within the configured iteration budget, then give the best final answer supported by the gathered results.',
  ].join(' ')
  const ask = canAskUser
    ? `If a missing fact or material user choice blocks correct progress, call `
      + `${AGENT_CONTROL_TOOLS.requestUserInput} and continue after the answer.`
    : 'If blocked by missing user input, state that limitation plainly in the final response.'
  const hil = mode === 'deep-human-in-loop'
    ? 'For material choices, surface 2-3 concise options with the recommended option first; '
      + 'the UI also permits free-form feedback.'
    : ''
  return [
    'Work autonomously in deep mode. After every tool result, compare the evidence against the user objective '
      + 'and all constraints; continue until gaps are closed.',
    `Do not treat a plausible draft as completion. When the work is actually complete, call `
      + `${AGENT_CONTROL_TOOLS.complete} `
      + 'with a summary and concrete evidence, then provide the final answer.',
    'Put verification summaries and evidence in the self-check tool call. Deliver the current user or '
      + 'assigned task\'s requested answer or artifact in its requested format, including exact text or JSON. '
      + 'Add verification commentary only when that format permits it.',
    ask, hil,
    'Never reveal private chain-of-thought. Use concise user-visible commentary for intent, progress, '
      + 'observations, and decisions.',
  ].filter(Boolean).join(' ')
}

export function joinSystem(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join('\n\n')
}
