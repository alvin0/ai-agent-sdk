import { AGENT_CONTROL_TOOLS } from './control-tools.ts'
import type { JsonObject } from '../../primitives/index.ts'
import type { AgentRunEvent, CompletionSubmission, DeepState, RunAgentOptions } from './run-agent.ts'

import { completionFromResult } from './run-agent-support.ts'
import type { ToolCatalog } from '../tool/registry.ts'

export type AgentTurnProgress = {
  options: RunAgentOptions; state: DeepState; tools: ToolCatalog | undefined
  stepCalls: string[]; completionCandidate: CompletionSubmission | undefined
}

function invalidateCompletionAfterTool(progress: AgentTurnProgress): void {
  if (progress.state.completion !== undefined) progress.state.completionInvalidated = 'tool'
  progress.state.completion = undefined
  progress.state.unverifiedAnswers = 0
}

function isSubstantiveTool(
  event: Extract<AgentRunEvent, { type: 'tool-result' }>, progress: AgentTurnProgress,
): boolean {
  return event.dispatched !== false
    && event.call.toolName !== AGENT_CONTROL_TOOLS.complete
    && progress.tools?.get(event.call.toolName)?.completionExempt !== true
}

function recordCompletionCandidate(
  event: Extract<AgentRunEvent, { type: 'tool-result' }>, progress: AgentTurnProgress,
): void {
  if (event.call.toolName === AGENT_CONTROL_TOOLS.complete && !event.result.isError
    && (event.result.value as JsonObject | undefined)?.accepted === true) {
    progress.completionCandidate = completionFromResult(event.result.value)
  }
}

export function processAgentToolResult(
  event: Extract<AgentRunEvent, { type: 'tool-result' }>, progress: AgentTurnProgress,
): void {
  const performed = event.dispatched !== false
  if (performed) progress.stepCalls.push(event.call.toolName)
  if (isSubstantiveTool(event, progress)) invalidateCompletionAfterTool(progress)
  recordCompletionCandidate(event, progress)
}

export function processAgentTurnProgress(event: AgentRunEvent, progress: AgentTurnProgress): void {
  if (event.type === 'step-start') { progress.stepCalls = []; progress.completionCandidate = undefined; return }
  if (event.type === 'tool-result') { processAgentToolResult(event, progress); return }
  if (event.type !== 'step-end' || progress.completionCandidate === undefined
    || progress.stepCalls.filter(name => name === AGENT_CONTROL_TOOLS.complete).length !== 1
    || !progress.stepCalls.every(name => name === AGENT_CONTROL_TOOLS.complete
      || progress.tools?.get(name)?.completionExempt === true)) return
  progress.state.completion = progress.completionCandidate
  progress.state.completionSeq = progress.options.history.entries().length
  progress.state.completionInvalidated = undefined
}
