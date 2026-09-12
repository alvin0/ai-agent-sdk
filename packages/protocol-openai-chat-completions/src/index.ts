/** OpenAI Chat Completions wire schema, serializer, translator, and dialect. */

export type {
  ProtocolDefinition,
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from './contract.ts'
export {
  chatCompletionsErrorCode,
  chatCompletionsHttpError,
  chatCompletionsRequestId,
  chatCompletionsRetryAfterMs,
  chatCompletionsStreamError,
  chatCompletionsTransportError,
  isContentFilteredError,
  parseChatCompletionsErrorBody,
  type ChatCompletionsHttpFailure,
  type ParsedChatCompletionsError,
} from './errors.ts'
export {
  OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID,
  openAiChatCompletionsProtocol,
  type ChatCompletionsDialect,
  type ChatCompletionsProtocolDefinition,
} from './protocol.ts'
export { serializeChatCompletionsRequest } from './serialize.ts'
export { translateChatCompletionsStream } from './translate.ts'
export type * from './wire.ts'
