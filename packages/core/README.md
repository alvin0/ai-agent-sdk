# `@ai-agent-sdk/core`

Provider-neutral contracts and runtime primitives for building model adapters and streaming AI applications.

Runtime: **Universal**. Published code uses ECMAScript, Fetch-compatible types, Web Streams, AbortController, performance timing, and Web Crypto. It does not use Node built-ins, `process`, `Buffer`, local paths, filesystem access, child processes, or stdio.

```sh
pnpm add @ai-agent-sdk/core
```

```ts
import { ModelAdapter, ModelRegistry } from '@ai-agent-sdk/core'

const registry = new ModelRegistry()
registry.registerAdapter(['example'], new YourAdapter())

const call = registry.stream({
  provider: 'example',
  model: 'model-id',
  messages: [],
})

for await (const chunk of call) {
  // Consume normalized chunks.
}

const report = await call.report
```

The package includes message and stream contracts, model registry and retry primitives, normalized errors, usage accounting, explicit observation/correlation ports, and transactional provider-plugin registration. Provider HTTP/SSE transport, concrete exporters, filesystem skills, environment credentials, and protocol implementations belong to separate capability packages.

Only the documented root export and `./package.json` are public. Internal source paths are not compatibility contracts.
