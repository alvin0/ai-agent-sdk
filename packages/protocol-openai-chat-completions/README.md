# @alvin0/ai-agent-sdk-protocol-openai-chat-completions

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-protocol-openai-chat-completions
```

Universal OpenAI Chat Completions wire schema, request serializer, stream translator, and dialect. It owns no endpoint, credentials, fetch implementation, filesystem access, or Node.js APIs, and it knows nothing about any specific provider that happens to speak this wire format.

```ts
import { openAiChatCompletionsProtocol } from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'
```

Composition: `provider-author.protocol`. Lifecycle: `inert-value`; select it in
`createRuntimeHttpProvider()` without any startup or cleanup obligation.

The only runtime dependency is `@alvin0/ai-agent-sdk-core`.
