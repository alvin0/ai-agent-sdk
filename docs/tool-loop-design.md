# Tool loop — design and implementation plan

Status: **tool-loop core, execution modes, memory, and compaction implemented.**
History, staged dispatch, scheduling, bounds, hooks, event backpressure,
Foundry-style trace identity, pinned task memory, pressure checkpoints, and
overflow recovery are now live.
Deep execution and human-input orchestration are implemented; sub-agents and
workflow composition remain later layers.

Derived from reading two production agent loops in `.temp/`: the OpenAI Codex CLI
(`codex-rs/core/src`) and deepseek-harness (`packages/core/agent-loop`,
`packages/core/tools`). Where they agree, this document follows them and says so.
Where it deviates, it says why.

---

## 1. What exists today

| Piece | State |
| --- | --- |
| `src/core/` | done — message model, stream protocol, assembler, registry, retry |
| `src/providers/` | done — base pipeline, protocols, Anthropic/OpenAI/Codex |
| `src/agent/tool/` | done — definition, registry, errors, approval, staged dispatch |
| `src/agent/history/` | done — append-only entries, projection, repair, snapshot/hydration |
| `src/agent/loop/` | done — scheduler, bounds, hooks, capacity-one event bridge |
| `src/agent/memory/` | done — pinned task facts, pressure compaction, overflow recovery |
| `src/agent/trace/` | done — W3C ids, span lifecycle, immutable process-tree projection |

The reproducible live mode gate is `node spikes/live-agent-modes.ts`; provider
requests are written to `.providers/codex/logs/YYYY-MM-DD.jsonl`.

The tool layer already settles the hardest question — what happens when a tool
fails — so the loop can be written assuming every tool call yields a result.

---

## 1b. Spike results

The decisions were settled by building spikes and running them, not by argument.
All are reproducible under `spikes/`; only `step-budget.ts` needs a Codex login.

### Spike A — history substrate

```
S1 compaction shrinks request, transcript intact
  Message[]+splice : request 3 msgs; transcript LOST 5 msgs
  append-only log  : request 3 msgs; transcript INTACT (grew)

S2 detect an unanswered tool call after a crash
  Message[]+splice : found 1 orphan(s) by scanning message content
  append-only log  : found 1 orphan(s), with tool name

S3 reconstruct the pre-compaction request
  Message[]+splice : IMPOSSIBLE (was 5, now 3, originals gone)
  append-only log  : reconstructed 5 from log prefix

cost: ArrayHistory ~18 lines, LogHistory ~46 lines (+28)
```

**The spike disproved one of this document's own arguments.** An earlier draft
claimed a plain array "leaves no place to record that a tool call was interrupted".
S2 shows that is false: the assistant message already carries its `tool-call` blocks,
so orphan detection works fine on an array. The log only adds convenience there.

The log is therefore justified by S1 and S3 alone — and it is, see §5.

### Spike B — step budget, live against `gpt-5.4`

Six repository-exploration tasks, read-only tools (`list_dir`, `read_file`, `grep`),
a throwaway loop whose only job is to count.

```
  trivial           2 steps   1 calls  0 errors  ok
  one-hop           3 steps   3 calls  0 errors  ok
  survey            5 steps  16 calls  5 errors  ok
  cross-reference   3 steps   5 calls  0 errors  ok
  contract          3 steps   3 calls  0 errors  ok
  open-ended        3 steps  10 calls  0 errors  ok

  n=6  min=2  median=3  p90=5  max=5
  tool calls: 38 total, 5 errors
  tokens: 45578 in, 1873 out
```

Four findings, three of them changed the design:

**F1 — steps are few, tool calls are many.** `survey` used 16 tool calls in 5 steps.
The model batches aggressively, so a step cap alone is a weak bound on cost. §8 now
bounds **both**.

**F2 — input tokens dominate output 24:1.** History replay, not generation, is what a
turn costs. That promotes compaction from a nice-to-have to a requirement for any
long conversation, which in turn makes S1 and S3 load-bearing rather than cosmetic.

**F3 — "tool errors are model input" survived a real test.** In `survey` the model
speculatively read a `README.md` in five provider folders, got `ENOENT` on all five
in one parallel batch, and still answered correctly. Had those thrown, the turn would
have died on a guess. This also exercised parallel dispatch and recovery end to end.

**F4 — a raw `ENOENT` surfaces as the generic `TOOL_FAILED`.** Correct per the
documented default, but it shows real tools should map errno to codes themselves.
Worth saying in the tool-authoring docs; no core change.

The measured p90 is 5 steps. §8 explains why the default is nonetheless higher, and
what the measurement does **not** cover.

### Spike C — persistence boundary

`node spikes/persistence-boundary.ts` tested the part the earlier history spike did
not: crash safety around a mutating tool.

```
  JSON snapshot round-trip     : PASS (message ids and tool calls preserved)
  awaited checkpoint ordering : PASS (durable before side effect)
  rejected checkpoint         : PASS (tool body did not run)
  storage backend in core     : NOT REQUIRED
```

This changes the persistence answer in §14. Caller-owned storage is sufficient,
but plain `entries()` is not: core must expose a versioned snapshot/hydration
contract and await a caller checkpoint before model requests and tool side effects.
That is a control-flow seam, not an observational event.

### Spike D — Chat Completions protocol fit

