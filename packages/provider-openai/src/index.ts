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
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@ai-agent-sdk/protocol-responses'
