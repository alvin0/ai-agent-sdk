# Budgets, limits, usage accounting, spill

## The run report every run produces

```ts
interface RunReport extends RunTerminalRecord {
  readonly delivery: ObservationDeliverySummary
}

interface RunTerminalRecord {
  readonly kind: 'run-terminal-record'
  readonly runId: string
  readonly traceId: TraceId
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly status: OperationStatus          // 'success' | 'error' | 'aborted' | 'rejected' | 'unknown'
  readonly usage: RunUsageReport
  readonly modelCalls: readonly ModelCallReport[]
  readonly toolSourceSnapshots: readonly ToolSourceRunReference[]
  readonly operationCounts: Readonly<Record<TrackedOperationKind, RunOperationCounts>>
  readonly errors: readonly SupportSafeError[]
}
```

`report.status === 'success'` is **execution** status. Objective completion is
`response.completed` — see references/streaming.md.

## Missing usage stays missing

```ts
type UsageCoverage = 'complete' | 'partial' | 'estimated' | 'missing' | 'not-applicable'
type DispatchState = 'not-sent' | 'sent' | 'unknown'

interface UsageCounters {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}
```

Every counter is optional on purpose: a number a provider did not report is
**absent**, never a fabricated zero. A budget that cannot be measured says so
instead of quietly passing.

Each physical attempt carries its own report, so a retried logical call shows
what each attempt actually cost:

```ts
interface AttemptUsageReport {
  readonly attemptId: string
  readonly attemptNumber: number
  readonly status: OperationStatus
  readonly dispatchState: DispatchState     // 'unknown' is why billing can be uncertain
  readonly coverage: UsageCoverage
  readonly reported: UsageCounters
  readonly estimated?: UsageCounters
  readonly origin?: string                  // scheme + host + non-default port, no path/query
  readonly httpStatus?: number
  readonly providerRequestId?: string
  readonly error?: SafeErrorRecord
}
```

### Choosing what missing usage means

`UsagePolicy`, `UsageEstimator`, `RunLedgerLimits` and `AgentRuntimeLimits` are
exported from `@alvin0/ai-agent-sdk-core/agent`, not the root facade.

```ts
interface UsagePolicy {
  readonly onMissing?: 'warn' | 'estimate' | 'fail'   // default: warn
  readonly estimator?: UsageEstimator
  readonly estimateTimeoutMs?: number                  // default 30,000; cancellation wins
}

const session = agent.createSession({ usagePolicy: { onMissing: 'estimate', estimator } })
```

An estimate is labelled `coverage: 'estimated'` — it never masquerades as
reported truth.

## Embedding accounts at three levels

One call to `embed()` or `embedMany()` can become several requests, and a
request can be attempted more than once. Those are three different things, and
embedding usage names all three rather than collapsing them into "a call":

| Level | What it is | Where it shows up |
| --- | --- | --- |
| `Logical_Call` | One `embed()` or `embedMany()`, however many inputs it carries | The `usage` on `EmbeddingResult` / `EmbeddingManyResult` |
| `Physical_Batch` | One group of items after splitting under the batch bounds | `batches`, `batchesWithUsage` |
| `Provider_Attempt` | One `embedBatch()` call on the adapter, retries included | `providerAttempts` |

The runtime owns retry, and an adapter performs exactly one attempt per
`embedBatch()`. That is what makes the third level countable: the attempts a
caller was billed for equals the number of times the runtime called the adapter.
A batch that succeeded is never re-sent by a later retry pass of the same
logical call. Embedding also holds a lease under the `'embedding-call'` runtime
operation kind, so `runtime.close()` reports it beside `'agent-run'`.

```ts
interface EmbeddingUsageReport {
  readonly status: 'complete' | 'partial' | 'missing'
  readonly tokens?: EmbeddingTokenUsage     // present ONLY when status === 'complete'
  readonly batches: number                  // dispatched; cache hits are not batches
  readonly batchesWithUsage: number
  readonly providerAttempts: number
  readonly inputsFromCache: number
  readonly inputsFromProvider: number
}
```

`inputsFromCache + inputsFromProvider` equals the input count by construction —
both are derived from the same evidence rather than kept in step by hand.

### The status is coverage of the batches that were sent

| `status` | When | `tokens` |
| --- | --- | --- |
| `complete` | Every dispatched batch returned readable usage | Published |
| `partial` | At least one batch reported readable usage, at least one did not | Absent |
| `missing` | No dispatched batch reported readable usage — including a call served entirely from cache, which reports `batches: 0` | Absent |

A cache-only call reporting `missing` is deliberate: it did not incur a cost, so
claiming complete knowledge of one would be a different lie from the usual.
`totalTokens` is summed only when **every** readable batch reported one, because
a partial sum of totals understates the call.

Absence is also said out loud, per batch:

| Warning code | Meaning |
| --- | --- |
| `usage-unreported` | The batch was dispatched and came back with no usage at all |
| `usage-malformed` | Usage arrived but could not be read as embedding token counts |

A counter past `Number.MAX_SAFE_INTEGER` is treated as unreadable, not as a
large number — precision lost is authority lost, so it may not enter a published
total. Gemini's `batchEmbedContents` reports no usage by design, so a Gemini call
routinely lands on `missing` plus one `usage-unreported` per batch. That is the
honest report, not a defect.

### `EmbeddingTokenUsage` is not `TokenUsage`

