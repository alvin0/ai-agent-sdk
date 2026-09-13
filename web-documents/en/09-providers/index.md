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

The table above is the **generation** lineup. Embedding is a separate capability
with its own plugin kind: `openAiEmbeddingPlugin()` and
`geminiEmbeddingPlugin()` install beside a generation plugin on the same runtime.
See [Embeddings](/en/09-providers/embeddings).

## Two registration styles

New in 0.1.2: [Compatible gateways and database credentials](/en/09-providers/gateways-and-credentials).

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

The SDK defaults to a standard-price operating context for verified model IDs on
official endpoints. This is a working budget, not the model's technical maximum.
Current built-in policies (reviewed 2026-09-13):

| Route/model | Default operating context | Known combined technical ceiling |
| --- | ---: | ---: |
| OpenAI GPT-5.6 Luna, Sol, Terra | 272,000 | 1,050,000 |
| Anthropic Opus 4.6/4.7/4.8/5, Sonnet 4.6/5, Fable 5/5.1, Mythos 5/5.1/Preview | 1,000,000 | 1,000,000 |
| Gemini 2.5 Pro, 3.1 Pro Preview (including customtools) | 200,000 | Unknown: separate input/output limits |
| Gemini 2.5 Flash, 3 Flash Preview | 1,000,000 | Unknown: separate input/output limits |
| Unknown OpenAI / Anthropic / Gemini model | 128,000 / 200,000 / 200,000 | Unknown |

Sources: [OpenAI Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[Claude context](https://platform.claude.com/docs/en/build-with-claude/context-windows),
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
These exact-ID policies do not advertise model availability or capabilities.
Unknown aliases and custom base URLs do not inherit official endpoint policies.

Precedence: explicit `models[].contextWindow`, then explicit provider
`defaultContextWindow`, then the model's `defaultContextWindow`, then the provider
fallback. `models[].defaultContextWindow`, `maxContextWindow`, and
`standardPriceInputTokens` can describe a custom model policy. An override cannot
raise a known official technical ceiling. Invalid numbers and windows above a
known ceiling fail rather than being silently clamped.

To deliberately opt into a larger context:

```ts
openAiPlugin({
  apiKey,
  models: [{ id: 'gpt-5.6-luna', contextWindow: 800_000 }],
})
```

Resolved `ModelContext` exposes the effective `contextWindow`, known
`defaultContextWindow`, `maxContextWindow`, and `standardPriceInputTokens`.
When the operating window exceeds a known price threshold it also exposes
`pricingWarning: 'extended-context-may-cost-more'`. This is an advisory metadata
warning for hosts to display, not a console log or an assertion that this request
will incur a surcharge. Unknown thresholds remain unknown. Compaction uses the
effective operating window and the output reserve, with its existing safety ratio;
this is not an exact-token billing guard and cannot guarantee the invoice.

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
| `models[].contextWindow` | Explicit combined input/output operating budget for that exact model ID. |
| `models[].defaultContextWindow` | Model operating default before an explicit override. |
| `models[].maxContextWindow` | Known technical ceiling, independent of the operating budget. |
| `models[].standardPriceInputTokens` | Known input-token price threshold; not a combined context limit. |
| `models[].maxTokens` | SDK output ceiling; also the default unless `models[].defaultMaxTokens` is set. |
| `models[].defaultMaxTokens` | Default output budget for that exact model, independently of its ceiling. |
| `defaultContextWindow` | Explicit provider operating override; built-in policies apply when omitted. |
| `defaultMaxTokens` | Fallback output budget, not evidence of a model's hard output ceiling. |
| Agent `maxTokens` | Output budget for the agent; may be lower than the model ceiling. |

Fallback is per field, not just for models missing from the catalog. If provider
defaults are also omitted, the adapter's built-in defaults apply. These are
declared SDK assumptions, not an automatic guarantee of current provider limits.

The output budget is the explicit agent/call `maxTokens`, otherwise the model's
resolved default. Exceeding the declared ceiling rejects with
`OUTPUT_TOKEN_LIMIT_EXCEEDED`; the SDK does not silently clamp the request.
The output reservation must also be smaller than the combined context window.

Use `models[].defaultMaxTokens` to keep a modest default while declaring a larger
`maxTokens` ceiling. Without a declared ceiling, the SDK leaves it unknown;
explicit larger requests remain subject to the context reservation check and
server-side validation. Existing catalog entries with only `maxTokens` retain
their previous default and ceiling.

### Standard-price context versus extended context

Do not automatically replace the operating context window with a model's largest
advertised window. Extended context can have a higher price. Research checked
on 2026-09-13: [OpenAI's GPT-5.6 Luna API model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
lists 1,050,000 context tokens and 128,000 maximum output tokens, but input above
272,000 tokens costs 2x input and 1.5x output for the full request.
For a standard-price configuration on this API route, use:

```ts
models: [{
  id: 'gpt-5.6-luna',
  contextWindow: 272_000, // Operating budget, not the extended model maximum.
  maxTokens: 128_000,
  defaultMaxTokens: 32_000,
}]
```

This example deliberately does not opt into extended context. The Codex endpoint
is distinct: a live catalog check reported `context_window: 272000` and
`max_context_window: 872000` for both Luna and `gpt-reserve`. Codex discovery uses
the former, not the extended maximum; its unchanged fallback is 272,000. That
catalog did not advertise an output ceiling, so do not copy the OpenAI API's
128,000 ceiling to Codex. The Codex dialect does not send `max_output_tokens`.
Copilot limits likewise come from its own catalog, not the upstream model page.

The SDK's token estimates and compaction are not a billing guarantee. Keep a
margin below the price threshold and do not disable compaction for a growing
history when standard-price operation is required.

When auto-compaction is enabled, the default pressure threshold is
`min(contextWindow * 0.8, contextWindow - outputReserve)`. The reserve uses
explicit `maxTokens`, then model default, then model maximum if available.
An explicit compaction `maxInputTokens` replaces the ratio threshold but is
still bounded by the available input window. Token counts are estimates, not
an exact per-model tokenizer; overflow can still occur. Declaring these values
does not increase server limits or make an unsupported wire parameter supported.

## Model discovery

### Streaming usage snapshots

Anthropic emits `usage-progress` from `message_start` and `message_delta` usage.
These are cumulative snapshots for one attempt, not increments: replace the
previous snapshot; do not add them together. Provider-attempt accounting supplies
an `attemptId` when available, including across retries. The event is also exposed
by agent sessions. Only the final `usage` event is a finalized token report.

If the stream is aborted or truncated before `message_stop`, the last received
snapshot remains in the attempt report with `coverage: 'partial'`, even if it
contains input, output, and total counters. It cannot satisfy mandatory complete
usage policies. A pre-content retry can still occur after usage progress; retries
have distinct attempt IDs and are accounted separately.

OpenAI Responses and Gemini Interactions continue to publish usage from terminal
provider events. No provisional counts are fabricated for providers that do not
send them. Usage progress does not become final message usage or increase final
totals more than once.

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
- [Embeddings](/en/09-providers/embeddings) — the separate embedding capability
- [Custom Provider](/en/09-providers/custom-provider) — any other endpoint
- [Adapter pipeline](/en/11-internals/adapter-pipeline) — what the base class owns
