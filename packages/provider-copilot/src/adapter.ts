/**
 * The Copilot provider: the Copilot API surface, authenticated with a GitHub user
 * token this project's own credential store holds.
 *
 * ## Configured, not subclassed
 *
 * `copilotAdapter` is built with `createRuntimeHttpProvider` and extends nothing
 * (Requirement 7.1). Everything Copilot needs beyond a plain API-key provider —
 * a two-tier credential, a token exchange with its own cache, two wire protocols
 * on one route, endpoint-driven discovery — is expressed as DATA:
 * `auth: { kind: 'dynamic' }` for the credential path, a composite protocol for
 * the two endpoints, `discoverModels` for the catalog. That is the point of the
 * exercise: the configuration path is proven by the provider with the most
 * demanding requirements in this repository, not by the simplest one.
 *
 * ## Client identity
 *
 * `COPILOT_EDITOR_VERSION` and `COPILOT_EDITOR_PLUGIN_VERSION` are two of the
 * three `Client_Identity_Constants` in this package; the third is
 * `COPILOT_OAUTH_CLIENT_ID` in `./oauth.ts`. Their defaults make this SDK
 * identify itself AS AN EDITOR CLIENT on every request to the Copilot surface.
 *
 * They are EXPORTED, OVERRIDABLE constants — not hidden values — precisely
 * because of that: presenting as another client is something the caller should be
 * able to read off the source and change without forking, so each one is a named
 * option (`editorHeaders`) with a visible default. Same reason
 * `CODEX_CLIENT_VERSION` is an exported constant in `provider-codex`. All three
 * values will also go stale, which is a second reason to keep them where a caller
 * can reach them.
 *
 * Use your own account, and prefer a provider's official first-party surface for
 * production. The README and the "Client identity" section of the docs carry the
 * full tradeoff.
 *
 * @module ai-agent-sdk/providers/copilot/adapter
 */

import { AgentSdkError, MISSING_CREDENTIAL_CODE, type RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
  type CredentialOperationOptions,
  type ModelTarget,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  createRuntimeHttpProvider,
  type HttpModelAdapter,
  type ProviderCatalogModel,
  type ProviderRequestLogger,
  type RuntimeModelDiscoveryContext,
} from '@alvin0/ai-agent-sdk-provider-http'
import { openAiChatCompletionsProtocol } from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'
import { openAiResponsesProtocol } from '@alvin0/ai-agent-sdk-protocol-responses'
import { requireGitHubToken, type CopilotCredentialSnapshot } from './auth.ts'
import {
  copilotCatalogCacheOptions,
  discoverCopilotModels,
  resolveCopilotCatalogLimits,
  type CopilotEndpoint,
} from './catalog.ts'
import { COPILOT_ERROR_CODES } from './common/error-codes.ts'
import {
  COPILOT_BASE_URL,
  resolveCopilotEditorHeaders,
  type CopilotEditorHeaders,
} from './common/identity.ts'
import { captureCopilotStore, type CapturedCopilotStore } from './common/store-capture.ts'
import type {
  CopilotAuthFile,
  CopilotAuthStore,
  CopilotCredentialStore,
} from './common/store-types.ts'
import {
  copilotDualProtocol,
  type CopilotDialect,
} from './dual-protocol.ts'
import { createCopilotTokenCache, type CopilotTokenCache } from './exchange.ts'
import {
  COPILOT_RESPONSES_MODEL_PREFIXES,
  createCopilotEndpointRouter,
  type CopilotEndpointDecision,
} from './router.ts'

/**
 * The Copilot API base (Requirement 2.1).
 *
 * Declared in `./common/identity.ts` and re-exported here; that module's note
 * explains why the value sits in the leaf layer while this module stays the door
 * a reader opens.
 */
export { COPILOT_BASE_URL } from './common/identity.ts'

