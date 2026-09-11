# OpenAI

Runtime: **Universal** — Edge/Worker, browser, Deno, Bun, and Node.
Composition slot: `runtime.providers`.
Lifecycle: `inert-runtime-owned-registration`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai
```

Targets the **OpenAI Responses API** through
[`@alvin0/ai-agent-sdk-protocol-responses`](/en/09-providers/protocols).

## Compose it

To declare context windows and output budgets per model, see
[Configure context and output limits](/en/09-providers/#configure-context-and-output-limits).

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const apiKey = defineCredentialSource({
  id: 'openai',
  resolve: () => secretStore.get('openai'),
})

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'gpt-5.4' },
})
```

On Node, read the key from the environment through the Node auth package:

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'

openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })
```

The provider package is Universal and **never reads environment variables or
files itself** — environment lookup belongs to a Node wrapper.

## Exports

```ts
export {
  OPENAI_BASE_URL,
  openAiAdapter,
  openAiPlugin,
  type OpenAiAdapterOptions,
  type OpenAiCredential,
  type OpenAiPluginOptions,
  type OpenAiProviderOptions,
}
// Re-exported for convenience:
export { openAiResponsesProtocol, type ResponsesDialect }
```

| Export | Use |
| --- | --- |
| `openAiPlugin(options)` | **Recommended.** A transactional registration for `createAgentRuntime()`. |
| `openAiAdapter(options)` | Manual route registration on a `ModelRegistry`. |
| `OPENAI_BASE_URL` | The default endpoint, if you need to reference or override it. |

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const registry = new ModelRegistry()
registry.registerAdapter(['openai'], openAiAdapter({ apiKey }))
```

## Capabilities

| Capability | Support |
| --- | --- |
| Native web search | ✓ |
| Native image generation | ✓ |
| Image input by URL / base64 | ✓ |
| Image input by `fileId` | ✓ |
| Document (PDF) input by URL / base64 / `fileId` | ✓ |
| `detail: 'original'` | ✓ |
| Reasoning effort | ✓ — validated against the model's declared efforts |
| Replay state | ✓ |

```ts
runtime.agent({
  id: 'researcher',
  model: { provider: 'openai', id: 'gpt-5.6' },
  instructions: 'Gather evidence before answering.',
  effort: 'medium',
  nativeTools: [
    { type: 'native', name: 'web-search', allowedDomains: ['openai.com'] },
    { type: 'native', name: 'image-generation', format: 'webp', partialImages: 2 },
  ],
})
```

See [Native Tools](/en/03-tools/native-tools) for the event surface.

## Model discovery

```ts
const catalog = await runtime.modelCatalog('openai')
```

`model.id` is **required** unless the route has a configured default. There is no
built-in default model: provider lineups turn over faster than this package's
release cadence, so any built-in default would eventually name a retired model.

## Retry

```ts
import { withRetry } from '@alvin0/ai-agent-sdk-core'

registry.registerAdapter(['openai'], withRetry(openAiAdapter({ apiKey }), {
  policy: { mode: 'normal', maxRetries: 3 },
  onRetry: attempt => console.warn(`retry ${attempt.attempt}: ${attempt.failure.code}`),
}))
```

Retry only covers failures **before the first chunk reaches the consumer** —
replaying delivered tokens would duplicate output. `AUTH`, `INVALID_REQUEST`,
`QUOTA`, and `CONTEXT_WINDOW_EXCEEDED` are excluded by default because they fail
identically on every attempt.

## Multiple accounts

```ts
const runtime = await createAgentRuntime({
  providers: [
    openAiPlugin({ id: 'openai-eu', apiKey: euKey }),
    openAiPlugin({ id: 'openai-us', apiKey: usKey }),
  ],
})

runtime.agent({ id: 'eu-agent', model: { provider: 'openai-eu', id: 'gpt-5.4' }, instructions: '…' })
```

Explicit instance IDs and routes make two accounts in one provider family
unambiguous. Discovery reports one row per route, with separate route,
plugin-instance, and provider-family identity.

A route collision fails **before setup completes** with
`DUPLICATE_ADAPTER`, not at first use.

## An OpenAI-compatible endpoint

Any endpoint speaking the **Responses** protocol needs no new package:

```ts
import { openAiResponsesProtocol } from '@alvin0/ai-agent-sdk-protocol-responses'
import { createHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'

registry.registerAdapter(['openrouter'], createHttpProvider({
  displayName: 'OpenRouter',
  protocol: openAiResponsesProtocol,
  baseUrl: 'https://openrouter.ai/api/v1',
  auth: { kind: 'bearer', token: envCredential('OPENROUTER_API_KEY') },
}))
```

> An endpoint that speaks **Chat Completions** rather than Responses is a
> different wire protocol and needs a protocol implementation — see
> [Custom Provider](/en/09-providers/custom-provider).

## Read next

- [Anthropic](/en/09-providers/anthropic) · [Codex](/en/09-providers/codex)
- [Protocols](/en/09-providers/protocols)
- [Custom Provider](/en/09-providers/custom-provider)
