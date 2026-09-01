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
export {
  anthropicMessagesProtocol,
  type AnthropicDialect,
  type AnthropicReasoningState,
  type ThinkingBudgets,
} from '@ai-agent-sdk/protocol-anthropic-messages'