`node spikes/chat-completions-fit.ts` ran a representative tool loop through the
existing `WireProtocol` and `BlockAssembler` contracts.

```
  WireProtocol integration      : PASS (no base/core/loop change)
  assistant calls + tool result : PASS
  parallel streamed tool calls  : PASS
  usage + termination           : PASS
  Responses reasoning replay    : UNAVAILABLE (documented capability loss)
```

The protocol fits without changing the loop. Production work is still more than a
trivial file: request projection, a stateful SSE translator, wire types, malformed
stream handling, usage normalization, and tests. It is therefore a compatibility
increment after the loop's live gate, not a loop blocker.

### Spike E — native capability live gate

`node spikes/live-native-capabilities.ts` ran native web search through the real
Codex Responses route with `gpt-5.6-luna`, reasoning effort `medium`, and a forced
native tool choice.

```
  request wire       : PASS (`web_search`, allowed domain, medium effort)
  native call ids    : PASS (two distinct `ws_*` nodes, both completed)
  public commentary : PASS (before and between searches)
  URL citation       : PASS (official developers.openai.com source)
  final answer       : PASS
```

The exact redacted request is appended to
`.providers/codex/logs/2026-08-30.jsonl`. Image generation is covered at the
serializer, translator, assembler, and loop-event boundaries; this environment
has no OpenAI API key, so it was not presented as a live image-generation result.

---

## 2. Three execution modes, two architectural axes

The public `runAgent()` layer exposes three product-facing behaviours:

| Execution mode | Host contract | Completion contract |
| --- | --- | --- |
| **`basic`** | Use tools proactively within `maxTurns` | A response with no tool calls, or a forced no-tools answer after exhaustion |
| **`deep`** | Re-check evidence against the objective after every batch; optionally ask when blocked | The reserved `submit_result` tool must be accepted before the final answer counts as complete |
| **`deep-human-in-loop`** | The deep loop plus a required `UserInputBroker` for material choices or missing facts | Park `request_user_input` by call id, resume after the answer, then pass the same completion gate |

Applications normally reach these policies through the declarative facade:

```ts
const planner = defineAgent({
  id: 'planner',
  name: 'Planner',
  instructions: 'Inspect evidence, ask about material ambiguity, then produce a concrete plan.',
  mode: 'deep-human-in-loop',
  tools: [readProjectFile],
})

const session = planner.createSession({ registry, userInput: broker })
for await (const event of session.stream('Plan the migration.')) render(event)
```

The split is deliberate: a frozen definition owns stable identity, instructions,
model policy, and capabilities; a session owns mutable history and one live-run
guard. `runAgent()` remains the policy engine and `runTurn()` remains the
mechanism. The facade adds no fourth loop and preserves every trace/event needed
by a Foundry-style GUI.

```ts
const broker = createUserInputBroker()

for await (const event of runAgent({
  mode: 'deep-human-in-loop',
  registry,
  // defaults to Codex gpt-5.6-luna with medium reasoning effort
  history,
  tools,
  userInput: broker,
  maxTurns: 8,
})) {
  if (event.type === 'user-input-request') renderQuestion(event.request)
  if (event.type === 'agent-end') console.log(event.outcome)
}

// Resume the exact parked call. The string can be a suggested label or free-form.
broker.resolve(requestId, {
  answers: { database: { answers: ['PostgreSQL 17'] } },
})
```

`maxTurns` counts normal model iterations. With the default
`force-final-answer` policy, exhaustion may use one additional request with tools
disabled so the evidence already gathered still produces a user-facing result.

Deep completion is structural, not a phrase detector. A prose draft without
`submit_result` causes the host to append a self-check instruction and run another
bounded iteration. The model submits a summary and concrete evidence; after the
accepted tool result it emits the actual final answer.

`submit_result` must be the only call in its batch. A model cannot truthfully claim
completion beside work whose result it has not seen; such a batch remains
incomplete and the host requests another self-check.

Human input follows Codex's separation of concerns. `ApprovalBroker` answers
"may this side effect run?" while `UserInputBroker` answers "which requirement or
option does the user want?" The input waiter is installed before
`user-input-request` becomes visible, so a GUI may resolve synchronously without a
race. Requests and responses are first-class events keyed by the provider tool-call
id. Each question carries 2-3 suggestions and `allowFreeForm: true`, matching the
Codex UI contract where the client adds an "Other" answer.

These execution presets sit above the two architectural axes below; they do not
add provider-specific branches to `runTurn`.

### Architectural axes

The requirement was a loop that can *follow a flow* or *dig into a problem on its
own*. Those are not two ends of one dial. Reading both harnesses, they are two
independent axes:

**Axis A — where context lives.** Accumulate in one conversation, or start each
round fresh and let only a bounded value cross.

**Axis B — who owns the loop.** The model writes the control flow, or the host owns
it and the model only signals completion.

That yields the three modes both harnesses actually ship:

| Mode | Context | Loop authority | Ends when |
| --- | --- | --- | --- |
| **Turn** (§6) | one conversation | model, step by step | no tool calls, or a tool concludes the turn |
| **Rounds** (§11) | one conversation | host; model signals done | model marks the objective complete, or round cap |
| **Workflow** (§11) | fresh child per call | model (writes a script) | the script returns |

The **turn loop is the foundation** — rounds and workflows both drive it. So it gets
built first and the other two are thin layers over it, not modes inside it. That is
also how the reference implementations are arranged: nothing in deepseek-harness
added a mode to the loop; Ralph, workflow, goal, and plan mode are all plugins over
public seams.

