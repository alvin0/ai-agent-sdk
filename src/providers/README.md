# Providers

Adapters are the **only** layer in this package that knows a vendor's wire format.
Everything above them speaks the neutral vocabulary in `../core/`.

The design goal of this folder is that **adding a provider should not be a code
change**. For most endpoints it isn't: you pass a config object and get a working
adapter. The three built-in providers are themselves nothing but config, which is
how we know the path works.

## Four layers

```
                        ┌──────────────────────────────────────┐
   core/runtime         │  ModelRegistry                       │  routing, middleware,
                        │  (the one failure funnel)            │  failure funnel
                        └───────────────────┬──────────────────┘
                                            │ ModelAdapter contract
                        ┌───────────────────▼──────────────────┐
   providers/base       │  HttpModelAdapter                    │  ONE fetch/SSE
                        │  owns stream() — not overridable     │  pipeline
                        └───────────────────┬──────────────────┘
                                            │
                        ┌───────────────────▼──────────────────┐
   providers/           │  createHttpProvider(config)          │  turns config
   http-provider.ts     │  auth · dialect · catalog · errors    │  into an adapter
                        └───────┬──────────────────────┬───────┘
                                │ WireProtocol         │
              ┌─────────────────▼──────┐   ┌───────────▼────────────┐
   providers/ │ openai-responses       │   │ anthropic-messages     │  pure translation
   protocols/ │ serialize + translate  │   │ serialize + translate  │  (no URL, no auth)
              └───────┬────────┬───────┘   └───────────┬────────────┘
                      │        │                       │
                 ┌────▼───┐ ┌──▼─────┐        ┌────────▼────────┐
                 │ openai │ │ codex  │        │    anthropic    │  ~80 lines of
                 │ config │ │ config │        │     config      │  config each
                 └────────┘ └────────┘        └─────────────────┘
```

Each boundary earns its place:

- **base** exists so no provider ships its own HTTP loop.
- **protocols** exist because "which JSON shapes and SSE events" is independent of
  "which URL and which credential". Dozens of endpoints speak the two protocols
  here; each should not need its own translation code.
- **http-provider** exists so an endpoint is *data*. `openai` and `codex` differ by
  a base URL, an auth scheme, and four dialect flags — that is a config diff, not a
  class hierarchy.

## Adding a provider

### The normal path: configuration

No new folder. No new file. No edit to `tsdown.config.ts` or `package.json`.

```ts
import { ModelRegistry, createHttpProvider, apiKeyFromEnv, openAiResponsesProtocol } from 'ai-agent-sdk'

const openrouter = createHttpProvider({
  displayName: 'OpenRouter',
  protocol: openAiResponsesProtocol,
  baseUrl: 'https://openrouter.ai/api/v1',
  auth: { kind: 'bearer', token: apiKeyFromEnv('OPENROUTER_API_KEY') },
})

registry.registerAdapter(['openrouter'], openrouter)
```

That is the entire cost for any endpoint speaking a protocol already implemented —
a gateway, a proxy, a self-hosted server, a regional deployment, a fine-tune host.

Full option set in `http-provider.ts`. The ones that matter:

| Option | Use it for |
| --- | --- |
| `auth` | `none` · `bearer` · `header` · **`dynamic`** (resolved per operation — this is what makes OAuth config-only) |
| `dialect` | partial override of the protocol's knobs; unspecified knobs keep their defaults |
| `headers` | static or resolved extra headers |
| `models` | declare capabilities the SDK cannot infer, above all **image support** |
| `discoverModels` | fetch the catalog from the endpoint instead; memoized, and a failure is non-fatal |
| `maxCatalogModels` / `maxCatalogBytes` | bound static and discovered metadata before it is retained |
| `describeModel` | decorate resolved metadata (Anthropic advertises thinking budgets this way) |
| `errorCode` | classify a status this endpoint reports specially; return `undefined` to fall through |

### A new protocol

Protocols are passed **by value**, not looked up in a mutable global registry, so a
third party can add one without mutating shared state and without this package
knowing about it:

