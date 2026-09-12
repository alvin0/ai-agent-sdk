# Embeddings

Runtime: **Universal** — Edge/Worker, browser, Deno, Bun, and Node.
Composition slot: `runtime.providers`.
Lifecycle: `inert-runtime-owned-registration`.

Embedding is a **separate model capability**, not a projection of generation. It
sits beside generation under the same runtime, with its own contract, its own
plugin kind, and its own error taxonomy.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai
```

The contract lives at its own entry point:

```ts
import {
  EMBEDDING_ERROR_CODES,
  EmbeddingError,
  type EmbeddingModelHandle,
  type EmbeddingResult,
} from '@alvin0/ai-agent-sdk-core/embedding'
```

## What v1 covers, and what it does not

In scope:

- **Text input.** The accepted input kind is `'text'`, and that is readable from
  the type (`EmbeddingInputType`) rather than from prose.
- **One dense vector per item.** Representation is `'dense-float32'`; there is no
  multi-vector or sparse output.
- **Two entry points**, `embed()` and `embedMany()`.
- **Cancellation** through an `AbortSignal` you own.
- **Bounded batching** — items, estimated tokens, and payload bytes at once.
- **Honest usage.** Tokens a provider did not report stay missing.

Out of scope, deliberately. Adding embedding does not drag a retrieval platform
into your dependency closure:

- retrieval and vector stores
- semantic memory (`MemoryStore` and `AgentMemorySnapshot` are unchanged)
- a RAG pipeline
- parsers, chunkers, OCR, rerankers
- index migration tooling
- an in-process inference engine

An app that only generates configures nothing new and carries no embedding
surface.

## Compose an embedding provider

Embedding plugins have their own kind, `'embedding-provider-plugin'`, so they
install **beside** a generation plugin instead of standing in for one. Route
claims are namespaced by operation, which is why both plugins below may claim
`openai`:

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin, openAiEmbeddingPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [
    openAiPlugin({ apiKey }),
    openAiEmbeddingPlugin({
      apiKey,
      models: [{
        id: 'text-embedding-3-small',
        dimensions: [1536, 512],
        defaultDimensions: 1536,
        purposeHandling: 'unsupported',
        compatibilityIdentity: 'openai:text-embedding-3-small',
      }],
    }),
  ],
})
```

