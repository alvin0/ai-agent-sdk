# Providers — Overview

## Two layers, one rule

**Adapters are the only layer that knows a wire format.** A provider package
supplies four things — `connect`, `endpointPath`, `buildBody`, `translate` — and
`stream()` lives in the base class, not in the provider.

That single rule is what prevents a provider from shipping its own fetch loop
that forgets attribution headers, mishandles abort, or invents error codes.

## Built-in providers

| Entry point | Endpoint | Credential |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-provider-anthropic` | Messages API | injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-openai` | Responses API | injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-codex` | ChatGPT-backed Codex | injected `CodexAuthStore` |
| `@alvin0/ai-agent-sdk-provider-gemini` | Gemini Interactions API | injected `apiKey` |
| `@alvin0/ai-agent-sdk-provider-copilot` | Copilot subscription surface | injected `CopilotCredentialStore` |
| `@alvin0/ai-agent-sdk-auth-node/codex` | Codex on Node | project-local device-code login |
| `@alvin0/ai-agent-sdk-auth-node/copilot` | Copilot on Node | project-local device-code login |

`openai` and `codex` share **one** Responses implementation
(`@alvin0/ai-agent-sdk-protocol-responses`) and differ only by a small dialect record:
base URL, auth, and which optional fields the endpoint accepts.

Every provider package is Universal and requires an explicit credential. It never
reads environment variables or files — environment lookup belongs to a Node
wrapper such as `@alvin0/ai-agent-sdk-auth-node`.

## Two registration styles

**Plugin (recommended).** A transactional registration the runtime activates and
removes:

```ts
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const apiKey = defineCredentialSource({
  id: 'openai',
  resolve: () => secretStore.get('openai'),
})

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
})
```

**Adapter (manual routes).** Direct registry control:

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const registry = new ModelRegistry()
registry.registerAdapter(['openai'], openAiAdapter({ apiKey }))
```

`registry.install(plugin)` also accepts a plugin directly.

## The registry does more than route

`ModelRegistry` validates and snapshots each adapter's declared capabilities, and
`prepareCall()` returns a **generation-bound** `model` capability snapshot:
combined context window, default and hard output limits, reasoning efforts,
input/output modalities, and explicit native-tool support.

Before any provider I/O, the registry:

- materializes model defaults;
- rejects an unsupported reasoning effort (`UNSUPPORTED_REASONING_EFFORT`);
- rejects an unsupported native tool (`UNSUPPORTED_NATIVE_TOOL`);
- rejects an output selection above the model's hard ceiling
  (`OUTPUT_TOKEN_LIMIT_EXCEEDED`);
- projects image input away only for models that explicitly lack vision;
- prevents an output reservation from consuming the whole combined context window.

These are execution invariants, not UI-only catalog fields. Automatic compaction
also reserves the selected model's output headroom rather than filling the entire
combined window.

## Configure context and output limits

