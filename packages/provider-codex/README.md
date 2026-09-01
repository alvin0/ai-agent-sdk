# @ai-agent-sdk/provider-codex

Universal Codex adapter, OAuth flows, memory/custom auth stores, and transactional provider plugin. A `CodexAuthStore` must be injected; filesystem and environment defaults belong to the Node auth package.

```ts
import { ModelRegistry } from '@ai-agent-sdk/core'
import { codexPlugin } from '@ai-agent-sdk/provider-codex'

const registry = new ModelRegistry()
registry.install(codexPlugin({ authStore: mySecretManagerStore }))
```

Use `codexAdapter()` for manual route registration. The store contract is
Universal; a browser, Worker, secret manager, or Node package owns persistence.
Credential and catalog observation excludes OAuth tokens, account details, store
locations, and raw authentication errors.
