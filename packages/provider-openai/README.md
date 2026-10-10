# @alvin0/ai-agent-sdk-provider-openai

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

Compatible gateways can configure `baseUrl`, `models`, `fetch`, and `headers`
(a string record or synchronous function returning one per operation).
Generation uses Responses; embedding uses the OpenAI embeddings protocol.

Project examples and live generation/decision tests use `gpt-6-luna` as the
minimum OpenAI model. Select it or a newer model explicitly; do not fall back to
older models when a request fails. Embedding model selection is separate.
The embedding adapter/plugin also supports custom headers.
Header names are case-insensitive. A `headers` entry overrides what the SDK
would otherwise send for that name (`accept`, `content-type`, `user-agent`,
protocol headers) — only a connection-level name `fetch` itself forbids
(`host`, `content-length`, …) or a credential-shaped name (must go through
`apiKey`/`auth` instead, so it can be redacted in logs) stays rejected.
Supply credentials with `apiKey`. Static records are copied;
prepared embedding calls keep the same header snapshot across all batches.
Trusted local HTTP gateways require `allowInsecureHttp: true`.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai
```

Universal OpenAI adapter and transactional provider plugin. Credentials are injected; this package never reads environment variables or files.

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const registry = new ModelRegistry()
registry.install(openAiPlugin({ apiKey: () => secretStore.get('openai') }))
```

Use `openAiAdapter()` for manual route registration. Both APIs are Universal and
require an explicit `apiKey`; environment lookup belongs to a Node wrapper.

Both accept `models: [{ id, contextWindow, maxTokens }]` plus provider-level
`defaultContextWindow` and `defaultMaxTokens` fallbacks. A catalog model's
`maxTokens` is its SDK output ceiling and, unless `models[].defaultMaxTokens`
is set, its default output budget. Provider fallback budgets are not hard ceilings.
Keep the operating context below any extended-context price threshold. See the
[provider model limits guide](../../web-documents/en/09-providers/index.md) for an example
and precedence rules. These declarations do not increase server-side limits.

Composition: `runtime.providers`. Lifecycle: `inert-runtime-owned-registration`;
the runtime activates and removes the captured provider registration.

## Connecting a compatible endpoint

This package speaks the whole OpenAI API family, not just `api.openai.com`. Two
wires are supported — `api: 'responses'` (default) and `api: 'chat-completions'`
— because most third-party OpenAI-compatible endpoints (DeepSeek, Groq, Together,
Qwen/DashScope, vLLM, Ollama, LM Studio, many gateways) only implement
`/chat/completions`. Give each vendor its own plugin instance with `id`,
`baseUrl`, `displayName` (so an error names the real vendor, not "OpenAI"), and
`api`:

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'

openAiPlugin({
  id: 'deepseek',
  displayName: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  api: 'chat-completions',
  apiKey: envCredential('DEEPSEEK_API_KEY'),
  compat: { reasoningFormat: 'deepseek' }, // effort → thinking + reasoning_effort
})
```

`compat` exposes the Chat Completions wire knobs one endpoint at a time:
`reasoningFormat` (`'openai'` default — `reasoning_effort` verbatim — or
`'deepseek'`, or `false` to send no effort field at all), `maxTokensField`
(`'max_tokens'` default, or `'max_completion_tokens'`, or `false`),
`systemRole`, `structuredOutputs`, `tools`, `parallelToolCalls`, `streamUsage`,
`stop`, `seed`, `promptCacheKey`. Unset knobs keep the protocol's own
conservative defaults.

## Prompt caching

Set `promptCaching: true` to generate one stable `prompt_cache_key` per adapter
instance, or pass `promptCacheKey` when the application already owns a stable
session key. The same key is used by Responses and Chat Completions, including a
mixed per-model route. Keep one adapter/plugin instance scoped to one cache
identity; do not share an auto-generated key across unrelated tenants.

Compatible gateways are handled opportunistically: if a gateway returns a 400
that specifically names `prompt_cache_key`, the adapter retries that call once
without the field and remembers the downgrade for the rest of its lifetime.
Unrelated request errors are never swallowed.

An endpoint mounted somewhere other than its protocol's own path (an Azure
OpenAI deployment, a gateway that rewrites the route) can override `path` and
add `query` (never for secrets — those belong in `auth`/`apiKey`):

```ts
openAiPlugin({
  id: 'azure-gpt',
  baseUrl: 'https://my-res.openai.azure.com/openai/deployments/gpt-6-luna',
  path: '/chat/completions',
  api: 'chat-completions',
  query: { 'api-version': '2026-06-01' },
  apiKey: envCredential('AZURE_KEY'),
})
```

## Default configuration precedence

`contextWindow`, `maxTokens`, and `inputModalities` resolve top-to-bottom, first
match wins: per-call `maxTokens` → **model** (`models[].contextWindow`,
`models[].maxTokens`, `models[].inputModalities`) → **route**
(`defaultContextWindow`/`defaultMaxTokens` on this plugin) → **runtime**
(`createAgentRuntime({ defaults })`) → **SDK constant** (`200_000` context,
`['text','image','document']` modalities; no default `maxTokens` — unset means
the field is not sent at all, except Anthropic which requires one). An
agent-level override (`runtime.agent({ contextWindow, inputModalities })`) is
not implemented yet; only effort and per-call `maxTokens` are agent/call-scoped
today. This package's adapter never guesses a vendor's real context window for
an uncatalogued model id; declare it via `models: [{ id, contextWindow }]` when
the SDK default doesn't match reality.

## Native Decisions API

Install the companion runtime as a direct dependency:

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-decision-adapter @alvin0/ai-agent-sdk-provider-openai
```

