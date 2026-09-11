# Gemini

Runtime: **Universal** — Edge/Worker, browser, Deno, Bun, and Node.
Composition slot: `runtime.providers`.
Lifecycle: `inert-runtime-owned-registration`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-gemini
```

Targets **only** Google's Gemini **Interactions** endpoint at
`/v1beta/interactions`, through
[`@alvin0/ai-agent-sdk-protocol-gemini-interactions`](/en/09-providers/protocols).

> It does **not** use `generateContent`, and it does **not** use the
> OpenAI-compatible Chat Completions endpoint. Those are different wire
> protocols.

## Compose it

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
import { geminiPlugin } from '@alvin0/ai-agent-sdk-provider-gemini'

const apiKey = defineCredentialSource({
  id: 'gemini',
  resolve: () => secretStore.get('gemini'),
})

const runtime = await createAgentRuntime({
  providers: [geminiPlugin({ apiKey })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'gemini', id: 'gemini-3-pro' },
})
```

On Node, read the key from the environment through the Node auth package:

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'

geminiPlugin({ apiKey: envCredential('GEMINI_API_KEY') })
```

Credentials are always **injected**. This package never reads `.env`,
environment variables, or files — that belongs to a Node wrapper.

The key is sent as the `x-goog-api-key` header, not as a query parameter.

## Exports

```ts
export {
  GEMINI_BASE_URL,
  geminiAdapter,
  geminiPlugin,
  type GeminiAdapterOptions,
  type GeminiCredential,
  type GeminiPluginOptions,
  type GeminiProviderOptions,
}
// Re-exported for convenience:
export { geminiInteractionsProtocol, type GeminiInteractionsDialect }
```

| Export | Use |
| --- | --- |
| `geminiPlugin(options)` | **Recommended.** Transactional registration for `createAgentRuntime()`. |
| `geminiAdapter(options)` | Manual route registration on a `ModelRegistry`. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` |

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { geminiAdapter } from '@alvin0/ai-agent-sdk-provider-gemini'

const registry = new ModelRegistry()
registry.registerAdapter(['gemini'], geminiAdapter({ apiKey }))
```

## Options

```ts
interface GeminiAdapterOptions {
  apiKey: GeminiCredential          // required; injected
  baseUrl?: string                  // defaults to GEMINI_BASE_URL
  models?: readonly ProviderCatalogModel[]
  store?: boolean                   // may Google retain the interaction? default false
  defaultMaxTokens?: number         // 8,192
  defaultContextWindow?: number     // 1,000,000
  streamIdleTimeoutMs?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxResponseChunks?: number
  maxSseEvents?: number
  maxSseEventChars?: number
  maxErrorBodyBytes?: number
  requestLoggerTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
  requestLogger?: ProviderRequestLogger
  fetch?: typeof globalThis.fetch
}
```

`GeminiProviderOptions` adds `id`, `routes`, and `defaultModel` for runtime
composition:

```ts
geminiPlugin({
  id: 'gemini-eu',
  routes: ['gemini-eu'],
  defaultModel: 'gemini-3-pro',
  apiKey: euKey,
})
```

### `store` — data retention is opt-in

```ts
geminiPlugin({ apiKey, store: true })   // default is false
```

`store: false` is the default, so Google is asked **not** to retain the request
and interaction unless you opt in. It maps to the protocol dialect, not to a
per-request flag.

### No built-in model ids

`models` is an **advisory** catalog and there are no model ids compiled into the
package — so the list cannot go stale when Google's lineup turns over.

```ts
const catalog = await runtime.modelCatalog('gemini')
```

`model.id` is required unless the route has a configured `defaultModel`.

## Capabilities

| Capability | Support | On mismatch |
| --- | --- | --- |
| Structured output (`outputFormat`) | ✓ `text` and `json_schema` | — |
| Reasoning effort | ✓ mapped to `thinking_level` | — |
| Thought summaries | ✓ `thinkingSummaries: 'auto' \| 'none'` | — |
| Native web search | ✓ mapped to `google_search` | — |
| Web-search filters (`allowedDomains`, `blockedDomains`, `searchContextSize`, `userLocation`, `maxUses`) | ✗ | typed `INVALID_REQUEST` |
| Native image generation | ✗ not exposed as an SDK native tool | typed `INVALID_REQUEST` |
| Image input — base64, URL, file id | ✓ | — |
| Document (PDF) input — base64, URL, file uri | ✓ declare `inputModalities: ['text', 'image', 'document']` | projected to text |
| `toolChoice` including forcing web search | ✓ | — |

### Web search is all-or-nothing

```ts
runtime.agent({
  /* … */
  nativeTools: [{ type: 'native', name: 'web-search' }],   // ✓
})

runtime.agent({
  /* … */
  nativeTools: [{ type: 'native', name: 'web-search', allowedDomains: ['example.com'] }],
})
// ✗ INVALID_REQUEST: "Gemini Interactions web search does not support SDK search
//    filters or limits"
```

The Interactions endpoint exposes `google_search` without the SDK's filter
vocabulary. Rather than silently dropping your filters — which would widen the
search you thought you had narrowed — the adapter fails with a typed error.

That is the same honesty rule Anthropic follows for native image generation.

### Reasoning

```ts
runtime.agent({
  id: 'analyst',
  model: { provider: 'gemini', id: 'gemini-3-pro' },
  instructions: '…',
  effort: 'medium',        // → thinking_level
})
```

Thought summaries are requested when reasoning is selected, controlled by the
dialect's `thinkingSummaries` (`'auto'` by default, `'none'` to suppress).
Summaries arrive as ordinary `reasoning` events — never mixed into public text.

## Structured output

Gemini Interactions supports the neutral `outputFormat` contract directly:

```ts
const agent = runtime.agent({
  id: 'extractor',
  model: { provider: 'gemini', id: 'gemini-3-pro' },
  instructions: 'Extract the invoice fields.',
  outputFormat: {
    type: 'json_schema',
    name: 'invoice',
    schema: {
      type: 'object',
      properties: { id: { type: 'string' }, total: { type: 'number' } },
      required: ['id', 'total'],
    },
  },
})
```

See [Structured Output](/en/02-agents/structured-output) for the loop behaviour
when tools and a JSON schema are combined.

## Multiple accounts

```ts
const runtime = await createAgentRuntime({
  providers: [
    geminiPlugin({ id: 'gemini-eu', apiKey: euKey }),
    geminiPlugin({ id: 'gemini-us', apiKey: usKey }),
  ],
})
```

Explicit instance IDs and routes keep two accounts in one provider family
unambiguous. A route collision fails **before setup completes** with
`DUPLICATE_ADAPTER`.

## Portable across providers

Everything above the adapter speaks the neutral vocabulary, so one definition
runs on any of the four shipped providers:

```ts
const definition = { id: 'reviewer', instructions: '…', tools: [readFile] }

runtime.agent({ ...definition, model: { provider: 'gemini', id: 'gemini-3-pro' } })
runtime.agent({ ...definition, model: { provider: 'openai', id: 'gpt-5.4' } })
runtime.agent({ ...definition, model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } })
```

What differs is exactly the capability table above — and the differences surface
as typed errors, not behaviour drift.

## Read next

- [OpenAI](/en/09-providers/openai) · [Anthropic](/en/09-providers/anthropic) · [Codex](/en/09-providers/codex)
- [Protocols](/en/09-providers/protocols)
- [Structured Output](/en/02-agents/structured-output)