---

## 3. Decisions inherited, because both harnesses agree

These are not preferences. Two independent production systems converged on each.

| Decision | Codex | deepseek-harness |
| --- | --- | --- |
| Termination is **structural** — "did the response contain tool calls" — never a heuristic on text | `needs_follow_up` set only in `handle_output_item_done` | `toolCalls.length === 0 → completed` |
| A tool failure is **model input**, not an exception | `FunctionCallError::{RespondToModel, Fatal}` | registry normalizes throws to `isError: true` |
| Parallel tool calls **default off**, fail-closed | `supports_parallel().unwrap_or(false)` | `isConcurrencySafe` must return exactly `true` |
| Results commit in **model call order**, whatever order they finish in | `FuturesOrdered` | `commitReady()` over contiguous slots |
| An aborted turn still produces a result for **every** requested call | `aborted_response` + `ensure_call_outputs_present` | `appendSkippedToolCall` |
| Approval is a parked promise resolved by id; **deny ≠ abort** | oneshot in `TurnState`, `Rejected` vs `TurnAborted` | `ask` → `deny` vs cancel |
| Compaction is a **hook**, never loop code | triggers in `run_turn`, work in `compact.rs` | plugin on `pre-step` + `request-error` |
| Retry, agentic iteration, and stream decoding are **three separate loops** | `run_turn` / `run_sampling_request` / `try_run_sampling_request` | driver / request-retry / assembler |

The last one is already true here by construction: retry lives in `withRetry` at
the adapter layer, stream decoding lives in each provider's `translate`. So the
loop being built only has to be loop #1.

---

## 4. Deliberate deviations

### 4.1 Bounded iteration — the one gap both harnesses leave open

**Neither has a step cap.** Codex states the reasoning outright: *"as long as
compaction works well in getting us way below the token limit, we shouldn't worry
about being in an infinite loop."* deepseek-harness leaves
`TODO(stop-loop-guard): cap consecutive forced continuations`.

Both rely heavily on an interactive operator being able to interrupt. **An SDK has
no such guarantee.** A loop embedded in a cron job, webhook handler, or CI step
needs explicit convergence policy.

The prototype in `.temp/agent-caller/tools/tool-loop.ts` already solved this better
than either harness: `maxToolIterations`, and on exhaustion a *forced final round*
that declines the pending calls and re-asks with `tool_choice: 'none'` — so the work
already paid for produces an answer instead of an exception. That behaviour is
adopted. The implementation adds two protections that the reference loops do not
currently provide: exact-call and multi-step cycle detection, plus a hard aggregate
token budget. A cycle such as `read A -> inspect B -> read A -> inspect B` is
recognized across step boundaries. Calls that would complete the terminal cycle
are recorded with synthetic declined results but are not dispatched.

### 4.2 Per-tool timeout in the core

Codex has none (handlers do their own). deepseek-harness makes it a plugin. Here it
is built into the dispatch pipeline, because a tool with no deadline in an
unattended process is a hang, not a slow call. The public pipeline and scheduler
impose an outer deadline even when a tool or interceptor ignores its signal, then
grant a bounded teardown interval. Ignoring teardown is a fatal contract violation
because the in-process operation may still be running.

### 4.3 A smaller history substrate

deepseek-harness derives every request from an append-only session log with a
surface projection, replaceable spans, and per-chunk events. It is genuinely good
and it is *large*. §5 keeps the load-bearing third of it and drops the rest, with
the tradeoff stated.

---

## 5. History (`src/agent/history/`)

### The problem

Three capabilities all need the same thing, and none of them work on a plain
`Message[]`:

1. **Compaction** must replace a span of history with a summary, without destroying
   the transcript a human already read.
2. **Interrupt repair** must find a tool call that never got a result and pair it,
   or the next request is invalid.
3. **Reconstruction** must recover the model-visible history at an earlier log
   boundary after compaction rewrote the current projection. Exact wire-request
   auditing includes ephemeral hook context and therefore belongs to the awaited
   checkpoint/request logger in §10, not to `History` alone.

### Proposal: append-only log + pure projection

```ts
/** How an entry affects the model-visible projection. */
export type SurfaceOp = 'append' | {
  op: 'replace'
  from: number
  to: number
  targets?: readonly number[] // exact current-surface seqs after nested replacements
}

/** One thing that happened. Tool results retain UI/audit data, not only model text. */
export type HistoryEvent =
  | { kind: 'user'; message: Message }
  | { kind: 'assistant'; message: Message; interrupted?: true; usage?: TokenUsage }
  | { kind: 'tool-call'; callId: ToolCallId; name: string; rawArguments: string }
  | { kind: 'tool-result'; callId: ToolCallId; message: Message; result: ToolExecutionResult }

/** One durable record. Projection metadata must survive serialization too. */
export interface HistoryEntry {
  readonly seq: number
  readonly event: HistoryEvent
  readonly surfaceOp: SurfaceOp
}

export interface HistorySnapshot {
  readonly version: 1
  readonly entries: readonly HistoryEntry[]
}

export class History {
  static fromSnapshot(snapshot: HistorySnapshot): History // validates + freezes
  append(event: HistoryEvent, surfaceOp?: SurfaceOp): HistoryEntry
  entries(): readonly HistoryEntry[]      // everything, for a transcript
  messages(): readonly Message[]          // model-visible, after replacements
  surface(): readonly { seq: number; message: Message }[]
  generation(): number                    // bumps when a replace lands
  snapshot(): HistorySnapshot             // JSON-safe durability boundary
}

/** Pure, so a caller can rebuild a historical model-visible projection. */
export function projectMessages(entries: readonly HistoryEntry[]): readonly Message[]
```