```ts
const myProtocol: WireProtocol<MyDialect> = {
  id: 'my-protocol',
  defaultDialect: { /* … */ },
  endpointPath: () => '/generate',
  protocolHeaders: dialect => ({ /* headers the PROTOCOL requires */ }),
  serialize: (request, dialect) => ({ /* wire JSON */ }),
  translate: async function* (events, request, displayName) { /* → StreamChunk */ },
}
```

`protocolHeaders` is for headers the protocol mandates regardless of endpoint —
`anthropic-version` is the motivating case, which is why no Anthropic-compatible
endpoint has to restate it.

### The escape hatch: subclassing

Subclass `HttpModelAdapter` only when the endpoint's connection facts **cannot be
expressed as data**. Concretely:

| Situation | Config is enough? |
| --- | --- |
| API key, bearer token, custom header | ✅ |
| OAuth with refresh, account-scoped headers | ✅ `auth: { kind: 'dynamic' }` |
| Catalog fetched from the endpoint | ✅ `discoverModels` |
| Reduced or extended request schema | ✅ `dialect` |
| Request signing over the **body** (AWS SigV4) | ❌ subclass |
| Credential exchange with its own state machine | ❌ subclass |
| Non-SSE transport (WebSocket, gRPC) | ❌ deeper than this layer |

That line is borrowed from prior art: a configuration shape that promises to serve
SigV4 or Vertex would hand back a provider that cannot authenticate, which is worse
than refusing.

A subclass supplies five members and inherits everything else:

```ts
class MyAdapter extends HttpModelAdapter {
  protected readonly displayName = 'MyProvider'
  protected connect(provider: string, signal?: AbortSignal): Promise<HttpConnection>
  protected endpointPath(request: ProviderRequest): string
  protected buildBody(request: ProviderRequest): unknown | Promise<unknown>
  protected translate(events: AsyncIterable<SseEvent>, request: ProviderRequest): AsyncGenerator<StreamChunk>
}
```

Optional overrides: `baseHeaders()`, `providerErrorCode()`, `providerRetryPolicy()`,
`resolveModel()`.

Note what is **not** an extension point: `stream()`. It lives in the base class, so
a provider cannot accidentally forget attribution headers, mishandle abort, leak a
response body, or invent error codes — it never writes that code.

### Before you start

- **No constructor parameter properties.** Node's strip-only TypeScript mode rejects
  `constructor(private readonly x: T)`, and this package runs under `node file.ts`
  with no build step. Declare fields explicitly. Vitest transforms them fine, so the
  test suite will **not** catch this.
- **No default model id.** Provider lineups turn over faster than this package's
  release cadence, so `GenerateOptions.model` is required. A catalog is advisory:
  never reject a model id merely because it is unlisted.

## The pipeline

`stream()` runs these steps, in this order, once:

1. **Guard modality** — an image against a model declaring no image support fails
   with `UNSUPPORTED_CONTENT` rather than being sent.
2. **Build `ProviderRequest`** — resolves `maxTokens` to a number, which some APIs
   require.
3. **Fuse abort signals** — `AbortSignal.any([caller, ownConsumer])`. Aborting our
   own controller in `finally` is what tears down an in-flight response when the
   consumer stops reading early, instead of leaking the connection.
4. **`buildBody` → `JSON.stringify` → `fetch`**, with `connection.headers` merged
   over `baseHeaders()`.
5. **Classify a non-2xx** — read the body, map to a stable `code`, extract
   `retry-after` and a request id, throw a populated `ModelError`.
6. **Decode** — `parseSse` → `withIdleTimeout` → `translate`.

Step 6's bound is on **idle** time between chunks, not total duration: a legitimate
generation can take minutes while never being idle. The failure it guards against is
specific — a provider returns 200, sends part of the body, then stops without
closing the connection. No error is ever delivered, so a plain `for await` waits
forever.

## Who owns errors

A strict division. Getting it wrong is the most common way to make retry misbehave.

- **The adapter** assigns a stable `code` at the wire boundary. It never decides
  whether to retry.
