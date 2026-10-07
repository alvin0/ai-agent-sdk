import {
  type CredentialOperationOptions,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  observeCredentialOperation,
} from '@alvin0/ai-agent-sdk-provider-http'
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
} from './oauth.ts'
import { CODEX_ORIGINATOR } from './adapter-types.ts'
import type { CodexAdapterOptions, CodexRevisionedAdapterOptions } from './adapter-types.ts'
import type { ModelInvocationContext } from '@alvin0/ai-agent-sdk-core/provider'

interface RuntimeAuthContext { provider: string; signal: AbortSignal; context?: ModelInvocationContext }

export const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined, debug: () => undefined, info: () => undefined,
  warn: () => undefined, error: () => undefined, fatal: () => undefined,
})

export function legacyAuth(
  options: CodexAdapterOptions | CodexRevisionedAdapterOptions, store: CodexAuthStore, promptCacheKey: string,
) {
  return {
    kind: 'dynamic' as const,
    resolve: async (_signal?: AbortSignal, context?: ModelInvocationContext) => {
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
  }
}

export function runtimeAuth(
  options: CodexAdapterOptions | CodexRevisionedAdapterOptions, store: CodexCredentialStore, promptCacheKey: string,
) {
  return {
    kind: 'dynamic' as const,
    resolve: async ({ provider, signal, context }: RuntimeAuthContext) => {
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
  }
}
