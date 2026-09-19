# Prompt caching

Prompt caching reuses the unchanged prefix of a request. It is most useful for a
long session that repeatedly sends the same system instructions, tool schemas,
and older conversation history before a short new turn.

The SDK preserves one public goal across providers—make stable prefixes
reusable—but keeps each provider's real wire semantics:

| Provider | SDK option | Wire behavior | Default |
| --- | --- | --- | --- |
| OpenAI Responses / Chat Completions | `promptCaching` or `promptCacheKey` | sends `prompt_cache_key` | off |
| Anthropic Messages | `promptCaching`, optional `promptCachingTtl` | adds `cache_control` breakpoints | off |
| Gemini Interactions | none | provider performs implicit prefix caching | automatic on supported models |

## OpenAI: stable session key

```ts
openAiPlugin({
  apiKey,
  promptCaching: true,
})
```

`promptCaching: true` generates one key when the adapter is constructed and
reuses it for every call through that instance. This is convenient when the
runtime/provider instance has session scope. If an instance serves many
sessions, supply the identity explicitly or construct one provider instance per
cache group:

```ts
openAiPlugin({
  id: `openai:${tenantId}:${conversationId}`,
  apiKey,
  promptCacheKey: `tenant:${tenantId}:conversation:${conversationId}`,
})
```

Do not put raw email addresses, access tokens, or other secrets in a cache key.
Treat it as a stable routing/accounting identifier, not as authorization.

The key applies to both supported OpenAI wires and is shared by models on a
mixed Responses/Chat-Completions route. It helps route similar prefixes; it does
not make different prompt content equivalent. Cache matching still depends on
the actual stable prefix.

## Anthropic: explicit prefix breakpoints

```ts
anthropicPlugin({
  apiKey,
  promptCaching: true,
  promptCachingTtl: '1h', // or '5m'; omit for the API default
})
```

The serializer places `cache_control: { type: 'ephemeral' }` on up to three
stable boundaries:

1. the system prompt;
2. the final tool definition;
3. the second-to-last wire message.

Each breakpoint means "cache the prefix through this block." The newest message
is deliberately left outside the history breakpoint because it is the part that
normally changes between turns. The SDK does not mutate the caller's message or
tool objects while adding these wire-only markers.

`promptCachingTtl` controls the breakpoint lifetime. It is a provider feature,
not a local SDK cache, and may affect pricing or data retention.

## Gemini: no cache key to configure

Gemini Interactions supports implicit caching for matching prefixes. The SDK
sends no synthetic `prompt_cache_key`: that field belongs to OpenAI. It also
does not send `cached_content`, because explicit cached-content resources are a
`generateContent` feature and are not accepted by Interactions.

This provider currently uses stateless Interactions requests, so it resends the
conversation history. Keep the beginning stable to improve implicit cache hits.
`store` is separate: it controls whether Google may retain an Interaction, not
whether implicit prompt caching runs.

## Compatible gateways and fallback

OpenAI-compatible and Anthropic-compatible gateways do not all support their
upstream provider's cache field. When caching is enabled, the adapter reacts
only to a narrow signal: HTTP 400 plus an error message naming
`prompt_cache_key` or `cache_control` respectively.

For that signal, the adapter:

1. disables the optional field for that adapter instance;
2. retries the rejected call once without it;
3. sends later calls without the field, including calls prepared earlier.

Concurrent rejected calls each receive their own transparent fallback. A 400
for another field, an authentication failure, or a model error still surfaces
normally.

## Preserve cacheable prefixes

- Keep the system prompt and tool schemas stable during a session.
- Append the new turn; avoid rewriting older messages into a different shape.
- Keep deterministic ordering for tools and structured schemas.
- Scope provider instances and explicit keys by tenant/account before session.
- Measure real cache reads rather than assuming that enabling a hint guarantees
  a hit.

Provider usage is normalized as `cacheReadTokens` and `cacheWriteTokens` when
the upstream response exposes those counters. Gemini
`usage.total_cached_tokens`, for example, maps to `cacheReadTokens`. A missing or
zero counter is not proof that caching is unsupported; it only means the
response did not report a cache hit.

## Read next

- [OpenAI](/en/09-providers/openai)
- [Anthropic](/en/09-providers/anthropic)
- [Gemini](/en/09-providers/gemini)
- [Compatible gateways and database credentials](/en/09-providers/gateways-and-credentials)
