/** Node provider surface: Universal transports plus project-local Codex defaults. */

export * from '@ai-agent-sdk/provider-http'
export * from '@ai-agent-sdk/provider-anthropic'
export * from '@ai-agent-sdk/provider-openai'
export * from '@ai-agent-sdk/auth-node/codex'

/** Full wire packages remain namespaced to avoid ambiguous shared contract type names. */
export * as anthropicMessages from '@ai-agent-sdk/protocol-anthropic-messages'
export * as responses from '@ai-agent-sdk/protocol-responses'
/** Injected-store Codex remains available explicitly; Node-named factories are the defaults above. */
export * as universalCodex from '@ai-agent-sdk/provider-codex'

// Resolve intentional protocol/provider duplicate bindings explicitly.
export {
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicMessagesProtocol,
} from '@ai-agent-sdk/provider-anthropic'
export { openAiResponsesProtocol } from '@ai-agent-sdk/provider-openai'
