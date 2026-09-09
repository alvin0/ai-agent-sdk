import type {
  CredentialInput,
  ModelInvocationContext,
  ResolvedModelInfo,
  RetryPolicyConfig,
} from '@alvin0/ai-agent-sdk-core/provider'
import type { ProviderCatalogModel, ProviderRequestLogger } from '../base/http-adapter.ts'
import type {
  HttpAuthResolveOptions,
  RuntimeWireProtocol,
} from '../protocol/runtime-types.ts'

export type RuntimeCredentialSource = CredentialInput

export type RuntimeAuthScheme =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly token: RuntimeCredentialSource; readonly label?: string }
  | {
    readonly kind: 'header'
    readonly name: string
    readonly value: RuntimeCredentialSource
    readonly label?: string
  }
  | {
    readonly kind: 'dynamic'
    readonly resolve: (
      options: HttpAuthResolveOptions,
    ) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>
  }

export interface RuntimeModelDiscoveryContext {
  readonly provider: string
  readonly baseUrl: URL
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly context?: ModelInvocationContext
}

export interface RuntimeHttpProviderOptions<Dialect extends object> {
  readonly displayName: string
  readonly protocol: RuntimeWireProtocol<Dialect>
  readonly baseUrl: string | URL
  readonly allowInsecureHttp?: boolean
  readonly auth: RuntimeAuthScheme
  readonly models?: readonly ProviderCatalogModel[]
  readonly dialect?: Partial<Dialect>
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  readonly discoverModels?: (
    context: RuntimeModelDiscoveryContext,
  ) => Promise<readonly ProviderCatalogModel[]>
  readonly catalogTtlMs?: number
  readonly catalogStaleTtlMs?: number
  readonly catalogFailureBackoffMs?: number
  readonly maxCatalogModels?: number
  readonly maxCatalogBytes?: number
  readonly describeModel?: (info: ResolvedModelInfo, dialect: Dialect) => ResolvedModelInfo
  readonly defaultMaxTokens?: number
  readonly defaultContextWindow?: number
  readonly streamIdleTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxResponseChunks?: number
  readonly maxSseEvents?: number
  readonly maxSseEventChars?: number
  readonly maxErrorBodyBytes?: number
  readonly requestLoggerTimeoutMs?: number
  readonly retryPolicy?: RetryPolicyConfig
  readonly errorCode?: (status: number, detail: string) => string | undefined
  readonly baseHeaders?: Readonly<Record<string, string>>
  readonly requestLogger?: ProviderRequestLogger
}
