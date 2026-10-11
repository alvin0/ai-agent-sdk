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
    model: 'gpt-6-luna',
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
  model: { provider: 'openai', id: 'gpt-6-luna' },
  tools: [readProjectFile],                                     // host functions
  nativeTools: [{ type: 'native', name: 'web-search' }],        // provider-executed
})
```

Host tools execute through the SDK scheduler. Native tools execute at the
provider and still produce correlated events for a GUI.

```text
   your host                                 the provider side
   ─────────────────────────────             ─────────────────────────
   tools: [readProjectFile]                  nativeTools: [web-search]
        │                                          │
        │  the model calls it                      │  the model calls it
        ▼                                          ▼
   SDK scheduler                             the provider runs it
   parse → execute → render                  (the SDK never sees the body)
        │                                          │
        └────► tool-call / tool-result             └────► assistant-native-tool
                (you control it)                           (progress + result only)
```

## Provider support is validated before dispatch

Adapters declare combined context capacity, default and hard output limits,
reasoning efforts, modalities, and supported native tools. `ModelRegistry`
snapshots those capabilities and rejects an impossible selection **before**
provider I/O:

| Selection | Rejected with |
| --- | --- |
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
| Document (PDF) input by URL / base64 / `fileId` | ✓ | ✓ |
| Document citations (`citations: true`) | ✗ — ignored | ✓ |

Anthropic reports unsupported selections as typed errors rather than silently
dropping them.

Gemini Interactions accepts document input by base64 and by URI (a remote URL or
a Files API uri) on the same terms.

## Web search content types (0.1.12)

```ts
nativeTools: [{
  type: 'native', name: 'web-search', searchContentTypes: ['text', 'image'],
}]
```

Omission requests text search. Responses maps this to `search_content_types`;
Codex accepts it. Anthropic Messages and Gemini Interactions reject image search
with `INVALID_REQUEST` rather than silently returning only text.

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

## Document (PDF) input

A PDF is a `DocumentBlock`, not an image. Providers read it with native vision:
each page is rasterized alongside its extracted text, so charts and tables
survive. The provider owns the page splitting.

```ts
const message = createUserMessage({
  content: [
    { type: 'document',
      source: { kind: 'base64', mediaType: 'application/pdf', data: base64Pdf },
      filename: 'inquiry.pdf',
      pages: 72 },
    { type: 'text', text: 'Summarize the open items.' },
  ],
  source: { kind: 'user' },
})
```

### Unknown and explicit modalities

Omitted `inputModalities` means unknown and permits the PDF. Projection happens
only when a resolved model, route or agent declaration explicitly omits
`document`. Override an incomplete discovery declaration when needed:

```ts
codexNodeAdapter({
  authStore,
  models: [{ id: 'gpt-6-luna', inputModalities: ['text', 'image', 'document'] }],
})
```

Gemini needs no declaration merely to permit PDF input. Use
`documentPolicy: 'strict'` to reject an explicit incompatibility with
`UNSUPPORTED_DOCUMENT_INPUT` instead of projecting the document into text.

### `pages` and token cost

Providers bill a PDF per page, so `pages` is what lets compaction cost it
correctly. Measured on a real 72-page PDF: OpenAI billed 214,019 input tokens
(~2,970/page) and Gemini 38,350 (~533/page). With `pages` set the estimate landed
within 1%; without it the estimator assumes 8 pages and under-states a long
document badly. It is local metadata — no adapter serializes it.

## Generated images

Generated images arrive twice, on purpose:

1. **Progressively** through `image-delta` events, for a live preview.
2. **Authoritatively** in the final `native-tool-call.content`.

```ts
// Low-level AgentEvent stream; registry/history/config are supplied by the host.
for await (const event of runAgent({
  mode: 'basic', registry, history,
  config: { provider: 'openai', model: 'gpt-6-luna' },
  nativeTools: [{ type: 'native', name: 'image-generation', partialImages: 2 }],
})) {
  if (event.type === 'image-delta') renderPreview(event.data, event.mediaType, event.partialIndex)
  if (event.type === 'assistant-message') storeFinalImages(event.message.content)
}
```

A basic image-only reply is a valid answer, including in a budget-forced final
round. Deep-mode completion still requires text. Persist final image bytes from
the low-level `assistant-message` event: if inline images exceed history limits,
the stored assistant entry omits them and records `omittedImages`. Direct images
become commentary placeholders. Other oversized entries still fail.
Responses replays generated images from `content`, with old `providerState.result`
as a compatibility fallback; new state does not duplicate the base64 result.

Image-generation requests default to a 12 MiB **character** SSE event limit.
An explicit connection `maxSseEventChars` overrides it; `maxResponseBytes` still
bounds the whole response. These transport limits do not remove history limits.

## Typed configuration carries through

Native web search and image generation configuration is **typed and
merge-extensible**, and it carries from an Edge agent definition all the way into
provider transport. Distinct progress events are emitted for each — you do not
have to correlate a generic "tool started" event by name.

## Read next

- [`Types` API reference](/en/13-api-reference/types) — `ImageBlock`, `DocumentBlock`, `StreamChunk`
- [Providers](/en/09-providers/) — what each provider supports
