# @alvin0/ai-agent-sdk-provider-anthropic

Runtime: **Universal** (Edge/Worker, browser, Deno, Bun, and Node).

Compatible gateways can configure `baseUrl`, `models`, `fetch`, and `headers`
(a string record or synchronous function returning one per operation).
Generation uses the Messages protocol.
Header names are case-insensitive. A `headers` entry overrides what the SDK
would otherwise send for that name (`accept`, `content-type`, `user-agent`,
`anthropic-version`/`anthropic-beta`) — only a connection-level name `fetch`
itself forbids (`host`, `content-length`, …) or a credential-shaped name (must
go through `apiKey`/`authHeader` instead, so it can be redacted in logs) stays
rejected. Supply credentials with `apiKey`; use `version` and `beta` for
Anthropic protocol headers, or `authHeader: 'bearer'` when a gateway in front
of Anthropic expects `Authorization: Bearer` instead of this API's own
`x-api-key`. Static records are copied.
Trusted local HTTP gateways require `allowInsecureHttp: true`.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-anthropic
```

Universal Anthropic adapter and transactional provider plugin. Credentials are injected; this package never reads environment variables or files.

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { anthropicPlugin } from '@alvin0/ai-agent-sdk-provider-anthropic'

const registry = new ModelRegistry()
registry.install(anthropicPlugin({ apiKey: () => secretStore.get('anthropic') }))
```

Use `anthropicAdapter()` for manual route registration. Both APIs are Universal
and require an explicit `apiKey`; environment lookup belongs to a Node wrapper.

Composition: `runtime.providers`. Lifecycle: `inert-runtime-owned-registration`;
the runtime activates and removes the captured provider registration.

## Connecting a compatible endpoint

This package speaks the Anthropic Messages wire, so any endpoint that speaks it
back is reachable by configuration alone — Anthropic itself, DeepSeek's
`/anthropic` compatibility surface, Kimi, MiniMax, GLM, or a local gateway:

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'

anthropicPlugin({
  id: 'kimi',
  displayName: 'Kimi',
  baseUrl: 'https://api.moonshot.ai/anthropic',
  apiKey: envCredential('KIMI_API_KEY'),
  authHeader: 'bearer', // this endpoint expects Authorization: Bearer, not x-api-key
})
```

Effort reaches `output_config.effort` verbatim by default (current GA models).
For an older model or a gateway that only understands a thinking-token budget,
set `reasoningFormat: 'thinking-budget'` plus `thinkingBudgets` to map each
effort id to a token count instead. `path`/`query` override the request path
and add query-string parameters, the same way as the other two providers in
this SDK.

## Prompt caching

Set `promptCaching: true` to place Anthropic `cache_control` breakpoints on the
stable request prefix: the system prompt, the final tool definition, and the
conversation through the second-to-last message. `promptCachingTtl` accepts
`'5m'` or `'1h'`; leaving it unset uses the API default.

Caching is opt-in because compatible Messages gateways do not all implement
this extension. If a gateway returns a 400 that specifically names
`cache_control`, the adapter retries once without breakpoints and remembers the
downgrade. Unrelated request errors still surface normally.

## Default configuration precedence

`contextWindow` and `maxTokens` resolve top-to-bottom, first match wins:
per-call `maxTokens` → **model** (`models[].contextWindow`,
`models[].maxTokens`) → **route** (`defaultContextWindow`/`defaultMaxTokens` on
this plugin) → **runtime** (`createAgentRuntime({ defaults })`) → **SDK
constant** (`200_000` context; `max_tokens` is REQUIRED by this API, so an
unset value falls back to the protocol's own constant rather than being
omitted — the one exception to "unset means not sent" in this SDK). This
package's adapter never guesses a vendor's real context window for an
uncatalogued model id; declare it via `models: [{ id, contextWindow }]` when
the SDK default doesn't match reality.
