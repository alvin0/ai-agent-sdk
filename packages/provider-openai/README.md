# @alvin0/ai-agent-sdk-provider-openai

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

Compatible gateways can configure `baseUrl`, `models`, `fetch`, and `headers`
(a string record or synchronous function returning one per operation).
Generation uses Responses; embedding uses the OpenAI embeddings protocol.
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
  baseUrl: 'https://my-res.openai.azure.com/openai/deployments/gpt-5-6',
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