/**
 * Default `Editor-Version`.
 *
 * NOT cosmetic: with either editor header missing the endpoint answers HTTP 400
 * and no request runs at all. This is also where the SDK identifies itself as an
 * editor client — see the module note for why it is a named option.
 *
 * ✔ CONFIRMED accepted on a live Copilot account on 2026-09-10 (`sku`
 * `free_educational_quota`). Sent as the only editor headers, together with
 * `COPILOT_EDITOR_PLUGIN_VERSION`, on all four live calls, and none answered
 * HTTP 400: `GET https://api.github.com/copilot_internal/v2/token` → 200,
 * `GET /models` → 200, a streaming `/chat/completions` on `gpt-4o-mini` → a
 * complete stream, `POST /embeddings` → 200.
 *
 * Confirmed, not permanent: this constant's first failure mode is going stale, so
 * re-run those four calls when the surface starts answering 400. The procedure is
 * exactly the one above — an editor header the endpoint rejects and one it never
 * received both surface as HTTP 400.
 */
export { COPILOT_EDITOR_VERSION } from './common/identity.ts'

/**
 * Default `Editor-Plugin-Version`.
 *
 * Same contract as `COPILOT_EDITOR_VERSION`: mandatory, and part of the client
 * identity this SDK presents.
 *
 * ✔ CONFIRMED accepted on a live Copilot account on 2026-09-10, in the same run
 * that confirmed `COPILOT_EDITOR_VERSION` — both headers travel on every request,
 * so the one run confirms the pair. See that constant for the four calls and
 * their statuses.
 */
export { COPILOT_EDITOR_PLUGIN_VERSION } from './common/identity.ts'

/** Overrides for the two editor headers; each field is independent. */
export type { CopilotEditorHeaders } from './common/identity.ts'

/**
 * The Copilot dialect and its two projections, declared in `./dual-protocol.ts`
 * and re-exported here.
 *
 * The design's file map puts them in this module and DD-2 puts ownership with the
 * composite; both hold, because `copilotAdapter` BUILDS the composite. The source
 * edge therefore already runs adapter → dual-protocol, and declaring the runtime
 * projections here would make it bidirectional, which the repo's
 * circular-dependency check forbids. Same shape as `./router.ts` re-exporting
 * `CopilotEndpoint` from `./catalog.ts`.
 */
export {
  COPILOT_DEFAULT_DIALECT,
  toChatCompletionsDialect,
  toResponsesDialect,
} from './dual-protocol.ts'
export type { CopilotDialect } from './dual-protocol.ts'

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
  /** Retry policy this route owns (Requirement 7.7). */
  readonly retryPolicy?: RetryPolicyConfig
  /**
   * Exact wire-request observer.
   *
   * BEST-EFFORT: credentials are redacted by the transport, the logger's deadline
   * is `requestLoggerTimeoutMs`, and a logger that overruns or throws does not
   * stop the request (Requirement 14.5).
   */
  readonly requestLogger?: ProviderRequestLogger
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

/** Never-aborting logger sink for a resolve that arrives without a context. */
const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

/** Marker written in place of a token value that appeared in a response body. */
const REDACTED = '[REDACTED]'

/**
 * The two transport-owned headers, sent on every request (Requirement 2.3).
 *
 * `content-type` cannot come from the auth layer — `provider-http` owns the name
 * at the transport layer and refuses a second owner — so it is declared here,
 * where it is allowed and where it is visible.
 */
const COPILOT_TRANSPORT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  accept: 'text/event-stream',
})

/** Bytes read from a non-success response when the caller configures no bound. */
const DEFAULT_MAX_ERROR_BODY_BYTES = 1024 * 1024

