/**
 * The OpenAI Responses API wire layer, shared by the `openai` and `codex`
 * providers. Not a provider itself — it has no endpoint and no credentials.
 */

export {
  serializeResponsesRequest,
  type ResponsesReasoningState,
} from './serialize.ts'
export { translateResponsesStream } from './translate.ts'
export type {
  ResponsesDialect,
  WireInputItem,
  WireRequest,
  WireStreamEvent,
  WireTool,
} from './wire.ts'
