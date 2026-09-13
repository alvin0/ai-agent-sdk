# @alvin0/ai-agent-sdk-provider-anthropic

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

Compatible gateways can configure `baseUrl`, `models`, `fetch`, and `headers`
(a string record or synchronous function returning one per operation).
Generation uses the Messages protocol.
Header names are case-insensitive; collisions and reserved auth/transport headers
are rejected. Supply credentials with `apiKey`; use `version` and `beta` for
Anthropic protocol headers. Static records are copied.
Trusted local HTTP gateways require `allowInsecureHttp: true`.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-anthropic
```

Universal Anthropic adapter and transactional provider plugin. Credentials are injected; this package never reads environment variables or files.

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { anthropicPlugin } from '@alvin0/ai-agent-sdk-provider-anthropic'

const registry = new ModelRegistry()
registry.install(anthropicPlugin({ apiKey: () => secretStore.get('anthropic') }))
```

Use `anthropicAdapter()` for manual route registration. Both APIs are Universal
and require an explicit `apiKey`; environment lookup belongs to a Node wrapper.

Composition: `runtime.providers`. Lifecycle: `inert-runtime-owned-registration`;
the runtime activates and removes the captured provider registration.
