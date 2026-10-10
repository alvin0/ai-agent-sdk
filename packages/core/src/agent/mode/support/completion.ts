import { AGENT_CONTROL_TOOLS  } from '../control-tools.ts'
import { UNCHANGED_ANSWER_MARKER  } from '../../loop/control-text.ts'
import type { TurnOutcome  } from '../../loop/types.ts'
import { defineTool, type ToolDefinition } from '../../tool/definition.ts'
import type { ToolCatalog  } from '../../tool/registry.ts'
import { type AgentMode, type RunAgentOptions, type CompletionSubmission, type DeepState  } from '../run-agent.ts'
import { invalidateDraftAfterSteering  } from './marker.ts'
import { record  } from './validation.ts'

function acceptedCompletionInstruction(state: DeepState): string {
  return state.draftAnswer === undefined
    ? 'This self-check is accepted for the current run. Now deliver the answer or artifact '
      + 'requested by the current user or assigned task, preserving its requested content and '
      + 'format. For exact text, only JSON, only a number, or another constrained format, '
      + 'return only the requested output. The summary and evidence in this tool result are '
      + 'verification metadata; keep them out of the final answer unless the task requests '
      + 'them. If the task requests a report, provide the substantive findings or changes, '
      + 'supporting evidence or sources, and relevant limitations. Do not merely say the '
      + 'self-check passed or refer to an earlier message. Do not call submit_result again in '
      + 'this run unless you perform new substantive tool work that invalidates this '
      + 'submission. A later user request or worker follow-up starts a new run and needs its '
      + 'own self-check.'
    : `This self-check is accepted for the current run. You already gave the user a `
      + `complete answer earlier in this run, before this check. If no user message or `
      + `delegated task arrived after that answer and it still satisfies every current `
      + `requirement, reply with exactly ${UNCHANGED_ANSWER_MARKER} and nothing else. If a `
      + `user message or delegated task arrived after that answer, give the complete answer `
      + `to the latest request in full, even if the earlier answer seems correct. If this `
      + `check found something to correct or add, also give the complete corrected answer in `
      + `full, as if the earlier one did not exist: never summarize it, point back to it, or `
      + `say the self-check passed. Do not call submit_result again in this run unless you `
      + `perform new substantive tool work that invalidates this submission. A later user `
      + `request or worker follow-up starts a new run and needs its own self-check.`
}

export function completionTool(state: DeepState, history: RunAgentOptions['history'],
  tools?: ToolCatalog): ToolDefinition<CompletionSubmission> {
  return defineTool({
    name: AGENT_CONTROL_TOOLS.complete,
    description: 'Submit the self-check only when the user objective and constraints are fully satisfied. '
      + 'After acceptance, give the user the final answer.',
    // The one call that ENDS a deep run. A budget that can block it can leave
    // the run with no way to complete at all.
    budgetExempt: true,
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise statement of what was completed.' },
        evidence: {
          type: 'array', items: { type: 'string' },
          description: 'Concrete checks or tool results showing the objective is satisfied.',
        },
      },
      required: ['summary', 'evidence'],
      additionalProperties: false,
    },
    parse: parseCompletion,
    execute: submission => {
      // A newer user or delegated task changes what the draft answered, so
      // "the earlier answer still stands" is no longer a truthful reply: the
      // model is asked for the answer in full, and a marker it sends anyway is
      // treated as having nothing to keep.
      invalidateDraftAfterSteering(state, history)
      const calls = history.messages().findLast(message => message.role === 'assistant')?.content
        .filter(block => block.type === 'tool-call') ?? []
      if (calls.filter(call => call.name === AGENT_CONTROL_TOOLS.complete).length !== 1
        || calls.some(call => call.name !== AGENT_CONTROL_TOOLS.complete
          && tools?.get(call.name)?.completionExempt !== true)) {
        return { accepted: false,
          instruction: 'Review the tool results, then call submit_result exactly once without substantive '
            + 'sibling tools. '
            + 'This batch has no accepted self-check.' }
      }
      return {
        accepted: true,
        summary: submission.summary,
        evidence: [...submission.evidence],
        // A draft recorded means the model already gave the user a complete
        // answer before this check, so confirming it is a legitimate outcome,
        // not just a shorter way to restate it.
        instruction: acceptedCompletionInstruction(state)
      }
    },
  })
}

export function completionFromResult(value: unknown): CompletionSubmission {
  const result = record(value, 'submit_result result')
  return parseCompletion({ summary: result.summary, evidence: result.evidence })
}

export function parseCompletion(raw: unknown): CompletionSubmission {
  const value = record(raw, 'submit_result arguments')
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    throw new Error('summary must be a non-empty string')
  }
  if (!Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string'
    || item.trim().length === 0)) {
    throw new Error('evidence must be an array of non-empty strings')
  }
  return { summary: value.summary, evidence: value.evidence as string[] }
}

export function isAgentCompletionEligible(mode: AgentMode, terminal: TurnOutcome, state: DeepState): boolean {
  if (mode === 'basic') {
    return (terminal.reason.kind === 'completed' && terminal.text.trim() !== '')
      || terminal.reason.kind === 'concluded-by-tool'
  }
  return state.completion !== undefined && !state.userAborted
    && (terminal.reason.kind === 'completed'
      || terminal.reason.kind === 'concluded-by-tool'
      || (terminal.reason.kind === 'budget-exhausted' && terminal.reason.forcedFinalAnswer))
    && terminal.text.trim() !== ''
}