`surfaceOp` is part of the stored entry, not an argument that disappears from
`entries()`; otherwise a serialized history could not rebuild its own projection.
`tool-call` entries are logged but are **not** model-visible — the assistant message
already carries the call. Only the `tool-result.message` is projected. The complete
`result` is retained because the tool contract promises that raw value and UI meta
survive persistence.

### Prompt-time normalization

Copied from Codex, and the reason is specific:

```ts
export function normalizeToolPairing(messages: readonly Message[]): readonly Message[]
```

Inserts a synthetic `"aborted"` result immediately after any tool call that has
none, and drops any result whose call is gone. It runs on the **projection**, not on
the log, so nothing synthetic is ever persisted.

The synthetic result reuses the original `ToolCallId`; this SDK's neutral
`ToolResultBlock` has no separate output-item id. Codex needs a UUIDv5 because its
provider-native output item *does* carry an id. Copying that rule here would invent
an identity no current serializer sends. If a future protocol serializes output-item
ids, derive those ids deterministically from the source call id to preserve prompt
cache bytes.

### What is dropped from the reference, and the cost

| Dropped | Cost |
| --- | --- |
| Per-chunk `assistant/chunk` events | cannot replay a stream token-by-token; a UI must buffer its own |
| `request/header` fold | exact requests are captured by the §10 checkpoint/provider logger, not reconstructed from history alone |
| Cordis scope/DI, remote projections | none for this package |

Kept because each is load-bearing: append-only, the pure projection, replace spans,
the generation counter, and a versioned snapshot/hydration contract.

### Alternative considered, and measured

**Plain `Message[]` plus a `splice()` method.** Smaller and obvious. Spike A built
both and ran three scenarios against each (§1b).

| | `Message[]`+splice | append-only log |
| --- | --- | --- |
| compaction keeps the human transcript | ✗ lost 5 of 8 messages | ✓ |
| detect an orphaned tool call | ✓ | ✓ |
| reconstruct a pre-compaction request | ✗ impossible | ✓ |
| cost | ~18 lines | ~46 lines |

**Decision: the log**, for two reasons, +28 lines.

Compaction is destructive on an array: the messages it replaces are gone, so a
caller that wants to show the user their own conversation has to keep a second copy —
a burden pushed onto every caller. And Spike B's 24:1 input-to-output token ratio
(F2) means compaction will run on any long conversation, so this is the common path,
not an edge case.

Note what did **not** justify it: orphan detection works equally well on an array
(S2), contrary to an earlier draft of this document.

---

## 6. The turn loop (`src/agent/loop/`)

```ts
export interface RunTurnOptions {
  readonly registry: ModelRegistry
  readonly config: CallConfig           // provider + model + sampling
  readonly history: History
  readonly tools?: ToolCatalog
  readonly nativeTools?: readonly NativeToolSchema[] // provider executes these
  readonly toolChoice?: ToolChoice
  readonly system?: string
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly bounds?: Partial<TurnBounds>
  readonly hooks?: TurnHooks
  readonly signal?: AbortSignal
  readonly commentary?: 'auto' | 'concise' | 'off'
  readonly trace?: {
    readonly traceId?: TraceId
    readonly parentSpanId?: SpanId
    readonly agentId?: string
    readonly agentName?: string
  }
}

export interface TurnOutcome {
  readonly reason: TurnEndReason
  readonly text: string                 // final assistant text, '' when none
  readonly steps: number                // all model calls, including a forced final call
  readonly usage: TokenUsage
  readonly toolCalls: number            // bodies actually dispatched; synthetic declines excluded
  readonly traceId: string              // root correlation id for logs and GUI lookup
}

export type ExhaustedBudget =
  | 'steps'
  | 'tool-calls'
  | 'consecutive-tool-errors'
  | 'repeated-tool-call'

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'concluded-by-tool'; toolName: string }
  | { kind: 'budget-exhausted'; budget: ExhaustedBudget; forcedFinalAnswer: boolean }
  | { kind: 'max-tokens' }
  | { kind: 'aborted' }
  | { kind: 'error'; failure: ModelFailure }

export function runTurn(options: RunTurnOptions): AsyncIterable<AgentEvent>
```

`runTurn` **returns an event stream, not a promise.** A caller that wants the
outcome awaits the terminal event; a caller that wants to render tokens iterates.
Returning a promise would force a second callback channel for streaming, and the
two would drift.

Host functions and native tools deliberately share neither execution nor result
semantics. `tools` is a `ToolCatalog` whose calls enter the approval/checkpoint/
scheduler pipeline. `nativeTools` is serialized by the provider and runs inside
the model response. A native item becomes a `native-tool-call` content block with
its provider id and opaque replay state, plus an `assistant-native-tool` event for
GUI correlation. It never increments `TurnOutcome.toolCalls` and never enters the
host scheduler.

The core media boundary is similarly semantic rather than provider-shaped:

