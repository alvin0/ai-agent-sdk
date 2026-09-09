/**
 * Nominal typing over strings, at zero runtime cost.
 *
 * The point is to stop a value from silently crossing a boundary it does not
 * belong to  Epassing a model id where a tool-call id is expected is a real bug
 * that plain `string` cannot catch. Each brand function is an identity cast and
 * performs NO validation; it asserts intent, not well-formedness.
 *
 * @module ai-agent-sdk/core/primitives/brand
 */

declare const BRAND: unique symbol

/** A string carrying a compile-time-only nominal tag `B`. */
export type Branded<B extends string> = string & { readonly [BRAND]: B }

/** Stable identity of one message across construction, history, and requests. */
export type MessageId = Branded<'MessageId'>

/**
 * Brand a message identifier.
 * @param id - the opaque message identifier.
 * @returns the same string, branded; no validation is performed.
 */
export function MessageId(id: string): MessageId {
  return id as MessageId
}

/**
 * Correlates a model-issued tool call with the result sent back for it.
 * Provider-issued in real adapters; synthesized by assembler fallbacks.
 */
export type ToolCallId = Branded<'ToolCallId'>

/**
 * Brand a tool-call identifier.
 * @param id - the provider-issued (or synthesized) call id.
 * @returns the same string, branded; no validation is performed.
 */
export function ToolCallId(id: string): ToolCallId {
  return id as ToolCallId
}

/** Provider-issued request identifier, retained only for diagnostics. */
export type ProviderRequestId = Branded<'ProviderRequestId'>

/**
 * Brand a provider-issued request identifier.
 * @param id - the opaque provider-issued string.
 * @returns the same string, branded; no validation is performed.
 */
export function ProviderRequestId(id: string): ProviderRequestId {
  return id as ProviderRequestId
}

/**
 * Adapter-owned identifier for one model's selectable reasoning effort.
 *
 * Deliberately opaque rather than a fixed union: "how hard should this model
 * think" is spelled differently by every provider (OpenAI takes an effort
 * level, Anthropic takes a thinking token budget), and freezing one vendor's
 * vocabulary into the core would make the other one lie.
 */
export type ReasoningEffortId = Branded<'ReasoningEffortId'>

/**
 * Brand a reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model's capabilities.
 * @returns the same string, branded; no validation is performed.
 */
export function ReasoningEffortId(id: string): ReasoningEffortId {
  return id as ReasoningEffortId
}
