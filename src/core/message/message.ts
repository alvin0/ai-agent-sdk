/**
 * The message value type, its identity, and immutable construction helpers.
 *
 * Two decisions carry most of the weight here:
 *
 * 1. `role` is a neutral three-value enum, and WHO produced a message lives in
 *    `source` instead. Providers disagree about roles  Ea tool result is its own
 *    role in one API and a user-role block in another  Eso provenance is kept on
 *    a separate axis that no provider dictates.
 * 2. Messages are frozen before publication. History is shared by reference
 *    across turns, retries, and (for the caller) any UI; a single in-place edit
 *    would silently rewrite the past, and cache-prefix reuse with it.
 *
 * @module ai-agent-sdk/core/message/message
 */

import { deepFreeze } from '../primitives/freeze.ts'
import { MessageId, type ToolCallId } from '../primitives/brand.ts'
import type { ContentBlock, ToolResultBlock } from './content.ts'

/** Provider/model identity and adapter-private replay data for an assistant message. */
export interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string
  /** Model id that produced the message. */
  model: string
  /**
   * Lossless-JSON adapter state needed to replay the provider response.
   *
   * Exposed to an adapter only when that same adapter instance owns both this
   * historical route and the route being called, because one provider's opaque
   * state is meaningless  Eand possibly rejected  Eat another's endpoint.
   */
  replayState?: unknown
}

/** Source of an assistant message produced by a routed model. */
export interface ModelMessageSource extends AssistantProvenance {
  kind: 'model'
}

/** Source of a message carrying one tool result. */
export interface ToolMessageSource {
  kind: 'tool'
  callId: ToolCallId
}

/** Source of a user-role message sent by another long-lived agent session. */
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  readonly teamId: string
  readonly messageId: string
  readonly sender: string
  readonly senderAgentId: string
}

/** Source of a message received from an interoperable A2A protocol peer. */
export interface A2AMessageSource {
  readonly kind: 'a2a-message'
  readonly contextId: string
  readonly messageId: string
  readonly taskId?: string
}

/**
 * Merge-extensible record of where a message came from. Widen by declaration
 * merging; switch on `kind` and fall through unknowns.
 */
export interface MessageSourceMap {
  /** Typed or supplied by the end user. */
  user: { kind: 'user' }
  /** Injected by the application rather than the user (assembled context, notices). */
  app: { kind: 'app'; producer: string }
  /** Produced by a model through a provider route. */
  model: ModelMessageSource
  /** The result of one tool call. */
  tool: ToolMessageSource
  /** Attributed context delivered through the in-process A2A control plane. */
  'agent-message': AgentMessageSource
  /** Input received through an A2A protocol server transport. */
  'a2a-message': A2AMessageSource
}

/** Any known message source. */
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

/** One immutable message, shared by history, requests, and consumers. */
export interface Message {
  /** Stable identity, preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** The exact model-facing blocks. */
  readonly content: readonly ContentBlock[]
  /** Who produced this message. */
  readonly source: MessageSource
}

/** A user-role message. */
export interface UserMessage extends Message {
  readonly role: 'user'
}

/** A model-produced assistant message. */
export interface AssistantMessage extends Message {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

/** A tool result, carried as a user-role message with a single tool-result block. */
export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: readonly [ToolResultBlock]
  readonly source: ToolMessageSource
}

type NewMessage = Omit<Message, 'id'>
type NewUserMessage = Omit<UserMessage, 'id' | 'role'>
type NewAssistantMessage = Omit<AssistantMessage, 'id' | 'role' | 'source'> & {
  readonly source: Omit<ModelMessageSource, 'kind'> & { readonly kind?: never }
}

/** Generate a message id, preferring the platform's own UUID source. */
function newMessageId(): MessageId {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) return MessageId(uuid)
  // Non-secure contexts (and pre-19 Node) expose no global crypto. Message ids
  // are correlation handles, never security tokens, so a unique-enough fallback
  // is correct rather than a compromise.
  return MessageId(`msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
}

/**
 * Detach and deep-freeze a message whose identity already exists.
 *
 * Clones first, so freezing cannot reach back into a caller's live object graph.
 * @param message - a complete message, including its identity.
 * @returns an immutable snapshot preserving that identity.
 */
export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/**
 * Create one identified message and freeze it before publication.
 *
 * The `id?: never` phantom parameter is what stops a caller from supplying an
 * identity: identity is minted here so it cannot be duplicated across messages.
 * @param input - complete role, content, and source.
 * @returns an immutable message with a fresh identity.
 */
export function createMessage<T extends NewMessage>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'> {
  return freezeMessage({ ...input, id: newMessageId() })
}

/**
 * Create one identified user-role message.
 * @param input - complete content and source.
 * @returns an immutable user message with a fresh identity.
 */
export function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  return createMessage({ ...input, role: 'user' })
}

/**
 * Create one identified model-produced assistant message.
 * @param input - content plus the provider, model, and optional replay state.
 * @returns an immutable assistant message with fixed role/source tags.
 */
export function createAssistantMessage(
  input: NewAssistantMessage & { readonly id?: never; readonly role?: never },
): AssistantMessage {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: { kind: 'model', ...input.source },
  })
}

/** Convenience shape for the common "user typed some text" case. */
export function createTextMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Input whose acceptance creates one tool-result message. */
export interface ToolResultMessageInput {
  readonly callId: ToolCallId
  readonly content: readonly ContentBlock[]
  readonly isError: boolean
}

/**
 * Create and freeze one identified tool-result message.
 * @param input - call identity, result blocks, and outcome.
 * @returns an immutable user-role tool-result message.
 */
export function createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage {
  return createUserMessage({
    source: { kind: 'tool', callId: input.callId },
    content: [{
      type: 'tool-result',
      toolCallId: input.callId,
      content: [...input.content],
      isError: input.isError,
    }] as const,
  })
}
