# @alvin0/ai-agent-sdk-provider-gemini

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

Compatible gateways can configure `baseUrl`, `models`, `fetch`, and `headers`
(a string record or synchronous function returning one per operation).
Generation uses Interactions; embedding uses batchEmbedContents.
The embedding adapter/plugin also supports custom headers.
Header names are case-insensitive. A `headers` entry overrides what the SDK
would otherwise send for that name (`accept`, `content-type`, `user-agent`) —
only a connection-level name `fetch` itself forbids (`host`, `content-length`,
…) or a credential-shaped name (must go through `apiKey`/`authHeader` instead,
so it can be redacted in logs) stays rejected. Supply credentials with
`apiKey`, or `authHeader: 'bearer'` when a gateway in front of Gemini expects
`Authorization: Bearer` instead of this API's own `x-goog-api-key`. Static
records are copied; prepared embedding calls keep the same header snapshot
across all batches.
Trusted local HTTP gateways require `allowInsecureHttp: true`.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-gemini
```

Universal Gemini provider for ai-agent-sdk. It targets only Google's Gemini
Interactions endpoint at `/v1beta/interactions` and does not use
`generateContent` or the OpenAI-compatible Chat Completions endpoint.

Credentials are always injected. This package never reads `.env`, environment
variables, or files; a Node host may opt into `envCredential()` from
`@alvin0/ai-agent-sdk-auth-node`.

An uncatalogued model defaults to the SDK's own 200,000-token operating
context — this package no longer hardcodes per-vendor context windows (Pro vs.
Flash, etc.), so a model with a larger real window (Flash's 1,000,000, for
example) needs it declared explicitly. Set `models: [{ id, contextWindow }]`
to override per model, or `defaultContextWindow` at the route level; both take
precedence over the SDK default and over `createAgentRuntime({ defaults })`.

## Prompt caching

Gemini Interactions uses implicit prompt caching automatically for supported
models, in both stateless requests (the SDK resends history) and stateful
`previous_interaction_id` flows. There is no OpenAI-style cache-key field to
send, and Interactions does not accept the explicit `cached_content` resources
from the legacy `generateContent` API. Keep stable instructions, tools, and
history at the front of the request to improve prefix matches. Cache hits are
reported as `cacheReadTokens` from Gemini's `usage.total_cached_tokens`.

This provider currently uses the stateless Interactions shape. Its `store`
option controls provider-side interaction retention; it is not a prompt-cache
toggle.

## Connecting a compatible endpoint

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'

geminiPlugin({
  id: 'ai-studio',
  apiKey: envCredential('GEMINI_API_KEY'),
  // path / query override the request path and add query-string parameters,
  // the same way as the other two providers in this SDK.
})
```
