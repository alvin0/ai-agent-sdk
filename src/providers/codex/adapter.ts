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

import type { RetryPolicyConfig } from '@ai-agent-sdk/core'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import { waitForSettlement } from '@ai-agent-sdk/core'
import type {
  HttpModelAdapter,
  ProviderCatalogModel,
  ProviderRequestLogger,
} from '../base/index.ts'
import { createHttpProvider, type ModelDiscoveryContext } from '../http-provider.ts'
import { openAiResponsesProtocol } from '../protocols/openai-responses.ts'
import type { ResponsesDialect } from '../responses/wire.ts'
import {
  fileCodexAuthStore,
  isFedrampAccount,
  requireTokens,
  resolveAccountId,
  shouldRefresh,
  type CodexAuthStore,
} from './auth-file.ts'
import { refreshCodexTokens, type CodexOAuthOptions } from './oauth.ts'

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
   * Defaults to this project's own store, NOT `~/.codex/auth.json`. Sharing the
   * Codex CLI's file would make both programs rotate the same single-use refresh
   * token and eventually log the user out of their real CLI.
   */
  authStore?: CodexAuthStore
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
   * Defaults to a per-adapter-instance id, so one long conversation shares a cache
   * while separate conversations do not collide.
   */
  promptCacheKey?: string
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
): Promise<readonly ProviderCatalogModel[]> {
  const url = `${context.baseUrl}/models?client_version=${encodeURIComponent(clientVersion)}`
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  const signal = context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout])
  const response = await fetch(url, {
    headers: context.headers,
    signal,
  })
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
export function codexAdapter(options: CodexAdapterOptions = {}): HttpModelAdapter {
  const store = options.authStore ?? fileCodexAuthStore()
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
      resolve: async () => {
        const file = await store.read()
        let tokens = requireTokens(file, store.location)
        if (file !== undefined && shouldRefresh(file)) {
          tokens = await refreshCodexTokens(store, options.oauth ?? {})
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
      ? { discoverModels: (context) => discoverCodexModels(context, clientVersion, catalogLimits) }
      : { models: options.models },
    defaultMaxTokens: options.defaultMaxTokens ?? 32_000,
    defaultContextWindow: options.defaultContextWindow ?? 272_000,
    ...options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
    ...transportLimits(options),
    ...options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy },
    ...options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger },
  })
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

function transportLimits(options: CodexAdapterOptions) {
  return {
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes },
    ...options.maxResponseChunks === undefined ? {} : { maxResponseChunks: options.maxResponseChunks },
    ...options.maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes: options.maxErrorBodyBytes },
    ...options.requestLoggerTimeoutMs === undefined ? {} : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs },
  }
}
