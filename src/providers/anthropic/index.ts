/** Anthropic provider: the Messages API on `api.anthropic.com`. */

export {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicAdapter,
  type AnthropicAdapterOptions,
  type AnthropicCredential,
} from './adapter.ts'
export { anthropicMessagesProtocol, type AnthropicDialect } from '../protocols/anthropic-messages.ts'
export type { AnthropicReasoningState, ThinkingBudgets } from './serialize.ts'
