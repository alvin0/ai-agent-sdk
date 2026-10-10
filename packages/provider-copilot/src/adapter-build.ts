import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core/provider'
import { type CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import {
  createRuntimeHttpProvider, type HttpModelAdapter, type ProviderCatalogModel,
  type RuntimeModelDiscoveryContext,
} from '@alvin0/ai-agent-sdk-provider-http'
import { openAiChatCompletionsProtocol } from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'
import { openAiResponsesProtocol } from '@alvin0/ai-agent-sdk-protocol-responses'
import { requireGitHubToken } from './auth.ts'
import { copilotCatalogCacheOptions, discoverCopilotModels, resolveCopilotCatalogLimits } from './catalog.ts'
import { COPILOT_ERROR_CODES } from './common/error-codes.ts'
import { COPILOT_BASE_URL, resolveCopilotEditorHeaders, type CopilotEditorHeaders } from './common/identity.ts'
import { type CapturedCopilotStore } from './common/store-capture.ts'
import { copilotDualProtocol, type CopilotDialect } from './dual-protocol.ts'
import { createCopilotTokenCache, type CopilotTokenCache } from './exchange.ts'
import { COPILOT_RESPONSES_MODEL_PREFIXES, createCopilotEndpointRouter } from './router.ts'
import type { CopilotProviderOptions, CopilotLegacyProviderOptions } from './adapter-types.ts'
import { COPILOT_ROUTE_ID, COPILOT_DISPLAY_NAME } from './adapter-types.ts'
import { NULL_LOGGER, createCopilotSecrets, readCopilotSnapshot, randomId } from './adapter-auth.ts'
import { copilotProviderFetch, isMissingEditorHeaderFailure } from './adapter-fetch.ts'

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
export function buildCopilotAdapter(
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
  const cache = tokenCacheOf(options, { providerId, editorHeaders })
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
    auth: dynamicAuth({ captured, cache, secrets, editorHeaders }),
    ...catalogOptions(options, { router, catalogLimits }),
    ...copilotCatalogCacheOptions(options),
    ...modelLimits(options),
    ...transportLimits(options),
    // The transport-layer half of Requirement 2.3, stated rather than inherited.
    // `accept` travels with it because both names belong to the same layer and
    // supplying one of a pair while defaulting the other is how a stream ends up
    // asking for JSON.
    baseHeaders: COPILOT_TRANSPORT_HEADERS,
    ...observerOptions(options),
    // A 400 for a missing editor header, and ONLY that, gets the Copilot code.
    errorCode: (status: number, detail: string): string | undefined =>
      isMissingEditorHeaderFailure(status, detail)
        ? COPILOT_ERROR_CODES.EDITOR_HEADERS_MISSING
        : undefined,
    fetch: copilotProviderFetch(options, secrets),
  })
}

/**
 * Forward every transport bound the caller set, and only those.
 * @param options - the caller's options.
 * @returns an object carrying the configured transport limits.
 */
export function transportLimits(
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

/**
 * The two transport-owned headers, sent on every request (Requirement 2.3).
 *
 * `content-type` cannot come from the auth layer — `provider-http` owns the name
 * at the transport layer and refuses a second owner — so it is declared here,
 * where it is allowed and where it is visible.
 */
export const COPILOT_TRANSPORT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json',
  accept: 'text/event-stream',
})

function tokenCacheOf(
  options: CopilotProviderOptions | CopilotLegacyProviderOptions,
  context: { providerId: string; editorHeaders: Required<CopilotEditorHeaders> },
): CopilotTokenCache {
  const { providerId, editorHeaders } = context
  return options.tokenCache ?? createCopilotTokenCache({
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
}

function catalogOptions(
  options: CopilotProviderOptions | CopilotLegacyProviderOptions,
  context: { router: ReturnType<typeof createCopilotEndpointRouter>;
    catalogLimits: ReturnType<typeof resolveCopilotCatalogLimits> },
) {
  const { router, catalogLimits } = context
  return options.models === undefined
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
      : { models: options.models }
}

function modelLimits(options: CopilotProviderOptions | CopilotLegacyProviderOptions) {
  return {
    ...(options.maxCatalogModels === undefined
      ? {}
      : { maxCatalogModels: options.maxCatalogModels }),
    ...(options.maxCatalogBytes === undefined ? {} : { maxCatalogBytes: options.maxCatalogBytes }),
    ...(options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens }),
    ...(options.defaultContextWindow === undefined
      ? {}
      : { defaultContextWindow: options.defaultContextWindow }),
  }
}

function dynamicAuth(ctx: { captured: CapturedCopilotStore; cache: CopilotTokenCache;
  secrets: ReturnType<typeof createCopilotSecrets>; editorHeaders: Required<CopilotEditorHeaders> }) {
  const { captured, cache, secrets, editorHeaders } = ctx
  return {
      kind: 'dynamic' as const,
      resolve: async ({ signal, context }: { signal: AbortSignal; context?: ModelInvocationContext }) => {
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
  }
}

function observerOptions(options: CopilotProviderOptions | CopilotLegacyProviderOptions) {
  return {
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
    ...(options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger }),
  }
}
