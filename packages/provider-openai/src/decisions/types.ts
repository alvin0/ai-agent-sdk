import type { CredentialInput, RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core/provider'

/** Native Decisions uses an API key, independently of Codex ChatGPT OAuth. */
export interface OpenAiDecisionAdapterOptions {
  readonly apiKey: CredentialInput
  /** API root, including /v1; defaults to https://api.openai.com/v1. */
  readonly baseUrl?: string | URL
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
  readonly safetyIdentifier?: string
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly retryPolicy?: RetryPolicyConfig
  readonly allowInsecureHttp?: boolean
}
export interface OpenAiDecisionPluginOptions extends OpenAiDecisionAdapterOptions {
  readonly id?: string
  readonly routes?: readonly string[]
}