/**
 * Create a Copilot adapter.
 *
 * Both store variants are accepted, and the variant is chosen by INSPECTING THE
 * MARKER through `captureCopilotStore` — which reads data properties only and
 * performs no storage I/O, so building a provider cannot run a line of the
 * caller's code (Requirement 7.3).
 * @param options - credential store, endpoint, catalog, dialect and transport settings.
 * @returns the adapter, ready to register.
 * @throws AgentSdkError with `CREDENTIAL_STORE_INVALID` when `authStore` is
 *   neither store variant, or `COPILOT_ENDPOINT_OVERRIDE_INVALID` when
 *   `endpointOverrides` pins an endpoint that does not exist.
 */
export function copilotAdapter(options: CopilotProviderOptions): HttpModelAdapter
export function copilotAdapter(options: CopilotLegacyProviderOptions): HttpModelAdapter
export function copilotAdapter(
  options: CopilotProviderOptions | CopilotLegacyProviderOptions,
): HttpModelAdapter {
  return buildCopilotAdapter(options, captureCopilotStore(options?.authStore))
}

/**
 * The one adapter body, shared by both store variants and by the plugin.
 *
 * Four things are worth reading closely.
 *
 * **`auth.resolve` is the only place a token enters a request.** It reads the
 * store, demands a long-lived token, then asks the cache — which decides on its
 * own whether an exchange is due. `provider-http` calls `resolve` ONCE PER
 * OPERATION (Requirement 7.2), not once per retry, so the number of store reads
 * equals the number of operations and every attempt of one operation carries the
 * credential and the endpoint from a single snapshot.
 *
 * **`requireGitHubToken` runs BEFORE `cache.acquire`.** With no credential the
 * failure is `MISSING_CREDENTIAL` naming the login command, rather than an HTTP
 * error from an exchange that never had anything to exchange (Requirement 13.4).
 *
 * **`x-request-id` is the CLIENT's id, not the server's.** It exists to line up
 * two logs and carries nothing about the user.
 *
 * **`router.learn` only ADDS.** A catalog refresh never rewrites a decision that
 * already exists, which is how Requirement 9.7 holds structurally rather than by
 * convention.
 *
 * Every absent option is spread away instead of passed as `undefined`: a key
 * carrying `undefined` still overrides the runtime's own default, which turns
 * "I did not configure this" into "I configured this to nothing"
 * (Requirement 8.7).
 * @param options - the caller's options, either store variant.
 * @param captured - the already-captured store.
 * @returns the configured adapter.
 */
