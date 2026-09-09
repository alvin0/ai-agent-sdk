# Adapter pipeline

## The split

A provider supplies **four things**. The base class owns everything else.

| Provider supplies | Base class owns |
| --- | --- |
| `connect` — credentials, headers, endpoint facts | `stream()` — the whole fetch/SSE loop |
| `endpointPath` — where the request goes | Attribution headers |
| `buildBody` — the neutral call → wire body | Abort handling and teardown |
| `translate` — wire events → neutral chunks | Error code assignment |

`stream()` lives in the base class **on purpose**. A provider that owned its own
fetch loop could forget attribution headers, mishandle abort, or invent error
codes — and each of those failures would be invisible until production.

## The full path of one call

```text
agent.generate(input)
    │
    ▼
runAgent / runTurn                 loop policy, bounds, tool scheduling
    │
    ▼
ModelRegistry.prepareCall()        capability snapshot, defaults, validation
    │                              → rejects UNSUPPORTED_* before any I/O
    ▼
withRetry (decorator)              only before the first chunk reaches the consumer
    │
    ▼
HttpModelAdapter.stream()          base class: fetch, SSE, bounds, abort, errors
    │
    ├── connect()                  provider: credentials + headers
    ├── endpointPath()             provider: URL path
    ├── buildBody()                provider/protocol: neutral → wire
    │
    ▼
Provider HTTP endpoint
    │
    ▼
SSE parse                          media-type, byte/chunk/event bounds, heartbeat
    │
    ▼
translate()                        provider/protocol: wire event → StreamChunk[]
    │
    ▼
StreamChunk stream                 block-start … usage … finish
    │
    ▼
BlockAssembler                     → Message + TokenUsage + FinishReason
```

## What the registry does before dispatch

`prepareCall()` returns a **generation-bound** model capability snapshot:
combined context window, default and hard output limits, reasoning efforts,
input/output modalities, and explicit native-tool support.

Before any provider I/O it:

- materializes model defaults;
- rejects an unsupported reasoning effort → `UNSUPPORTED_REASONING_EFFORT`;
- rejects an unsupported native tool → `UNSUPPORTED_NATIVE_TOOL`;
- rejects output above the hard ceiling → `OUTPUT_TOKEN_LIMIT_EXCEEDED`;
- projects image input away **only** for models that explicitly lack vision;
- prevents an output reservation from consuming the whole combined window.

A prepared call is generation-bound: mutating or reusing one across generations
fails with `INVALID_PREPARED_CALL`.

## Serialization rules

- **Synchronous and JSON-object-only.**
- Bounded pre-dispatch validation and detachment.
- **One encoded request body reused across retries** — a retry must not
  re-serialize a mutated object.

## SSE parsing rules

Provider-local and exact-pinned:

| Rule | Purpose |
| --- | --- |
| Media-type check | Reject an HTML error page pretending to be a stream. |
| Byte / chunk / event bounds | A runaway stream cannot exhaust memory. |
| Comment-heartbeat activity | A silent-but-alive connection is not a timeout. |
| Linear draining | No quadratic buffer rescanning. |
| One required terminal finish | A truncated body produces `STREAM_CLOSED`, not a silently short message. |

`@ai-agent-sdk/provider-http` is the sole direct owner of exact
`eventsource-parser@4.1.0`; see
[the dependency policy](/en/14-project/dependency-policy).

## Error assignment

Adapters assign a stable `code` **at the wire boundary**. Retry **policy** then
decides which codes are eligible — never the adapter that assigned them.

An adapter may throw, but the registry normalizes that into a terminal `error`
or `aborted` finish before a consumer ever sees it. A stream that fails still has
to **end**.

## Retry placement

Retry is a decorator around an adapter, and it retries only failures that occur
**before the first chunk reaches the consumer**. Replaying delivered tokens would
duplicate output.

```ts
registry.registerAdapter(['openai'], withRetry(openAiAdapter({ apiKey }), {
  policy: { mode: 'normal', maxRetries: 3 },
}))
```

`mode: 'always'` is accepted only when the request carries an `AbortSignal`.
Normal agent turns provide one through their model deadline.

## Physical attempts vs logical calls

One **logical** model call may include several **physical** provider attempts.
The observation model keeps them separate:

- `modelCallId` — one logical operation, including automatic retries
- `attemptId` — one physical attempt

Each attempt records `dispatchState: 'not-sent' | 'sent' | 'unknown'`. An
interrupted attempt in `sent` or `unknown` state that returned no usage
increments `possiblyBilledAttemptsWithoutUsage` — the honest answer when exact
billing is unknowable from the response.

## Subclassing

Subclass `HttpModelAdapter` **only** when connection facts cannot be expressed as
data — request signing over the body, such as AWS SigV4.

For a fully non-HTTP provider, the direct `ModelAdapter` author surface remains
public, along with activation-scoped registrar handles and middleware, model
metadata, accounting, and cleanup.

## Read next

- [Adding a provider](/en/09-providers/custom-provider)
- [Providers and the registry](/en/09-providers/)
