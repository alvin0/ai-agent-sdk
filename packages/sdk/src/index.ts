/** Universal compatibility root. Node capabilities are intentionally absent. */

export * from '@ai-agent-sdk/core'
export * from '@ai-agent-sdk/agent'

export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  HttpModelAdapter,
  createHttpProvider,
  httpErrorCode,
  parseErrorBody,
  parseSse,
  requestIdFrom,
  resolveDialect,
  retryAfterMs,
  type AuthScheme,
  type CredentialSource,
  type HttpConnection,
  type HttpProviderOptions,
  type ModelDiscoveryContext,
  type ParsedErrorBody,
  type ProviderCatalogModel,
  type ProviderRequest,
  type ProviderRequestLogger,
  type ProviderRequestLogRecord,
  type SseEvent,
  type WireProtocol,
} from '@ai-agent-sdk/provider-http'
export {
  ANTHROPIC_MESSAGES_PROTOCOL_ID,
  anthropicMessagesProtocol,
  type AnthropicDialect,
} from '@ai-agent-sdk/protocol-anthropic-messages'
export {
  OPENAI_RESPONSES_PROTOCOL_ID,
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@ai-agent-sdk/protocol-responses'
