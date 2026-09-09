# Performance

Every threshold below is host-configurable and defaults to a value that is safe
for unattended SDK use.

## Loop bounds

Set on an agent definition:

```ts
runtime.agent({
  id: 'worker',
  model,
  instructions: '…',
  maxTurns: 16,        // model steps
  maxToolCalls: 64,    // dispatched tools
  maxTokens: 16_384,   // per-response output ceiling
})
```

| Bound | Default | Exhaustion behaviour |
| --- | --- | --- |
| Model steps | 16 | Reserves one tool-disabled final answer. |
| Dispatched tools | 64 | Reserves one tool-disabled final answer. |
| Aggregate reported tokens | 500,000 | **Stops immediately** — the safety budget must not spend itself explaining that it was reached. |

At **75% of `maxToolCalls`** the loop injects one app-authored budget warning
before the next model step, so a long coding agent can stop broad exploration and
reserve calls for edits and verification.

`maxTokens` is checked against the model's hard output ceiling **before** provider
I/O and fails with `OUTPUT_TOKEN_LIMIT_EXCEEDED` rather than a provider 400.

## Session runtime limits

```ts
const session = agent.createSession({
  runtimeLimits: {
    maxSteps: 16,
    maxToolCalls: 64,
    maxConsecutiveToolErrors: 3,
    maxTotalTokens: 250_000,
    observerTimeoutMs: 5_000,
    repeatToolWarningAt: 3,
    repeatToolLimit: 6,
    toolCycleWarningAt: 2,
    toolCycleLimit: 3,
    maxToolCycleLength: 4,
    maxToolDurationMs: 120_000,
    toolTeardownTimeoutMs: 10_000,
  },
})
```

| Group | Purpose |
| --- | --- |
| `repeatTool*` | Exact-repeat detection — warn, then stop. |
| `toolCycle*`, `maxToolCycleLength` | Short multi-step cycle detection. |
| `maxConsecutiveToolErrors` | Consecutive-error cutoff. |
| `maxToolDurationMs` | Cooperative wall-clock bound per tool call. |
| `toolTeardownTimeoutMs` | How long teardown waits after abort before reporting `MODEL_TEARDOWN_TIMEOUT`. |
| `observerTimeoutMs` | Bound on host observer callbacks. |

## History limits

```ts
const session = agent.createSession({
  historyLimits: {
    maxEntries: 20_000,
    maxBytes: 128 * 1024 * 1024,
  },
})
```

| Limit | Default |
| --- | --- |
| Entries | 100,000 |
| Bytes per entry | 16 MiB |
| Total bytes | 128 MiB |

## Memory limits

| Limit | Default |
| --- | --- |
| Items retained | 1,024 |
| Characters per item | 65,536 |
| Total content | 1 MiB |
| Characters injected per request | 12,000 |

Restore paths validate limits **before publication** and canonicalize only the
documented fields.

## Compaction

```ts
runtime.agent({
  compaction: {
    thresholdRatio: 0.8,
    retainRatio: 0.2,
    maxSummaryTokens: 4096,
    maxOverflowRetries: 1,
    maxToolResultChars: 24_000,
  },
})
```

| Option | Default | Effect |
| --- | --- | --- |
| `thresholdRatio` | `0.8` | Pressure threshold as a fraction of the usable context window. |
| `retainRatio` | `0.2` | Recent tail kept verbatim. |
| `maxSummaryTokens` | — | Checkpoint output ceiling, further capped by the summarizer model's hard limit. |
| `maxOverflowRetries` | `1` | Provider-confirmed `CONTEXT_WINDOW_EXCEEDED` recoveries. |
| `maxToolResultChars` | — | Oversized tool-result pruning threshold. |

Set `compaction: false` to disable checkpointing entirely.

> The usable window is the model's `contextWindow` **minus** the effective output
> reservation. A 128k combined window with a 32k output budget is never treated
> as 128k of input.
>
> If an adapter reports no context window, automatic pressure compaction is a
> no-op unless `maxInputTokens` is configured.

## Skill limits

| Limit | Default |
| --- | --- |
| `maxCatalogChars` | 8,000 |
| `maxSearchResources` | 32 |
| `maxSearchInputChars` | 200,000 |

Returned text from `read_skill_resource` and `search_skill_resources` is
hard-bounded; large resources are exposed as chunks.

## Usage policy when data is missing

```ts
const session = agent.createSession({ usagePolicy: { onMissing: 'warn' } })
```

| Policy | Behaviour |
| --- | --- |
| `warn` (default) | Continue, emit a critical missing-usage diagnostic. |
| `estimate` | Enforce the budget with a configured estimator, labelled estimated. |
| `fail` | Stop before the next model call. |

A total-token guard cannot enforce an exact limit if a provider omits usage, so
the policy makes that explicit rather than pretending.

## Runtime and close deadlines

```ts
await createAgentRuntime({
  providers,
  startupTimeoutMs: 10_000,
  closeTimeoutMs: 30_000,
  diagnosticMaxEvents: 1_000,
  diagnosticMaxBytes: 1_048_576,
})
```

`close()` returns `quiescenceEnd` (`settled` / `timeout` / `caller-abort`) and
`unsettledRuns`. Treat `unsettledRuns > 0` as a defect, not noise.

## Read next

- [Short-term Memory](/en/05-memory/short-term-memory) — compaction in detail
- [Tool Execution](/en/03-tools/tool-execution) — concurrency and timeouts
- [Production Deployment](/en/10-advanced/production-deployment)
