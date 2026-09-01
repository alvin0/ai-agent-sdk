/** OpenAI provider: the Responses API on `api.openai.com`. */

export {
  OPENAI_API_KEY_ENV,
  OPENAI_BASE_URL,
  openAiAdapter,
  type OpenAiAdapterOptions,
  type OpenAiCredential,
} from './adapter.ts'
export {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@ai-agent-sdk/protocol-responses'