- image input supports URL, base64, or provider file id, with an optional detail;
- `image-delta` carries progressive generated images for rendering only;
- the final image is authoritative inside `native-tool-call.content` and therefore
  survives history, hydration, and replay;
- `TextBlock.annotations` carries public URL citations, while encrypted or exact
  provider replay data remains in `providerState`.

Responses maps `web-search` and `image-generation`, including partial images and
URL citations. Anthropic maps `web-search`, pairs `server_tool_use` with
`web_search_tool_result`, and replays the encrypted result unchanged. Capability
loss is explicit: Anthropic rejects native image generation and image file ids;
Responses rejects Anthropic-only `maxUses`/`blockedDomains` controls.

One step:

```
build messages  = normalizeToolPairing(history.messages())
                  + hooks.beforeStep may prepend context or reject the step
      ↓
await hooks.checkpoint({ kind: 'before-model-request', request, snapshot })
      ↓
registry.stream(...)  → BlockAssembler          (retry lives inside the adapter)
      ↓
append assistant message to history
      ↓
tool calls present?  ── no ──→ { completed }
      │ yes
      ↓
runToolCalls(...)  (§7)  → append call intent, checkpoint, dispatch,
                           append results in model order
      ↓
concluded by a tool?  ── yes ──→ { concluded-by-tool }
      │ no
      ↓
step budget left?  ── no ──→ forced final answer (§8)
      │ yes
      └──→ next step
```

---

## 7. Tool call scheduler

```ts
export interface RunToolCallsOptions {
  readonly calls: readonly ToolCallRequest[]
  readonly catalog: ToolCatalog
  readonly position: ToolCallPosition
  readonly signal: AbortSignal
  readonly maxParallel?: number          // default 8
  readonly interceptors?: readonly ToolInterceptor[]
  readonly approvals?: ApprovalBroker
  readonly emit?: (event: ToolSchedulerEvent) => Promise<void>
  readonly checkpoint?: TurnHooks['checkpoint']
}

export interface ToolCallsOutcome {
  /** One result per call, in MODEL ORDER. */
  readonly results: readonly ToolExecutionResult[]
  readonly concluded: boolean
  readonly concludedBy?: string
}
```

### Required staging change in the tool pipeline

The current public `dispatchToolCall()` is deliberately convenient but monolithic:
it parses, runs pre-policy/approval, executes, and runs post-policy in one promise.
The scheduler cannot both classify on typed parsed arguments and preserve ordered
policy by calling that function concurrently. Parsing once in the scheduler and
again in the pipeline is also invalid: a caller-supplied `parse()` may transform the
value, throw, or be expensive.

Before the scheduler, split the pipeline behind an **internal** staged interface:

```ts
interface ToolDispatchStages {
  prepare(call): PreparedToolCall                           // parse once + classify
  authorize(call: PreparedToolCall): Promise<AuthorizedToolCall | FinalToolResult>
                                                            // ordered pre-policy + approval
  dispatch(call: AuthorizedToolCall): Promise<PendingToolResult> // only this overlaps
  finalize(call, result): Promise<ToolExecutionResult>       // post-policy; model order
}
```

The existing `dispatchToolCall()` remains public and composes all three stages, so
ordinary callers and existing tests keep their API. This is the same internal seam
deepseek-harness exposes to its scheduler.

Algorithm, following both references:

1. Walk calls in model order and prepare just in time. An exclusive call is a
   barrier. A parallel call opens a bounded rolling pool; later calls are prepared
   and reclassified before start, so registry changes can still create a barrier.
2. Append/emit the `tool-call`, run authorization in model order, await the
   `before-tool-dispatch` checkpoint, then run only the dispatch/body stage
   concurrently, at most `maxParallel` in flight.
3. **Finalize and commit in model order** even though body completion order differs.
   Post-policy, results,
   `addContext` injections, and `concludesTurn` all apply in model order, so the
   conversation is reproducible regardless of scheduling.
4. On abort: `Promise.allSettled` the started calls, then synthesize
   `ABORTED_BEFORE_DISPATCH` results for the rest. **Every requested call gets a
   result** — a missing one makes the next request invalid.
5. Emit `tool-call`, `approval-request`, and committed `tool-result` through the
   awaited event sink. The base `ApprovalBroker` has no observable `onRequest`, so
   the scheduler/pipeline must emit the approval event before awaiting
   `broker.request()`; it cannot recover that event afterward from the broker.

`concludesTurn` never short-circuits a sibling that already started.

---

## 8. Bounds and termination

```ts
export interface TurnBounds {
  /** Model calls in one turn. Default 16 — see below. */
  maxSteps: number
  /**
   * Tool calls in one turn, across all steps. Default 64.
   *
   * A step cap alone is a weak bound: Spike B measured 16 tool calls inside 5
   * steps, because the model batches parallel calls aggressively (F1). Cost tracks
   * calls at least as much as steps, so both are bounded.
   */
  maxToolCalls: number
  /** What to do when a budget runs out. Default 'force-final-answer'. */
  onExhausted: 'force-final-answer' | 'stop'
  /** Consecutive failing tool calls before the turn gives up. Default 8. */
  maxConsecutiveToolErrors: number
  /** Identical (name, args) repeats before a reminder is injected. Default 3. */
  repeatToolWarningAt: number
  /** Identical repeats before the turn is forced to conclude. Default 6. */
  repeatToolLimit: number
  /** Repeated tool-step cycles before a corrective reminder. Default 2. */
  toolCycleWarningAt: number
  /** Repeated tool-step cycles before the next cycle call is declined. Default 3. */
  toolCycleLimit: number
  /** Longest repeated step sequence inspected. Default 4. */
  maxToolCycleLength: number
  /** Aggregate model usage reported for one turn. Default 500,000 tokens. */
  maxTotalTokens: number
  /** Maximum overlapping concurrency-safe tool bodies. Default 8. */
  maxParallel: number
  /** Maximum retained result size per tool. Default 4 MiB. */
  maxToolResultBytes: number
  /** End-to-end deadline per tool call. Default 10 minutes. */
  maxToolDurationMs: number
  /** Cancellation settlement allowance. Default 30 seconds. */
  toolTeardownTimeoutMs: number
}
```

