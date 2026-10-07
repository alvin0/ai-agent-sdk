import { type RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import { type ModelTarget } from '@alvin0/ai-agent-sdk-core/provider'
import {
  type ProviderCatalogModel, type ProviderRequestLogger, type ProviderResponseLogger,
} from '@alvin0/ai-agent-sdk-provider-http'
import { type CopilotEndpoint } from './catalog.ts'
import { type CopilotEditorHeaders } from './common/identity.ts'
import type { CopilotAuthStore, CopilotCredentialStore } from './common/store-types.ts'
import { type CopilotDialect } from './dual-protocol.ts'
import { type CopilotTokenCache } from './exchange.ts'
import { type CopilotEndpointDecision } from './router.ts'

/** Registry id, provider family, and observation label when the caller sets none. */
export const COPILOT_ROUTE_ID = 'copilot'

/** Display name reported by the adapter and the plugin. */
export const COPILOT_DISPLAY_NAME = 'GitHub Copilot'

/**
 * Everything a Copilot route can be configured with.
 *
 * The `authStore` is REQUIRED and injected: paths, the filesystem and the
 * environment belong to `Copilot_Node_Auth`, so a Universal package cannot supply
 * a default here (Requirement 6.1). Every other field is optional, and an absent
 * one is spread away rather than passed as `undefined` — see
 * {@link copilotAdapter}.
 */
export interface CopilotProviderOptions {
  /**
   * Where the credentials live: the compare-and-swap variant.
   *
   * This is the main path. {@link copilotAdapter} also accepts the read/write
   * variant through an overload; `copilotPlugin` does not, because transactional
   * registration and a store with no revisions are a poor pair.
   */
  readonly authStore: CopilotCredentialStore
  /** Endpoint base; defaults to `COPILOT_BASE_URL`. */
  readonly baseUrl?: string
  /**
   * Permit a cleartext `http:` base URL.
   *
   * Explicit opt-in rather than a lenient default, because every request to this
   * surface carries a bearer token (Requirement 2.2).
   */
  readonly allowInsecureHttp?: boolean
  /** Overrides for the two mandatory editor headers (Requirement 2.4). */
  readonly editorHeaders?: CopilotEditorHeaders
  /** Pin an endpoint for specific model ids, overriding the router (Requirement 9.6). */
  readonly endpointOverrides?: Readonly<Record<string, CopilotEndpoint>>
  /**
   * Extra model-id prefixes treated as `/responses`-capable when the catalog says
   * nothing.
   *
   * ADDS to `COPILOT_RESPONSES_MODEL_PREFIXES`; it cannot replace it, so an
   * override never silently drops a prefix this package ships.
   */
  readonly responsesModelPrefixes?: readonly string[]
  /** Synchronous, best-effort observer of every endpoint decision (Requirement 9.8). */
  readonly onEndpointDecision?: (decision: CopilotEndpointDecision) => void
  /**
   * A token cache shared with other routes.
   *
   * Pass one cache to several routes backed by the SAME credential and they
   * exchange once between them instead of once each.
   */
  readonly tokenCache?: CopilotTokenCache
  /** Exchange this long before the API token expires. */
  readonly exchangeMarginMs?: number
  /** GitHub API base, where the token exchange lives; pinned as its own origin. */
  readonly githubApiBaseUrl?: string

  /**
   * The model catalog.
   *
   * Left undefined, the adapter DISCOVERS it: which models an account may call
   * depends on its plan, its organisation policy and the editor identity the
   * request presents, so no hardcoded list is right for two accounts at once
   * (Requirement 8.1).
   */
  readonly models?: readonly ProviderCatalogModel[]
  /** Maximum raw catalog bytes. */
  readonly maxCatalogBytes?: number
  /** Maximum catalog entries; more than this is a malformed catalog, not a truncated one. */
  readonly maxCatalogModels?: number
  /** Maximum catalog response chunks. */
  readonly maxCatalogChunks?: number
  /** Catalog request deadline. */
  readonly catalogTimeoutMs?: number
  /** How long a discovered catalog stays fresh. */
  readonly catalogTtlMs?: number
  /** How long a stale catalog may still be served while a refresh runs. */
  readonly catalogStaleTtlMs?: number
  /** How long to wait before retrying discovery after it failed. */
  readonly catalogFailureBackoffMs?: number

  /** Dialect overrides, merged shallowly over `COPILOT_DEFAULT_DIALECT`. */
  readonly dialect?: Partial<CopilotDialect>
  /** Output cap when neither caller nor catalog names one. */
  readonly defaultMaxTokens?: number
  /** Context capacity assumed for an uncatalogued model. */
  readonly defaultContextWindow?: number
  /** Idle bound while a stream read is outstanding. */
  readonly streamIdleTimeoutMs?: number
  /** Deadline for one request. */
  readonly requestTimeoutMs?: number
  /** Maximum serialized request bytes. */
  readonly maxRequestBytes?: number
  /** Maximum response bytes. */
  readonly maxResponseBytes?: number
  /** Maximum response chunks. */
  readonly maxResponseChunks?: number
  /** Maximum SSE events in one stream. */
  readonly maxSseEvents?: number
  /** Maximum characters in one SSE event. */
  readonly maxSseEventChars?: number
  /** Maximum bytes read from a non-success response (Requirement 13.6). */
  readonly maxErrorBodyBytes?: number
  /** Deadline granted to {@link requestLogger} before the request proceeds anyway. */
  readonly requestLoggerTimeoutMs?: number
  /**
   * How this route's failures are classified as retryable. Classification
   * only: nothing retries until the adapter is wrapped with `withRetry`.
   */
  readonly retryPolicy?: RetryPolicyConfig
  /**
   * Exact wire-request observer.
   *
   * BEST-EFFORT: credentials are redacted by the transport, the logger's deadline
   * is `requestLoggerTimeoutMs`, and a logger that overruns or throws does not
   * stop the request (Requirement 14.5).
   */
  readonly requestLogger?: ProviderRequestLogger
  /**
   * Exact wire-response observer, fired once a stream ends.
   *
   * BEST-EFFORT, same contract as {@link requestLogger}: a logger that
   * overruns or throws does not affect the request it describes.
   */
  readonly responseLogger?: ProviderResponseLogger
  /** HTTP implementation, for tests and non-browser runtimes. */
  readonly fetch?: typeof globalThis.fetch

  /** Registry id; defaults to {@link COPILOT_ROUTE_ID}. */
  readonly id?: string
  /** Routes the plugin installs; defaults to `[id]`. */
  readonly routes?: readonly string[]
  /** Default model; a string form requires exactly one route (Requirement 7.5). */
  readonly defaultModel?: string | ModelTarget
}

/**
 * The same options against the read/write store variant.
 *
 * Kept for symmetry with `provider-codex` and with the two store contracts
 * (Requirement 7.3). It has no revisions, so a commit cannot be
 * compare-and-swapped — which costs nothing here, since nothing on the Copilot
 * credential path writes.
 */
export interface CopilotLegacyProviderOptions extends Omit<CopilotProviderOptions, 'authStore'> {
  /** Where the credentials live: the read/write variant. */
  readonly authStore: CopilotAuthStore
}

/** Plugin options; the CAS store variant only. */
export type CopilotPluginOptions = CopilotProviderOptions