function buildCopilotAdapter(
  options: CopilotProviderOptions | CopilotLegacyProviderOptions,
  captured: CapturedCopilotStore,
): HttpModelAdapter {
  const router = createCopilotEndpointRouter({
    overrides: options.endpointOverrides ?? {},
    // Merged HERE so "adds, never replaces" is visible at the call site.
    prefixes: [...COPILOT_RESPONSES_MODEL_PREFIXES, ...(options.responsesModelPrefixes ?? [])],
  })
  const editorHeaders = resolveCopilotEditorHeaders(options.editorHeaders)
  const secrets = createCopilotSecrets()
  const catalogLimits = resolveCopilotCatalogLimits(options)
  const providerId = options.id ?? COPILOT_ROUTE_ID
  const cache = options.tokenCache ?? createCopilotTokenCache({
    providerId,
    editorHeaders,
    ...(options.githubApiBaseUrl === undefined
      ? {}
      : { githubApiBaseUrl: options.githubApiBaseUrl }),
    ...(options.exchangeMarginMs === undefined ? {} : { marginMs: options.exchangeMarginMs }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.maxResponseChunks === undefined
      ? {}
      : { maxResponseChunks: options.maxResponseChunks }),
    ...(options.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureIssuer: options.allowInsecureHttp }),
    // The raw fetch, not the redacting wrapper: the exchange path does its own
    // bounded read and its own redaction, and it must not have its error bodies
    // rewritten by a layer that knows nothing about its classification table.
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const sessionId = options.dialect?.promptCacheKey ?? randomId()

  return createRuntimeHttpProvider<CopilotDialect>({
    displayName: COPILOT_DISPLAY_NAME,
    protocol: copilotDualProtocol({
      router,
      responses: openAiResponsesProtocol,
      chat: openAiChatCompletionsProtocol,
      ...(options.onEndpointDecision === undefined
        ? {}
        : { onDecision: options.onEndpointDecision }),
    }),
    baseUrl: options.baseUrl ?? COPILOT_BASE_URL,
    ...(options.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: options.allowInsecureHttp }),
    dialect: { ...options.dialect, promptCacheKey: sessionId },
    auth: {
      kind: 'dynamic',
      resolve: async ({ signal, context }) => {
        const operation: CredentialOperationOptions = {
          signal,
          logger: context?.logger ?? NULL_LOGGER,
        }
        const snapshot = await readCopilotSnapshot(captured, operation)
        // BEFORE the exchange: an empty store is a missing credential with a
        // command to run, not an HTTP failure.
        const github = requireGitHubToken(snapshot.file, snapshot.label)
        secrets.remember('github', github.token)
        const api = await cache.acquire(snapshot, operation, context)
        secrets.remember('api', api.token)
        return {
          authorization: `Bearer ${api.token}`,
          'editor-version': editorHeaders.editorVersion,
          'editor-plugin-version': editorHeaders.editorPluginVersion,
          // `content-type` is NOT returned here even though Requirement 2.3 lists
          // it among the mandatory headers: `provider-http` owns that name at the
          // TRANSPORT layer and rejects any other layer supplying it, which is a
          // good rule — one header, one owner, no last-writer-wins. It is set
          // explicitly through `baseHeaders` below rather than inherited
          // silently, so the requirement is still visible in this file.
          'x-request-id': randomId(),
        }
      },
    },
    ...(options.models === undefined
      ? {
        discoverModels: async (
          context: RuntimeModelDiscoveryContext,
        ): Promise<readonly ProviderCatalogModel[]> => {
          const snapshot = await discoverCopilotModels(
            context,
            catalogLimits,
            options.fetch ?? globalThis.fetch,
          )
          // Adds only ids that have no decision yet (Requirement 9.7).
          router.learn(snapshot.generation)
          return snapshot.generation.map((entry) => entry.model)
        },
      }
      : { models: options.models }),
    ...copilotCatalogCacheOptions(options),
    ...(options.maxCatalogModels === undefined
      ? {}
      : { maxCatalogModels: options.maxCatalogModels }),
    ...(options.maxCatalogBytes === undefined ? {} : { maxCatalogBytes: options.maxCatalogBytes }),
    ...(options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens }),
    ...(options.defaultContextWindow === undefined
      ? {}
      : { defaultContextWindow: options.defaultContextWindow }),
    ...transportLimits(options),
    // The transport-layer half of Requirement 2.3, stated rather than inherited.
    // `accept` travels with it because both names belong to the same layer and
    // supplying one of a pair while defaulting the other is how a stream ends up
    // asking for JSON.
    baseHeaders: COPILOT_TRANSPORT_HEADERS,
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
    // A 400 for a missing editor header, and ONLY that, gets the Copilot code.
    errorCode: (status: number, detail: string): string | undefined =>
      isMissingEditorHeaderFailure(status, detail)
        ? COPILOT_ERROR_CODES.EDITOR_HEADERS_MISSING
        : undefined,
    fetch: copilotProviderFetch(options, secrets),
  })
}

/** Plugin options; the CAS store variant only. */
export type CopilotPluginOptions = CopilotProviderOptions

