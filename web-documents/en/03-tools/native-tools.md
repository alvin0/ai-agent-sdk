# Native Tools

Provider-executed tools are passed **separately** from host functions, so the
scheduler never tries to execute them.

## Declaring native tools

```ts
import { ReasoningEffortId, runAgent } from '@alvin0/ai-agent-sdk-core'

for await (const event of runAgent({
  mode: 'basic',
  registry,
  history,
  config: {
    provider: 'openai',
    model: 'gpt-5.6',
    reasoningEffort: ReasoningEffortId('medium'),
  },
  nativeTools: [
    { type: 'native', name: 'web-search', allowedDomains: ['openai.com'] },
    { type: 'native', name: 'image-generation', format: 'webp', partialImages: 2 },
  ],
})) {
  if (event.type === 'image-delta') renderPreview(event.data, event.mediaType)
  if (event.type === 'assistant-native-tool') renderTraceNode(event.call.id, event.call.name)
}
```

On a definition or runtime agent it is the same field:

```ts
runtime.agent({
  id: 'researcher',
  instructions: 'Gather evidence before answering.',
  model: { provider: 'openai', id: 'gpt-5.6' },
  tools: [readProjectFile],                                     // host functions
  nativeTools: [{ type: 'native', name: 'web-search' }],        // provider-executed
})
```

Host tools execute through the SDK scheduler. Native tools execute at the
provider and still produce correlated events for a GUI.

## Provider support is validated before dispatch

Adapters declare combined context capacity, default and hard output limits,
reasoning efforts, modalities, and supported native tools. `ModelRegistry`
snapshots those capabilities and rejects an impossible selection **before**
provider I/O:

| Selection | Rejected with |
| --- | --- |
| Unsupported reasoning effort | `UNSUPPORTED_REASONING_EFFORT` |
| Unsupported native tool | `UNSUPPORTED_NATIVE_TOOL` |
| `maxTokens` above the hard ceiling | `OUTPUT_TOKEN_LIMIT_EXCEEDED` |

## What each provider supports

| Capability | Responses (`openai`, `codex`) | Anthropic Messages |
| --- | --- | --- |
| Native web search | ✓ | ✓ (encrypted result/citation replay state preserved) |
| Native image generation | ✓ | ✗ — typed `INVALID_REQUEST` |
| Image input by URL / base64 | ✓ | ✓ |
| Image input by `fileId` | ✓ | ✗ — typed `INVALID_REQUEST` |
| `detail: 'original'` | ✓ | ✗ |

Anthropic reports unsupported selections as typed errors rather than silently
dropping them.

## Image input

Image input uses the same `ImageBlock` in user messages:

```ts
const message = createUserMessage({
  content: [
    { type: 'text', text: 'What is wrong with this chart?' },
    { type: 'image', source: { kind: 'url', url: 'https://example.com/chart.png' } },
  ],
  source: { kind: 'user' },
})
```

URL and base64 sources are portable across providers. The registry projects image
input away only for models that **explicitly** declare no vision modality — it
does not guess.

## Generated images

Generated images arrive twice, on purpose:

1. **Progressively** through `image-delta` events, for a live preview.
2. **Authoritatively** in the final `native-tool-call.content`.

```ts
for await (const event of agent.stream('Draw a system diagram.')) {
  if (event.type === 'image-delta') {
    renderPreview(event.data, event.mediaType, event.partialIndex)
  }
}

const response = await handle.result
// response.report / the final assistant message carries the authoritative image.
```

Render previews from `image-delta`; persist from the final message. `partialIndex`
tells you which progressive frame you are on when `partialImages` is configured.

## Typed configuration carries through

Native web search and image generation configuration is **typed and
merge-extensible**, and it carries from an Edge agent definition all the way into
provider transport. Distinct progress events are emitted for each — you do not
have to correlate a generic "tool started" event by name.

## Read next

- [`Types` API reference](/en/13-api-reference/types) — `ImageBlock`, `StreamChunk`
- [Providers](/en/09-providers/) — what each provider supports
