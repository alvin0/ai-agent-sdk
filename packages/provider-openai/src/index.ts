/** Universal OpenAI provider adapter and transactional plugin. */

export {
  OPENAI_BASE_URL,
  openAiAdapter,
  openAiPlugin,
  type OpenAiAdapterOptions,
  type OpenAiCredential,
  type OpenAiPluginOptions,
  type OpenAiProviderOptions,
} from './adapter.ts'
export {
  openAiEmbeddingAdapter,
  openAiEmbeddingPlugin,
  type OpenAiEmbeddingProviderOptions,
} from './embedding.ts'
export {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'
