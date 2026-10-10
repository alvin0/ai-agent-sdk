import type { Message } from '../../message/index.ts'
import { createMessage } from '../../message/index.ts'
import { UNCHANGED_ANSWER_MARKER } from '../loop/control-text.ts'
import type { AgentRunEvent, DeepState, RunAgentOptions } from './run-agent.ts'
import {
  invalidateDraftAfterSteering, isMarkerPrefix, keptAnswerMessage, restoreKeptAnswer, soleText,
} from './run-agent-support.ts'

export type AnswerEventState = {
  options: RunAgentOptions; deep: boolean; deepState: DeepState
  emit: (event: AgentRunEvent) => Promise<void>; heldEvents: AgentRunEvent[]
  kept: { readonly from: Message['id']; readonly message: Message } | undefined
  sanitized: { readonly from: Message['id']; readonly message: Message } | undefined
  orphan: Message['id'] | undefined; keptRestored: boolean; lastRequestSeq: number
  draftMessageId: Message['id'] | undefined; keptTextEmitted: boolean
  markerCandidate: boolean; candidateText: string; candidateBlocks: Map<number, string>
  flushHeld: () => Promise<void>; dropHeldText: () => Promise<void>
}

async function forwardSanitized(ctx: AnswerEventState, event: AgentRunEvent): Promise<boolean> {
  if (ctx.sanitized === undefined || (event.type !== 'assistant-text' && event.type !== 'assistant-reasoning')
    || event.messageId !== ctx.sanitized.from) return false
  const text = event.type === 'assistant-text'
    ? event.text.replaceAll(UNCHANGED_ANSWER_MARKER, '') : undefined
  await ctx.emit({ ...event, messageId: ctx.sanitized.message.id, ...(text === undefined ? {} : { text }) })
  return true
}

async function forwardKept(ctx: AnswerEventState, event: AgentRunEvent): Promise<boolean> {
  if (ctx.kept === undefined) return false
  if (event.type === 'assistant-reasoning' && event.messageId === ctx.kept.from) {
    await ctx.emit({ ...event, messageId: ctx.kept.message.id })
    return true
  }
  if (event.type !== 'assistant-text' || event.messageId !== ctx.kept.from) return false
  if (ctx.keptTextEmitted) return true
  ctx.keptTextEmitted = true
  const block = ctx.kept.message.content.find(item => item.type === 'text')
  const text = block?.type === 'text' ? block.text : event.text
  await ctx.emit({ ...event, messageId: ctx.kept.message.id, text })
  return true
}

async function forwardAnswerPrelude(ctx: AnswerEventState, event: AgentRunEvent): Promise<boolean> {
  if (await forwardSanitized(ctx, event)) return true
  if (ctx.orphan !== undefined && event.type === 'assistant-text' && event.messageId === ctx.orphan) return true
  return forwardKept(ctx, event)
}

async function resetAnswerRound(ctx: AnswerEventState): Promise<void> {
  ctx.lastRequestSeq = ctx.options.history.entries().length
  ctx.kept = undefined
  ctx.sanitized = undefined
  ctx.orphan = undefined
  ctx.keptRestored = false
  ctx.keptTextEmitted = false
  ctx.deepState.markerCut = false
  ctx.deepState.markerReply = false
  await ctx.flushHeld()
  invalidateDraftAfterSteering(ctx.deepState, ctx.options.history)
  ctx.markerCandidate = true
  ctx.candidateText = ''
  ctx.candidateBlocks.clear()
}

function isCandidateTextEvent(
  event: AgentRunEvent,
): event is Extract<AgentRunEvent, { type: 'text-delta' | 'text-end' }> {
  return event.type === 'text-delta' || event.type === 'text-end'
}

async function holdMarkerText(
  ctx: AnswerEventState, event: Extract<AgentRunEvent, { type: 'text-delta' | 'text-end' }>,
): Promise<void> {
  ctx.candidateBlocks.set(event.index,
    event.type === 'text-end' ? event.text : (ctx.candidateBlocks.get(event.index) ?? '') + event.text)
  ctx.candidateText = [...ctx.candidateBlocks.values()].join('')
  ctx.heldEvents.push(event)
  if (!isMarkerPrefix(ctx.candidateText) && !ctx.candidateText.trimStart().startsWith(UNCHANGED_ANSWER_MARKER)) {
    ctx.markerCandidate = false
    await ctx.flushHeld()
    return
  }
  if (event.type === 'text-end' && event.incomplete) ctx.deepState.markerCut = true
}

async function keepBareMarker(
  ctx: AnswerEventState, event: Extract<AgentRunEvent, { type: 'assistant-message' }>, draft: string | undefined,
): Promise<void> {
  ctx.deepState.markerReply = true
  ctx.deepState.resolvedMarkerAnswer = draft ?? ''
  ctx.kept = { from: event.message.id, message: keptAnswerMessage(draft ?? '', event.message.content) }
  restoreKeptAnswer(ctx.options.history, ctx.kept.message, ctx.deepState.markerCut)
  ctx.keptRestored = true
  if (draft === undefined) ctx.orphan = event.message.id
  await ctx.dropHeldText()
  if (ctx.draftMessageId !== undefined) {
    await ctx.emit({ type: 'assistant-replacement', fromMessageId: ctx.draftMessageId, message: ctx.kept.message })
  }
  await ctx.emit({ ...event, message: ctx.kept.message })
}