- **The policy** (`core/contract/retry-policy.ts`) decides which codes are eligible.

That split is what lets a caller widen or narrow retry per route without touching —
or even understanding — any vendor's error mapping.

The shared mapping in `base/http-errors.ts` handles the vendor-independent calls:

| Situation | Code | Why it matters |
| --- | --- | --- |
| quota wording on a 429 | `QUOTA` | checked **before** 429 → a spent balance never clears, so retrying costs latency and money |
| plain 429 | `RATE_LIMIT` | retryable; it does clear |
| 400 naming the context window | `CONTEXT_WINDOW_EXCEEDED` | the caller should compact history, not retry |
| other 400/422 | `INVALID_REQUEST` | a schema bug; retrying cannot fix it |
| 404 | `INVALID_REQUEST` | **not** `SERVER` — otherwise retry hammers a model that does not exist |
| any 5xx (incl. 529) | `SERVER` | retryable |

## Throw or finish chunk?

Adapters **throw**. The registry's funnel is the single place that converts a throw
into a terminal `error` / `aborted` finish chunk.

```
adapter throws ──► HttpModelAdapter wraps as ModelError
                     ──► ModelRegistry.adapterStream ──► { type:'finish', reason:{kind:'error'} }
```

Two consequences:

- Consumers of `registry.stream()` never see a throw from a provider. A stream that
  fails still **ends**, so text that already arrived is not stranded.
- `withRetry` decorates an *adapter*, so it sits **inside** the funnel. On a bare
  adapter it propagates throws; composed as intended it yields finish chunks. Both
  halves are covered in `tests/unit/with-retry.spec.ts`.

Middleware and consumer failures stay thrown — those are bugs in code the caller
controls, and converting them to a finish reason would hide them.

## Request logs for debugging

Wire-request logging is opt-in because the body contains prompts, images, and tool
outputs. The shared HTTP pipeline logs after protocol serialization and immediately
before `fetch`, so the record is the request the provider actually receives rather
than the neutral `GenerateOptions` used above the adapter.

```ts
import { createDailyJsonlRequestLogger } from 'ai-agent-sdk/request-logger'
import { codexAdapter } from 'ai-agent-sdk/codex'

const adapter = codexAdapter({
  requestLogger: createDailyJsonlRequestLogger(),
})
```

The default layout is:

```
.providers/
└── codex/
    └── logs/
        └── 2026-08-30.jsonl
```

Each line is an independently parseable JSON record with timestamp, local request
id, route, model, URL, redacted headers, exact wire body, and byte count. JSONL is
used instead of one JSON array so appending a request does not rewrite the entire
day and a crash cannot invalidate earlier records. Authorization, API-key, token,
cookie, and account-id headers are redacted. The body is intentionally not redacted;
`.providers/` is git-ignored, but it must still be treated as sensitive local data.
Timestamps remain ISO UTC instants, while daily filenames rotate on the host's
local calendar by default. Set `calendar: 'utc'` when UTC rotation is preferred.

## Snapshot discipline

`connect()` returns everything needed for one request as a single value:

```ts
interface HttpConnection {
  baseUrl, headers,              // endpoint AND credential, resolved together
  streamIdleTimeoutMs, retryPolicy,
  models, defaultMaxTokens, defaultContextWindow
}
```

Resolving the credential inside `connect()` closes a real gap: read separately, a
configuration change between the two reads would send one generation's secret to
another generation's URL. Read together, once per call, that is impossible.

`prepareCall()` extends the idea to capabilities — it binds model metadata and the
eventual dispatch to one snapshot, so a caller cannot resolve "what can this model
do" against one configuration and dispatch to another.

## The built-in providers

| Folder | URL | Auth | Protocol |
| --- | --- | --- | --- |
| `anthropic/` | `api.anthropic.com/v1/messages` | `x-api-key` | `anthropic-messages` |
| `openai/` | `api.openai.com/v1/responses` | bearer | `openai-responses` |
| `codex/` | `chatgpt.com/backend-api/codex/responses` | OAuth device code | `openai-responses` |

