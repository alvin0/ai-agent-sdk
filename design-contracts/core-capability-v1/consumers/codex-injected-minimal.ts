import { createAgentRuntime } from '@ai-agent-sdk/core'
import { defineCredentialStore } from '@ai-agent-sdk/core/provider'
import {
  codexPlugin,
  type CodexAuthFile,
} from '@ai-agent-sdk/provider-codex'

let revision = 0
let value: CodexAuthFile | undefined
const credentials = defineCredentialStore<CodexAuthFile>({
  id: 'host-codex-credentials',
  label: 'Host-injected Codex credentials',
  async read({ signal }) {
    signal.throwIfAborted()
    return value === undefined ? undefined : { value, revision: String(revision) }
  },
  async commit(input, { signal }) {
    signal.throwIfAborted()
    const expected = value === undefined ? null : String(revision)
    if (input.expectedRevision !== expected) throw new Error('revision conflict')
    value = input.value
    revision += 1
    return { revision: String(revision) }
  },
})

/** Universal Codex uses an injected store and must not select auth-node. */
export async function createMinimalCodexRuntime() {
  return await createAgentRuntime({ providers: [codexPlugin({ authStore: credentials })] })
}
