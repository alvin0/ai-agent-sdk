import type { CredentialOperationOptions, SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { requireGitHubToken, type CopilotAuthStore, type CopilotCredentialStore } from './auth.ts'
import { captureCopilotStore } from './common/store-capture.ts'
import { raceAbort } from './common/http.ts'
import {
  createCopilotTokenCache,
  type CopilotApiToken,
  type CopilotTokenCache,
  type CopilotTokenCacheOptions,
} from './exchange.ts'

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

/** Store-backed token acquisition, with an optional application-owned cache. */
export interface GetCopilotTokenOptions extends CopilotTokenCacheOptions {
  /** Reuse the same cache as copilotPlugin; when omitted each call exchanges anew. */
  readonly tokenCache?: CopilotTokenCache
  /** Invalidate the cached entry before acquisition; an in-flight exchange may be reused. */
  readonly forceRefresh?: boolean
}

/**
 * Read a GitHub credential from any store and acquire a live Copilot API token.
 * The GitHub credential does not rotate. A custom tokenCache can persist API tokens
 * in a database; its acquire/invalidate methods own refresh and cache policy.
 * When tokenCache is supplied, its configuration owns exchange settings.
 */
export async function getCopilotToken(
  store: CopilotCredentialStore | CopilotAuthStore,
  options: GetCopilotTokenOptions = {},
): Promise<CopilotApiToken> {
  const operation: CredentialOperationOptions = {
    signal: options.signal ?? new AbortController().signal,
    logger: NULL_LOGGER,
  }
  operation.signal.throwIfAborted()
  const captured = captureCopilotStore(store)
  const record = captured.kind === 'versioned'
    ? await raceAbort(captured.store.read(operation), operation.signal) : undefined
  const file = captured.kind === 'legacy'
    ? await raceAbort(captured.store.read(), operation.signal) : record?.value
  operation.signal.throwIfAborted()
  requireGitHubToken(file, captured.label)
  // The credential validation above establishes that file is present.
  if (file === undefined) throw new TypeError('Copilot credential is missing')
  const cache = options.tokenCache ?? createCopilotTokenCache(options)
  if (options.forceRefresh === true) cache.invalidate()
  operation.signal.throwIfAborted()
  return raceAbort(
    cache.acquire({ file, revision: record?.revision ?? null, label: captured.label }, operation),
    operation.signal,
  )
}
