/**
 * The OpenAI Responses API wire shapes, shared by the `openai` and `codex`
 * providers.
 *
 * Both speak the same protocol — Codex's own client dropped Chat Completions
 * entirely (`wire_api = "chat"` is a hard error there now) — so the dialect
 * differences are narrow enough to express as a profile rather than a second
 * implementation. What actually differs is the base URL, the auth headers, and
 * whether sampling knobs are accepted; see {@link ResponsesDialect}.
 *
 * These types never leave this folder.
 *
 * @module ai-agent-sdk/providers/responses/wire
 */

/** Detail level requested for an input image. */
export type WireImageDetail = 'auto' | 'low' | 'high' | 'original'

/** One part of a message item's content. */
export type WireContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: WireImageDetail }
  | { type: 'input_image'; file_id: string; detail?: WireImageDetail }
  | { type: 'output_text'; text: string; annotations?: WireTextAnnotation[] }

export interface WireTextAnnotation {
  type: 'url_citation'
  url: string
  title?: string
  start_index?: number
  end_index?: number
}

/** One summary paragraph of a reasoning item. */
export interface WireReasoningSummary {
  type: 'summary_text'
  text: string
}

/** One body paragraph of a reasoning item. */
export interface WireReasoningContent {
  type: 'reasoning_text'
  text: string
}

/**
 * An item in the `input` array.
 *
 * Note the shape of the conversation here: this is a FLAT list of items, not a
 * list of messages with nested content. A tool result is its own top-level
 * `function_call_output` item rather than a part inside a user message, and one
 * assistant turn that reasoned, spoke, and called two tools becomes four items.
 * That is the main thing serialization has to get right.
 */
export type WireInputItem =
  | {
    type: 'message'
    role: 'user' | 'assistant' | 'developer' | 'system'
    content: WireContentPart[]
    phase?: 'commentary' | 'final_answer'
  }
  | {
    type: 'function_call'
    /** Correlates with the matching output item. */
    call_id: string
    name: string
    /** JSON-encoded STRING, not an object. */
    arguments: string
    /** Server-assigned item id, echoed back when known. */
    id?: string
  }
  | {
    type: 'function_call_output'
    call_id: string
    /** Either plain text or structured content items. */
    output: string | WireContentPart[]
  }
  | {
    type: 'reasoning'
    id?: string
    summary: WireReasoningSummary[]
    content?: WireReasoningContent[]
    /**
     * Opaque encrypted reasoning, returned when `include` requests it.
     *
     * Echoing it back is what lets the model keep its chain of thought across a
     * tool-use loop; dropping it silently degrades multi-step quality.
     */
    encrypted_content?: string | null
  }
  | {
    /** Provider-native web-search item replayed on a later request. */
    type: 'web_search_call'
    id?: string
    status?: string
    action?: unknown
  }
  | {
    /** Provider-native image-generation item replayed on a later request. */
    type: 'image_generation_call'
    id?: string
    status?: string
    result?: string | null
  }

/** A function tool, flat rather than nested under a `function` key. */
export interface WireFunctionTool {
  type: 'function'
  name: string
  description: string
  strict: boolean
  parameters: Record<string, unknown>
}

export interface WireNativeTool {
  type: string
  [key: string]: unknown
}

export type WireTool = WireFunctionTool | WireNativeTool

/** How the model must choose among the offered tools. */
export type WireToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }
  | { type: string }

/** Reasoning controls. */
export interface WireReasoning {
  effort?: string
  summary?: 'auto' | 'concise' | 'detailed' | 'none'
}

/** Output text controls. */
export interface WireTextControls {
  verbosity?: 'low' | 'medium' | 'high'
}

/** The request body. */
export interface WireRequest {
  model: string
  /** System prompt. Its own field here, not a message item. */
  instructions?: string
  input: WireInputItem[]
  tools?: WireTool[]
  tool_choice?: WireToolChoice
  parallel_tool_calls?: boolean
  reasoning?: WireReasoning
  text?: WireTextControls
  /** Whether the provider retains the response server-side. */
  store: boolean
  stream: boolean
  /** Extra payloads to include, e.g. `reasoning.encrypted_content`. */
  include?: string[]
  /** Stable key that lets the provider reuse a cached prompt prefix. */
  prompt_cache_key?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
}

/** Cached-token breakdown of the input count. */
export interface WireInputTokensDetails {
  /** Portion of `input_tokens` served from cache — a SUBSET, not an addition. */
  cached_tokens?: number
  /** Codex-backend extension. */
  cache_write_tokens?: number
}

/** Reasoning breakdown of the output count. */
export interface WireOutputTokensDetails {
  reasoning_tokens?: number
}

/** Token accounting as the Responses API reports it. */
export interface WireUsage {
  input_tokens?: number
  input_tokens_details?: WireInputTokensDetails | null
  output_tokens?: number
  output_tokens_details?: WireOutputTokensDetails | null
  total_tokens?: number
}

/** A completed output item, as `response.output_item.done` delivers it. */
export interface WireOutputItem {
  id?: string
  type?: string
  role?: string
  content?: unknown
  summary?: unknown
  encrypted_content?: string | null
  call_id?: string
  name?: string
  arguments?: string
  phase?: string
  status?: string
  action?: unknown
  result?: string | null
}

/** The error payload in `response.failed` and in HTTP error bodies. */
export interface WireErrorBody {
  type?: string
  code?: string
  message?: string
}

/** Why a response stopped short of completion. */
export interface WireIncompleteDetails {
  reason?: string
}

/** The `response` object carried by lifecycle events. */
export interface WireResponse {
  id?: string
  status?: string
  usage?: WireUsage | null
  error?: WireErrorBody | null
  incomplete_details?: WireIncompleteDetails | null
}

/** One decoded streaming event. */
export interface WireStreamEvent {
  type?: string
  response?: WireResponse
  item?: WireOutputItem
  item_id?: string
  output_index?: number
  content_index?: number
  summary_index?: number
  delta?: string
  text?: string
  partial_image_b64?: string
  partial_image_index?: number
  /** Present on a top-level `error` event, which carries its fields inline. */
  code?: string
  message?: string
}

/**
 * The narrow set of differences between the two endpoints that speak this
 * protocol.
 *
 * Expressed as data rather than as subclasses because the differences are all
 * "send this field or not" — behaviour is identical.
 */
export interface ResponsesDialect {
  /**
   * Whether `temperature` / `top_p` may be sent.
   *
   * The ChatGPT-backed Codex endpoint has no such fields in its request schema,
   * so sending them risks a rejection for no benefit.
   */
  readonly sampling: boolean
  /** Whether `max_output_tokens` may be sent. */
  readonly maxOutputTokens: boolean
  /** Value for `store`. Codex always sends false. */
  readonly store: boolean
  /** Values for `include`. */
  readonly include: readonly string[]
  /** Whether to ask for reasoning summaries, and how detailed. */
  readonly reasoningSummary?: 'auto' | 'concise' | 'detailed'
  /** Whether assistant message phase may be replayed on input. */
  readonly messagePhase?: boolean
  /**
   * Stable key letting the provider reuse a cached prompt prefix across turns.
   *
   * A dialect knob rather than an adapter concern because `prompt_cache_key` is a
   * field of THIS protocol; putting it here means any endpoint speaking Responses
   * gets prefix caching without post-processing the serialized body.
   */
  readonly promptCacheKey?: string
}
