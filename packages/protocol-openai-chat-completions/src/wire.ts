/**
 * The OpenAI Chat Completions wire shapes and the dialect describing how one
 * endpoint differs from another.
 *
 * "OpenAI-compatible" is a family, not a single API: gateways, Azure
 * deployments, editor-subscription endpoints, and self-hosted proxies all speak
 * this protocol with small, well-known divergences — which field caps the
 * output length, whether
 * `parallel_tool_calls` is accepted at all, whether the system prompt travels
 * as `system` or as `developer`. Those divergences are expressed here as DATA
 * ({@link ChatCompletionsDialect}) so the serializer and the translator stay
 * single-implementation.
 *
 * These types never leave this folder except through `ChatCompletionsDialect`.
 *
 * @module ai-agent-sdk/protocols/openai-chat-completions/wire
 */

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Detail level requested for an input image. */
export type WireImageDetail = 'auto' | 'low' | 'high'

/** One part of a multimodal message's content. */
export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: WireImageDetail } }

/**
 * A tool call as the assistant turn carries it.
 *
 * `arguments` is a JSON-encoded STRING, not an object. When replaying a prior
 * turn the string is sent back BYTE-FOR-BYTE as received: a
 * `JSON.parse`/`JSON.stringify` round-trip reorders keys and renormalizes
 * numbers, and some models use that exact string as context.
 */
export interface WireToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON-encoded STRING, verbatim. */
    arguments: string
  }
}

/**
 * One entry of the `messages` array.
 *
 * Note the shape of the conversation: unlike the Responses API's flat item
 * list, this is a list of MESSAGES. A tool result is its own message with
 * `role: 'tool'` correlated by `tool_call_id`, and an assistant turn that spoke
 * and called two tools stays a single message carrying both `content` and
 * `tool_calls`.
 */
export type WireMessage =
  | {
    /** `developer` is the newer spelling; which one to use is a dialect knob. */
    role: 'system' | 'developer'
    content: string
  }
  | {
    role: 'user'
    content: string | WireContentPart[]
  }
  | {
    role: 'assistant'
    /** Absent or null on a turn that only called tools. */
    content?: string | null
    tool_calls?: WireToolCall[]
  }
  | {
    role: 'tool'
    /** Correlates with the `id` of the assistant's tool call. */
    tool_call_id: string
    content: string
  }

/** A function tool, nested under a `function` key rather than flat. */
export interface WireFunctionTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean
  }
}

export type WireTool = WireFunctionTool

/** How the model must choose among the offered tools. */
export type WireToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

/** Output format controls. */
export type WireResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
    type: 'json_schema'
    json_schema: {
      name: string
      schema: Readonly<Record<string, unknown>>
      strict: true
    }
  }

/** Streaming extras. */
export interface WireStreamOptions {
  include_usage?: boolean
}

/**
 * The request body.
 *
 * Every optional field here is gated by a {@link ChatCompletionsDialect} flag,
 * and a disabled flag means the key is ABSENT — never `null`, never a default
 * value. Some gateways reject unknown-but-null keys outright, and a default
 * value silently changes behaviour the caller never asked for.
 */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: boolean
  stream_options?: WireStreamOptions
  /** Present under whichever name `dialect.maxTokensField` names. */
  max_tokens?: number
  /** The reasoning-model spelling of the same cap. */
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  stop?: string | string[]
  seed?: number
  reasoning_effort?: string
  tools?: WireTool[]
  tool_choice?: WireToolChoice
  parallel_tool_calls?: boolean
  response_format?: WireResponseFormat
  /** Stable key letting the endpoint reuse a cached prompt prefix. */
  prompt_cache_key?: string
  user?: string
}

// ---------------------------------------------------------------------------
// Response and streaming
// ---------------------------------------------------------------------------

/** Cached-token breakdown of the prompt count. */
export interface WirePromptTokensDetails {
  /** Portion of `prompt_tokens` served from cache — a SUBSET, not an addition. */
  cached_tokens?: number
}

/** Reasoning breakdown of the completion count. */
export interface WireCompletionTokensDetails {
  reasoning_tokens?: number
}

/** Token accounting as Chat Completions reports it. */
export interface WireUsage {
  prompt_tokens?: number
  prompt_tokens_details?: WirePromptTokensDetails | null
  completion_tokens?: number
  completion_tokens_details?: WireCompletionTokensDetails | null
  total_tokens?: number
}

/**
 * Why a choice stopped.
 *
 * A value other than `null` is the TERMINAL FINISH of the stream. `[DONE]` is
 * not: a truncated stream ends without ever producing one of these, and it is
 * indistinguishable from a short answer unless the translator insists on
 * seeing it.
 */
export type WireFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call'

/**
 * A tool-call fragment inside a streaming delta.
 *
 * `index` is the correlation key, NOT `id`: `id` and `function.name` arrive
 * once, usually on the first fragment, while `function.arguments` arrives in
 * many fragments that carry only `index`.
 */
