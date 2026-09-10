# Anthropic

Runtime: **Universal** — Edge/Worker, browser, Deno, Bun, and Node.
Composition slot: `runtime.providers`.
Lifecycle: `inert-runtime-owned-registration`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-anthropic
```

Targets the **Anthropic Messages API** through
[`@alvin0/ai-agent-sdk-protocol-anthropic-messages`](/en/09-providers/protocols).

## Compose it

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
import { anthropicPlugin } from '@alvin0/ai-agent-sdk-provider-anthropic'

const apiKey = defineCredentialSource({
  id: 'anthropic',
  resolve: () => secretStore.get('anthropic'),
})

const runtime = await createAgentRuntime({
  providers: [anthropicPlugin({ apiKey })],
})

const agent = runtime.agent({
  id: 'reviewer',
  instructions: 'Review carefully and cite evidence.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
})
```

Credentials are **injected**. The package is Universal and never reads
environment variables or files itself; on Node use
`envCredential('ANTHROPIC_API_KEY')` from `@alvin0/ai-agent-sdk-auth-node`.

## Exports

```ts
export {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicAdapter,
  anthropicPlugin,
  type AnthropicAdapterOptions,
  type AnthropicCredential,
  type AnthropicPluginOptions,
  type AnthropicProviderOptions,
}
// Re-exported for convenience:
export {
  anthropicMessagesProtocol,
  type AnthropicDialect,
  type AnthropicReasoningState,
  type ThinkingBudgets,
}
```

| Export | Use |
| --- | --- |
| `anthropicPlugin(options)` | **Recommended.** Transactional registration. |
| `anthropicAdapter(options)` | Manual route registration. |
| `ANTHROPIC_VERSION` | The pinned API version header the adapter sends. |
| `DEFAULT_THINKING_BUDGETS` | Maps reasoning efforts to thinking token budgets. |

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
import { anthropicPlugin } from '@alvin0/ai-agent-sdk-provider-anthropic'

const apiKey = defineCredentialSource({
  id: 'anthropic',
  resolve: () => secretStore.get('anthropic'),
})

const registry = new ModelRegistry()
registry.install(anthropicPlugin({ apiKey }))
```

## Reasoning maps to thinking budgets

Anthropic expresses reasoning as a **token budget**, not an effort level. The
adapter bridges the neutral `effort` to a budget through
`DEFAULT_THINKING_BUDGETS`:

```ts
runtime.agent({
  id: 'analyst',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
  instructions: '…',
  effort: 'medium',        // → a thinking token budget
})
```

Override the mapping when your model or workload needs a different curve:

```ts
anthropicPlugin({
  apiKey,
  thinkingBudgets: { low: 1_024, medium: 8_192, high: 32_768 },
})
```

`AnthropicReasoningState` carries the adapter-private reasoning state needed for
replay.

## Capabilities

| Capability | Support | On mismatch |
| --- | --- | --- |
| Native web search | ✓ | — |
| Encrypted web-search result / citation replay state | ✓ preserved | — |
| Native image generation | ✗ | typed `INVALID_REQUEST` |
| Image input by URL / base64 | ✓ | — |
| Image input by `fileId` | ✗ | typed `INVALID_REQUEST` |
| `detail: 'original'` | ✗ | typed `INVALID_REQUEST` |
| Reasoning as thinking budget | ✓ | — |

**Unsupported selections are reported as typed errors, not silently dropped.**
That is the property worth relying on: an agent written against Responses does
not quietly lose its image-generation step when you point it at Anthropic — it
fails with a code you can branch on.

```ts
try {
  await agent.generate(input)
} catch (error) {
  if (error instanceof AgentSdkError && error.code === MODEL_ERROR_CODES.INVALID_REQUEST) {
    // e.g. native image generation was requested on Anthropic
  }
}
```

### Replay state

Anthropic returns **encrypted** native web-search results and citations that must
be replayed verbatim on the next request. The adapter preserves them in the
terminal `finish` chunk's `ReplayEnvelope`, and assembly keeps that metadata
aligned with the stored content.

You never handle it directly — but it is why an Anthropic conversation with web
search must keep its assembled messages rather than reconstructing them from
text.

## Model discovery

```ts
const catalog = await runtime.modelCatalog('anthropic')
```

`model.id` is required unless the route has a configured default. Adapters
declare combined context capacity, default and hard output limits, reasoning
efforts, modalities, and native-tool support — and `ModelRegistry` validates a
selection **before** provider I/O.

## Portable across both providers

Everything above the adapter speaks the neutral vocabulary, so the same agent
definition runs on either provider:

```ts
const definition = {
  id: 'reviewer',
  instructions: 'Review carefully and cite evidence.',
  tools: [readFile],
}

const onOpenAi = runtime.agent({ ...definition, model: { provider: 'openai', id: 'gpt-5.4' } })
const onAnthropic = runtime.agent({ ...definition, model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } })
```

What differs is exactly the capability table above — and those differences
surface as typed errors rather than behaviour drift.

## Read next

- [OpenAI](/en/09-providers/openai) · [Codex](/en/09-providers/codex)
- [Protocols](/en/09-providers/protocols)
- [Native Tools](/en/03-tools/native-tools)