async function keepMarkerWithText(
  ctx: AnswerEventState, event: Extract<AgentRunEvent, { type: 'assistant-message' }>, only: string,
): Promise<void> {
  const answer = only.replaceAll(UNCHANGED_ANSWER_MARKER, '').trim()
  ctx.deepState.resolvedMarkerAnswer = answer
  const replacement = keptAnswerMessage(answer, event.message.content)
  restoreKeptAnswer(ctx.options.history, replacement)
  ctx.kept = { from: event.message.id, message: replacement }
  const textEvent = ctx.heldEvents.find(held => held.type === 'text-end')
    ?? ctx.heldEvents.find(held => held.type === 'text-delta')
  await ctx.dropHeldText()
  if (textEvent?.type === 'text-end' || textEvent?.type === 'text-delta') {
    await ctx.emit({ type: 'text-delta', trace: textEvent.trace, index: textEvent.index,
      phase: 'final-answer', text: answer })
    await ctx.emit({ type: 'text-end', trace: textEvent.trace, index: textEvent.index,
      phase: 'final-answer', text: answer })
  }
  await ctx.emit({ ...event, message: replacement })
}

async function handleMarkerMessage(
  ctx: AnswerEventState, event: Extract<AgentRunEvent, { type: 'assistant-message' }>,
): Promise<boolean> {
  const only = soleText(event.message.content)
  const bare = only !== undefined
    && (only.trim() === UNCHANGED_ANSWER_MARKER || (ctx.deepState.markerCut && isMarkerPrefix(only)))
  ctx.markerCandidate = false
  if (bare) {
    await keepBareMarker(ctx, event, ctx.deepState.draftAnswer)
    return true
  }
  if (only?.includes(UNCHANGED_ANSWER_MARKER)) {
    await keepMarkerWithText(ctx, event, only)
    return true
  }
  ctx.deepState.markerCut = false
  await ctx.flushHeld()
  return false
}

async function handleHeldAnswerEvents(ctx: AnswerEventState, event: AgentRunEvent): Promise<boolean> {
  if (ctx.heldEvents.length === 0) return false
  if (event.type === 'turn-end' && ctx.markerCandidate && isMarkerPrefix(ctx.candidateText)) {
    ctx.markerCandidate = false
    ctx.deepState.markerCut = true
    await ctx.dropHeldText()
  } else if (event.type === 'turn-end' || event.type === 'tool-call') {
    ctx.markerCandidate = false
    await ctx.flushHeld()
  } else {
    ctx.heldEvents.push(event)
    return true
  }
  return false
}

async function handleOrdinaryAnswerMessage(
  ctx: AnswerEventState, event: Extract<AgentRunEvent, { type: 'assistant-message' }>,
): Promise<boolean> {
  if (ctx.kept !== undefined) return false
  const message = event.message
  const combined = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  delete ctx.deepState.resolvedMarkerAnswer
  if (combined.includes(UNCHANGED_ANSWER_MARKER)) {
    const replacement = createMessage({ role: 'assistant', source: message.source,
      content: message.content.map(block => block.type === 'text'
        ? { ...block, text: block.text.replaceAll(UNCHANGED_ANSWER_MARKER, '') } : block) })
    restoreKeptAnswer(ctx.options.history, replacement)
    ctx.sanitized = { from: message.id, message: replacement }
    await ctx.emit({ ...event, message: replacement })
    return true
  }
  if (ctx.deep && !message.content.some(block => block.type === 'tool-call') && combined.trim() !== '') {
    if (ctx.deepState.completion !== undefined && ctx.draftMessageId !== undefined) {
      await ctx.emit({ type: 'assistant-replacement', fromMessageId: ctx.draftMessageId, message })
    }
    ctx.draftMessageId = message.id
  }
  return false
}

async function emitAnswerTail(ctx: AnswerEventState, event: AgentRunEvent): Promise<void> {
  if (event.type === 'assistant-message' && await handleOrdinaryAnswerMessage(ctx, event)) return
  if (event.type === 'assistant-text') {
    await ctx.emit({ ...event, text: event.text.replaceAll(UNCHANGED_ANSWER_MARKER, '') })
    return
  }
  await ctx.emit(event)
}

export function createAnswerEventHandler(ctx: AnswerEventState): (event: AgentRunEvent) => Promise<void> {
  return async (event: AgentRunEvent): Promise<void> => {
    if (await forwardAnswerPrelude(ctx, event)) return
    if (event.type === 'step-start') await resetAnswerRound(ctx)
    if (ctx.markerCandidate && isCandidateTextEvent(event)) {
      await holdMarkerText(ctx, event)
      return
    }
    if (ctx.markerCandidate && event.type === 'assistant-message') {
      if (await handleMarkerMessage(ctx, event)) return
    } else if (await handleHeldAnswerEvents(ctx, event)) return
    await emitAnswerTail(ctx, event)
  }
}