Repeat signatures use the tool name plus a bounded fingerprint of raw arguments;
JSON whitespace outside strings is ignored without recursively parsing attacker-
controlled nesting. Cycle detection operates on whole model-step call patterns,
so it catches alternating and short periodic loops that a per-call counter misses.
The warning is inserted only as model-visible app context after ordered tool
results. When the hard guard trips, every requested call still receives an ordered
synthetic result, preserving the provider tool-call/result invariant.

`maxTotalTokens` uses aggregate usage reported by adapters. Unlike other exhausted
budgets, it does not buy a forced-final request: once the monetary budget is
reached, spending more tokens for graceful prose would violate the guard itself.
Hosts can tune all of these values through `runTurn`/`runAgent` bounds or a defined
session's `runtimeLimits`.

### Where `maxSteps: 16` comes from

Spike B measured a **p90 of 5 steps and a max of 5** across six exploration tasks
(§1b). The default is deliberately ~3× that headroom, for a reason the spike could
not measure:

**the spike used only read-only tools.** Exploration converges quickly — look, read,
answer. Mutation does not: an edit-verify-fix cycle costs at least two steps per
attempt, so 16 steps is roughly seven repair attempts. That is the shape of work this
bound has to survive, and it is unmeasured here.

`maxConsecutiveToolErrors: 8` is the safety net for the case 16 turns out to be
generous: a loop that is failing rather than progressing trips it first.

**Revisit both numbers once write tools exist.** They are the two defaults in this
package with the weakest evidence, and unlike everything else here there is no prior
art to fall back on — neither reference implementation has a cap at all.

### Exhaustion and forced final answer

All four guards use the one structural outcome:
`{ kind: 'budget-exhausted', budget, forcedFinalAnswer }`. This closes the earlier
gap where the document added `maxToolCalls` but could only report `max-steps`.

When an assistant batch would exceed `maxToolCalls`, dispatch only the remaining
allowance in model order and synthesize `TOOL_BUDGET_EXHAUSTED` results for every
later call. Requested-but-declined calls do not increment `TurnOutcome.toolCalls`.
History is therefore valid before either exhaustion policy runs.

With `onExhausted: 'force-final-answer'`:

1. Finish/synthesize every pending tool result, so history stays valid.
2. Make one extra request with `toolChoice: 'none'` and an instruction to answer
   from what was gathered and state plainly what is still unknown.
3. Report `forcedFinalAnswer: true`. The extra call is exempt from `maxSteps` — it
   is the bounded escape hatch — but is included in `TurnOutcome.steps` and usage.

With `onExhausted: 'stop'`, emit the same outcome with
`forcedFinalAnswer: false`; exhaustion is expected control flow, not a thrown or
generic model error.

This is the prototype's `runForcedFinalRound`, and it matters because the
alternative — throwing — discards every tool result already paid for.

### Repeat detection

deepseek-harness counts identical `(name, canonicalized args)` runs and injects a
reminder via `additionalContext`; it never vetoes. Same here, plus a hard limit,
because "observe and enrich" with no ceiling is exactly the unattended-loop problem
from §4.1. Counted **after** dispatch, so a model hammering a *denied* call is
caught too — that is the loop most worth breaking.

`maxConsecutiveToolErrors` is evaluated over committed model-order results; a
success resets it. Repeat keys use recursively key-sorted JSON, not raw argument
text, so whitespace and object-key order do not evade the guard.

---

## 9. Interruption

On abort:

1. Partial assistant text is kept — `assembler.interruptedBlocks()` returns closed
   and open text/reasoning with real content, never a fabricated tool call.
2. The assistant entry is marked `interrupted: true`.
3. Started tool calls are drained; unstarted ones get synthetic results (§7).
4. Outcome is `{ kind: 'aborted' }`.
5. Any parked approval is settled with `abort` — a promise nobody will answer keeps
   the process alive.

If the process dies mid-turn, the log is repaired on load by pairing orphaned calls
(§5), so a resumed conversation is valid without the loop knowing anything happened.

---

## 10. Events and hooks

```ts
export type AgentEvent =
  | TraceEvent
  | { type: 'turn-start'; turn: number }
  | { type: 'step-start'; turn: number; step: number }
  | { type: 'text-delta'; text: string; phase: 'commentary' | 'final-answer' | 'unknown' }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'assistant-message'; message: Message }
  | { type: 'assistant-text'; text: string; phase: 'commentary' | 'final-answer'; timing: AssistantContentTiming }
  | { type: 'assistant-reasoning'; text: string; timing: AssistantContentTiming }
  | { type: 'tool-call'; call: ToolCallRequest }
  | { type: 'tool-result'; call: ToolCallRequest; result: ToolExecutionResult }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'step-end'; turn: number; step: number }
  | { type: 'turn-end'; outcome: TurnOutcome }
```