Use the `/decisions` entry point with the companion decision runtime:

```ts
import { createDecisionRuntime, choiceQuestion, scoreQuestion, booleanQuestion }
  from '@alvin0/ai-agent-sdk-decision-adapter'
import { openAiDecisionPlugin } from '@alvin0/ai-agent-sdk-provider-openai/decisions'

const runtime = createDecisionRuntime({ providers: [openAiDecisionPlugin({
  apiKey: process.env.OPENAI_API_KEY!,
  // baseUrl: 'https://api.openai.com/v1', // API root, including /v1
})] })
try {
  const result = await runtime.decisionModel({ provider: 'openai', model: 'gpt-6-luna' }).evaluate({
    state: { message: 'Please refund my order today.' },
    questions: {
      route: choiceQuestion('Choose the department.', { billing: 'Payments and refunds', support: 'Technical issues' }),
      urgency: scoreQuestion('How urgent is this?', ['Routine', 'Urgent']),
      refund: booleanQuestion('Does the customer request a refund?'),
    },
  })
  console.log(result.answers, result.usage)
} finally {
  await runtime.close()
}
```

`openAiDecisionAdapter` also works directly with `DecisionRequest`. API keys may
be strings or SDK credential sources. Custom routes, API roots, headers, retry
policies, `safetyIdentifier`, deadlines and request/response byte limits are
configurable. The adapter performs one HTTP attempt; the decision runtime owns
retries. It never falls back to Responses after a Decisions error.

String state and instructions remain text; structured JSON descriptions are
serialized as text. This entry point currently accepts the SDK's text/JSON
`DecisionInput`, rather than native image messages. Choice options use their SDK
record keys as wire values. Score labels are zero-based indexes, with the SDK
level description preserved as the wire description. SDK boolean questions map
to native predicates; `value` uses a probability threshold of 0.5 and
`probabilityTrue` retains the provider probability. Use decision evidence gates
when your application needs stronger confidence.

Answers retain provider probability provenance. Usage maps cached and uncached
input into disjoint SDK buckets, and zero output tokens remain authoritative.
A native refusal throws a non-retryable `ModelError` with code
`OPENAI_DECISION_REFUSED`; it produces no fabricated answer. Attempt accounting
retains reported usage even when a refusal or invalid answer prevents a result.

The current native model catalog contains `gpt-6-luna`. Explicit model IDs remain
configurable for consumers and compatible gateways; the server determines
availability. Native Decisions requires an OpenAI API key. Codex uses
`CODEX_GUARDIAN_DECISIONS_API_KEY` (or `OPENAI_API_KEY`) for this call independently
of its ChatGPT OAuth Responses credentials; OAuth login alone does not configure
Decisions access. See the [Decisions guide](https://developers.openai.com/api/docs/guides/decisions)
and [Codex startup source](https://github.com/openai/codex/blob/main/codex-rs/ext/guardian-v2/src/async_scorer/startup.rs).
