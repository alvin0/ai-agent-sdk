import { createUserMessage } from '../../../message/index.ts'
import type { AgentEvent, TurnOutcome } from '../types.ts'
import type { TraceRef } from '../../trace/trace.ts'
import type { RunTurnOptions } from './types.ts'
import type { now } from './common.ts'

function turnSpanAttributes(options: RunTurnOptions): Record<string, string> {
  return {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': options.trace?.agentId ?? 'agent',
      'gen_ai.agent.name': options.trace?.agentName ?? options.trace?.agentId ?? 'agent',
      'gen_ai.request.model': options.config.model,
      ...options.trace?.conversationId === undefined
        ? {}
        : { 'gen_ai.conversation.id': options.trace.conversationId },
    }
}

export async function emitTurnSpanStart(
  options: RunTurnOptions, emit: (event: AgentEvent) => Promise<void>, root: TraceRef,
  startedAt: ReturnType<typeof now>,
): Promise<void> {
  await emit({
    type: 'span-start', trace: root, at: startedAt,
    name: `invoke_agent ${options.trace?.agentId ?? 'agent'}`, kind: 'invoke_agent',
    attributes: turnSpanAttributes(options),
  })

}

export function appendTurnInterruption(options: RunTurnOptions, outcome: TurnOutcome): void {
  if (outcome.reason.kind === 'aborted') {
    // Without this, the next turn sees an unfinished request and a cancelled
    // tool call, and a model resumes the abandoned work instead of answering
    // the new message (observed live). Codex and Claude Code record the same
    // interruption marker.
    options.history.append({ kind: 'user', message: createUserMessage({
      source: { kind: 'app', producer: 'turn-interrupted' },
      content: [{ type: 'text',
        text: 'The previous request was interrupted before it finished. '
          + 'Use the next message to determine what to do next.' }],
    }) })
  }

}
