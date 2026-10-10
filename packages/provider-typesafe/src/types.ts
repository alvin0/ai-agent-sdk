import { type CredentialInput, type RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core/provider'
import { type DecisionInput } from '@alvin0/ai-agent-sdk-decision-adapter'

export interface TypesafeAdapterOptions {
  readonly apiKey: CredentialInput
  /** API root including /v1. Default: https://api.typesafe.ai/v1 */
  readonly baseUrl?: string | URL
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>>
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly retryPolicy?: RetryPolicyConfig
  /** For explicitly configured development endpoints only. */
  readonly allowInsecureHttp?: boolean
}

export interface TypesafePluginOptions extends TypesafeAdapterOptions {
  readonly id?: string
  readonly routes?: readonly string[]
}

export interface CapturedTypesafeRequest { readonly input: DecisionInput; readonly wire: string;
  readonly timeout: number; readonly provider: string; readonly model: string;
    readonly headers: Readonly<Record<string, string>> }
