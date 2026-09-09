# @alvin0/ai-agent-sdk-auth-node

Runtime: **Node 22.12+**.

Node-owned environment credentials and project-local Codex OAuth storage. The
package root and `/env` entrypoint are environment-only: installing either does
not require or load a model provider.

For an OpenAI agent whose key comes from the environment:

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai @alvin0/ai-agent-sdk-auth-node
```

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})
```

`envCredential()` is lazy, receives the model-operation cancellation signal and
remains callable for compatibility. It is borrowed by the provider and has no
close lifecycle.

Codex support is an explicit optional closure:

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex @alvin0/ai-agent-sdk-auth-node
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'

const runtime = await createAgentRuntime({
  providers: [codexNodeProviderPlugin()],
})
```

`codexNodeProviderPlugin()` uses the revisioned `fileCodexCredentialStore()` by
default. The store is borrowed and remains caller-owned; the runtime closes the
provider registration, not the store. Codex defaults to
`.providers/.codex/auth.json` below `process.cwd()` and never uses the Codex
CLI's global credential file. Writes use compare-and-swap under a cross-process
writer lock, a private same-directory temporary file, file sync, atomic rename,
mode `0600`, and directory sync. Credential-file symlinks are rejected.

The deprecated `fileCodexAuthStore()` and `codexNodePlugin()` retain the former
`read/write` compatibility contract. New runtime composition should use the
revisioned factory above.

Run `ai-agent-sdk-codex-login` after installation to authenticate this project.

Composition: `provider-factory.credentials`. Lifecycle: `borrowed-caller-owned`;
`envCredential()` and file-backed stores are resolved lazily by the selected
provider and are never closed by core.