Declare these limits when creating the provider plugin or adapter. The built-in
HTTP-based providers accept `models`, `defaultContextWindow`, and
`defaultMaxTokens`. Model IDs and numbers below are illustrative, not a catalog
of real model limits; replace them with values for your endpoint.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({
    apiKey: 'YOUR_API_KEY',
    defaultContextWindow: 128_000,
    defaultMaxTokens: 8_192,
    models: [
      { id: 'model-a', contextWindow: 128_000, maxTokens: 16_384 },
      { id: 'model-b', contextWindow: 200_000, maxTokens: 32_768 },
    ],
  })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'model-a' },
  maxTokens: 4_096,
})
```

| Setting | Meaning |
| --- | --- |
| `models[].contextWindow` | Combined input/output capacity for that exact model ID. |
| `models[].maxTokens` | Both the default output budget and the SDK output ceiling for that model. |
| `defaultContextWindow` | Fallback when the selected model has no declared context window. |
| `defaultMaxTokens` | Fallback default and output ceiling when the selected model has no declared `maxTokens`. |
| Agent `maxTokens` | Output budget for the agent; may be lower than the model ceiling. |

Fallback is per field, not just for models missing from the catalog. If provider
defaults are also omitted, the adapter's built-in defaults apply. These are
declared SDK assumptions, not an automatic guarantee of current provider limits.

The output budget is the explicit agent/call `maxTokens`, otherwise the model's
resolved default. Exceeding the declared ceiling rejects with
`OUTPUT_TOKEN_LIMIT_EXCEEDED`; the SDK does not silently clamp the request.
The output reservation must also be smaller than the combined context window.

**Current catalog limitation:** `ProviderCatalogModel` has only `maxTokens`,
not separate `defaultMaxTokens` and `maxOutputTokens` per model. Internally it
populates both. A provider-level `defaultMaxTokens: 8192` does not lower the
default for a model declaring `maxTokens: 16384`; set the agent's `maxTokens`
to request less output.

When auto-compaction is enabled, the default pressure threshold is
`min(contextWindow * 0.8, contextWindow - outputReserve)`. The reserve uses
explicit `maxTokens`, then model default, then model maximum if available.
An explicit compaction `maxInputTokens` replaces the ratio threshold but is
still bounded by the available input window. Token counts are estimates, not
an exact per-model tokenizer; overflow can still occur. Declaring these values
does not increase server limits or make an unsupported wire parameter supported.

## Model discovery

```ts
const catalog = await runtime.modelCatalog('openai')
```

Some providers discover their catalog from the endpoint because the available
models depend on the account's plan — Codex is the built-in example:

```ts
import { codexAdapter } from '@alvin0/ai-agent-sdk-auth-node/codex'

registry.registerAdapter(['codex'], codexAdapter())
const models = await registry.listModels('codex')
```

> The Codex endpoint serves the Codex CLI and identifies its client with an
> `originator` header; the adapter defaults to the CLI's value so requests are
> accepted. Use your own account, and prefer `openai` for production.

## `model` is required

There is no default model. Provider lineups turn over faster than this package's
release cadence, so any built-in default would eventually name a retired model.

The one exception is `defineAgent()`: omitting `provider`, `model`, and `effort`
on a *definition* selects Codex `gpt-5.6-luna` at `medium` effort, an explicitly
reviewed and approved decision rather than an implicit fallback.

## Multiple accounts of the same provider

Provider instances carry explicit IDs and routes, so two accounts in the same
family compose without ambiguity. Discovery reports one row per route with
separate route, plugin-instance, and provider-family identity.

## Retry

Retry is a decorator, and it only retries failures that occur **before the first
chunk reaches the consumer** — replaying delivered tokens would duplicate output.

```ts
import { withRetry } from '@alvin0/ai-agent-sdk-core'

registry.registerAdapter(['openai'], withRetry(openAiAdapter({ apiKey }), {
  policy: { mode: 'normal', maxRetries: 3 },
  onRetry: attempt => console.warn(`retry ${attempt.attempt}: ${attempt.failure.code}`),
}))
```

Adapters assign a stable `code` at the wire boundary; **policy** decides which
codes are eligible — never the adapter that assigned them. `AUTH`,
`INVALID_REQUEST`, `QUOTA`, and `CONTEXT_WINDOW_EXCEEDED` are excluded by default
because they fail identically on every attempt.

`mode: 'always'` is accepted only when the request carries an `AbortSignal`.
Normal agent turns provide one through their model deadline; direct callers must
supply their own cancellation boundary.

## Read next

- [OpenAI](/en/09-providers/openai) · [Anthropic](/en/09-providers/anthropic) · [Codex](/en/09-providers/codex) · [Gemini](/en/09-providers/gemini) · [Copilot](/en/09-providers/copilot)
- [Custom Provider](/en/09-providers/custom-provider) — any other endpoint
- [Adapter pipeline](/en/11-internals/adapter-pipeline) — what the base class owns
