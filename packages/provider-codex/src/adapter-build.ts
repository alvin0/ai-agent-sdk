import { randomId } from './adapter-options.ts'
import type {
  HttpModelAdapter,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  createHttpProvider,
  createModelContextPolicy,
  createRuntimeHttpProvider,

} from '@alvin0/ai-agent-sdk-provider-http'
import {
  openAiResponsesProtocol,
} from '@alvin0/ai-agent-sdk-protocol-responses'
import { captureCodexStore } from './common/store-capture.ts'
import { CODEX_BASE_URL, CODEX_CLIENT_VERSION } from './adapter-types.ts'
import type { CodexAdapterOptions, CodexRevisionedAdapterOptions } from './adapter-types.ts'
import {
  resolveCatalogLimits,
  codexDialect,
  adapterDefaults,
  transportLimits,
  observerOptions,
}
  from './adapter-options.ts'
import { legacyAuth, runtimeAuth } from './adapter-auth.ts'

import { discoverCodexModels } from './catalog.ts'

export function legacyCodexAdapter(
  options: CodexAdapterOptions,
  captured = captureCodexStore(options.authStore),
): HttpModelAdapter {
  if (captured.kind !== 'legacy') {
    throw new TypeError('Codex legacy adapter requires a read/write auth store')
  }
  const store = captured.store
  const promptCacheKey = options.promptCacheKey ?? randomId()
  const clientVersion = options.clientVersion ?? CODEX_CLIENT_VERSION
  const catalogLimits = resolveCatalogLimits(options)
  return createHttpProvider({
    describeModel: createModelContextPolicy({}, options.models, options.defaultContextWindow),
    displayName: 'Codex',
    protocol: openAiResponsesProtocol,
    baseUrl: options.baseUrl ?? CODEX_BASE_URL,
    dialect: codexDialect(promptCacheKey),
    auth: legacyAuth(options, store, promptCacheKey),
    ...(options.models === undefined
      ? { discoverModels: context => discoverCodexModels(
        context,
        clientVersion,
        catalogLimits,
        options.fetch ?? globalThis.fetch,
      ) }
      : { models: options.models }),
    ...adapterDefaults(options),
    ...transportLimits(options),
    ...observerOptions(options),
  })
}

export function runtimeCodexAdapter(
  options: CodexRevisionedAdapterOptions,
  captured = captureCodexStore(options.authStore),
): HttpModelAdapter {
  if (captured.kind !== 'versioned') {
    throw new TypeError('Codex runtime authStore must be a versioned credential store')
  }
  const store = captured.store
  const promptCacheKey = options.promptCacheKey ?? randomId()
  const clientVersion = options.clientVersion ?? CODEX_CLIENT_VERSION
  const catalogLimits = resolveCatalogLimits(options)
  return createRuntimeHttpProvider({
    describeModel: createModelContextPolicy({}, options.models, options.defaultContextWindow),
    displayName: 'Codex',
    protocol: openAiResponsesProtocol,
    baseUrl: options.baseUrl ?? CODEX_BASE_URL,
    dialect: codexDialect(promptCacheKey),
    auth: runtimeAuth(options, store, promptCacheKey),
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
    ...adapterDefaults(options),
    ...transportLimits(options),
    ...observerOptions(options),
  })
}