All three are `createHttpProvider` calls. `codex/` is the interesting one: it has the
most demanding requirements here — OAuth with proactive refresh, account-scoped
headers, endpoint-driven discovery, a reduced request schema — and still needs no
subclass. If it did, the config path would not be pulling its weight.

You can see the sharing in the build: `dist/openai.js` is ~2 kB because the
pipeline, the protocol, and the factory all live in shared chunks.

### The Responses dialect

`openai` and `codex` differ only by this record — behaviour is identical, so the
difference is data:

| Knob | `openai` | `codex` | Reason |
| --- | --- | --- | --- |
| `sampling` | `true` | `false` | the Codex request schema has no `temperature` / `top_p` |
| `maxOutputTokens` | `true` | `false` | likewise no `max_output_tokens` |
| `store` | `false` | `false` | retaining prompts server-side should be explicit |
| `include` | `['reasoning.encrypted_content']` | same | without it the model loses its chain of thought between a tool call and its result |
| `promptCacheKey` | caller's choice | per-instance id | prefix-cache reuse across turns |

### Where the two protocols genuinely differ

The traps. All covered by unit tests.

**Conversation shape.** Responses wants a *flat* list of items: a tool result is a
top-level `function_call_output`, not a part inside a user message. One assistant
turn that reasoned, spoke, and called two tools becomes four items, and their order
must survive because the model reads it back as its own prior turn.

Anthropic keeps nested content but requires **merging consecutive same-role
messages** — three parallel tool results must arrive as three `tool_result` blocks
in **one** user message, or the turn is rejected.

**Tool arguments.** Responses takes `arguments` as a JSON *string*. Anthropic takes
`input` as a parsed *object*. Our `ToolCallBlock` keeps the raw string the model
produced, so the Anthropic serializer parses on the way out — falling back to `{}`
on invalid JSON, which keeps the conversation well-formed so the tool layer can
report the problem back to the model.

**Reasoning replay.** Both need prior reasoning echoed back, both via
`ReasoningBlock.providerState`:

- Responses: `{ id, encryptedContent, summary }`
- Anthropic: `{ kind, signature }` — a thinking block **without** a signature is
  dropped, because unsigned thinking is rejected outright.

**Cached-token accounting.** `TokenUsage` treats the three input figures as
disjoint. Responses reports `input_tokens` as the *total* with `cached_tokens` as a
subset, so the translator **subtracts**. Anthropic already reports them disjointly,
so it **does not**. Reversing this silently double-counts or under-reports on every
cached call.

Both protocol packages treat an omitted cache bucket as authoritative zero, but
never invent a missing input or output count. Partial and malformed usage remains
on the provider-attempt report (`partial` / `USAGE_INVALID`) and is withheld from
the public stream, where `TokenUsage` continues to mean an exact normalized
report. This prevents a missing counter from silently becoming a trustworthy zero.

**Termination.** Neither API sends a `[DONE]` sentinel, so `parseSse` stays
protocol-agnostic and each `translate` owns termination: `response.completed` for
Responses, `message_stop` for Anthropic. A body ending before either is truncation →
`STREAM_CLOSED`, not an empty success.

## Field notes

Verified against live endpoints, not documentation:

- The Codex backend reports some rejections as a bare `{"detail": "..."}` — a FastAPI
  convention with no `error` wrapper and no `message`. `parseErrorBody` handles it;
  without that, "this model is not supported" surfaces as an opaque `HTTP 400`.
- Codex's `/models` requires a `client_version` query parameter **and gates the
  result on it**: `0.45.0` returns `{"models":[]}` while `1.0.0` returns the full
  set. An empty list is easy to misread as "this account has no access".
- Codex model slugs are not guessable (`gpt-5.6-sol`, `gpt-5.4-mini`,
  `gpt-5.3-codex-spark`, …) and are plan-dependent, which is why `codexAdapter`
  discovers its catalog. Discovery also supplies `input_modalities` — without it
  every model is assumed text-only and image input is silently projected to text.