Every semantic event also carries `trace: { traceId, spanId, parentSpanId }`.
`TraceEvent` is the explicit span lifecycle:

```ts
type TraceEvent =
  | { type: 'span-start'; trace: TraceRef; at: string; name: string; kind: AgentSpanKind }
  | { type: 'span-end'; trace: TraceRef; at: string; status: AgentSpanStatus }

type AgentSpanKind = 'invoke_agent' | 'chat' | 'execute_tool'
```

The ids follow the W3C shape used by Foundry: a 32-hex `traceId` and a 16-hex
`spanId`. `toolCallId` is kept as a separate `gen_ai.tool.call.id` attribute. This
matters when the model makes parallel calls to the same tool: correlation ids
describe provider calls, while distinct span ids describe distinct executions.
`buildTraceTree(events)` can project a partial or completed event list into
immutable nested spans for a GUI. `text-delta` and `reasoning-delta` point at the
chat span; tool events point at their execute-tool span. The loop does not invent
or expose hidden chain-of-thought — only reasoning content actually emitted by the
provider can appear in `reasoning-delta`.

Codex's `MessagePhase::Commentary` / `FinalAnswer` split is preserved on text
blocks and Responses wire replay. Providers that omit phase use the structural
fallback also demonstrated by deepseek-harness: text in a response that calls a
tool is commentary; text in a response without tool calls is the final answer.
The finalized `assistant-text` event additionally reports whether it appeared
before tools, after results, between tool rounds, or outside tool use. Setting
`commentary: 'concise'` appends a progress-narration instruction while explicitly
forbidding disclosure of private chain-of-thought.

```ts
export interface TurnHooks {
  /** Gate or enrich a step. This is where compaction hangs. */
  beforeStep?(ctx: BeforeStepContext): Promise<StepDecision> | StepDecision
  /** Recover from a request failure — return 'retry' after compacting. */
  onRequestError?(ctx: RequestErrorContext): Promise<'retry' | 'fail'> | 'retry' | 'fail'
  /** Await caller-owned durability immediately before an external side effect. */
  checkpoint?(ctx: CheckpointContext): Promise<void> | void
  /** Object to the turn ending; may append context to force another step. */
  onTurnEnd?(ctx: TurnEndContext): Promise<void> | void
}

export type CheckpointContext =
  | {
    kind: 'before-model-request'
    request: GenerateOptions             // exact request, including hook prepend
    snapshot: HistorySnapshot
  }
  | {
    kind: 'before-tool-dispatch'
    call: ToolCallRequest
    snapshot: HistorySnapshot             // contains assistant + tool intent
  }

export type StepDecision =
  | { kind: 'proceed'; prepend?: readonly Message[] }
  | { kind: 'reject'; reason: string }
```

`beforeStep` and `onRequestError` are exactly where deepseek-harness attaches
compaction — pressure before a step, overflow recovery on a request error — which
is the evidence that the seam is in the right place. **No compaction code goes in
the loop.**

The checkpoint is different from an event: the driver **awaits it**. On a model
checkpoint failure, the turn ends with a caller-controlled error. On a tool
checkpoint failure, the tool body does not run and the call receives a
`CHECKPOINT_FAILED` error result. Spike C proves the ordering. This lets the caller
write JSONL, SQLite, S3, or nothing at all without a storage interface in core.

Provider request logs are complementary diagnostics. The implemented
`createDailyJsonlRequestLogger()` records the exact serialized wire body at
`.providers/<provider>/logs/YYYY-MM-DD.jsonl`, with sensitive headers redacted.
It is best-effort and intentionally **not** a durability gate; history checkpoints
remain the crash-safety mechanism.

Implementation note: `runTurn` cannot `yield` from nested model/tool callbacks.
Drive the loop in a background promise and bridge it to the async iterator with a
capacity-one awaited event queue. That preserves consumer backpressure, lets
parallel tools publish approval events while the scheduler is active, and prevents
an unbounded event buffer when a caller reads slowly.

`onTurnEnd` intentionally cannot veto by return value: it appends context and the
loop re-checks, so listener order cannot change the outcome. Bounded by `maxSteps`
regardless, which is the guard deepseek-harness left as a TODO.

---

## 11. Other layers above the loop

### Sub-agent

```ts
export interface SubAgentOptions {
  readonly prompt: string | readonly ContentBlock[]
  readonly tools?: ToolFilter          // ToolRegistry.view() already supports this
  readonly config?: Partial<CallConfig>
  readonly outputSchema?: JsonObject
  readonly bounds?: Partial<TurnBounds>
}
export interface SubAgentResult {
  readonly text: string
  readonly structured?: unknown
  readonly reason: TurnEndReason
  readonly usage: TokenUsage
}
```

Isolation is **a fresh `History`**, not a scope trick. The parent sees only
`SubAgentResult`; the child's steps, tool calls, and dead ends never enter parent
history. Both harnesses do exactly this, and Codex additionally forces approvals off
in a child — a sub-agent must never be able to prompt the human. That rule is worth
copying.

### Deep execution modes (implemented)