/**
 * The transactional plugin for installing the Copilot provider.
 *
 * Composition follows `codexPlugin`: `id` defaults to {@link COPILOT_ROUTE_ID},
 * `family` is `'copilot'`, `routes` defaults to `[id]`, and a string
 * `defaultModel` requires exactly one route so the model target's provider can be
 * inferred (Requirements 7.4, 7.5).
 *
 * One difference from Codex: there is no overload per store variant. The
 * compare-and-swap store is the main path here, the read/write variant exists for
 * symmetry, and {@link copilotAdapter} is where it is accepted (Requirement 6.2).
 * The marker is checked at construction rather than at setup so a wrong store is
 * reported while the runtime is being composed, not on the first generation.
 * @param options - the same options {@link copilotAdapter} takes, CAS store only.
 * @returns a composable plugin registering one Copilot adapter.
 * @throws TypeError when `authStore` is not the compare-and-swap variant, or when
 *   a string `defaultModel` is paired with anything but exactly one route.
 */
export function copilotPlugin(
  options: CopilotPluginOptions,
): ComposableModelProviderPlugin & { readonly family: 'copilot' } {
  if (!isCredentialStoreInput(options?.authStore)) {
    throw new TypeError('copilotPlugin requires a Copilot credential store (the CAS variant)')
  }
  const id = options.id ?? COPILOT_ROUTE_ID
  const routes = Object.freeze([...(options.routes ?? [id])])
  return defineModelProviderPlugin({
    id,
    family: 'copilot',
    displayName: COPILOT_DISPLAY_NAME,
    routes,
    ...runtimeDefaultModel(options.defaultModel, routes),
    setup(registrar) {
      const adapter = buildCopilotAdapter(options, captureCopilotStore(options.authStore))
      const remove = registrar.registerAdapter(adapter)
      return () => {
        remove()
        return undefined
      }
    },
  }) as ComposableModelProviderPlugin & { readonly family: 'copilot' }
}

/**
 * Marker inspection only: no accessor is invoked and no method is captured.
 *
 * Full capture stays deferred to {@link buildCopilotAdapter}, so this check
 * cannot be the thing that runs the caller's code.
 * @param value - the `authStore` as passed in.
 * @returns true when it carries the credential-store marker.
 */
function isCredentialStoreInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const marker = Object.getOwnPropertyDescriptor(value, 'kind')
  return marker !== undefined && 'value' in marker && marker.value === 'credential-store'
}

/**
 * Resolve `defaultModel`, demanding one route for the string form.
 *
 * A string names a model but not a provider, and the provider is inferred from
 * the route. With two routes there is no answer, and picking the first would
 * install a default nobody chose (Requirement 7.5).
 * @param value - the caller's default model, when they set one.
 * @param routes - the routes this plugin installs.
 * @returns a one-key spread carrying `defaultModel`, or an empty one.
 * @throws TypeError when a string is paired with anything but exactly one route.
 */
function runtimeDefaultModel(
  value: string | ModelTarget | undefined,
  routes: readonly string[],
): { readonly defaultModel?: ModelTarget } {
  if (value === undefined) return {}
  if (typeof value !== 'string') return { defaultModel: value }
  if (routes.length !== 1) {
    throw new TypeError('A string defaultModel requires exactly one Copilot route')
  }
  return { defaultModel: Object.freeze({ provider: routes[0] ?? COPILOT_ROUTE_ID, id: value }) }
}

/**
 * Read the credential store once, through whichever variant was captured.
 *
 * The read/write variant has no revisions, so its snapshot revision is `null` —
 * which the token cache compares just as strictly as a real revision, it simply
 * never changes on its own.
 * @param captured - the captured store.
 * @param operation - the calling operation, whose signal bounds the read.
 * @returns the file, its revision and the store label, as one snapshot.
 * @throws AgentSdkError with the SDK's missing-credential code when the store is
 *   empty (Requirement 13.4).
 */
async function readCopilotSnapshot(
  captured: CapturedCopilotStore,
  operation: CredentialOperationOptions,
): Promise<CopilotCredentialSnapshot> {
  const record = captured.kind === 'versioned'
    ? await captured.store.read(operation)
    : { value: await captured.store.read(), revision: null }
  return Object.freeze({
    file: requireCopilotFile(record?.value, captured.label),
    revision: record?.revision ?? null,
    label: captured.label,
  })
}

