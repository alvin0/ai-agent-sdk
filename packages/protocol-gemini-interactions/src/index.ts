/** Gemini Interactions wire schema, serializer, translator, and dialect. */

export type {
  ProtocolDefinition,
  ProtocolRequest,
  ProtocolSseEvent,
  ProtocolStreamChunk,
} from './contract.ts'
export {
  GEMINI_INTERACTIONS_PROTOCOL_ID,
  geminiInteractionsProtocol,
  type GeminiInteractionsProtocolDefinition,
} from './protocol.ts'
export { serializeGeminiInteractionsRequest } from './serialize.ts'
export { translateGeminiInteractionsStream } from './translate.ts'
export type * from './wire.ts'
