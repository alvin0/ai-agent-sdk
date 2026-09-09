# @ai-agent-sdk/protocol-anthropic-messages

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/protocol-anthropic-messages
```

Universal Anthropic Messages wire schema, request serializer, stream translator, and dialect. It owns no endpoint, credentials, fetch implementation, filesystem access, or Node.js APIs.

```ts
import { anthropicMessagesProtocol } from '@ai-agent-sdk/protocol-anthropic-messages'
```

Composition: `provider-author.protocol`. Lifecycle: `inert-value`; select it in
`createRuntimeHttpProvider()` without any startup or cleanup obligation.

The only runtime dependency is `@ai-agent-sdk/core`.
