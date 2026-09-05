import {
  OPENAI_RESPONSES_PROTOCOL_ID,
  openAiResponsesProtocol,
  serializeResponsesRequest,
  translateResponsesStream,
  type ProtocolDefinition,
  type ProtocolRequest,
  type ProtocolSseEvent,
  type ProtocolStreamChunk,
  type ResponsesDialect,
  type ResponsesReasoningState,
  type WireContentPart,
  type WireErrorBody,
  type WireFunctionTool,
  type WireImageDetail,
  type WireIncompleteDetails,
  type WireInputItem,
  type WireInputTokensDetails,
  type WireNativeTool,
  type WireOutputItem,
  type WireOutputTokensDetails,
  type WireReasoning,
  type WireReasoningContent,
  type WireReasoningSummary,
  type WireRequest,
  type WireResponse,
  type WireStreamEvent,
  type WireTextAnnotation,
  type WireTextControls,
  type WireTool,
  type WireToolChoice,
  type WireUsage,
} from '@ai-agent-sdk/protocol-responses'

export type ResponsesProtocolTypeInventory = [
  ProtocolDefinition<ResponsesDialect>,
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
  ResponsesDialect,
  ResponsesReasoningState,
  WireContentPart,
  WireErrorBody,
  WireFunctionTool,
  WireImageDetail,
  WireIncompleteDetails,
  WireInputItem,
  WireInputTokensDetails,
  WireNativeTool,
  WireOutputItem,
  WireOutputTokensDetails,
  WireReasoning,
  WireReasoningContent,
  WireReasoningSummary,
  WireRequest,
  WireResponse,
  WireStreamEvent,
  WireTextAnnotation,
  WireTextControls,
  WireTool,
  WireToolChoice,
  WireUsage,
]

export type ResponsesProtocolValueInventory = [
  typeof OPENAI_RESPONSES_PROTOCOL_ID,
  typeof openAiResponsesProtocol,
  typeof serializeResponsesRequest,
  typeof translateResponsesStream,
]

const dialect: ResponsesDialect = {
  sampling: true,
  maxOutputTokens: true,
  store: false,
  include: ['reasoning.encrypted_content'],
  reasoningSummary: 'concise',
  messagePhase: true,
  promptCacheKey: 'compatibility',
}

const toolResult: WireInputItem = {
  type: 'function_call_output',
  call_id: 'call-1',
  output: [{ type: 'input_text', text: 'result' }],
}

const nativeTool: WireNativeTool = { type: 'web_search_preview' }
const toolChoice: WireToolChoice = { type: 'function', name: 'lookup' }
void toolResult
void nativeTool
void toolChoice

export function exerciseResponsesProtocol(
  request: ProtocolRequest,
  events: AsyncIterable<ProtocolSseEvent>,
): {
  readonly protocol: ProtocolDefinition<ResponsesDialect>
  readonly wire: WireRequest
  readonly stream: AsyncGenerator<ProtocolStreamChunk>
} {
  return {
    protocol: openAiResponsesProtocol,
    wire: serializeResponsesRequest(request, dialect),
    stream: translateResponsesStream(events, 'Responses compatibility', request),
  }
}
