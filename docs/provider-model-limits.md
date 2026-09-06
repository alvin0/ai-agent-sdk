# Provider model limits

Declare these limits when creating the provider plugin or adapter. The built-in
HTTP-based providers accept `models`, `defaultContextWindow`, and
`defaultMaxTokens`. Model IDs and numbers below are illustrative, not a catalog
of real model limits; replace them with values for your endpoint.

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

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

## Related documentation

- [Agent definitions](agent-definitions.md)
- [Memory and compaction](memory-and-compaction.md)

