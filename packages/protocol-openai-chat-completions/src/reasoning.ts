/**
 * Reasoning replay for the Chat Completions wire.
 *
 * The official API has no field for a model's earlier reasoning, but the
 * open-weight ecosystem converged on two non-standard ones: `reasoning_content`
 * (DeepSeek, vLLM, llama.cpp, LM Studio) and `reasoning` (OpenRouter, Ollama,
 * newer vLLM). Thinking models served this way lose their chain of thought
 * between tool calls unless it is sent back.
 *
 * @module ai-agent-sdk/protocols/openai-chat-completions/reasoning
 */

import type { ContentBlock, Message } from '@alvin0/ai-agent-sdk-core'
import type { ChatCompletionsDialect } from './wire.ts'

/** Wire field a streamed reasoning block arrived on. */
export type ChatCompletionsReasoningField = 'reasoning_content' | 'reasoning' | 'think-tag'

/**
 * Adapter-private state kept on a reasoning block read by this protocol, so a
 * later request knows which field (if any) the endpoint understands.
 */
export interface ChatCompletionsReasoningState {
  readonly protocol: 'openai-chat-completions'
  readonly field: ChatCompletionsReasoningField
  /** Wire model id that produced the block. */
  readonly model?: string
}

export type ReasoningReplay = Exclude<ChatCompletionsDialect['reasoningReplay'], false | undefined>

/** Where replayed reasoning goes: a message field, or back into `<think>` tags. */
export type ReplayField = 'reasoning_content' | 'reasoning' | 'think-tag'

/** Reasoning waiting to ride on the next assistant wire message. */
export interface ReplayedReasoning {
  readonly field: ReplayField
  readonly texts: readonly string[]
}

/** What the serializer knows when deciding whether to replay. */
export interface ReplayContext {
  readonly replay: ReasoningReplay
  /** Wire model id of the request being built. */
  readonly model: string
}

/**
 * Response-level replay marker, sent on the `finish` chunk of a response that
 * produced reasoning. Core keeps a message's `replayState` only while the
 * history goes back to the adapter (and failover member) that produced it, so
 * its presence is the proof that the endpoint about to receive the reasoning is
 * the one that emitted it.
 */
export const CHAT_COMPLETIONS_REPLAY_MARKER = Object.freeze({ protocol: 'openai-chat-completions' })

/**
 * Whether `'auto'` may replay reasoning from this assistant message at all.
 *
 * Two failover members can serve the same model id from different hosts; only
 * the `replayState` core strips from another member's messages tells them
 * apart. A named field is an explicit opt-in and needs no such proof.
 */
export function replaysFrom(message: Message, replay: ReasoningReplay): boolean {
  if (replay !== 'auto') return true
  return message.source.kind === 'model' && message.source.replayState !== undefined
}

/**
 * Where one reasoning block is replayed, or `undefined` to drop it.
 *
 * `'auto'` trusts only what this protocol read itself, from this same model on
 * this same endpoint (see {@link replaysFrom}): a field the endpoint emitted is
 * a field it understands. Reasoning from a different model, another failover
 * member, or another provider is not sent, because the endpoint now receiving
 * it never offered that field and a strict one rejects unknown message
 * properties. Reasoning that arrived in `<think>` tags goes back the same way,
 * inside `content`, which is what the model's chat template expects to see in
 * a tool loop.
 */
export function replayField(block: Extract<ContentBlock, { type: 'reasoning' }>, context: ReplayContext)
  : ReplayField | undefined {
  if (context.replay !== 'auto') return context.replay
  const state = block.providerState as Partial<ChatCompletionsReasoningState> | undefined
  if (state?.protocol !== 'openai-chat-completions' || state.model !== context.model) return undefined
  return state.field === 'reasoning_content' || state.field === 'reasoning' || state.field === 'think-tag'
    ? state.field
    : undefined
}

/**
 * Index of the first message of the current turn: the one after the latest
 * message the user (or another agent) actually sent. Messages the application
 * injects mid-loop — budget reminders, tool `additionalContext`, guard notes —
 * travel as user-role messages too, but they do not end the tool loop.
 */
export function currentTurnStart(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message !== undefined && startsTurn(message)) return index + 1
  }
  return 0
}

function startsTurn(message: Message): boolean {
  if (message.role !== 'user') return false
  if (message.source.kind === 'app' || message.source.kind === 'tool') return false
  return message.content.some(block => block.type !== 'tool-result')
}