`openAiEmbeddingPlugin()` ships an **empty** catalog by default, for the same
reason the generation adapter ships no model list: a built-in list would
eventually name a retired model. A declared entry is what makes `dimensions`
reachable on the wire and what states the embedding space, so declare the models
a route cares about. `compatibilityIdentity` is the one required field — see
[Embedding spaces](#embedding-spaces).

Gemini ships a declared catalog and defaults its plugin id (and therefore its
route) to `'gemini-embedding'`:

```ts
import { geminiEmbeddingPlugin } from '@alvin0/ai-agent-sdk-provider-gemini'

const runtime = await createAgentRuntime({
  providers: [geminiEmbeddingPlugin({ apiKey })],
})
```

Two plugins of the **same** operation claiming one route fails construction
before anything is installed: `PROVIDER_ROUTE_CONFLICT` for generation,
`PROVIDER_OPERATION_CONFLICT` for embedding.

## `embeddingModel()`

No agent, no team, no session. A handle is all you need:

```ts
const embeddings = runtime.embeddingModel({
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
})
```

| Option | Meaning |
| --- | --- |
| `provider` | Route key that must own an embedding adapter |
| `model` | Model id passed to the provider |
| `dimensions` | Requested width; absent means the model default |
| `truncation` | SDK default is `'reject'`, even where the provider's default is to cut |
| `expectedSpace` | Expected `Space_Id`; an incompatible resolution rejects the call |
| `concurrency` | In-flight batches per logical call; defaults to `4` |
| `batchLimits` | Overrides for `maxItems` / `maxTokens` / `maxBytes` / `estimateTokens` |
| `cache` | Opt-in cache; off unless supplied |

A route with no embedding adapter rejects with `EMBEDDING_ADAPTER_MISSING`. A
width the route does not declare rejects with
`EMBEDDING_DIMENSIONS_UNSUPPORTED`, before the first request goes out.

## `embed()` — one input

```ts
const result = await embeddings.embed({
  value: 'How do I rotate an API key?',
  purpose: 'retrieval-query',
  signal: request.signal,
})

result.embedding   // readonly number[]
result.space       // Space_Id the vector belongs to
result.profile     // the full EmbeddingProfile behind that space
result.usage       // EmbeddingUsageReport
result.warnings    // non-fatal facts, e.g. 'usage-unreported'
```

`purpose` is **required**, with exactly two values: `'retrieval-query'` and
`'retrieval-document'`. Translating it to a wire mechanism belongs entirely to
the adapter. Gemini has `taskType`, so purpose becomes a wire parameter; the
OpenAI embeddings API has no mechanism, so the text is sent verbatim. No adapter
invents an undocumented prefix.

## `embedMany()` — a corpus

```ts
const { embeddings: vectors, space, usage } = await embeddings.embedMany({
  values: chunks,
  purpose: 'retrieval-document',
  signal: job.signal,
})
```

`vectors` follows **input order**, always. The runtime writes each vector at its
input index, so batch settlement order, retries, and a provider returning one
batch permuted are all invisible in the output.

Everything between the call and the vectors belongs to the runtime, not to the
adapter — batching, the in-flight bound, retry, the optional cache, usage
aggregation, order restoration. An adapter does three things only: issue one
physical request, translate the protocol, validate the response.

Batching applies three bounds at once, and a batch closes as soon as any one of
them would be exceeded:

| Bound | Fallback when the catalog declares none |
| --- | --- |
| `maxItems` | 96 |
| `maxTokens` (estimated, `ceil(utf8Bytes / 4)`) | 100 000 |
| `maxBytes` | 1 MiB |

Precedence is your override, then the route's declared capability, then the
fallback. The fallback is total, so a model id outside the catalog still batches
instead of being rejected. Peak payload memory stays `concurrency × maxBytes`
rather than scaling with the corpus.

Cancellation is honoured at every level: aborting your signal fails the call
with `EMBEDDING_ABORTED`, and batches already succeeded are never re-sent by a
later retry of the same call.

## Embedding spaces

Two vectors of the same width are **not** comparable for that reason alone. The
SDK manages an embedding space, not a model name.

Every result carries a `Space_Id` derived from the `EmbeddingProfile`:
compatibility identity, dimensions, representation, normalization,
post-processing, profile revision — joined into a canonical string, with each
component escaped so two different tuples cannot collide. It is an identifier for
comparison, not a digest.

Compatibility is decided by the **declared compatibility identity**, never by
comparing model names and never by comparing dimension counts. Same width plus a
different identity means incompatible.

Store the `Space_Id` next to your index, and pass it back:

```ts
const result = await embeddings.embed({
  value: query,
  purpose: 'retrieval-query',
  expectedSpace: index.space,
})
```

An incompatible space fails with `EMBEDDING_SPACE_INCOMPATIBLE` **before** the
first request — a rejection, not a warning.

## Usage stays honest

Embedding has no output tokens, so it does not reuse the generation usage shape:
that one only reports `complete` once `outputTokens` is present, which embedding
could satisfy only by inventing a `0`.

```ts
const { usage } = await embeddings.embedMany({ values, purpose: 'retrieval-document' })

usage.status              // 'complete' | 'partial' | 'missing'
usage.tokens              // present ONLY when status === 'complete'
usage.batches             // physical batches this logical call produced
usage.batchesWithUsage    // how many returned readable usage
usage.providerAttempts    // attempts including retries
usage.inputsFromCache     // reported separately …
usage.inputsFromProvider  // … from what was actually sent
```

`status` is `'complete'` only when every batch sent to the provider returned
readable usage. A malformed counter is dropped rather than repaired, and a
`usage-unreported` or `usage-malformed` warning says so.

## Optional cache

Off unless you configure it. `scope` is required and has no default: there is no
safe default answer to "may two tenants share a cache entry".

```ts
const embeddings = runtime.embeddingModel({
  provider: 'openai',
  model: 'text-embedding-3-small',
  cache: { scope: `tenant:${tenantId}`, store: myStore },
})
```

The key covers five things: security scope, model/profile revision, purpose and
its recipe revision, dimensions with post-processing, and a hash of the effective
input. A cached entry whose `Space_Id` differs from the current call's is
discarded rather than trusted, and the vector is re-requested. Cache enabled
without a scope is `EMBEDDING_CONFIGURATION_INVALID`.

## Errors

Embedding failures use `EMBEDDING_ERROR_CODES` and the `EmbeddingError` class;
transport faults keep the model taxonomy, so rate limiting stays distinguishable
from a wrong-width vector. `EmbeddingError` carries `itemIndexes`, `limit`,
`provider`, `model`, and `space` — never raw input text or vector values.

```ts
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '@alvin0/ai-agent-sdk-core/embedding'

try {
  await embeddings.embedMany({ values: chunks, purpose: 'retrieval-document' })
} catch (error) {
  if (error instanceof EmbeddingError
    && error.code === EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE) {
    return rechunk(error.itemIndexes ?? [], error.limit)
  }
  throw error
}
```

## Read next

- [Error handling](/en/10-advanced/error-handling) — the full taxonomy
- [OpenAI](/en/09-providers/openai) · [Gemini](/en/09-providers/gemini)
- [Custom Provider](/en/09-providers/custom-provider) — the shared HTTP transport
  both the SSE and JSON pipelines sit on
