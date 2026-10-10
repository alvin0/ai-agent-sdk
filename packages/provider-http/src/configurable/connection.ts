import { HttpCatalog } from './catalog.ts'
import { authHeaders } from './auth.ts'
import { positiveFinite, raceAbort } from './configuration-support.ts'
import type { HttpProviderOptions } from './http-options.ts'
import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import { attributionHeaders } from '@alvin0/ai-agent-sdk-core'
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RESPONSE_CHUNKS,
  DEFAULT_MAX_ERROR_BODY_BYTES,
  type HttpConnection,
} from '../base/http-adapter.ts'
import { captureHeaderLayer, DEFAULT_TRANSPORT_HEADERS, mergeHeaderLayers } from '../common/header-layers.ts'

interface ConnectionHost<Dialect extends object> {
  readonly options: HttpProviderOptions<Dialect>
  readonly dialect: Dialect
  readonly retry: ResolvedRetryPolicy
  readonly catalogCache: HttpCatalog<Dialect>
  readonly displayName: string
}
interface ConnectionOperation {
  signal: AbortSignal | undefined; context: ModelInvocationContext | undefined; model: string | undefined
}

export async function configuredConnection<Dialect extends object>(
    host: ConnectionHost<Dialect>,
    provider: string,
    operation: ConnectionOperation,
  ): Promise<HttpConnection> {
  const { signal, context, model } = operation
  const timeoutMs = positiveFinite(
    host.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  )
  const timeout = AbortSignal.timeout(timeoutMs)
  const operationSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const baseUrl = host.options.baseUrl.replace(/\/+$/, '')
    // Credential and endpoint resolve together, in one snapshot, so a rotating
    // secret can never be paired with a different generation's URL.
  const publicLayers = publicHeaderLayers(host, provider, { signal: operationSignal, context, model })
    // Structural conflicts that do not depend on credentials fail before secret
    // resolution. The captured layer snapshots cannot mutate while auth awaits.
  mergeHeaderLayers(publicLayers)
  const auth = await raceAbort(authHeaders(
    { options: host.options, displayName: host.displayName }, provider, operationSignal, context,
  ), operationSignal)
  const merged = mergeHeaderLayers([
    ...publicLayers,
    captureHeaderLayer({ layer: 'auth', headers: auth.headers }),
  ])
  const headers = merged.headers

  return {
    baseUrl,
    headers,
    sensitiveHeaderNames: merged.sensitiveHeaderNames,
    ...(Object.keys(auth.query).length === 0 ? {} : {
      queryOverrides: auth.query,
      sensitiveQueryParamNames: Object.freeze(Object.keys(auth.query)),
    }),
    ...connectionBounds(host.options),
    ...connectionSseOptions(host.options),
    maxErrorBodyBytes: host.options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES,
    ...connectionOverrides(host.options),
    retryPolicy: host.retry,
    models: host.options.models ?? await host.catalogCache.resolve(
      provider, baseUrl, headers, { signal: operationSignal, context },
    ),
    ...connectionModelDefaults(host.options),
  }
}

function publicHeaderLayers<Dialect extends object>(
  host: ConnectionHost<Dialect>, provider: string, operation: ConnectionOperation,
) {
  const { context, model } = operation
  const extra = endpointHeaderOptions(host.options, provider, operation)
  const modelEntry = configuredModel(host.options, model)
  return [
    captureHeaderLayer({
      layer: 'transport', headers: host.options.baseHeaders ?? DEFAULT_TRANSPORT_HEADERS,
    }),
    captureHeaderLayer({ layer: 'sdk-attribution', headers: attributionHeaders() }),
    captureHeaderLayer({
      layer: 'wire-protocol',
      headers: host.options.protocol.protocolHeaders?.(host.dialect) ?? {},
    }),
    captureHeaderLayer({ layer: 'endpoint', headers: extra }),
    // The model's own headers win over the route's, per decision 12's
    // "route, model, agent" precedence.
    captureHeaderLayer({ layer: 'endpoint', headers: modelEntry?.headers ?? {} }),
    // The agent's own headers, last among the public layers so they win over
    // both the route's and the model's.
    captureHeaderLayer({ layer: 'endpoint', headers: context?.providerOptions?.headers ?? {} }),
  ] as const
}

function configuredModel<Dialect extends object>(options: HttpProviderOptions<Dialect>, model: string | undefined) {
  return model === undefined ? undefined : options.models?.find(candidate => candidate.id === model)
}

function connectionBounds<Dialect extends object>(options: HttpProviderOptions<Dialect>) {
  return {
      streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxRequestBytes: options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      maxResponseChunks: options.maxResponseChunks ?? DEFAULT_MAX_RESPONSE_CHUNKS,
  }
}

function connectionSseOptions<Dialect extends object>(options: HttpProviderOptions<Dialect>) {
  return {
      ...(options.maxSseEvents === undefined ? {} : { maxSseEvents: options.maxSseEvents }),
      ...(options.maxSseEventChars === undefined
        ? {}
        : { maxSseEventChars: options.maxSseEventChars }),
  }
}

function connectionOverrides<Dialect extends object>(options: HttpProviderOptions<Dialect>) {
  return {
      ...options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: options.allowInsecureHttp },
      ...options.fetch === undefined ? {} : { fetch: options.fetch },
      ...options.requestLoggerTimeoutMs === undefined
        ? {}
        : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs },
  }
}

function connectionModelDefaults<Dialect extends object>(options: HttpProviderOptions<Dialect>) {
  return {
      ...(options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens }),
      ...(options.defaultContextWindow === undefined ? {} : { defaultContextWindow: options.defaultContextWindow }),
  }
}

function endpointHeaderOptions<Dialect extends object>(
  options: HttpProviderOptions<Dialect>, provider: string, operation: ConnectionOperation,
) {
  const { context, signal } = operation
  return typeof options.headers === 'function'
      ? options.headers({
        provider,
        ...(context?.agentId === undefined ? {} : { agentId: context.agentId }),
        ...(signal === undefined ? {} : { signal: signal }),
      })
      : options.headers ?? {}
}
