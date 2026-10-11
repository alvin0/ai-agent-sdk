# Upgrading to 0.1.12

Upgrade the SDK packages together to **0.1.12**. The workspace has 28 package
manifests, of which 27 are publishable; `testkit` remains private. A push to
`main` triggers guarded publication, while manual Release dispatch defaults to
a dry run. Local checks do not prove npm publication or hosted CI success.

## Required event fields

`reasoning-delta` and `assistant-reasoning` events now require
`reasoningKind: 'summary' | 'content' | 'unknown'` in both the low-level and
runtime API. Update event builders, wrappers and test doubles. Raw stream
chunks and persisted `ReasoningBlock` use optional `kind` instead. Old histories
without labels restore unchanged; missing or mixed labels mean unknown.

## Image search and image-only answers

Opt into Responses image search with:

```ts
nativeTools: [{
  type: 'native', name: 'web-search', searchContentTypes: ['text', 'image'],
}]
```

Omission means text search. Codex accepts the Responses field; Anthropic and
Gemini reject image search with `INVALID_REQUEST`.

Basic turns accept actual image output without text, including budget-forced
answers. Deep completion still requires text. A completed native-tool status
with no image is not an image answer.

Consume the low-level `assistant-message` event to persist final image bytes.
When inline base64 images exceed history limits, the loop records the assistant
without those bytes and sets the assistant history event's optional positive
`omittedImages` count. Direct images become commentary notes. Snapshots preserve
that count, not the missing images. A reduced entry that still exceeds limits
continues to fail.

Image-generation requests use a default SSE event bound of 12 × 1,048,576
characters. An explicit `maxSseEventChars` wins; `maxResponseBytes` still bounds
the whole response. Responses no longer duplicates images in
`providerState.result`; replay reads `content`, with fallback for older state.

## Retry and recovery changes from 0.1.11

`RequestErrorContext` requires `consecutiveFailures` and `retries`. The first
counts failed model requests in the current outage, resetting after success;
the second counts retries granted across the turn. Update constructed hook
contexts and test doubles.

`requestRetryHook` from `@alvin0/ai-agent-sdk-core/agent` builds an
`onRequestError` hook with per-outage and per-turn limits, abortable waits,
backoff and an optional deadline. Transport retry before the first delivered
chunk and agent-loop request retry are separate boundaries. Loop admission and
checkpoint errors are not retried.

`TurnHooks.onTerminalRecovery` and `createTerminalRecoveryMessage` let a host
deliver committed public text/tool results when no further request can run.
Recovery preserves the unsuccessful outcome and explicit cancellation. Do not
infer objective completion from a recovery message or a resolved promise.
The report reserve adapts to observed request cost; a forced answer can begin
earlier, and its finalize window only opens when another request can fit.

## Effort and model policy

Omitted effort stays omitted. The SDK forwards an explicit effort as an opaque
provider value rather than checking a local effort catalog. The low-level
`defineAgent()` retains a legacy Codex model default; configure provider/model
explicitly in this project's examples and live calls with `gpt-6-luna` or a newer
chosen model. Consumer model selection remains configurable.
