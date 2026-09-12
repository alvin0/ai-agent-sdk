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
  GEMINI_EMBEDDING_BASE_URL,
  GEMINI_EMBEDDING_MODELS,
  geminiEmbeddingAdapter,
  geminiEmbeddingPlugin,
  type GeminiEmbeddingProviderOptions,
} from './embedding.ts'
export {
  geminiInteractionsProtocol,
  type GeminiInteractionsDialect,
} from '@alvin0/ai-agent-sdk-protocol-gemini-interactions'
