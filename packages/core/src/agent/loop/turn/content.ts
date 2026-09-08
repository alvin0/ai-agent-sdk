import type { ModelFailure } from '../../../errors/index.ts'
import type { ContentBlock } from '../../../message/index.ts'
import { createMessage, type Message } from '../../../message/index.ts'
import type { ToolCallId } from '../../../primitives/index.ts'
import { History } from '../../history/history.ts'
import { createSpanId, type TraceRef } from '../../trace/trace.ts'
import type { AgentEvent, AgentMaintenanceEvent, AssistantContentTiming } from '../types.ts'
import { type RunTurnOptions, type RoundResult } from './types.ts'
import { now } from './common.ts'

export function maintenanceEmitter(
  emit: (event: AgentEvent) => Promise<void>,
  root: TraceRef,
): (event: AgentMaintenanceEvent) => Promise<void> {
  const spans = new Map<string, TraceRef>()
  return async event => {
    if (event.type === 'compaction-start') {
      const trace: TraceRef = {
        traceId: root.traceId, spanId: createSpanId(), parentSpanId: root.spanId,
      }
      spans.set(event.compactionId, trace)
      await emit({
        type: 'span-start', trace, at: now(),
        name: `compact ${event.trigger}`, kind: 'compact',
        attributes: {
          'gen_ai.operation.name': 'compact',
          'gen_ai.compaction.id': event.compactionId,
          'gen_ai.compaction.trigger': event.trigger,
          'gen_ai.input.tokens.estimated': event.estimatedInputTokens,
        },
      })
      await emit({ ...event, trace })
      return
    }
    const trace = spans.get(event.compactionId) ?? root
    await emit({ ...event, trace })
    await emit({
      type: 'span-end', trace, at: now(), status: event.status === 'completed' ? 'success' : 'error',
      output: {
        shadowedSeqs: event.shadowedSeqs,
        estimatedTokensBefore: event.estimatedTokensBefore,
        estimatedTokensAfter: event.estimatedTokensAfter,
        ...(event.thresholdTokens === undefined ? {} : { thresholdTokens: event.thresholdTokens }),
        ...(event.estimatedNonCompactableTokens === undefined
          ? {} : { estimatedNonCompactableTokens: event.estimatedNonCompactableTokens }),
        ...(event.backoffReason === undefined ? {} : { backoffReason: event.backoffReason }),
      },
      ...(event.usage === undefined ? {} : { usage: event.usage }),
      ...(event.error === undefined ? {} : {
        error: { type: 'CompactionError', message: event.error },
      }),
    })
    spans.delete(event.compactionId)
  }
}

export async function emitAssistantContent(
  round: RoundResult,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<void> {
  const message = round.message
  if (message === undefined) return
  const toolCallIds = Object.freeze(round.calls.map(call => call.callId))
  for (const block of message.content) {
    if (block.type === 'text' && block.text.length > 0) {
      await emit({
        type: 'assistant-text', trace: round.trace, messageId: message.id, text: block.text,
        phase: block.phase ?? (round.calls.length > 0 ? 'commentary' : 'final-answer'),
        timing: round.timing, toolCallIds, afterToolCallIds: round.afterToolCallIds,
      })
    } else if (block.type === 'reasoning' && block.text.length > 0) {
      await emit({
        type: 'assistant-reasoning', trace: round.trace, messageId: message.id, text: block.text,
        timing: round.timing, toolCallIds, afterToolCallIds: round.afterToolCallIds,
      })
    } else if (block.type === 'native-tool-call') {
      await emit({ type: 'assistant-native-tool', trace: round.trace, messageId: message.id, call: block })
    }
  }
}

export function classifyTextPhases(
  blocks: readonly ContentBlock[],
  processOnly = false,
): ContentBlock[] {
  const hasHostCalls = blocks.some(block => block.type === 'tool-call')
  const lastNative = blocks.findLastIndex(block => block.type === 'native-tool-call')
  return blocks.map((block, index) => {
    if (block.type !== 'text' || block.phase !== undefined) return block
    const phase = processOnly || hasHostCalls || (lastNative >= 0 && index < lastNative)
      ? 'commentary' as const
      : 'final-answer' as const
    return { ...block, phase }
  })
}

export function invalidHostToolCall(
  blocks: readonly ContentBlock[],
  _history: History,
): ModelFailure | undefined {
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    if (typeof block.id !== 'string' || block.id.trim().length === 0
      || typeof block.name !== 'string' || block.name.trim().length === 0
      || typeof block.arguments !== 'string') {
      return {
        message: 'provider emitted a host tool call with invalid identity, name, or arguments',
        code: 'INVALID_TOOL_CALL',
      }
    }
  }
  return undefined
}

