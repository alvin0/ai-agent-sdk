import {
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'
import { codexResponseMediaFetch } from './common/response-media.ts'
import { CODEX_BASE_URL } from './adapter-types.ts'
import type { CodexAdapterOptions, CodexRevisionedAdapterOptions } from './adapter-types.ts'
import { positiveSafeInteger } from './catalog.ts'

export function transportLimits(options: CodexAdapterOptions | CodexRevisionedAdapterOptions) {
  return {
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes },
    ...options.maxResponseChunks === undefined ? {} : { maxResponseChunks: options.maxResponseChunks },
    ...options.maxSseEvents === undefined ? {} : { maxSseEvents: options.maxSseEvents },
    ...options.maxSseEventChars === undefined ? {} : { maxSseEventChars: options.maxSseEventChars },
    ...options.maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes: options.maxErrorBodyBytes },
    ...options.requestLoggerTimeoutMs === undefined ? {} : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs },
    fetch: mediaFetch(options),
  }
}
function mediaFetch(options: CodexAdapterOptions | CodexRevisionedAdapterOptions) {
  return codexResponseMediaFetch({
    baseUrl: options.baseUrl ?? CODEX_BASE_URL,
    officialBaseUrl: CODEX_BASE_URL,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
}

export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sdk-${Date.now().toString(36)}`
}
export function resolveCatalogLimits(options: CodexAdapterOptions | CodexRevisionedAdapterOptions) {
  return Object.freeze({
    maxBytes: positiveSafeInteger(options.maxCatalogBytes ?? 4 * 1024 * 1024, 'maxCatalogBytes'),
    maxModels: positiveSafeInteger(options.maxCatalogModels ?? 2_048, 'maxCatalogModels'),
    maxChunks: positiveSafeInteger(options.maxCatalogChunks ?? 10_000, 'maxCatalogChunks'),
    timeoutMs: positiveSafeInteger(options.catalogTimeoutMs ?? 30_000, 'catalogTimeoutMs'),
  })
}

export function codexDialect(promptCacheKey: string): Partial<ResponsesDialect> {
  return { sampling: false, maxOutputTokens: false, structuredOutputs: true, store: false,
    messagePhase: true, promptCacheKey }
}

export function adapterDefaults(options: CodexAdapterOptions | CodexRevisionedAdapterOptions) {
  return {
    defaultMaxTokens: options.defaultMaxTokens ?? 32_000,
    defaultContextWindow: options.defaultContextWindow ?? 272_000,
    ...options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
    ...options.catalogTtlMs === undefined ? {} : { catalogTtlMs: options.catalogTtlMs },
    ...options.catalogStaleTtlMs === undefined ? {} : { catalogStaleTtlMs: options.catalogStaleTtlMs },
    ...options.catalogFailureBackoffMs === undefined
      ? {}
      : { catalogFailureBackoffMs: options.catalogFailureBackoffMs },
  }
}

export function observerOptions(options: CodexAdapterOptions | CodexRevisionedAdapterOptions) {
  return {
    ...options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy },
    ...options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger },
    ...options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger },
  }
}
