/** Universal OpenAI provider adapter and transactional plugin. */

export {
  OPENAI_BASE_URL,
  openAiAdapter,
  openAiPlugin,
  type OpenAiAdapterOptions,
  type OpenAiCatalogModel,
  type OpenAiChatCompletionsCompat,
  type OpenAiCredential,
  type OpenAiPluginOptions,
  type OpenAiProviderOptions,
} from './adapter.ts'
export type { OpenAiApi } from './dual-api.ts'
export {
  openAiEmbeddingAdapter,
  openAiEmbeddingPlugin,
  type OpenAiEmbeddingProviderOptions,
} from './embedding.ts'
export {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'
// Both wire protocols this provider speaks are re-exported, not just Responses:
// `api: 'chat-completions'` makes the second one reachable through the same
// adapter, so its dialect has to be nameable by a caller tuning `compat`.
export {
  openAiChatCompletionsProtocol,
  type ChatCompletionsDialect,
} from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'
