import { UNCHANGED_ANSWER_MARKER } from '../loop/control-text.ts'
import { AGENT_CONTROL_TOOLS } from './control-tools.ts'
import { createUserMessage } from '../../message/index.ts'
import { type RunAgentOptions, type DeepState } from './run-agent.ts'
import type { TurnHooks } from '../loop/types.ts'
import { keptAnswerOutcome } from './run-agent-support.ts'

export const UNVERIFIED_ANSWER_LIMIT = 3

function appendOrphanMarkerPrompt(history: RunAgentOptions['history']): void {
  history.append({ kind: 'user', message: createUserMessage({
    source: { kind: 'app', producer: 'deep-mode-self-check' },
    content: [{ type: 'text',
      text: 'There is no earlier answer in this run eligible for ' + UNCHANGED_ANSWER_MARKER
        + ' to keep. A new user or delegated task after the earlier answer makes it ineligible too. '
        + 'Reply with the answer itself now, in the requested format.',
    }],
  }) })
}

function invalidationNotice(state: DeepState): string {
  if (state.completionInvalidated === undefined) return ''
  if (state.completionInvalidated === 'input') {
    return 'Your previously accepted submission is no longer current because a new user request or delegated task '
      + 'arrived afterwards. Review the latest input and call ' + AGENT_CONTROL_TOOLS.complete
      + ' again when complete; '
      + 'the old instruction not to resubmit no longer applies. '
  }
  return 'Your previously accepted submission is no longer current because you called another substantive tool '
    + 'afterwards. Review the later tool results and call ' + AGENT_CONTROL_TOOLS.complete + ' again when complete; '
    + 'the old instruction not to resubmit no longer applies. '
}

function appendSelfCheckPrompt(history: RunAgentOptions['history'], state: DeepState): void {
  const text = invalidationNotice(state)
    + `Self-check required: this run has no accepted current self-check. Acceptance `
    + `recorded in an earlier run does not complete this request or follow-up; an earlier `
    + `instruction not to resubmit applied only to that earlier run. Compare the current `
    + `result against the user's objective and every constraint. If anything is missing, `
    + `continue with tools. If blocked and request_user_input is available, ask the user. `
    + `Only when the work is actually complete, call ${AGENT_CONTROL_TOOLS.complete}. Keep `
    + `verification in that tool call and then deliver the current user or assigned task's `
    + `requested output in its original format. This reminder does not change the task or `
    + `request a process report. Rephrasing a completion claim without submitting does not `
    + `satisfy this gate.`
  history.append({ kind: 'user', message: createUserMessage({
    source: { kind: 'app', producer: 'deep-mode-self-check' },
    content: [{ type: 'text', text }],
  }) })
}

function shouldNudgeOrphan(context: Parameters<NonNullable<TurnHooks['onTurnEnd']>>[0], state: DeepState): boolean {
  return context.outcome.reason.kind === 'completed' && context.canContinue
    && state.completion !== undefined && state.draftAnswer === undefined && !state.orphanMarkerNudged
    && state.markerReply && context.outcome.text.trim() === UNCHANGED_ANSWER_MARKER
}

function shouldRequestSelfCheck(
  context: Parameters<NonNullable<TurnHooks['onTurnEnd']>>[0], state: DeepState,
): boolean {
  return context.outcome.reason.kind === 'completed' && context.canContinue
    && state.completion === undefined && !state.userAborted
    
}

function recordDraft(
  context: Parameters<NonNullable<TurnHooks['onTurnEnd']>>[0], state: DeepState, draftSeq: number,
): void {
  if (context.outcome.text.trim() === '' || context.outcome.text.trim() === UNCHANGED_ANSWER_MARKER) return
  state.draftAnswer = context.outcome.text
  state.draftSeq = draftSeq
}

export function deepHooks(
  userHooks: TurnHooks | undefined, history: RunAgentOptions['history'], state: DeepState,
): TurnHooks {
  return {
    ...userHooks,
    onTurnEnd: async context => {
      const draftSeq = history.entries().length
      const outcome = keptAnswerOutcome(context.outcome, state)
      await userHooks?.onTurnEnd?.(outcome === context.outcome ? context : { ...context, outcome })
      if (shouldNudgeOrphan(context, state)) {
        state.orphanMarkerNudged = true
        appendOrphanMarkerPrompt(history)
        return
      }
      if (!shouldRequestSelfCheck(context, state)) return
      state.unverifiedAnswers++
      if (state.unverifiedAnswers >= UNVERIFIED_ANSWER_LIMIT) return
      recordDraft(context, state, draftSeq)
      appendSelfCheckPrompt(history, state)
    },
  }
}
