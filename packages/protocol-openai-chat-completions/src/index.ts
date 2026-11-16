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
  createOpenAiChatCompletionsProtocol,
  openAiChatCompletionsProtocol,
  type ChatCompletionsProtocolOptions,
  type ChatCompletionsDialect,
  type ChatCompletionsProtocolDefinition,
} from './protocol.ts'
export type { ChatCompletionsReasoningField, ChatCompletionsReasoningState } from './reasoning.ts'
export { serializeChatCompletionsRequest } from './serialize.ts'
export {
  jsonAnswerFromReasoning,
  translateChatCompletionsStream,
  type ChatCompletionsTranslateOptions,
} from './translate.ts'
export type * from './wire.ts'
