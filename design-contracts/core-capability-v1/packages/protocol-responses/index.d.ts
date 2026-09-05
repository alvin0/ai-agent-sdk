import type {
  GenerateOptions,
  ModelTarget,
  ResolvedModelInfo,
  StreamChunk,
  UsageCounters,
} from '@ai-agent-sdk/core/provider'

/** Marker-free compatibility contract retained for advanced protocol authors. */
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

/** Existing advanced protocol shape; runtime family markers remain additive. */
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

export type WireImageDetail = 'auto' | 'low' | 'high' | 'original'

export type WireContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: WireImageDetail }
  | { type: 'input_image'; file_id: string; detail?: WireImageDetail }
  | {
    type: 'output_text'
    text: string
    annotations?: WireTextAnnotation[]
  }

export interface WireTextAnnotation {
  type: 'url_citation'
  url: string
  title?: string
  start_index?: number
  end_index?: number
}

export interface WireReasoningSummary {
  type: 'summary_text'
  text: string
}

export interface WireReasoningContent {
  type: 'reasoning_text'
  text: string
}

export type WireInputItem =
  | {
    type: 'message'
    role: 'user' | 'assistant' | 'developer' | 'system'
    content: WireContentPart[]
    phase?: 'commentary' | 'final_answer'
  }
  | {
    type: 'function_call'
    call_id: string
    name: string
    arguments: string
    id?: string
  }
  | {
    type: 'function_call_output'
    call_id: string
    output: string | WireContentPart[]
  }
  | {
    type: 'reasoning'
    id?: string
    summary: WireReasoningSummary[]
    content?: WireReasoningContent[]
    encrypted_content?: string | null
  }
  | {
    type: 'web_search_call'
    id?: string
    status?: string
    action?: unknown
  }
  | {
    type: 'image_generation_call'
    id?: string
    status?: string
    result?: string | null
  }

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

export type WireToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }
  | { type: string }

export interface WireReasoning {
  effort?: string
  summary?: 'auto' | 'concise' | 'detailed' | 'none'
}

export interface WireTextControls {
  verbosity?: 'low' | 'medium' | 'high'
}

export interface WireRequest {
  model: string
  instructions?: string
  input: WireInputItem[]
  tools?: WireTool[]
  tool_choice?: WireToolChoice
  parallel_tool_calls?: boolean
  reasoning?: WireReasoning
  text?: WireTextControls
  store: boolean
  stream: boolean
  include?: string[]
  prompt_cache_key?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
}

export interface WireInputTokensDetails {
  cached_tokens?: number
  cache_write_tokens?: number
}

export interface WireOutputTokensDetails {
  reasoning_tokens?: number
}

export interface WireUsage {
  input_tokens?: number
  input_tokens_details?: WireInputTokensDetails | null
  output_tokens?: number
  output_tokens_details?: WireOutputTokensDetails | null
  total_tokens?: number
}

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

export interface WireErrorBody {
  type?: string
  code?: string
  message?: string
}

export interface WireIncompleteDetails {
  reason?: string
}

export interface WireResponse {
  id?: string
  status?: string
  usage?: WireUsage | null
  error?: WireErrorBody | null
  incomplete_details?: WireIncompleteDetails | null
}

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
  code?: string
  message?: string
}

export interface ResponsesDialect {
  readonly sampling: boolean
  readonly maxOutputTokens: boolean
  readonly store: boolean
  readonly include: readonly string[]
  readonly reasoningSummary?: 'auto' | 'concise' | 'detailed'
  readonly messagePhase?: boolean
  readonly promptCacheKey?: string
}

export interface ResponsesReasoningState {
  id?: string
  encryptedContent?: string
  summary?: readonly string[]
}

interface RuntimeProtocolRequest extends ProtocolRequest {
  readonly model: ResolvedModelInfo
  readonly connection: {
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>>
  }
}

/** Marker-based runtime view consumed by the composable HTTP provider. */
export interface ResponsesProtocolDefinition {
  readonly kind: 'http-wire-protocol'
  readonly apiVersion: 1
  readonly id: string
  readonly defaultDialect: ResponsesDialect
  readonly exampleModel?: ModelTarget
  readonly endpointPath: (
    request: RuntimeProtocolRequest,
    dialect: ResponsesDialect,
  ) => string
  readonly protocolHeaders?: (
    dialect: ResponsesDialect,
  ) => Readonly<Record<string, string>>
  readonly serialize: (
    request: RuntimeProtocolRequest,
    dialect: ResponsesDialect,
  ) => Readonly<Record<string, unknown>>
  readonly translate: (
    events: AsyncIterable<ProtocolSseEvent>,
    request: RuntimeProtocolRequest,
    displayName: string,
  ) => AsyncGenerator<ProtocolStreamChunk>
}

export declare const OPENAI_RESPONSES_PROTOCOL_ID: 'openai-responses'

export declare const openAiResponsesProtocol:
  & ProtocolDefinition<ResponsesDialect>
  & ResponsesProtocolDefinition

export declare function serializeResponsesRequest(
  request: ProtocolRequest,
  dialect: ResponsesDialect,
): WireRequest

export declare function translateResponsesStream(
  events: AsyncIterable<ProtocolSseEvent>,
  displayName: string,
  request?: ProtocolRequest,
): AsyncGenerator<ProtocolStreamChunk>
