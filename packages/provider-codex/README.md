# @alvin0/ai-agent-sdk-provider-codex

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node with an injected auth store).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex
```

Universal Codex adapter, OAuth flows, memory/custom auth stores, and transactional provider plugin. A `CodexAuthStore` must be injected; filesystem and environment defaults belong to the Node auth package.

For normal runtime composition use a revisioned `CodexCredentialStore`, created
with `defineCredentialStore<CodexAuthFile>({ id, label, read, commit })`.
`getCodexTokens(store)` reads tokens and refreshes/commits when due;
`getCodexTokens(store, { refreshIfNeeded: false })` reads only.
`refreshCodexTokens(store)` explicitly refreshes and commits the rotated tokens.
These APIs and device login accept database stores without filesystem access.
See the [working database example](../../samples/credential-database/README.md).

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { codexPlugin } from '@alvin0/ai-agent-sdk-provider-codex'

const registry = new ModelRegistry()
registry.install(codexPlugin({ authStore: mySecretManagerStore }))
```

Use `codexAdapter()` for manual route registration. The store contract is
Universal; a browser, Worker, secret manager, or Node package owns persistence.
Credential and catalog observation excludes OAuth tokens, account details, store
locations, and raw authentication errors.

Composition: `runtime.providers`. Lifecycle: `inert-runtime-owned-registration`;
the runtime owns registration while the injected credential store remains
caller-owned.
