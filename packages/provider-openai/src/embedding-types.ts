import { type RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import {
  type CredentialInput,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  type EmbeddingCatalogModel,
} from '@alvin0/ai-agent-sdk-provider-http'

/** Options for {@link openAiEmbeddingAdapter} and {@link openAiEmbeddingPlugin}. */
export interface OpenAiEmbeddingProviderOptions {
  /** Injected API key or credential source; universal packages never read the environment. */
  readonly apiKey: CredentialInput
  /** Extra endpoint headers, captured once per logical call; reserved names fail. */
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  /**
   * Endpoint base; defaults to {@link OPENAI_BASE_URL}.
   *
   * Point this at a self-hosted OpenAI-compatible endpoint. Declare that
   * endpoint's models through {@link models}: the compatibility claim is the
   * configuration's, not this adapter's (Requirement 15.3).
   */
  readonly baseUrl?: string
  /** Organization to bill, when the key belongs to several. */
  readonly organization?: string
  /** Project to attribute usage to. */
  readonly project?: string
  /** Plugin id; also the default route. Defaults to `'openai'`. */
  readonly id?: string
  /** Registry routes the plugin claims. Defaults to `[id]`. */
  readonly routes?: readonly string[]
  /**
   * Advisory embedding catalog.
   *
   * Empty by default, for the same reason the generation adapter ships no model
   * list: a stale built-in catalog would name retired models. A declared entry is
   * what makes `dimensions` reachable on the wire and what states the embedding
   * space, so a route that cares about either declares its models.
   */
  readonly models?: readonly EmbeddingCatalogModel[]
  /** Permit cleartext HTTP explicitly, for trusted local endpoints only. */
  readonly allowInsecureHttp?: boolean
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxResponseChunks?: number
  readonly maxErrorBodyBytes?: number
  readonly requestLoggerTimeoutMs?: number
  /** Retry policy this route owns. */
  readonly retryPolicy?: RetryPolicyConfig
  readonly fetch?: typeof globalThis.fetch
}

