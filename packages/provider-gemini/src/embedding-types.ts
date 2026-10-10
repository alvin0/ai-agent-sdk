import {
  type RetryPolicyConfig,
} from '@alvin0/ai-agent-sdk-core'
import {
  type CredentialInput,
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  type EmbeddingCatalogModel,
} from '@alvin0/ai-agent-sdk-provider-http'

/** Configuration for {@link geminiEmbeddingAdapter} and {@link geminiEmbeddingPlugin}. */
export interface GeminiEmbeddingProviderOptions {
  /** Injected key or credential source; universal packages never read the environment. */
  readonly apiKey: CredentialInput
  /** Extra endpoint headers, captured once per logical call; reserved names fail. */
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  /** Endpoint base; defaults to {@link GEMINI_EMBEDDING_BASE_URL}. */
  readonly baseUrl?: string
  /** Plugin id; defaults to `'gemini-embedding'`. */
  readonly id?: string
  /** Routes the plugin claims; defaults to `[id]`. */
  readonly routes?: readonly string[]
  /** Default model for the claimed route. */
  readonly defaultModel?: string | ModelTarget
  /** Declared embedding catalog; defaults to {@link GEMINI_EMBEDDING_MODELS}. */
  readonly models?: readonly EmbeddingCatalogModel[]
  /** Permit cleartext HTTP explicitly, for a trusted local endpoint only. */
  readonly allowInsecureHttp?: boolean
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxResponseChunks?: number
  readonly maxErrorBodyBytes?: number
  readonly requestLoggerTimeoutMs?: number
  readonly retryPolicy?: RetryPolicyConfig
  readonly fetch?: typeof globalThis.fetch
}