/**
 * Drop a repeated tool-call id instead of failing the round over it.
 *
 * Results are paired to calls by id, so two calls sharing one id cannot both be
 * answered — but the FIRST of them is perfectly good work, and killing the turn
 * throws it away along with everything the model had done to get there. Codex
 * treats a duplicate as something to reconcile rather than to abort on. The
 * repeat is removed, the original stands, and the model is told which id it
 * reused so its next round does not repeat the mistake.
 * @param blocks - The assistant content as the provider sent it.
 * @param history - The turn so far; ids already used are duplicates too.
 * @returns The content to keep, and the ids that were dropped.
 */
export function dropDuplicateToolCalls(
  blocks: readonly ContentBlock[],
  history: History,
): { readonly blocks: readonly ContentBlock[]; readonly dropped: readonly string[] } {
  const seen = new Set<string>()
  for (const entry of history.entries()) {
    if (entry.event.kind !== 'assistant') continue
    for (const block of entry.event.message.content) {
      if (block.type === 'tool-call') seen.add(block.id)
    }
  }
  const dropped: string[] = []
  const kept = blocks.filter((block) => {
    if (block.type !== 'tool-call' || typeof block.id !== 'string') return true
    if (seen.has(block.id)) {
      dropped.push(block.id)
      return false
    }
    seen.add(block.id)
    return true
  })
  return dropped.length === 0 ? { blocks, dropped } : { blocks: kept, dropped }
}

export function contentTiming(hasToolCalls: boolean, followsToolResults: boolean): AssistantContentTiming {
  if (hasToolCalls && followsToolResults) return 'between-tools'
  if (hasToolCalls) return 'before-tools'
  if (followsToolResults) return 'after-tools'
  return 'standalone'
}

export function recentToolResultIds(history: History): readonly ToolCallId[] {
  const ids: ToolCallId[] = []
  const entries = history.entries()
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index]?.event
    if (event === undefined) continue
    if (event.kind === 'assistant' || (event.kind === 'user' && event.message.source.kind === 'user')) break
    if (event.kind === 'tool-result') ids.unshift(event.callId)
  }
  return Object.freeze(ids)
}

export function systemText(options: RunTurnOptions, forcedFinal: boolean): string {
  const parts = [options.system]
  if (options.commentary === 'concise') {
    parts.push(
      'Before calling tools, give a brief user-visible progress update about what you are about to do. After tool results, briefly summarize what changed before another action. Do not reveal private chain-of-thought; communicate only intent and observed outcomes.',
    )
  } else if (options.commentary === 'off') {
    parts.push('Do not emit progress commentary around tool calls; call tools directly and provide only the final answer.')
  }
  if (forcedFinal) parts.push(
    'Tool use is now disabled. Answer from the information already gathered and state plainly what remains unknown.',
  )
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join('\n\n')
}

export function createAssistant(options: RunTurnOptions, content: readonly ContentBlock[], replayState: unknown): Message {
  const source = {
    kind: 'model' as const, provider: options.config.provider, model: options.config.model,
    ...replayState === undefined ? {} : { replayState },
  }
  return createMessage({ role: 'assistant', content, source })
}

export function textOf(blocks: readonly ContentBlock[]): string {
  const text = blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
  const final = text.filter(block => block.phase === 'final-answer')
  if (final.length > 0) return final.map(block => block.text).join('')
  return text.filter(block => block.phase !== 'commentary').map(block => block.text).join('')
}
