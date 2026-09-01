# @ai-agent-sdk/provider-openai

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-openai
```

Universal OpenAI adapter and transactional provider plugin. Credentials are injected; this package never reads environment variables or files.

```ts
import { ModelRegistry } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

const registry = new ModelRegistry()
registry.install(openAiPlugin({ apiKey: () => secretStore.get('openai') }))
```

Use `openAiAdapter()` for manual route registration. Both APIs are Universal and
require an explicit `apiKey`; environment lookup belongs to a Node wrapper.
