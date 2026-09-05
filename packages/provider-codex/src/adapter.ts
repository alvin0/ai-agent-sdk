/**
 * The Codex provider: the Responses API behind the ChatGPT-backed Codex endpoint,
 * authenticated with this project's own credential store.
 *
 * Useful because it needs no API key and no billing setup — a ChatGPT subscription
 * plus `npm run provider:codex:login-device` is the whole setup, which makes it the
 * cheapest way to run real integration tests.
 *
 * This is also the proof that the configuration path scales: Codex has the most
 * demanding requirements of any provider here — OAuth with proactive token refresh,
 * account-scoped headers, endpoint-driven model discovery, and a reduced request
 * schema — and it still needs no adapter subclass. `auth: { kind: 'dynamic' }` is
 * what makes OAuth expressible as data.
 *
 * One thing to be deliberate about: this endpoint exists to serve the Codex CLI and
 * identifies its client with an `originator` header. Sending `codex_cli_rs` is what
 * makes the backend accept the request, so that is the default — but it IS
 * presenting as another client, so it is a named option rather than a hidden
 * constant. Use your own account, and prefer the `openai` provider for production.
 *
 * @module ai-agent-sdk/providers/codex/adapter
 */

import type { ModelProviderPlugin, ModelProviderRegistrar, RetryPolicyConfig } from '@ai-agent-sdk/core'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import { waitForSettlement } from '@ai-agent-sdk/core'
import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
  type CredentialOperationOptions,
  type ModelTarget,
  type SdkLogger,
} from '@ai-agent-sdk/core/provider'
import type {
  HttpModelAdapter,
  ProviderCatalogModel,
  ProviderRequestLogger,
} from '@ai-agent-sdk/provider-http'
import {
  createHttpProvider,
  createRuntimeHttpProvider,
  observeCredentialOperation,
  type ModelDiscoveryContext,
} from '@ai-agent-sdk/provider-http'
import {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@ai-agent-sdk/protocol-responses'
import {
  isFedrampAccount,
  requireTokens,
  resolveAccountId,
  shouldRefresh,
  type CodexAuthStore,
  type CodexCredentialStore,
} from './auth.ts'
import {
  refreshCodexTokens,
  refreshCodexTokensWithOperation,
  type CodexOAuthOptions,
} from './oauth.ts'
import { captureCodexStore, type CapturedCodexStore } from './common/store-capture.ts'
import { codexResponseMediaFetch } from './common/response-media.ts'
import { rejectCodexRedirect } from './common/no-follow.ts'

/** The ChatGPT-backed Codex API base. */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Client identifier this endpoint expects. See the module note. */
export const CODEX_ORIGINATOR = 'codex_cli_rs'

/**
 * Client version sent when listing models.
 *
 * NOT cosmetic: the model catalog is gated on it, and an older value returns a
 * shorter list or an empty one. Verified against a live account — `0.45.0` returns
 * `{"models":[]}` while `1.0.0` returns the full set.
 */
export const CODEX_CLIENT_VERSION = '1.0.0'

/** One entry of the `/models` response. */
interface WireCatalogModel {
  slug?: string
  display_name?: string
  description?: string
  input_modalities?: string[]
  output_modalities?: string[]
  context_window?: number
  default_reasoning_level?: string
  supported_reasoning_levels?: Array<{
    effort?: string
    description?: string
  }>
}

/** Options for {@link codexAdapter}. */
export interface CodexAdapterOptions {
  /**
   * Where the credentials live.
   *
   * Required injection. Filesystem/env defaults belong to the Node auth wrapper.
   */
  authStore: CodexAuthStore
  /** Endpoint base; defaults to {@link CODEX_BASE_URL}. */
  baseUrl?: string
  /** Client identifier; defaults to {@link CODEX_ORIGINATOR}. */
  originator?: string
  /**
   * Model catalog.
   *
   * Left undefined, the adapter DISCOVERS it from the endpoint, which is the right
   * default here: the available models depend on the account's plan and on
   * {@link CODEX_CLIENT_VERSION}, so no hardcoded list could be correct for
   * everyone. Discovery also supplies `input_modalities`, without which every model
   * would be assumed text-only and image input silently stripped.
   */
  models?: readonly ProviderCatalogModel[]
  /** Client version used for catalog discovery; defaults to {@link CODEX_CLIENT_VERSION}. */
  clientVersion?: string
  /** Maximum raw model-catalog response bytes. Defaults to 4 MiB. */
  maxCatalogBytes?: number
  /** Maximum model entries accepted from discovery. Defaults to 2,048. */
  maxCatalogModels?: number
  /** Maximum response chunks accepted during discovery. Defaults to 10,000. */
  maxCatalogChunks?: number
  /** Model-catalog request deadline. Defaults to 30 seconds. */
  catalogTimeoutMs?: number
  catalogTtlMs?: number
  catalogStaleTtlMs?: number
  catalogFailureBackoffMs?: number
  /** Output cap when neither caller nor catalog names one. */
  defaultMaxTokens?: number
  /** Context capacity assumed for an uncatalogued model. */
  defaultContextWindow?: number
  /** Idle bound while a stream read is outstanding. */
  streamIdleTimeoutMs?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxResponseChunks?: number
  maxSseEvents?: number
  maxSseEventChars?: number
  maxErrorBodyBytes?: number
  requestLoggerTimeoutMs?: number
  /** Retry policy this route owns. */
  retryPolicy?: RetryPolicyConfig
  /** Optional exact wire-request logger; credentials/account ids are redacted. */
  requestLogger?: ProviderRequestLogger
  /** Issuer and client id overrides for token refresh. */
  oauth?: CodexOAuthOptions
  /**
   * Stable key letting the provider reuse a cached prompt prefix across turns.
   *
   * Defaults to one id captured by the adapter/provider-plugin instance. Every
   * conversation routed through that same instance shares the key. Use separate
   * plugin instances (and routes) when cache identity must be isolated; this is
   * not a conversation- or tenant-scoped setting.
   */
  promptCacheKey?: string
  fetch?: typeof globalThis.fetch
}

export interface CodexRevisionedAdapterOptions extends Omit<CodexAdapterOptions, 'authStore'> {
  readonly authStore: CodexCredentialStore
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sdk-${Date.now().toString(36)}`
}

/** Read `/models`, which requires — and is gated on — a client version. */
async function discoverCodexModels(
  context: ModelDiscoveryContext,
  clientVersion: string,
  limits: {
    readonly maxBytes: number
    readonly maxModels: number
    readonly maxChunks: number
    readonly timeoutMs: number
  },
  fetchImpl: typeof globalThis.fetch,
): Promise<readonly ProviderCatalogModel[]> {
  const url = `${context.baseUrl}/models?client_version=${encodeURIComponent(clientVersion)}`
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout])
  const response = await fetchImpl(url, {
    headers: context.headers,
    signal,
    redirect: 'manual',
  })
  await rejectCodexRedirect(response, url, 'model catalog', 30_000)
  if (!response.ok) return []
  const body = await readCatalogJson(response, limits.maxBytes, limits.maxChunks, signal)
  const models = Array.isArray(body.models) ? body.models as WireCatalogModel[] : []
  if (models.length > limits.maxModels) {
    throw new RangeError(`Codex model catalog exceeds the ${limits.maxModels}-model limit`)
  }
  return models.flatMap((entry) => {
    if (typeof entry.slug !== 'string' || entry.slug.length === 0) return []
    const modalities = (entry.input_modalities ?? [])
      .filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    const outputModalities = (entry.output_modalities ?? [])
      .filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    const efforts = (entry.supported_reasoning_levels ?? []).flatMap((candidate) => {
      if (typeof candidate.effort !== 'string' || candidate.effort.length === 0) return []
      return [{
        id: ReasoningEffortId(candidate.effort),
        name: candidate.effort,
        ...candidate.description === undefined ? {} : { description: candidate.description },
      }]
    })
    const defaultEffort = typeof entry.default_reasoning_level === 'string'
      && efforts.some(effort => effort.id === entry.default_reasoning_level)
      ? ReasoningEffortId(entry.default_reasoning_level)
      : undefined
    return [{
      id: entry.slug,
      ...entry.display_name === undefined ? {} : { name: entry.display_name },
      ...entry.description === undefined ? {} : { description: entry.description },
      ...modalities.length > 0 ? { inputModalities: modalities } : {},
      ...outputModalities.length > 0 ? { outputModalities } : {},
      ...typeof entry.context_window === 'number' && Number.isSafeInteger(entry.context_window) && entry.context_window > 0
        ? { contextWindow: entry.context_window }
        : {},
      ...efforts.length === 0 ? {} : {
        reasoning: {
          efforts,
          ...defaultEffort === undefined ? {} : { defaultEffort },
        },
      },
    }]
  })
}

/**
 * Create a Codex adapter.
 * @param options - credential store, endpoint, and catalog overrides.
 * @returns the adapter, ready to register.
 */
export function codexAdapter(options: CodexRevisionedAdapterOptions): HttpModelAdapter
export function codexAdapter(options: CodexAdapterOptions): HttpModelAdapter
export function codexAdapter(
  options: CodexAdapterOptions | CodexRevisionedAdapterOptions,
): HttpModelAdapter {
  const captured = captureCodexStore(options?.authStore)
  return captured.kind === 'versioned'
    ? runtimeCodexAdapter(options as CodexRevisionedAdapterOptions, captured)
    : legacyCodexAdapter(options as CodexAdapterOptions, captured)
}

function legacyCodexAdapter(
  options: CodexAdapterOptions,
  captured = captureCodexStore(options?.authStore),
): HttpModelAdapter {
  if (captured.kind !== 'legacy') throw new TypeError('Codex legacy adapter requires a read/write auth store')
  const store = captured.store
  const promptCacheKey = options.promptCacheKey ?? randomId()
  const clientVersion = options.clientVersion ?? CODEX_CLIENT_VERSION
  const catalogLimits = Object.freeze({
    maxBytes: positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024, 'maxCatalogBytes'),
    maxModels: positiveSafeInteger(options.maxCatalogModels ?? 2_048, 'maxCatalogModels'),
    maxChunks: positiveSafeInteger(options.maxCatalogChunks ?? 10_000, 'maxCatalogChunks'),
    timeoutMs: positiveSafeInteger(options.catalogTimeoutMs ?? 30_000, 'catalogTimeoutMs'),
  })

  /**
   * The Codex request schema has no `temperature`, `top_p`, or
   * `max_output_tokens`, so those knobs are turned off rather than sent and
   * rejected.
   */
  const dialect: Partial<ResponsesDialect> = {
    sampling: false,
    maxOutputTokens: false,
    store: false,
    messagePhase: true,
    promptCacheKey,
  }

  return createHttpProvider({
    displayName: 'Codex',
    protocol: openAiResponsesProtocol,
    baseUrl: options.baseUrl ?? CODEX_BASE_URL,
    dialect,
    /**
     * Resolved per operation, which is what lets OAuth live in configuration.
     *
     * Refresh happens HERE, proactively, keyed on the access token's own `exp`
     * with a five-minute margin. Doing it before the request rather than reacting
     * to a 401 keeps `AUTH` correctly non-retryable: by the time a 401 does
     * arrive, the credentials really are dead and the fix is re-login.
     */
    auth: {
      kind: 'dynamic',
      resolve: async (_signal, context) => {
        const file = await store.read()
        let tokens = requireTokens(file, store.location)
        if (file !== undefined && shouldRefresh(file)) {
          tokens = await observeCredentialOperation(
            context,
            'codex',
            'refresh',
            async () => await refreshCodexTokens(store, options.oauth ?? {}),
          )
        }
        const accountId = resolveAccountId(tokens)
        return {
          'authorization': `Bearer ${tokens.access_token}`,
          'originator': options.originator ?? CODEX_ORIGINATOR,
          ...accountId === undefined ? {} : { 'chatgpt-account-id': accountId },
          ...isFedrampAccount(tokens) ? { 'x-openai-fedramp': 'true' } : {},
          'session-id': promptCacheKey,
        }
      },
    },
    ...options.models === undefined
      ? { discoverModels: (context) => discoverCodexModels(
        context,
        clientVersion,
        catalogLimits,
        options.fetch ?? globalThis.fetch,
      ) }
      : { models: options.models },
    defaultMaxTokens: options.defaultMaxTokens ?? 32_000,
    defaultContextWindow: options.defaultContextWindow ?? 272_000,
    ...options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
    ...options.catalogTtlMs === undefined ? {} : { catalogTtlMs: options.catalogTtlMs },
    ...options.catalogStaleTtlMs === undefined ? {} : { catalogStaleTtlMs: options.catalogStaleTtlMs },
    ...options.catalogFailureBackoffMs === undefined
      ? {}
      : { catalogFailureBackoffMs: options.catalogFailureBackoffMs },
    ...transportLimits(options),
    ...options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy },
    ...options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger },
  })
}

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

function runtimeCodexAdapter(
  options: CodexRevisionedAdapterOptions,
  captured = captureCodexStore(options.authStore),
): HttpModelAdapter {
  if (captured.kind !== 'versioned') {
    throw new TypeError('Codex runtime authStore must be a versioned credential store')
  }
  const store = captured.store
  const promptCacheKey = options.promptCacheKey ?? randomId()
  const clientVersion = options.clientVersion ?? CODEX_CLIENT_VERSION
  const catalogLimits = Object.freeze({
    maxBytes: positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024, 'maxCatalogBytes'),
    maxModels: positiveSafeInteger(options.maxCatalogModels ?? 2_048, 'maxCatalogModels'),
    maxChunks: positiveSafeInteger(options.maxCatalogChunks ?? 10_000, 'maxCatalogChunks'),
    timeoutMs: positiveSafeInteger(options.catalogTimeoutMs ?? 30_000, 'catalogTimeoutMs'),
  })
  const dialect: Partial<ResponsesDialect> = {
    sampling: false,
    maxOutputTokens: false,
    store: false,
    messagePhase: true,
    promptCacheKey,
  }

  return createRuntimeHttpProvider({
    displayName: 'Codex',
    protocol: openAiResponsesProtocol,
    baseUrl: options.baseUrl ?? CODEX_BASE_URL,
    dialect,
    auth: {
      kind: 'dynamic',
      resolve: async ({ provider, signal, context }) => {
        const operation: CredentialOperationOptions = {
          signal,
          logger: context?.logger ?? NULL_LOGGER,
        }
        const record = await store.read(operation)
        const file = record?.value
        let tokens = requireTokens(file, store.label)
        if (file !== undefined && shouldRefresh(file)) {
          tokens = await observeCredentialOperation(
            context,
            provider,
            'refresh',
            async () => await refreshCodexTokensWithOperation(
              store,
              { ...(options.oauth ?? {}), signal },
              operation,
            ),
          )
        }
        const accountId = resolveAccountId(tokens)
        return {
          authorization: `Bearer ${tokens.access_token}`,
          originator: options.originator ?? CODEX_ORIGINATOR,
          ...(accountId === undefined ? {} : { 'chatgpt-account-id': accountId }),
          ...(isFedrampAccount(tokens) ? { 'x-openai-fedramp': 'true' } : {}),
          'session-id': promptCacheKey,
        }
      },
    },
    ...(options.models === undefined
      ? { discoverModels: context => discoverCodexModels(
        {
          baseUrl: context.baseUrl.href.replace(/\/+$/, ''),
          headers: context.headers,
          signal: context.signal,
          provider: context.provider,
          ...(context.context === undefined ? {} : { context: context.context }),
        },
        clientVersion,
        catalogLimits,
        options.fetch ?? globalThis.fetch,
      ) }
      : { models: options.models }),
    ...(options.catalogTtlMs === undefined ? {} : { catalogTtlMs: options.catalogTtlMs }),
    ...(options.catalogStaleTtlMs === undefined ? {} : { catalogStaleTtlMs: options.catalogStaleTtlMs }),
    ...(options.catalogFailureBackoffMs === undefined
      ? {}
      : { catalogFailureBackoffMs: options.catalogFailureBackoffMs }),
    defaultMaxTokens: options.defaultMaxTokens ?? 32_000,
    defaultContextWindow: options.defaultContextWindow ?? 272_000,
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
  })
}

export interface CodexPluginOptions extends CodexAdapterOptions {
  /** Registry routes installed by the plugin. Defaults to `['codex']`. */
  readonly routes?: readonly string[]
}

export interface CodexProviderOptions extends CodexRevisionedAdapterOptions {
  readonly defaultModel?: string | ModelTarget
  readonly id?: string
  readonly routes?: readonly string[]
}

/** Preferred transactional plugin for installing the Universal Codex provider. */
export function codexPlugin(
  options: CodexProviderOptions,
): ComposableModelProviderPlugin & { readonly family: 'codex' }
export function codexPlugin(options: CodexPluginOptions): ModelProviderPlugin
export function codexPlugin(
  options: CodexProviderOptions | CodexPluginOptions,
): ModelProviderPlugin | (ComposableModelProviderPlugin & { readonly family: 'codex' }) {
  if (isVersionedStoreInput(options.authStore)) {
    const id = 'id' in options && options.id !== undefined ? options.id : 'codex'
    const routes = Object.freeze([...options.routes ?? [id]])
    return defineModelProviderPlugin({
      id,
      family: 'codex',
      displayName: 'Codex',
      routes,
      ...runtimeDefaultModel(
        'defaultModel' in options ? options.defaultModel : undefined,
        routes,
      ),
      setup(registrar) {
        const adapter = runtimeCodexAdapter(options as CodexProviderOptions)
        const remove = registrar.registerAdapter(adapter)
        return () => { remove(); return undefined }
      },
    }) as ComposableModelProviderPlugin & { readonly family: 'codex' }
  }
  return legacyCodexPlugin(options as CodexPluginOptions)
}

/** Marker inspection only; full store capture stays deferred to preferred setup. */
function isVersionedStoreInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')
  return kind !== undefined && 'value' in kind && kind.value === 'credential-store'
}

function legacyCodexPlugin(
  options: CodexPluginOptions,
  captured?: CapturedCodexStore,
): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['codex'])])
  const adapter = legacyCodexAdapter(options, captured)
  return Object.freeze({
    id: 'codex',
    displayName: 'Codex',
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(routes, adapter)
    },
  })
}

function runtimeDefaultModel(
  value: string | ModelTarget | undefined,
  routes: readonly string[],
): { readonly defaultModel?: ModelTarget } {
  if (value === undefined) return {}
  if (typeof value !== 'string') return { defaultModel: value }
  if (routes.length !== 1) throw new TypeError('A string defaultModel requires exactly one Codex route')
  return { defaultModel: Object.freeze({ provider: routes[0]!, id: value }) }
}

async function readCatalogJson(
  response: Response,
  maxBytes: number,
  maxChunks: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body !== null) await waitForSettlement(response.body.cancel().catch(() => undefined), 30_000)
    throw new RangeError(`Codex model catalog exceeds the ${maxBytes}-byte limit`)
  }
  if (response.body === null) throw new TypeError('Codex model catalog returned no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let chunkCount = 0
  try {
    while (true) {
      const next = await raceAbort(reader.read(), signal)
      if (next.done) break
      if (next.value === undefined) continue
      chunkCount++
      if (chunkCount > maxChunks) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        throw new RangeError(`Codex model catalog exceeds the ${maxChunks}-chunk limit`)
      }
      bytes += next.value.byteLength
      if (bytes > maxBytes) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        throw new RangeError(`Codex model catalog exceeds the ${maxBytes}-byte limit`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(merged))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('Codex model catalog must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Codex catalog request aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Codex catalog request aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Codex ${field} must be a positive safe integer`)
  return value
}

function transportLimits(options: CodexAdapterOptions | CodexRevisionedAdapterOptions) {
  const fetch = codexResponseMediaFetch({
    baseUrl: options.baseUrl ?? CODEX_BASE_URL,
    officialBaseUrl: CODEX_BASE_URL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  return {
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes },
    ...options.maxResponseChunks === undefined ? {} : { maxResponseChunks: options.maxResponseChunks },
    ...options.maxSseEvents === undefined ? {} : { maxSseEvents: options.maxSseEvents },
    ...options.maxSseEventChars === undefined ? {} : { maxSseEventChars: options.maxSseEventChars },
    ...options.maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes: options.maxErrorBodyBytes },
    ...options.requestLoggerTimeoutMs === undefined ? {} : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs },
    fetch,
  }
}
