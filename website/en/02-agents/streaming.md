# Streaming

Streaming is the only path through the SDK. `generate()` drains the same stream
`stream()` exposes — there is no separate non-streaming call that could drift.

## The run handle

```ts
const handle = agent.stream('Investigate the failure and summarise it.')

for await (const event of handle) {
  switch (event.type) {
    case 'commentary-delta': process.stdout.write(event.text); break
    case 'assistant-delta':  process.stdout.write(event.text); break
    case 'tool-call':        console.log('\n→', event.name, event.input); break
    case 'tool-result':      console.log('←', event.name, event.status); break
    case 'usage':            console.log(event.usage); break
    case 'error':            console.error(event.error); break
  }
}

const response = await handle.result
```

```ts
interface RuntimeAgentRunHandle extends AsyncIterable<RuntimeAgentRunEvent> {
  readonly runId: string
  readonly result: Promise<RuntimeAgentResponse>
  readonly report: Promise<RuntimeRunReport>
  abort(reason?: unknown): void
}
```

`result` settles after run cleanup, so awaiting it makes the session available for
another run, reset, or compaction (unless the session or runtime has closed).
`result` and `report` are available whether or not you iterate. `abort(reason)`
cancels the run and composes with any `signal` you passed.

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

`tool-result.status` is one of `completed`, `failed`, `aborted`, `rejected`.

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
```

Two things make this reliable rather than heuristic:

**Commentary is classified, not guessed.** `assistant-delta` is the answer;
`commentary-delta` is progress narration. Commentary also carries `timing` —
`before-tools`, `after-tools`, `between-tools`, `standalone` — and the tool-call
ids it refers to, so a narration line links to the exact calls it describes.

**Reasoning is separate from both.** Reasoning summary or content the provider
actually emitted arrives as reasoning events, never mixed into public text.

## One-shot

```ts
const response = await agent.generate(input)

response.runId
response.traceId
response.text        // the final answer
response.usage
response.report      // RuntimeRunReport: coverage, errors, terminal record
```

Under the hood this drains the stream and returns the terminal outcome. Use it
when no UI is watching.

## Cancellation

```ts
const controller = new AbortController()

const handle = session.stream(input, { signal: controller.signal })

// Either of these cancels the run:
controller.abort()
handle.abort('user navigated away')
```

Cancellation is **composed**: a run stops when its own signal, the runtime's
signal, or `handle.abort()` fires. A tool that declares `timeoutMs` is asserting
that it forwards `ctx.signal` — the pipeline aborts the signal and **waits**, it
does not abandon the promise, because an orphaned tool would keep mutating state
behind the loop's back.

If something ignores cancellation you will see it: `MODEL_TEARDOWN_TIMEOUT` on
the call, and `unsettledRuns > 0` in the runtime close report.

## Observing without consuming

Sometimes the consumer of the stream is not the code that needs the events:

```ts
await agent.generate(input, {
  onEvent: event => metrics.record(event),
})
```

`onEvent` receives the same events while `generate()` still returns the terminal
response. Observer failures are bounded by `observerTimeoutMs` and contained —
they never change run behaviour.

## Raw model streaming

To consume the neutral chunk protocol with **no agent loop around it**, use
`ModelRegistry.stream()` and `BlockAssembler` directly. That is a lower level
than this chapter — see [`Types` API reference](/en/13-api-reference/types) for
`StreamChunk`, `TokenUsage`, `FinishReason`, and `ReplayEnvelope`.

## Read next

- [Lifecycle](/en/02-agents/lifecycle) — hooks, cancellation, close evidence
- [Tool Execution](/en/03-tools/tool-execution) — how tool events are scheduled
- [`Types` API reference](/en/13-api-reference/types) — the raw chunk protocol
