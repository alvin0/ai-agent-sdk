import type { ModelInvocationContext, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import { type RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import {
  type ProviderCatalogModel,
  type ProviderRequestLogger,
  type ProviderResponseLogger,
} from '../base/http-adapter.ts'
import { type WireProtocol } from '../protocol/protocol.ts'
import type { HeaderContext } from '../common/endpoint-headers.ts'

/** A credential, either literal or resolved per operation. */
export type CredentialSource = string | ((
  signal?: AbortSignal,
  context?: ModelInvocationContext,
) => string | Promise<string>)

/**
 * How requests are authenticated.
 *
 * `dynamic` is the escape hatch that keeps OAuth out of subclass territory: it is
 * called once per operation, so it can refresh a token, read a rotating secret, or
 * add account-scoping headers.
 */
export type AuthScheme =
  /** Unauthenticated — a local server, or an endpoint behind a network boundary. */
  | { kind: 'none' }
  /** `authorization: Bearer <token>`. */
  | { kind: 'bearer'; token: CredentialSource; label?: string }
  /** A named header, e.g. `x-api-key`. */
  | { kind: 'header'; name: string; value: CredentialSource; label?: string }
  /** Arbitrary headers resolved per operation. */
  | {
    kind: 'dynamic'
    resolve: (
      signal?: AbortSignal,
      context?: ModelInvocationContext,
      provider?: string,
    ) => Record<string, string> | Promise<Record<string, string>>
  }
  /**
   * A named query-string parameter, e.g. Azure's `?key=`. Never a header —
   * the value reaches the URL instead — but still resolved alongside every
   * other scheme and still redacted in logs by name.
   */
  | { kind: 'query'; name: string; value: CredentialSource; label?: string }

export interface ResolvedAuth {
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
}

/** Normalize a single scheme or an array of schemes into an array. */

/** Union several name/value records, case-insensitively, failing fast on a name two entries both set. */

/** What `transformRequest` sees alongside the body. */
export interface RequestContext {
  /** Registered provider route. */
  readonly provider: string
  /** Exact model id for this call. */
  readonly model: string
  /** Stable code-owned agent identity, when this call belongs to one and the caller supplied it. */
  readonly agentId?: string
  readonly signal?: AbortSignal
}

/** What a model-discovery hook receives. */
export interface ModelDiscoveryContext {
  /** The endpoint base, with no trailing slash. */
  readonly baseUrl: string
  /** Every header the request would carry, including authentication. */
  readonly headers: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** Additive runtime context; legacy discovery hooks may ignore it. */
  readonly provider?: string
  /** Additive invocation context; legacy discovery hooks may ignore it. */
  readonly context?: ModelInvocationContext
}

/** Configuration for {@link createHttpProvider}. */
export interface HttpProviderOptions<Dialect extends object> {
  /** Human-readable name used in every diagnostic. */
  displayName: string
  /** The wire protocol this endpoint speaks. */
  protocol: WireProtocol<Dialect>
  /** Endpoint base; the protocol's path is appended. */
  baseUrl: string
  /** Permit cleartext HTTP explicitly, for trusted local development only. */
  allowInsecureHttp?: boolean
  /** Captured fetch implementation for tests, custom runtimes, and transport policy. */
  fetch?: typeof globalThis.fetch
  /**
   * How to authenticate. An array resolves every scheme and unions their
   * headers — a gateway key alongside an upstream key, for instance. Each
   * entry's headers are marked sensitive and redacted in logs; two entries
   * producing the same header name fail fast, before either credential
   * resolves.
   */
  auth: AuthScheme | readonly AuthScheme[]
  /**
   * Per-endpoint protocol knobs, merged over the protocol's defaults.
   *
   * Partial, so a protocol can gain a knob without any endpoint needing an edit.
   */
  dialect?: Partial<Dialect>
  /** Extra static headers, or a resolver receiving `{ provider, agentId?, signal? }`. */
  headers?: Record<string, string> | ((ctx: HeaderContext) => Record<string, string>)
  /**
   * Override the request path every protocol would otherwise pick for itself
   * (e.g. an Azure OpenAI deployment path). Applies uniformly to every request
   * this endpoint sends; a protocol's own default stays in force when unset.
   */
  path?: string
  /**
   * Extra query-string parameters, or a resolver for them (e.g. Azure's
   * `api-version`). Never for secrets — a value here is NOT redacted in logs;
   * put a credential in `auth` instead.
   */
  query?: Record<string, string> | (() => Record<string, string>)
  /**
   * Fields to deep-merge into the serialized body, route-wide. The caller's
   * value always wins, even over a field the SDK set (`model`, `max_tokens`,
   * `reasoning`, `stream`, …) — decision 12. A `null` value deletes the field.
   */
  body?: Readonly<Record<string, unknown>>
  /**
   * Last-resort hook with full authority over the body, run after `body` is
   * merged in and right before the request is sent (and logged). Prefer
   * `body` when a deep-merge already says what you mean.
   */
  transformRequest?: (body: unknown, ctx: RequestContext) => unknown
  /**
   * Advisory model catalog.
   *
   * Requests are never restricted to it. Supply entries to declare capabilities
   * the SDK cannot infer — most importantly image support, since an uncatalogued
   * model is treated as text-only and its images are projected to text.
   */
  models?: readonly ProviderCatalogModel[]
  /**
   * Fetch the catalog from the endpoint instead of declaring it.
   *
   * Result is memoized for {@link catalogTtlMs}. A failure here is NOT fatal:
   * refusing the actual model call because a metadata request failed would be the
   * wrong trade.
   */
  discoverModels?: (context: ModelDiscoveryContext) => Promise<readonly ProviderCatalogModel[]>
  /** How long a discovered catalog is reused. Defaults to five minutes. */
  catalogTtlMs?: number
  /** Additional opt-in lifetime for the last valid catalog after refresh failure. */
  catalogStaleTtlMs?: number
  /** Backoff after discovery failure before another refresh is attempted. */
  catalogFailureBackoffMs?: number
  /** Maximum catalog entries retained from static config or discovery. Defaults to 2,048. */
  maxCatalogModels?: number
  /** Maximum serialized catalog bytes retained. Defaults to 4 MiB. */
  maxCatalogBytes?: number
  /**
   * Decorate resolved model metadata.
   *
   * The hook for capabilities that come from the endpoint's configuration rather
   * than its catalog — Anthropic uses it to advertise thinking budgets as
   * selectable reasoning efforts.
   */
  describeModel?: (info: ResolvedModelInfo, dialect: Dialect) => ResolvedModelInfo
  /** Output cap when neither caller nor catalog names one. */
  defaultMaxTokens?: number
  /** Context capacity assumed for an uncatalogued model. */
  defaultContextWindow?: number
  /** Idle bound while a stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** End-to-end request/stream timeout. Defaults to ten minutes. */
  requestTimeoutMs?: number
  /** Maximum serialized outbound request bytes. Defaults to 32 MiB. */
  maxRequestBytes?: number
  /** Maximum cumulative successful response bytes. Defaults to 32 MiB. */
  maxResponseBytes?: number
  /** Maximum raw response chunks. Defaults to 100,000. */
  maxResponseChunks?: number
  /** Maximum decoded SSE events accepted from one response. */
  maxSseEvents?: number
  /** Maximum characters accepted in one decoded SSE event. */
  maxSseEventChars?: number
  /** Maximum non-success response bytes retained. Defaults to 1 MiB. */
  maxErrorBodyBytes?: number
  /** Maximum time granted to the optional request logger. Defaults to 5 seconds. */
  requestLoggerTimeoutMs?: number
  /**
   * How this route's failures are classified as retryable. Classification
   * only: nothing retries until the adapter is wrapped with `withRetry`.
   */
  retryPolicy?: RetryPolicyConfig
  /**
   * Classify a status this endpoint reports specially.
   *
   * Return `undefined` to fall through to the shared mapping, so an override only
   * has to describe what is genuinely different.
   */
  errorCode?: (status: number, detail: string) => string | undefined
  /** Override the `accept` / `content-type` the pipeline sends. */
  baseHeaders?: Record<string, string>
  /**
   * Observe exact protocol-serialized requests immediately before `fetch`.
   * Credentials are redacted, but bodies still contain prompts and tool output.
   * @deprecated High-risk compatibility bridge. Prefer structured observation.
   */
  requestLogger?: ProviderRequestLogger
  /**
   * Observe the exact, header-redacted wire response once a stream ends.
   * `frames` is every decoded SSE event in this provider's own vocabulary,
   * before `translate()` reshapes it — the counterpart `requestLogger` is
   * missing entirely, and without it a trace can show what went out but not
   * what came back.
   */
  responseLogger?: ProviderResponseLogger
}

