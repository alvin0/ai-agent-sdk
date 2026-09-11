export interface GeminiInteractionsDialect {
  /** Whether Google may retain the request and interaction. Defaults to false. */
  readonly store: boolean
  /** Whether thought summaries should be requested when reasoning is selected. */
  readonly thinkingSummaries: 'auto' | 'none'
}

export interface WireTextContent {
  type: 'text'
  text: string
  annotations?: WireAnnotation[]
}

export interface WireImageContent {
  type: 'image'
  data?: string
  uri?: string
  mime_type?: string
  resolution?: 'low' | 'medium' | 'high' | 'ultra_high'
}

/** An inline or uploaded document, read with native vision rather than as text. */
export interface WireDocumentContent {
  type: 'document'
  data?: string
  uri?: string
  mime_type?: string
}

export type WireContent = WireTextContent | WireImageContent | WireDocumentContent

export type WireStep =
  | { type: 'user_input'; content: WireContent[] }
  | { type: 'model_output'; content: WireContent[] }
  | { type: 'thought'; signature?: string; summary?: WireContent[] }
  | { type: 'function_call'; id: string; name: string; arguments: Record<string, unknown> }
  | {
    type: 'function_result'
    call_id: string
    name?: string
    result: string | Record<string, unknown> | WireContent[]
    is_error?: boolean
  }

export interface WireFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Readonly<Record<string, unknown>>
}

export interface WireGoogleSearchTool {
  type: 'google_search'
  search_types: ['web_search']
}

export type WireTool = WireFunctionTool | WireGoogleSearchTool

export type WireToolChoice =
  | 'auto'
  | 'any'
  | 'none'
  | {
    allowed_tools: {
      mode: 'any'
      tools: string[]
    }
  }

export interface WireGenerationConfig {
  max_output_tokens: number
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  thinking_level?: string
  thinking_summaries?: 'auto' | 'none'
  tool_choice?: WireToolChoice
}

export type WireResponseFormat =
  | { type: 'text'; mime_type: 'text/plain' }
  | {
    type: 'text'
    mime_type: 'application/json'
    schema: Readonly<Record<string, unknown>>
  }

export interface WireRequest {
  model: string
  input: WireStep[]
  system_instruction?: string
  tools?: WireTool[]
  response_format?: WireResponseFormat
  stream: true
  store: boolean
  generation_config: WireGenerationConfig
}

export interface GeminiThoughtState {
  signature?: string
  summary?: readonly WireContent[]
}

export interface WireAnnotation {
  type?: string
  url?: string
  title?: string
  start_index?: number
  end_index?: number
  [key: string]: unknown
}

export interface WireStepData {
  type?: string
  content?: unknown
  summary?: unknown
  signature?: string
  id?: string
  name?: string
  arguments?: unknown
}

export interface WireDelta {
  type?: string
  text?: string
  arguments?: string
  signature?: string
  content?: unknown
  annotations?: unknown
}

export interface WireUsage {
  total_input_tokens?: number
  total_output_tokens?: number
  total_cached_tokens?: number
  total_thought_tokens?: number
  total_tool_use_tokens?: number
  total_tokens?: number
}

export interface WireInteraction {
  id?: string
  status?: string
  usage?: WireUsage | null
}

export interface WireError {
  code?: string
  message?: string
}

export interface WireStreamEvent {
  event_type?: string
  index?: number
  step?: WireStepData
  delta?: WireDelta
  interaction?: WireInteraction
  error?: WireError
}