```ts
interface EmbeddingTokenUsage {
  readonly inputTokens: number      // required
  readonly totalTokens?: number
}
```

There is no `outputTokens`, and embedding does not reuse `UsageCounters` or
`validateUsageCounters` to fake one. Those treat a report as `complete` only once
`outputTokens` is present, which for embedding could be satisfied only by
inventing a `0` — and a fabricated zero is indistinguishable from a provider that
charged nothing. Reusing the generation shape without the zero would instead
leave every embedding report permanently short of `complete`, making the signal
meaningless. So embedding has its own counter shape, `inputTokens` required and
`totalTokens` optional, and a report with an unreadable input bucket publishes
nothing at all.

### Batch bounds and concurrency

`EmbeddingModelOptions` carries `batchLimits` and `concurrency`; the bounds
resolve **override → catalog → default**, so they are always finite and a model
id outside the catalog is still batchable rather than rejected:

```ts
const EMBEDDING_BATCH_DEFAULTS = { maxItems: 96, maxTokens: 100_000, maxBytes: 1024 * 1024 }
```

An `unknown` catalog capability feeds batching but never validation — batching
needs a finite ceiling or one logical call's memory is unbounded, while an
undeclared capability is not a reason to refuse a request. `estimateTokens` is
one shared heuristic, `ceil(utf8Bytes / 4)` by default, used both to split
batches and to check an input against a declared `maxInputTokens`; a single owner
is why a split and a length check can never disagree about the size of the same
text. An adapter with a closer estimator passes it through
`limits.estimateTokens`.

## Turn and run limits

Definition-level:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxTurns` | 16 | Model steps per prompt; `'auto'` removes the step ceiling, not resource limits |
| `maxToolCalls` | 64 | Dispatched tools |
| `maxTokens` | model default | Output ceiling for one call |

Session-level `runtimeLimits: AgentRuntimeLimits` is where the rest lives:

```ts
{
  teardownTimeoutMs, modelTimeoutMs,
  maxModelRequestBytes, maxModelResponseBytes, maxModelStreamEvents,
  maxToolResultBytes, maxToolDurationMs, toolTeardownTimeoutMs,
  maxParallelToolCalls,                      // caps simultaneous concurrency-safe calls
  maxConsecutiveToolErrors,
  repeatToolWarningAt, repeatToolLimit,      // loop guards
  toolCycleWarningAt, toolCycleLimit, maxToolCycleLength,
  maxToolResultTokens,                       // default 10,000
  toolResultOverflow,                        // 'auto' | 'truncate' | 'spill'
  onExhausted,                               // 'force-final-answer' | 'stop' | 'continue'
  maxTotalTokens,                            // 'auto' by default: no aggregate ceiling
  finalReportReserveTokens,                  // headroom for one tools-disabled report
  hookTimeoutMs, hookTeardownTimeoutMs,
  memoryOperationTimeoutMs,
  observerTimeoutMs,                         // default 30,000
}
```

`onExhausted: 'continue'` turns a spent tool-call budget into a notice rather
than a wall, leaving the turn bounded by steps, tokens, and the run ledger.
Long research runs and team leads want it, because for them the useful call is
usually the last one.

`maxTotalTokens` as a number sets a hard stop across normal rounds (retries and
finalizers included) but excludes compaction; summary calls use compaction
limits and still appear in the report.

At **75%** of `maxToolCalls` the loop injects one warning before the next model
step — see references/context-and-instructions.md.

## Oversized tool output: truncate or spill

```ts
type ToolOutputOverflowPolicy = 'auto' | 'truncate' | 'spill'
```

- `auto` (default) — spill when a store is mounted, truncate when none is.
- `truncate` — always cut the middle; needs no store.
- `spill` — save the full text, show a preview; falls back to truncating when
  no store is mounted or the store fails, because losing the result entirely is
  worse than shortening it.

Mounting a store also registers `read_tool_output`, so the model can read back
what left its context:

```ts
import { createMemorySpillStore } from '@alvin0/ai-agent-sdk-core/agent'   // also on /tools

const session = agent.createSession({ spillStore: createMemorySpillStore() })
```

```ts
interface SpillStore {
  save(text: string, context: { readonly toolName: string; readonly callId: string })
    : Promise<SpillRecord> | SpillRecord
  read(locator: string, range: { readonly offset: number; readonly limit: number })
    : Promise<SpillSlice | undefined> | SpillSlice | undefined
  search(locator: string, pattern: string, limit: number)
    : Promise<readonly string[] | undefined> | readonly string[] | undefined
}

interface SpillRecord {
  readonly locator: string    // opaque handle, also shown to the model
  readonly bytes: number
  readonly retrieval: string  // one sentence telling the model how to get the rest
}
```

The port is deliberately tiny because core is Universal and cannot open a file.
`retrieval` is written by the backend, since only it knows what the locator *is*
— a file a shell can grep, or a handle only the built-in tool resolves.

Per-tool ceilings still apply: `maxOutputTokens` on a `ToolDefinition`, and the
stricter of that and the turn budget wins. `budgetExempt: true` exempts a call
from the turn's tool-call budget and loop guards — for calls that END work.

## Event queue backpressure

```ts
interface AgentRunEventBufferLimits { readonly maxEvents?: number; readonly maxBytes?: number }
```

A slow or paused consumer is bounded rather than allowed to grow the queue
without limit.
