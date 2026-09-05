import type {
  GenerateOptions,
  ModelTarget,
  ResolvedModelInfo,
  StreamChunk,
  UsageCounters,
} from '@ai-agent-sdk/core/provider'

export interface ProtocolRequest {
  readonly options: GenerateOptions
  readonly maxTokens: number
}

export interface ProtocolSseEvent {
  readonly event: string | undefined
  readonly data: string
}

export type ProtocolStreamChunk =
  | Exclude<StreamChunk, { readonly type: 'usage' }>
  | { readonly type: 'usage'; readonly usage: UsageCounters }

/** Marker-free compatibility contract retained for advanced protocol authors. */
export interface ProtocolDefinition<Dialect> {
  readonly id: string
  readonly defaultDialect: Dialect
  endpointPath(request: ProtocolRequest, dialect: Dialect): string
  protocolHeaders?(dialect: Dialect): Record<string, string>
  serialize(request: ProtocolRequest, dialect: Dialect): unknown | Promise<unknown>
  translate(
    events: AsyncIterable<ProtocolSseEvent>,
    request: ProtocolRequest,
    displayName: string,
  ): AsyncGenerator<ProtocolStreamChunk>
}

export type WireImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }

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

export type WireToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: WireImageSource }

export type WireRequestBlock =
  | { type: 'text'; text: string; citations?: WireCitation[] }
  | { type: 'image'; source: WireImageSource }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
    type: 'tool_result'
    tool_use_id: string
    content: WireToolResultContent[] | string
    is_error?: boolean
  }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | WireServerToolUseBlock
  | WireWebSearchToolResultBlock

export interface WireMessage {
  role: 'user' | 'assistant'
  content: WireRequestBlock[]
}

export interface WireFunctionTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

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

export type WireToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string }

export type WireThinking =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' }

export interface WireRequest {
  model: string
  max_tokens: number
  messages: WireMessage[]
  system?: string
  tools?: WireTool[]
  tool_choice?: WireToolChoice
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  thinking?: WireThinking
  stream?: boolean
}

export interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export type WireStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'

export type WireResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | WireServerToolUseBlock
  | WireWebSearchToolResultBlock

export type WireDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'citations_delta'; citation: WireCitation }

export type WireStreamEvent =
  | {
    type: 'message_start'
    message: { id?: string; model?: string; usage?: WireUsage }
  }
  | { type: 'content_block_start'; index: number; content_block: WireResponseBlock }
  | { type: 'content_block_delta'; index: number; delta: WireDelta }
  | { type: 'content_block_stop'; index: number }
  | {
    type: 'message_delta'
    delta: {
      stop_reason?: WireStopReason | null
      stop_sequence?: string | null
    }
    usage?: WireUsage
  }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: WireErrorBody }

export interface WireErrorBody {
  type?: string
  message?: string
}

export interface WireErrorResponse {
  type?: 'error'
  error?: WireErrorBody
}

export interface AnthropicReasoningState {
  kind: 'thinking' | 'redacted_thinking'
  signature?: string
  data?: string
}

export type ThinkingBudgets = Readonly<Record<string, number>>

export interface AnthropicSerializeOptions {
  budgets: ThinkingBudgets
}

export interface AnthropicDialect {
  readonly budgets: ThinkingBudgets
  readonly version: string
  readonly beta: readonly string[]
}

/** Preferred descriptive alias; AnthropicDialect remains the canonical type. */
export type AnthropicMessagesDialect = AnthropicDialect

interface RuntimeProtocolRequest extends ProtocolRequest {
  readonly model: ResolvedModelInfo
  readonly connection: {
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>>
  }
}

/** Marker-based runtime view consumed by the composable HTTP provider. */
export interface AnthropicMessagesProtocolDefinition {
  readonly kind: 'http-wire-protocol'
  readonly apiVersion: 1
  readonly id: string
  readonly defaultDialect: AnthropicDialect
  readonly exampleModel?: ModelTarget
  readonly endpointPath: (
    request: RuntimeProtocolRequest,
    dialect: AnthropicDialect,
  ) => string
  readonly protocolHeaders?: (
    dialect: AnthropicDialect,
  ) => Readonly<Record<string, string>>
  readonly serialize: (
    request: RuntimeProtocolRequest,
    dialect: AnthropicDialect,
  ) => Readonly<Record<string, unknown>>
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: RuntimeProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

export declare const ANTHROPIC_MESSAGES_PROTOCOL_ID: 'anthropic-messages'
export declare const ANTHROPIC_VERSION: '2023-06-01'
export declare const DEFAULT_THINKING_BUDGETS: ThinkingBudgets

export declare const anthropicMessagesProtocol:
  & ProtocolDefinition<AnthropicDialect>
  & AnthropicMessagesProtocolDefinition

export declare function serializeAnthropicRequest(
  request: ProtocolRequest,
  options: AnthropicSerializeOptions,
): WireRequest

export declare function translateAnthropicStream(
  events: AsyncIterable<ProtocolSseEvent>,
  displayName: string,
): AsyncGenerator<ProtocolStreamChunk>