/**
 * Demand a credential file, reusing the one message that says how to get one.
 *
 * `requireGitHubToken` owns the message and the code for all three shapes of "no
 * credential", so it is asked first. The throw after it is UNREACHABLE — an
 * absent file already failed there — and exists only so the type narrows without
 * a non-null assertion.
 * @param file - the file the store returned, or `undefined` for an empty store.
 * @param label - the store location named in the diagnostic.
 * @returns the file.
 */
function requireCopilotFile(file: CopilotAuthFile | undefined, label: string): CopilotAuthFile {
  requireGitHubToken(file, label)
  if (file === undefined) {
    throw new AgentSdkError(
      `no GitHub Copilot credentials at ${label}`,
      MISSING_CREDENTIAL_CODE,
    )
  }
  return file
}

/**
 * The two token values currently held in memory, and the redaction that uses them.
 *
 * Two slots rather than a growing set: there is exactly one long-lived token and
 * one API token in play at a time, and a set that only ever grows would be a
 * credential leak of its own making.
 */
interface CopilotSecrets {
  /** Record the current value of one of the two tokens. */
  remember(kind: 'github' | 'api', value: string): void
  /** Replace every occurrence of either token with {@link REDACTED}. */
  redact(text: string): string
}

/** Build the two-slot secret registry. */
function createCopilotSecrets(): CopilotSecrets {
  let github = ''
  let api = ''
  return {
    remember(kind, value): void {
      if (value.length === 0) return
      if (kind === 'github') github = value
      else api = value
    },
    redact(text): string {
      let result = text
      for (const secret of [github, api]) {
        if (secret.length === 0) continue
        result = result.split(secret).join(REDACTED)
      }
      return result
    },
  }
}

/**
 * The fetch the provider dispatches through: identical to the injected one,
 * except that an error body is redacted — and, for the one case the endpoint is
 * known to be unhelpful about, explained — before anything retains it.
 *
 * Why here and not in an error mapper: `provider-http` puts the raw error body
 * into the failure's `cause`, and by the time a mapper sees it the text is
 * already retained. Redacting at the transport is the only point that runs BEFORE
 * that, and an endpoint echoing the `Authorization` header back in an error body
 * is something that has actually happened (Requirement 13.7).
 *
 * What is deliberately NOT touched:
 *
 * - **Successful responses.** The body is a live SSE stream and must reach the
 *   pipeline unread and unwrapped.
 * - **Redirects, in every shape.** Rebuilding a `Response` loses `type`,
 *   `redirected` and `url` — the three signals the transport's redirect guard
 *   reads — so anything that is not a 4xx/5xx passes through untouched and the
 *   guard still sees the original (Requirement 7.8).
 * @param options - read for the injected fetch and the error-body bound.
 * @param secrets - the live token values to redact.
 * @returns a fetch implementation to hand to the runtime provider.
 */