export interface WireToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    /** One fragment of the JSON string. Concatenate; do not parse. */
    arguments?: string
  }
}

/** The incremental payload of one streamed choice. */
export interface WireChoiceDelta {
  role?: 'assistant'
  content?: string | null
  refusal?: string | null
  /** Non-standard but widely emitted by reasoning-capable endpoints. */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** One streamed choice. */
export interface WireStreamChoice {
  index?: number
  delta?: WireChoiceDelta
  finish_reason?: WireFinishReason | null
}

/**
 * One decoded `data:` payload of the stream.
 *
 * The usage-bearing final chunk has `choices: []`, so an empty `choices` array
 * is normal traffic rather than a malformed event.
 */
export interface WireStreamChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: WireStreamChoice[]
  usage?: WireUsage | null
  /** Some gateways inline an error into the stream instead of failing the HTTP call. */
  error?: WireErrorBody | null
}

/** One choice of a non-streamed response. */
export interface WireChoice {
  index?: number
  message?: {
    role?: string
    content?: string | null
    refusal?: string | null
    tool_calls?: WireToolCall[]
  }
  finish_reason?: WireFinishReason | null
}

/** A non-streamed response body. */
export interface WireResponse {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: WireChoice[]
  usage?: WireUsage | null
  error?: WireErrorBody | null
}

/** The error payload of an HTTP error body, and of inline stream errors. */
export interface WireErrorBody {
  type?: string
  code?: string | number
  message?: string
  param?: string | null
}

/** An HTTP error response body, which nests the payload under `error`. */
export interface WireErrorResponse {
  error?: WireErrorBody | string | null
}

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

/**
 * The set of differences between endpoints that speak Chat Completions.
 *
 * Expressed as data rather than as subclasses because the differences are all
 * "send this field, under this name, or not at all" — behaviour is identical.
 * Every flag maps one-to-one onto the presence of a wire field, and a disabled
 * flag means the field is absent from the body entirely.
 */
export interface ChatCompletionsDialect {
  /** Send `temperature`, `top_p`, `frequency_penalty`, `presence_penalty`. */
  readonly sampling: boolean
  /**
   * Name of the output-length field; `false` sends no field at all.
   *
   * A three-value enum rather than a boolean because this is exactly where
   * OpenAI-compatible endpoints split into two families: newer reasoning models
   * reject `max_tokens` and require `max_completion_tokens`, while older
   * gateways only understand `max_tokens`. A boolean would force each provider
   * to fork the translator; an enum keeps one.
   */
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens' | false
  /**
   * `response_format` support, three-state.
   *
   * `'json-schema'` sends the full schema with `strict: true`,
   * `'json-object'` sends only `{ type: 'json_object' }` for endpoints that
   * accept JSON mode but not schemas, and `false` sends nothing.
   */
  readonly structuredOutputs: 'json-schema' | 'json-object' | false
  /** Send `tools` + `tool_choice`. */
  readonly tools: boolean
  /** Send `parallel_tool_calls`. */
  readonly parallelToolCalls: boolean
  /** Send `stream_options: { include_usage: true }`. */
  readonly streamUsage: boolean
  /** Role the system prompt travels under in `messages[0]`. */
  readonly systemRole: 'system' | 'developer'
  /** Send `stop`. */
  readonly stop: boolean
  /** Send `seed`. */
  readonly seed: boolean
  /** Send `reasoning_effort`. */
  readonly reasoningEffort: boolean
  /** Prompt-cache key, sent when the endpoint accepts one. */
  readonly promptCacheKey?: string
  /**
   * Endpoint path appended to the base URL.
   *
   * Configurable because a gateway is free to mount the endpoint elsewhere, and
   * hard-coding the path would make such a gateway unreachable without forking
   * the protocol.
   */
  readonly path: string
}

/**
 * Conservative defaults.
 *
 * Conservative in one direction on purpose: a field an endpoint does not
 * understand is usually a hard HTTP 400, while a field left unsent merely
 * forgoes a feature. So `parallelToolCalls`, `seed` and `reasoningEffort` — the
 * three fields older gateways most often reject — stay OFF until a provider
 * opts in.
 *
 * Frozen because `defaultDialect` is snapshotted by the runtime and is shared
 * across every adapter built on this protocol; a mutable default is a
 * cross-provider side channel.
 */
export const DEFAULT_DIALECT: ChatCompletionsDialect = Object.freeze({
  sampling: true,
  maxTokensField: 'max_tokens',
  structuredOutputs: 'json-schema',
  tools: true,
  parallelToolCalls: false,
  streamUsage: true,
  systemRole: 'system',
  stop: true,
  seed: false,
  reasoningEffort: false,
  path: '/chat/completions',
} as const satisfies ChatCompletionsDialect)
