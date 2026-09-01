/**
 * The wire protocols this package implements, reusable by any endpoint.
 *
 * Deliberately NOT a mutable global registry. A protocol is passed by value to
 * {@link createHttpProvider}, so a third party can supply its own without
 * mutating shared state and without this module having to know about it.
 */

export {
  ANTHROPIC_MESSAGES_PROTOCOL_ID,
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicMessagesProtocol,
  type AnthropicDialect,
  type ThinkingBudgets,
} from './anthropic-messages.ts'
export {
  OPENAI_RESPONSES_PROTOCOL_ID,
  openAiResponsesProtocol,
  type ResponsesDialect,
} from './openai-responses.ts'
export {
  resolveDialect,
  type AnyWireProtocol,
  type WireProtocol,
} from './protocol.ts'
