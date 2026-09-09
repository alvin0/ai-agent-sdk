/** Universal Gemini Interactions provider adapter and transactional plugin. */

export {
  GEMINI_BASE_URL,
  geminiAdapter,
  geminiPlugin,
  type GeminiAdapterOptions,
  type GeminiCredential,
  type GeminiPluginOptions,
  type GeminiProviderOptions,
} from './adapter.ts'
export {
  geminiInteractionsProtocol,
  type GeminiInteractionsDialect,
} from '@ai-agent-sdk/protocol-gemini-interactions'
