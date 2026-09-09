# @alvin0/ai-agent-sdk-provider-openai

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai
```

Universal OpenAI adapter and transactional provider plugin. Credentials are injected; this package never reads environment variables or files.

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const registry = new ModelRegistry()
registry.install(openAiPlugin({ apiKey: () => secretStore.get('openai') }))
```

Use `openAiAdapter()` for manual route registration. Both APIs are Universal and
require an explicit `apiKey`; environment lookup belongs to a Node wrapper.

Both accept `models: [{ id, contextWindow, maxTokens }]` plus provider-level
`defaultContextWindow` and `defaultMaxTokens` fallbacks. Currently a catalog
model's `maxTokens` is both its default output budget and its SDK output ceiling;
set a lower `maxTokens` on the agent to request less output. See the
[provider model limits guide](../../web-documents/en/09-providers/index.md) for an example
and precedence rules. These declarations do not increase server-side limits.

Composition: `runtime.providers`. Lifecycle: `inert-runtime-owned-registration`;
the runtime activates and removes the captured provider registration.
