import { createAgentRuntime } from '@ai-agent-sdk/core'
import { defineCredentialStore } from '@ai-agent-sdk/core/provider'
import { anthropicPlugin } from '@ai-agent-sdk/provider-anthropic'
import {
  codexPlugin,
  type CodexAuthFile,
} from '@ai-agent-sdk/provider-codex'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

let codexRevision = 0
let codexValue: CodexAuthFile | undefined
const codexSecretStore = defineCredentialStore<CodexAuthFile>({
  id: 'edge-secret-manager',
  label: 'Host-injected Codex credentials',
  async read({ signal }) {
    signal.throwIfAborted()
    return codexValue === undefined
      ? undefined
      : { value: codexValue, revision: String(codexRevision) }
  },
  async commit(input, { signal }) {
    signal.throwIfAborted()
    const current = codexValue === undefined ? null : String(codexRevision)
    if (input.expectedRevision !== current) throw new Error('revision conflict')
    codexValue = input.value
    codexRevision += 1
    return { revision: String(codexRevision) }
  },
})

/** Official factories hide HTTP/protocol packages while retaining provider-specific options. */
export async function createOfficialProviderRuntime(fetch: typeof globalThis.fetch) {
  return await createAgentRuntime({
    providers: [
      openAiPlugin({
        id: 'openai-gateway',
        apiKey: 'host-injected-openai-key',
        baseUrl: 'https://openai-gateway.example.test/v1',
        organization: 'example-org',
        project: 'research',
        store: false,
        models: [{ id: 'gateway-model', nativeTools: ['web-search'] }],
        maxSseEvents: 50_000,
        fetch,
      }),
      anthropicPlugin({
        id: 'anthropic-research',
        apiKey: 'host-injected-anthropic-key',
        version: '2023-06-01',
        beta: ['example-beta'],
        thinkingBudgets: { off: 0, high: 24_576 },
        maxSseEventChars: 1_048_576,
        fetch,
      }),
      codexPlugin({
        id: 'codex-account-a',
        authStore: codexSecretStore,
        clientVersion: 'host-version',
        maxCatalogModels: 2_048,
        catalogStaleTtlMs: 0,
        promptCacheKey: 'provider-instance-cache-key',
        fetch,
      }),
    ],
  })
}