`src/agent/mode/` owns bounded host continuation, the structural `submit_result`
completion gate, and `request_user_input`. It composes public `runTurn` hooks and
tools rather than copying the model/tool loop. A human request parks only its tool
call and resumes by provider call id; no polling or text parsing is involved.

### Workflow

Host-language coordination — plain `async` functions calling `runSubAgent` — rather
than a graph type or a sandboxed script realm. deepseek-harness runs
model-authored JavaScript in a worker thread, which needs an isolate this package
should not own. For an SDK the caller already *has* a host language.

---

## 12. Layout

```
src/agent/
├── tool/        ● definition · registry · errors · approval · staged pipeline
├── history/     ● entries · project · normalize
├── loop/        ● run-turn · schedule · bounds · events · hooks
├── mode/        ● basic · deep self-check · human input broker
├── trace/       ● identity · lifecycle events · process tree
├── subagent/    ▢ later
└── index.ts     ●
```

---

## 13. Build order

| # | Step | Unblocks | Verified by |
| --- | --- | --- | --- |
| 1 | `history/` + snapshot/hydration | everything | unit: projection, replace, pairing, round-trip |
| 2 | split tool pipeline into internal prepare/authorize/dispatch/finalize stages | safe scheduler | existing pipeline suite + stage-order unit |
| 3 | `loop/schedule.ts` | the loop | unit: ordering, grouping, checkpoint, abort drain |
| 4 | `loop/run-turn.ts` + capacity-one event bridge | real use | unit with a fake adapter |
| 5 | bounds + forced final answer | unattended safety | unit: both caps, repeat, errors, forced round |
| 6 | integration | live gate | live Codex, multi-step tools; inspect `.providers/codex/logs/` |
| 7 | Chat Completions protocol | compatible endpoints | protocol unit + mock SSE; optional live endpoint |
| 8 | `mode/` basic/deep/HIL | bounded autonomy + human decisions | fake adapter + live Codex for all three modes |
| 9 | neutral effort/native-tool/media contract | provider web search + image I/O | serializer/translator + loop event units |
| 10 | `subagent/` | delegation | unit + live |

Steps 1–6 are the deliverable "tool loop core". Step 7 is independent provider
compatibility after the live gate. Steps 8–9 are implemented; sub-agent isolation
is the remaining higher-level layer in this plan.

---

## 14. Decisions

### Settled by spike

1. **History substrate → append-only log.** Spike A, §1b, §5. Justified by
   compaction quality and request reconstruction; *not* by orphan detection, which
   the spike showed works either way. Reinforced by Spike B's 24:1 token ratio,
   which makes compaction the common path.

2. **`maxSteps: 16`, plus a new `maxToolCalls: 64`.** Spike B measured p90 = 5 steps
   on exploration work, and 16 tool calls inside 5 steps — so a step cap alone does
   not bound cost. Both are bounded; §8 records the headroom reasoning and states
   plainly that mutation work is unmeasured.

3. **Persistence → caller owns storage; core owns the safety boundary.** Spike C
   showed a versioned `HistorySnapshot` round-trips and an awaited checkpoint makes
   tool intent durable before a side effect. Do not add a storage backend interface
   to core. Do add `fromSnapshot()`, validation, and `hooks.checkpoint`; plain
   end-of-turn serialization is not crash-safe.

4. **Chat Completions → after the loop's live gate.** Spike D proved it fits the
   existing `WireProtocol` and `BlockAssembler` without core/loop changes, including
   parallel streamed calls. It loses Responses reasoning replay and needs real
   serializer/translator tests, so it is a compatibility feature rather than a
   prerequisite. Avoid categorical claims that named gateways are unusable without
   it; protocol support changes. The durable claim is that Chat Completions widens
   compatibility with endpoints that do not implement Responses.

5. **Sub-agent and rounds → after the loop runs live.** Build sub-agent first, then
   rounds. Both are thin consumers of `runTurn`; implementing them before the live
   gate would test copies of unproven seams. The gate is: one live multi-step tool
   turn plus fake-adapter coverage of abort, checkpoint failure, both budgets, and
   the forced-final request.

### Settled by design audit

6. **The existing tool pipeline needs internal staging before the scheduler.** Only
   the dispatch/body stage overlaps; argument parsing happens once, authorization
   stays model-ordered, and post-policy/finalization commits model-ordered. The
   public `dispatchToolCall()` remains unchanged as the composed convenience API.

7. **Budget termination uses one typed outcome.** `maxToolCalls`, repeated calls,
   and consecutive failures cannot truthfully surface as `max-steps`. Use
   `budget-exhausted` with a budget discriminator, synthesize results for declined
   calls, and reserve one bounded no-tools request for forced finalization.

8. **Provider-native tools are first-class content, not fake host functions.** The
   provider owns execution; core owns a neutral schema, stable call id, public
   result content, and opaque replay state. Progressive images are presentation
   events, while the final image lives in history. Unsupported provider/tool
   combinations fail as `INVALID_REQUEST` instead of silently dropping fields.

---

## 15. Method note

Two decisions had no prior art to copy — neither reference implementation caps
iteration — and one rested on an argument that turned out to be wrong. The spikes
produced a measured bound, a disproof, a crash-safety boundary, and a protocol-fit
result. The subsequent `.temp` audit found two implementation blockers before code
was written: pipeline staging and incomplete budget outcomes.

`spikes/` is kept in the repository as the evidence for §14, not as code to maintain.
No spike is imported by `src/`.
