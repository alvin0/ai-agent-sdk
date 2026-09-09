# Streaming, cancellation, completion

Streaming is the only path. `generate()` drains the same stream `stream()`
exposes, so a non-streaming path cannot drift from a streaming one.

## The run handle

```ts
interface RuntimeAgentRunHandle extends AsyncIterable<RuntimeAgentRunEvent> {
  readonly runId: string
  readonly result: Promise<RuntimeAgentResponse>
  readonly report: Promise<RuntimeRunReport>
  abort(reason?: unknown): void
}
```

`result` and `report` are available whether or not you iterate. `result` settles
after run cleanup, so awaiting it makes the session available for another run,
reset, or compaction.

## Every event

All events carry `runId`, `traceId`, and a monotonic `sequence`.

| Event | Payload | Use for |
| --- | --- | --- |
| `commentary-delta` | `text` | Progress narration around tool use |
| `assistant-delta` | `text` | The answer, token by token |
| `tool-call` | `callId`, `name`, `input` | Render a tool node |
| `tool-result` | `callId`, `name`, `status`, `output` | Complete that node |
| `assistant-native-tool` | `callId`, `provider`, `name`, `status`, `input?`, `output?` | Provider-executed tool progress |
| `approval-request` | `request` | Prompt the user to allow a call |
| `user-input-request` | `request` | Park on a material decision |
| `user-input-response` | `requestId`, `response` | Echo the answer into the UI |
| `usage` | `usage`, `report` | Token accounting |
| `error` | `error`, `report` | Correlated, sanitized failure |

`tool-result.status` is `completed` | `failed` | `aborted` | `rejected`.

**Commentary is classified, not guessed.** `assistant-delta` is the answer;
`commentary-delta` is narration and carries `timing` — `before-tools`,
`after-tools`, `between-tools`, `standalone` — plus the tool-call ids it refers
to. Reasoning arrives as its own events, never mixed into public text.

## Rendering a live UI

```ts
const handle = session.stream(input)

for await (const event of handle) {
  if (event.type === 'commentary-delta') appendProgress(event.text)
  if (event.type === 'assistant-delta') appendAnswer(event.text)
  if (event.type === 'tool-call') openToolNode(event.callId, event.name, event.input)
  if (event.type === 'tool-result') closeToolNode(event.callId, event.status, event.output)
  if (event.type === 'approval-request') showApprovalDialog(event.request)
  if (event.type === 'error') showBanner(event.error)
}

const response = await handle.result
```

## One-shot

```ts
const response = await agent.generate(input)

response.runId
response.traceId
response.text        // the final answer
response.usage
response.report      // RuntimeRunReport: coverage, errors, terminal record
```

## Judging completion correctly

This is the most commonly mis-coded part.

- `response.completed` indicates objective completion.
- `response.stopReason` is the terminal reason: `completed`,
  `concluded-by-tool`, `budget-exhausted`, `max-tokens`, or
  `usage-unavailable`.
- Do **not** mark a business job done because the promise resolved or
  `report.status === 'success'`.
- In `deep` mode, `stopReason === 'completed'` alone is insufficient — an
  accepted completion submission is also required.
- Cancellation and execution errors **reject** the result; inspect the terminal
  report on the error or `handle.report` rather than expecting a response.

## Cancellation

```ts
const controller = new AbortController()
const handle = session.stream(input, { signal: controller.signal })

controller.abort()                      // either of these cancels
handle.abort('user navigated away')
```

Cancellation is **composed**: the run stops when its own signal, the runtime's
signal, or `handle.abort()` fires. A tool declaring `timeoutMs` asserts that it
forwards `ctx.signal`; the pipeline aborts the signal and **waits** rather than
abandoning the promise, because an orphaned tool would keep mutating state
behind the loop's back.

Ignored cancellation is visible: `MODEL_TEARDOWN_TIMEOUT` on the call, and
`unsettledRuns > 0` in the runtime close report.

## Observing without consuming

```ts
await agent.generate(input, { onEvent: event => metrics.record(event) })
```

`onEvent` receives the same events while `generate()` still returns the terminal
response. Observer failures are bounded by `observerTimeoutMs` and contained —
they never change run behaviour.

## Raw model streaming

To consume the neutral chunk protocol with no agent loop, use
`ModelRegistry.stream()` with `BlockAssembler`. Types: `StreamChunk`,
`TokenUsage`, `FinishReason`, `ReplayEnvelope`.
