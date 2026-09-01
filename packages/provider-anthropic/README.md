# @ai-agent-sdk/provider-anthropic

Universal Anthropic adapter and transactional provider plugin. Credentials are injected; this package never reads environment variables or files.

```ts
import { ModelRegistry } from '@ai-agent-sdk/core'
import { anthropicPlugin } from '@ai-agent-sdk/provider-anthropic'

const registry = new ModelRegistry()
registry.install(anthropicPlugin({ apiKey: () => secretStore.get('anthropic') }))
```

Use `anthropicAdapter()` for manual route registration. Both APIs are Universal
and require an explicit `apiKey`; environment lookup belongs to a Node wrapper.
