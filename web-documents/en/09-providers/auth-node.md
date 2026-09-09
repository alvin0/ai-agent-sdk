# `@ai-agent-sdk/auth-node`

Runtime: **Node 22.12+**. Entrypoints: `.`, `./env`, `./codex`.
Composition: `provider-factory.credentials`. Lifecycle: `borrowed-caller-owned` —
credentials are resolved lazily by the selected provider and are **never closed
by core**.

Node-owned environment credentials and project-local Codex OAuth storage. The
package root and `/env` entrypoint are **environment-only**: installing either
does not require or load a model provider.

---

## Root and `/env` — environment credentials

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-openai @ai-agent-sdk/auth-node
```

```ts
export function envCredential(envVar: string): CredentialSource & (() => string)
export const apiKeyFromEnv = envCredential   // alias
```

```ts
import { envCredential } from '@ai-agent-sdk/auth-node'
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})
```

`envCredential()` is **lazy**, receives the model-operation cancellation signal,
and remains callable as a plain function for compatibility. It is borrowed by the
provider and has no close lifecycle.

`@ai-agent-sdk/auth-node/env` is a retained compatibility route: an
identity-preserving view of the env-only root that does **not** pull in the
optional Codex closure.

---

## `/codex` — project-local Codex auth

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-codex @ai-agent-sdk/auth-node
```

```ts
export function codexNodeProviderPlugin(
  options?: CodexNodeProviderOptions,
): ComposableModelProviderPlugin

export function codexNodeAdapter(options?: CodexNodeAdapterOptions): ModelAdapter
export function codexNodePlugin(options?: CodexNodePluginOptions): ModelProviderPlugin

// Aliases kept so Node recipes read naturally
export const codexAdapter = codexNodeAdapter
export const codexPlugin = codexNodePlugin
export type CodexAdapterOptions = CodexNodeAdapterOptions
export type CodexPluginOptions = CodexNodePluginOptions

export { CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR }
```

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { codexNodeProviderPlugin } from '@ai-agent-sdk/auth-node/codex'

const runtime = await createAgentRuntime({
  providers: [codexNodeProviderPlugin()],
})
```

### Credential stores

```ts
fileCodexCredentialStore(options?)   // revisioned — use this
fileCodexAuthStore(options?)         // deprecated read/write compatibility contract
```

`codexNodeProviderPlugin()` uses the revisioned `fileCodexCredentialStore()` by
default. The store is **borrowed and remains caller-owned** — the runtime closes
the provider registration, not the store.

### Where tokens live, and why

Codex defaults to `.providers/.codex/auth.json` below `process.cwd()` and
**never** uses the Codex CLI's global credential file.

That isolation is deliberate: OAuth refresh tokens are single-use and rotate on
every refresh, so two programs sharing one credential file will eventually race —
the second to refresh replays a spent token and silently logs you out of your
real Codex CLI.

### Write safety

Writes use compare-and-swap under a **cross-process writer lock**, a private
same-directory temporary file, file sync, atomic rename, mode `0600`, and
directory sync. Credential-file symlinks are **rejected**.

### CLI

```bash
pnpm exec ai-agent-sdk-codex-login             # sign in
pnpm exec ai-agent-sdk-codex-login --status    # local account/status details
```

The package ships this binary and a `bin` directory as part of its packed
install surface.

## Read next

- [Codex](/en/09-providers/codex) — the provider that uses this store
- [Security](/en/10-advanced/security)
