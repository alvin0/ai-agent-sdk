/**
 * The OpenAI Responses API wire layer, shared by the `openai` and `codex`
 * providers. Not a provider itself — it has no endpoint and no credentials.
 */

export {
  serializeResponsesRequest,
  type ResponsesReasoningState,
  translateResponsesStream,
} from '@ai-agent-sdk/protocol-responses'
export type {
  ResponsesDialect,
  WireInputItem,
  WireRequest,
  WireStreamEvent,
  WireTool,
} from '@ai-agent-sdk/protocol-responses'
