import {
  ANTHROPIC_MESSAGES_PROTOCOL_ID,
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicMessagesProtocol,
  serializeAnthropicRequest,
  translateAnthropicStream,
  type AnthropicDialect,
  type AnthropicReasoningState,
  type AnthropicSerializeOptions,
  type ProtocolDefinition,
  type ProtocolRequest,
  type ProtocolSseEvent,
  type ProtocolStreamChunk,
  type ThinkingBudgets,
  type WireCitation,
  type WireDelta,
  type WireErrorBody,
  type WireErrorResponse,
  type WireFunctionTool,
  type WireImageSource,
  type WireMessage,
  type WireRequest,
  type WireRequestBlock,
  type WireResponseBlock,
  type WireServerToolUseBlock,
  type WireStopReason,
  type WireStreamEvent,
  type WireThinking,
  type WireTool,
  type WireToolChoice,
  type WireToolResultContent,
  type WireUsage,
  type WireWebSearchTool,
  type WireWebSearchToolResultBlock,
} from '@ai-agent-sdk/protocol-anthropic-messages'

export type AnthropicProtocolTypeInventory = [
  AnthropicDialect,
  AnthropicReasoningState,
  AnthropicSerializeOptions,
  ProtocolDefinition<AnthropicDialect>,
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
  ThinkingBudgets,
  WireCitation,
  WireDelta,
  WireErrorBody,
  WireErrorResponse,
  WireFunctionTool,
  WireImageSource,
  WireMessage,
  WireRequest,
  WireRequestBlock,
  WireResponseBlock,
  WireServerToolUseBlock,
  WireStopReason,
  WireStreamEvent,
  WireThinking,
  WireTool,
  WireToolChoice,
  WireToolResultContent,
  WireUsage,
  WireWebSearchTool,
  WireWebSearchToolResultBlock,
]

export type AnthropicProtocolValueInventory = [
  typeof ANTHROPIC_MESSAGES_PROTOCOL_ID,
  typeof ANTHROPIC_VERSION,
  typeof DEFAULT_THINKING_BUDGETS,
  typeof anthropicMessagesProtocol,
  typeof serializeAnthropicRequest,
  typeof translateAnthropicStream,
]

const thinking: WireRequestBlock = {
  type: 'thinking',
  thinking: 'opaque-to-host-logs',
  signature: 'provider-signature',
}

const serverSearch: WireWebSearchTool = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3,
}
void thinking
void serverSearch

export function exerciseAnthropicProtocol(
  request: ProtocolRequest,
  events: AsyncIterable<ProtocolSseEvent>,
): {
  readonly protocol: ProtocolDefinition<AnthropicDialect>
  readonly wire: WireRequest
  readonly stream: AsyncGenerator<ProtocolStreamChunk>
} {
  return {
    protocol: anthropicMessagesProtocol,
    wire: serializeAnthropicRequest(request, { budgets: DEFAULT_THINKING_BUDGETS }),
    stream: translateAnthropicStream(events, 'Anthropic compatibility'),
  }
}