function copilotProviderFetch(
  options: CopilotProviderOptions | CopilotLegacyProviderOptions,
  secrets: CopilotSecrets,
): typeof globalThis.fetch {
  const inner = options.fetch ?? globalThis.fetch
  const maxBytes = options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES
  return async (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const response = await inner(...args)
    if (response.status < 400 || response.type === 'opaqueredirect' || response.redirected) {
      return response
    }
    let raw: string
    try {
      raw = await readErrorBody(response, maxBytes)
    } catch {
      // A body that could not be read must not replace the status, which is the
      // more reliable signal anyway.
      return response
    }
    const redacted = secrets.redact(raw)
    const body = isMissingEditorHeaderFailure(response.status, redacted)
      ? editorHeaderDiagnostic(redacted)
      : redacted
    const headers = new Headers(response.headers)
    // The length changed, and a stale content-length would fail the bounded read
    // that comes next.
    headers.delete('content-length')
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/**
 * Read an error body up to a byte bound, marking a truncation rather than hiding it.
 * @param response - the non-success response.
 * @param maxBytes - the configured bound (Requirement 13.6).
 * @returns the decoded text, truncated with a note when it hit the bound.
 */
async function readErrorBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return text + decoder.decode()
      if (next.value === undefined) continue
      const remaining = maxBytes - bytes
      if (remaining <= 0 || next.value.byteLength > remaining) {
        const kept = remaining <= 0 ? undefined : next.value.subarray(0, remaining)
        const partial = kept === undefined ? '' : decoder.decode(kept, { stream: true })
        await reader.cancel().catch(() => undefined)
        return `${text}${partial}${decoder.decode()}\n[error body truncated at ${maxBytes} bytes]`
      }
      bytes += next.value.byteLength
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Whether a failure looks like the endpoint refusing a request for a missing
 * editor header.
 *
 * Matched BROADLY on purpose. The endpoint's wording is not a contract — it is
 * one sentence that can be rephrased at any time — so this looks for the header
 * names in any plausible spelling, or for the word "editor" beside a complaint
 * about a header. It is also bounded to status 400: a 400 that says nothing about
 * editors keeps `REQUEST_INVALID` from the shared mapping rather than being
 * relabelled into a Copilot-specific failure it is not (Requirement 2.5).
 * @param status - the response status.
 * @param detail - the provider's error text, joined by the shared parser.
 * @returns true when the missing-header diagnosis is warranted.
 */
function isMissingEditorHeaderFailure(status: number, detail: string): boolean {
  if (status !== 400) return false
  if (/editor[\s_-]*(?:plugin[\s_-]*)?version/i.test(detail)) return true
  return /\beditor\b/i.test(detail)
    && /(missing|required|absent|invalid|unsupported|unrecogni[sz]ed|header)/i.test(detail)
}

/**
 * Wrap the endpoint's 400 in a body that names both headers and how to set them.
 *
 * The endpoint's own text is kept beside it rather than replaced: it is the
 * evidence, and the shared classifier reads it too.
 * @param endpointText - the endpoint's error body, already redacted.
 * @returns a JSON error body carrying the SDK-authored diagnosis.
 */
function editorHeaderDiagnostic(endpointText: string): string {
  return JSON.stringify({
    error: {
      code: COPILOT_ERROR_CODES.EDITOR_HEADERS_MISSING,
      message: 'the Copilot endpoint rejected this request for a missing or unaccepted editor '
        + 'header. Both `Editor-Version` and `Editor-Plugin-Version` are mandatory; configure '
        + 'them with the `editorHeaders` option (`editorVersion`, `editorPluginVersion`), whose '
        + 'defaults are the exported COPILOT_EDITOR_VERSION and '
        + `COPILOT_EDITOR_PLUGIN_VERSION constants. The endpoint said: ${endpointText}`,
    },
  })
}

/**
 * Forward every transport bound the caller set, and only those.
 * @param options - the caller's options.
 * @returns an object carrying the configured transport limits.
 */
function transportLimits(
  options: CopilotProviderOptions | CopilotLegacyProviderOptions,
): Readonly<Record<string, number>> {
  return {
    ...(options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.maxResponseChunks === undefined
      ? {}
      : { maxResponseChunks: options.maxResponseChunks }),
    ...(options.maxSseEvents === undefined ? {} : { maxSseEvents: options.maxSseEvents }),
    ...(options.maxSseEventChars === undefined ? {} : { maxSseEventChars: options.maxSseEventChars }),
    ...(options.maxErrorBodyBytes === undefined
      ? {}
      : { maxErrorBodyBytes: options.maxErrorBodyBytes }),
    ...(options.requestLoggerTimeoutMs === undefined
      ? {}
      : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs }),
  }
}

/** A client-side correlation id; carries nothing about the account or the prompt. */
function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sdk-${Date.now().toString(36)}`
}
