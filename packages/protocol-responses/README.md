# @ai-agent-sdk/protocol-responses

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @ai-agent-sdk/core @ai-agent-sdk/protocol-responses
```

Universal OpenAI Responses/Codex wire schema, request serializer, stream translator, and dialect. It owns no endpoint, credentials, fetch implementation, filesystem access, or Node.js APIs.

```ts
import { openAiResponsesProtocol } from '@ai-agent-sdk/protocol-responses'
```

Composition: `provider-author.protocol`. Lifecycle: `inert-value`; select it in
`createRuntimeHttpProvider()` without any startup or cleanup obligation.

The only runtime dependency is `@ai-agent-sdk/core`.
