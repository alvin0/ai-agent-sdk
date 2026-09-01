/**
 * The OpenAI provider: the Responses API on `api.openai.com`.
 *
 * Note how little there is here. Every endpoint fact is configuration handed to
 * {@link createHttpProvider}; the protocol, the pipeline, and the error mapping are
 * all shared. That is the intended shape for any endpoint speaking a protocol this
 * package already implements — including your own gateway.
 *
 * @module ai-agent-sdk/providers/openai/adapter
 */

import type { RetryPolicyConfig } from '@ai-agent-sdk/core'
import type {
  HttpModelAdapter,
  ProviderCatalogModel,
  ProviderRequestLogger,
} from '../base/index.ts'
import {
  apiKeyFromEnv,
  createHttpProvider,
  type CredentialSource,
} from '../http-provider.ts'
import { openAiResponsesProtocol } from '../protocols/openai-responses.ts'
import type { ResponsesDialect } from '../responses/wire.ts'

/** The OpenAI API base. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Environment variable read when no key is supplied. */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY'

/** How the API key is obtained. */
export type OpenAiCredential = CredentialSource

/** Options for {@link openAiAdapter}. */
export interface OpenAiAdapterOptions {
  /** The API key, or a resolver. Omit to read `OPENAI_API_KEY`. */
  apiKey?: OpenAiCredential
  /**
   * Endpoint base; defaults to {@link OPENAI_BASE_URL}.
   *
   * Point this at a compatible gateway to reuse this provider wholesale.
   */
  baseUrl?: string
  /** Organization to bill, when the key belongs to several. */
  organization?: string
  /** Project to attribute usage to. */
  project?: string
  /**
   * Advisory model catalog.
   *
   * Empty by default: this package cannot know which model ids are current, and a
   * stale built-in list would name retired models. Supply entries to declare
   * capabilities the SDK cannot infer, such as image support.
   */
  models?: readonly ProviderCatalogModel[]
  /** Whether the provider may retain responses server-side. Defaults to false. */
  store?: boolean
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
  /** Optional exact wire-request logger; credentials are redacted. */
  requestLogger?: ProviderRequestLogger
}

/**
 * Create an OpenAI adapter.
 * @param options - credential, endpoint, and catalog overrides.
 * @returns the adapter, ready to register.
 */
export function openAiAdapter(options: OpenAiAdapterOptions = {}): HttpModelAdapter {
  const dialect: Partial<ResponsesDialect> = options.store === undefined
    ? {}
    : { store: options.store }

  return createHttpProvider({
    displayName: 'OpenAI',
    protocol: openAiResponsesProtocol,
    baseUrl: options.baseUrl ?? OPENAI_BASE_URL,
    auth: {
      kind: 'bearer',
      token: options.apiKey ?? apiKeyFromEnv(OPENAI_API_KEY_ENV),
      label: options.apiKey === undefined ? OPENAI_API_KEY_ENV : 'the `apiKey` option',
    },
    dialect,
    headers: {
      ...options.organization === undefined
        ? {}
        : { 'openai-organization': options.organization },
      ...options.project === undefined ? {} : { 'openai-project': options.project },
    },
    ...options.models === undefined ? {} : { models: options.models },
    defaultMaxTokens: options.defaultMaxTokens ?? 32_000,
    defaultContextWindow: options.defaultContextWindow ?? 128_000,
    ...options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
    ...transportLimits(options),
    ...options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy },
    ...options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger },
  })
}

function transportLimits(options: OpenAiAdapterOptions) {
  return {
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes },
    ...options.maxResponseChunks === undefined ? {} : { maxResponseChunks: options.maxResponseChunks },
    ...options.maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes: options.maxErrorBodyBytes },
    ...options.requestLoggerTimeoutMs === undefined ? {} : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs },
  }
}
