import { UNCHANGED_ANSWER_MARKER  } from '../../loop/control-text.ts'
import { createMessage, type Message  } from '../../../message/index.ts'
import type { TurnOutcome  } from '../../loop/types.ts'
import { type RunAgentOptions, type DeepState  } from '../run-agent.ts'

/**
 * The message's combined text, when text is all it says. Reasoning is not
 * something it says to the user: reasoning models attach it to a reply that is
 * otherwise only the marker, and that reply must still count as the marker.
 */
export function soleText(content: readonly Message['content'][number][]): string | undefined {
  const said = content.filter(block => block.type !== 'reasoning')
  return said.length > 0 && said.every(block => block.type === 'text')
    ? said.map(block => block.type === 'text' ? block.text : '').join('') : undefined
}

/** Text that is, so far, only the beginning (or the whole) of the marker. */
export function isMarkerPrefix(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length === 0 ? true : UNCHANGED_ANSWER_MARKER.startsWith(trimmed)
}

export function markerFallbackText(state: DeepState): string {
  return state.completion !== undefined && (state.markerReply || state.markerCut)
    ? state.draftAnswer ?? '' : ''
}

export function exactMarkerOutcome(outcome: TurnOutcome, state: DeepState): TurnOutcome {
  return { ...outcome, text: state.resolvedMarkerAnswer ?? markerFallbackText(state) }
}

export function keptAnswerOutcome(outcome: TurnOutcome, state: DeepState): TurnOutcome {
  const trimmed = outcome.text.trim()
  if (trimmed === UNCHANGED_ANSWER_MARKER) return exactMarkerOutcome(outcome, state)
  if (outcome.text.includes(UNCHANGED_ANSWER_MARKER)) {
    return { ...outcome, text: outcome.text.replaceAll(UNCHANGED_ANSWER_MARKER, '').trim() }
  }
  if (!state.markerReply && !state.markerCut) return outcome
  const cut = state.markerCut && trimmed !== '' && isMarkerPrefix(outcome.text)
  if (!cut && trimmed !== UNCHANGED_ANSWER_MARKER) return outcome
  return { ...outcome, text: state.draftAnswer ?? '' }
}

/** Replace the control text while preserving the confirming round's reasoning. */
export function keptAnswerMessage(draftAnswer: string, content?: Message['content']): Message {
  return createMessage({
    role: 'assistant',
    content: content === undefined
      ? [{ type: 'text', text: draftAnswer, phase: 'final-answer' }]
      : [...content.filter(block => block.type === 'reasoning'),
        { type: 'text' as const, text: draftAnswer, phase: 'final-answer' as const }],
    source: { kind: 'app', producer: draftAnswer === '' ? 'deep-mode-invalid-marker' : 'deep-mode-kept-answer' },
  })
}

/** Supersede a bare marker on the history surface without changing the raw log. */
export function latestAssistantEntry(
  history: RunAgentOptions['history'],
): ReturnType<RunAgentOptions['history']['entries']>[number] | undefined {
  return [...history.entries()].reverse().find(entry => entry.event.kind === 'assistant')
}

export function restoreKeptAnswer(history: RunAgentOptions['history'], replacement: Message, cut = false): void {
  const target = latestAssistantEntry(history)
  if (target?.event.kind !== 'assistant') return
  const only = target.event.message.content
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (!only.includes(UNCHANGED_ANSWER_MARKER)
    && !(cut && only.trim() !== '' && isMarkerPrefix(only))) return
  history.append(
    { kind: 'assistant', message: replacement },
    { op: 'replace', from: target.seq, to: target.seq },
  )
}

/** Whether a new user or delegated task arrived after the given history position. */
export function taskChangedSince(history: RunAgentOptions['history'], seq: number | undefined): boolean {
  return history.entries().slice(seq ?? 0)
    .some(entry => entry.event.kind === 'user' && ['user', 'agent-message', 'a2a-message']
      .includes(entry.event.message.source.kind))
}

export function invalidateDraftAfterSteering(state: DeepState, history: RunAgentOptions['history']): void {
  if (state.completion !== undefined && taskChangedSince(history, state.completionSeq)) {
    state.completion = undefined
    state.completionInvalidated = 'input'
  }
  if (state.draftAnswer === undefined || !taskChangedSince(history, state.draftSeq)) return
  state.draftAnswer = undefined
  state.draftSeq = undefined
}
