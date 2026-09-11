/**
 * The Anthropic Messages API wire shapes.
 *
 * These types never leave this folder. Keeping the vendor vocabulary quarantined
 * here is what lets `serialize`/`translate` be the only two places that need
 * updating when the API changes, and it stops provider-specific field names from
 * leaking into the core.
 *
 * @module ai-agent-sdk/providers/anthropic/wire
 */

/** Image bytes as the Messages API accepts them. */
export type WireImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }

/**
 * Document bytes as the Messages API accepts them.
 *
 * Unlike {@link WireImageSource}, this one DOES accept a Files API id, which is
 * the recommended path for a PDF large enough to strain the 32 MB request cap.
 */
export type WireDocumentSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'file'; file_id: string }

/** A request-side content block. */
export type WireRequestBlock =
  | { type: 'text'; text: string; citations?: WireCitation[] }
  | { type: 'image'; source: WireImageSource }
  | {
    type: 'document'
    source: WireDocumentSource
    title?: string
    context?: string
    citations?: { enabled: boolean }
  }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
    type: 'tool_result'
    tool_use_id: string
    content: WireToolResultContent[] | string
    is_error?: boolean
  }
  /**
   * An echoed thinking block. `signature` is mandatory on the way back: the API
   * verifies it to confirm the block is genuinely Claude's own reasoning.
   */
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | WireServerToolUseBlock
  | WireWebSearchToolResultBlock

export interface WireServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: string
  input: unknown
}

export interface WireWebSearchToolResultBlock {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: unknown
  caller?: unknown
}

export interface WireCitation {
  type: string
  [key: string]: unknown
}

/** What a `tool_result` block may carry back to the model. */
export type WireToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: WireImageSource }

/** One request message. Only `user` and `assistant` exist; system text is a top-level field. */
export interface WireMessage {
  role: 'user' | 'assistant'
  content: WireRequestBlock[]
}

/** A host function offered to the model. */
export interface WireFunctionTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** Anthropic-hosted web search. */
export interface WireWebSearchTool {
  type: 'web_search_20250305'
  name: 'web_search'
  max_uses?: number
  allowed_domains?: string[]
  blocked_domains?: string[]
  user_location?: {
    type: 'approximate'
    city?: string
    region?: string
    country?: string
    timezone?: string
  }
}

export type WireTool = WireFunctionTool | WireWebSearchTool

/** How the model must choose among the offered tools. */
export type WireToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string }

/** Extended-thinking configuration. */
export type WireThinking =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' }

export interface WireOutputConfig {
  format: {
    type: 'json_schema'
    schema: Readonly<Record<string, unknown>>
  }
}

/** The request body. */
export interface WireRequest {
  model: string
  /** REQUIRED by this API, unlike most others — the adapter always resolves one. */
  max_tokens: number
  messages: WireMessage[]
  system?: string
  tools?: WireTool[]
  tool_choice?: WireToolChoice
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  thinking?: WireThinking
  output_config?: WireOutputConfig
  stream?: boolean
}

/**
 * Token accounting.
 *
 * `input_tokens` already EXCLUDES cached tokens, which is why this adapter passes
 * the counts through unchanged — providers that fold cache hits into one prompt
 * total have to subtract them back out to honour the SDK's disjoint convention.
 */
export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

/** Why generation stopped. */
export type WireStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'

/** A response-side content block, as `content_block_start` announces it. */
export type WireResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | WireServerToolUseBlock
  | WireWebSearchToolResultBlock

/** Incremental updates to an open content block. */
export type WireDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  /** Arrives once, immediately before `content_block_stop`, for a thinking block. */
  | { type: 'signature_delta'; signature: string }
  | { type: 'citations_delta'; citation: WireCitation }

/** The streaming event union. */
export type WireStreamEvent =
  | { type: 'message_start'; message: { id?: string; model?: string; usage?: WireUsage } }
  | { type: 'content_block_start'; index: number; content_block: WireResponseBlock }
  | { type: 'content_block_delta'; index: number; delta: WireDelta }
  | { type: 'content_block_stop'; index: number }
  | {
    type: 'message_delta'
    delta: { stop_reason?: WireStopReason | null; stop_sequence?: string | null }
    usage?: WireUsage
  }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: WireErrorBody }

/** The error payload, in both HTTP error bodies and mid-stream `error` events. */
export interface WireErrorBody {
  type?: string
  message?: string
}

/** An HTTP error response body. */
export interface WireErrorResponse {
  type?: 'error'
  error?: WireErrorBody
}
