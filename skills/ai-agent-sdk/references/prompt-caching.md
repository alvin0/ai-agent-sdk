# Prompt caching for long sessions

Prompt caching is a provider optimization, not an SDK-side response cache. The
same system instructions, tool schemas, and older history still travel on later
turns; the upstream provider may reuse work for the unchanged prefix.

| Provider wire | Configuration | What reaches the wire | Default |
| --- | --- | --- | --- |
| OpenAI Responses / Chat Completions | `promptCaching` or `promptCacheKey` | `prompt_cache_key` | off |
| Anthropic Messages | `promptCaching`, optional `promptCachingTtl` | `cache_control` breakpoints | off |
| Gemini Interactions | none | implicit matching-prefix cache | provider-managed |

## OpenAI: keep one key per cache identity

```ts
openAiPlugin({ apiKey, promptCaching: true })
```

`promptCaching: true` generates one stable key when the adapter is constructed.
It is reused by both OpenAI wires, including a mixed route using `models[].api`.
This fits a provider/runtime instance scoped to one conversation or cache group.

When one provider instance serves multiple sessions, name the identity yourself:

```ts
openAiPlugin({
  apiKey,
  promptCacheKey: `tenant:${tenantId}:conversation:${conversationId}`,
})
```

Do not put credentials or direct personal identifiers in the key. A cache key
helps upstream routing; it never makes different prompt prefixes equivalent.
An explicit top-level `promptCacheKey` wins over the older
`compat.promptCacheKey`, and both win over auto-generation.

## Anthropic: cache stable boundaries

```ts
anthropicPlugin({
  apiKey,
  promptCaching: true,
  promptCachingTtl: '1h', // '5m' or omit for the API default
})
```

The Messages serializer adds at most three wire-only breakpoints:

1. the system prompt;
2. the final tool definition, covering the complete ordered tool list;
3. the final content block of the second-to-last wire message, covering history
   before the newest turn.

The newest message remains outside the history breakpoint because it normally
changes every turn. The serializer does not mutate caller-owned messages or
tool definitions. `promptCachingTtl` affects every emitted breakpoint.

## Gemini: preserve the prefix, configure no key

Gemini Interactions performs implicit prefix caching for supported models. It
has no OpenAI-style cache-key field, and Interactions does not accept the
`cached_content` resource used by the separate `generateContent` API. The SDK
therefore sends no invented caching field.

Keep the system prompt, tool ordering, schemas, and older messages stable. The
provider's `usage.total_cached_tokens` becomes normalized `cacheReadTokens`.
`store` is independent: it controls whether Google may retain an Interaction,
not whether implicit cache matching is enabled.

## Compatible-gateway downgrade

An OpenAI- or Anthropic-compatible gateway may reject its upstream vendor's
optional cache field. The adapter falls back only for a narrow signal: HTTP 400
whose provider message names `prompt_cache_key` or `cache_control`.

For that signal the adapter retries the rejected dispatch once without the
field, permanently disables the field on that adapter instance, and sends later
calls without it. Concurrent rejected calls each receive their own transparent
fallback, while prepared calls re-check the disabled state at iteration time.
The rejected attempt cannot have emitted chunks because HTTP failure occurs
before stream delivery, so this retry cannot duplicate visible output.

Authentication failures, model errors, and 400s naming another field are not
swallowed by this mechanism. Normal retry policy remains a separate layer.

## Usage and verification

Normalized generation usage exposes `cacheReadTokens` and `cacheWriteTokens`
when the provider reports them. Missing counters mean only that the response did
not report cache activity; they do not prove the feature is unavailable.

To make repeated turns cache-friendly:

- append new messages instead of rewriting old ones;
- keep system instructions and tool/schema order deterministic;
- scope explicit keys by tenant/account before conversation;
- measure actual cache-read counters, latency, and billed input rather than
  treating configuration as evidence of a cache hit.
