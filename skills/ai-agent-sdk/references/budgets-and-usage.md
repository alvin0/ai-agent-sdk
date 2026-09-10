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
