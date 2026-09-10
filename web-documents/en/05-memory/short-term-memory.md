# Short-term Memory

Long-running tasks have two different continuity problems, and the SDK keeps them
separate:

- **Task memory** contains facts that must never disappear — the original
  objective, constraints, explicit decisions.
- **Context compaction** replaces older model-visible conversation with a
  structured checkpoint while preserving recent evidence verbatim.

A checkpoint is lossy by design. Pinned memory is **not part of the compactable
history span**.

## Defaults

Every `defineAgent()` definition enables both mechanisms unless configured
otherwise:

| Behaviour | Default |
| --- | --- |
| First real user message becomes `original-objective` memory | on |
| Memory prepended to each request as app-authored user context under `<task-memory>` | on |
| Automatic compaction checks pressure before each normal model step | on |
| Pressure threshold | 80% of the model context window |
| Retained verbatim tail | most recent 20% |
| Oversized tool-result text | pruned to a durable head/tail projection before summarization |
| Pressure backoff | 4 model steps when retained context alone exceeds the threshold, or the checkpoint saves too little |
| Provider-confirmed `CONTEXT_WINDOW_EXCEEDED` | may compact and retry once |
| Checkpoint call | inherits the conversation provider, model, and effort |

Memory retains at most 1,024 items, 65,536 characters per item, and 1 MiB of
content; at most 12,000 characters are injected into a request. History defaults
to 100,000 entries, 16 MiB per entry, and 128 MiB total.

> If an adapter does not report a context window, automatic pressure compaction
> is a **no-op** unless `maxInputTokens` is configured. Overflow recovery and
> manual `session.compact()` can still force a useful reduction.

## Configuration

```ts
const agent = defineAgent({
  id: 'migration-agent',
  instructions: 'Complete the migration and verify every change.',
  memory: {
    seed: [{ kind: 'constraint', content: 'Do not change the public HTTP API.' }],
  },
  compaction: {
    thresholdRatio: 0.8,
    retainRatio: 0.2,
    maxSummaryTokens: 4096,
    maxOverflowRetries: 1,
    maxToolResultChars: 24_000,
  },
})
```

Set `compaction: false` to disable checkpointing. Set
`memory.autoCaptureObjective: false` when the application supplies its own
objective memory.

## Explicit task memory

Memory is inspectable and host-controlled — the model cannot silently rewrite it.

> **Which session.** `.memory` is on the `defineAgent()` layer's
> `AgentSession`. The runtime layer's `RuntimeAgentSession` — what
> `runtime.agent().createSession()` returns — has no `.memory` accessor; bind a
> store there and read it back through a `defineAgent()` session, or keep task
> facts in your own state.

```ts
session.memory.remember({
  kind: 'decision',
  content: 'Use a transactional outbox for event delivery.',
})

session.memory.remember({
  id: 'release-constraint',
  kind: 'constraint',
  content: 'The release must remain backward compatible.',
})

session.memory.forget('release-constraint')
console.log(session.memory.items())
```

Supported kinds: `objective`, `constraint`, `decision`, `fact`, `progress`,
`next-step`. Reusing an id updates that item. Rendering is bounded and prioritizes
objectives, constraints, and decisions.

**Memory is deliberately not concatenated into the system prompt.** User-authored
objectives retain user authority instead of being promoted to developer/system
instructions.

## Compaction lifecycle

1. Measure the full next request — system memory, messages, and tools.
2. Select an old head span while retaining a recent tail.
3. Durably prune oversized tool-result text with Unicode-safe head/tail retention.
4. Move the boundary so a host tool call and its result are never split.
5. Append a durable `compaction-start` log record.
6. Run a **tool-disabled** summarization request with a structured handoff prompt.
7. Reject an empty, truncated, tool-calling, or non-shrinking summary.
8. Append `compaction-summary`, a replacement user checkpoint, then
   `compaction-end`.

The replacement uses exact surface seq targets. This matters after multiple
compactions: replacement seqs are append-only log identities and are **not**
necessarily a contiguous numeric range.

**The human transcript is never deleted.** `history.entries()` retains original
messages and lifecycle records; `history.messages()` returns only the current
model-visible projection.

## The structured handoff

The summarizer is instructed to preserve:

- primary request and evolving intent;
- completed work and evidence;
- decisions and rationale;
- constraints and user corrections;
- important files, symbols, commands, and errors;
- pending/current work and one concrete next step.

The file section distinguishes inspected and modified files and retains the exact
declarations needed next. `Current Work` records the latest successful tool action
and verification result; `Next Step` must be a direct edit or command instead of a
request to reread unchanged files.

This gives the resumed model an **executable working state**, not only a prose
reminder of the objective. Prior `<compacted-summary>` checkpoints are
consolidated rather than copied verbatim, preventing summaries from growing on
every generation.

## Manual compaction and GUI events

```ts
const result = await session.compact({ signal })
if (result !== null) {
  console.log(result.shadowedSeqs, result.estimatedTokensAfter)
}
```

Automatic compaction emits traced `compaction-start` and `compaction-end` events
through `session.stream()`, bracketed by a child trace span with kind `compact`.
A GUI can render these as maintenance nodes beside model and tool spans.

Completed events expose `thresholdTokens`, `estimatedNonCompactableTokens`, and
an optional `backoffReason` — `unreachable-threshold` or `low-savings`. These
fields make a misconfigured absolute threshold **visible** instead of causing a
silent compaction loop.

Pressure compaction is **fail-open**: a summarizer failure does not kill a healthy
request. Overflow recovery is stricter and returns `retry` only when the history
replacement generation actually advanced.

## Token estimation

The neutral SDK cannot bundle every provider tokenizer, so the default meter is a
conservative deterministic estimator over text, tool schemas, replay state, and
fixed image costs.

Policy uses the adapter's authoritative `contextWindow` when available and
**subtracts the effective model output reservation** before choosing the pressure
threshold. A model with a 128k combined window and a 32k output budget is
therefore never treated as having 128k available for input. The checkpoint
request is also capped to the summarizer model's declared hard output limit.

Applications needing exact pricing can set an absolute `maxInputTokens`. Future
tokenizer backends can replace the meter without changing history or session
contracts.

## Read next

- [Persistent Memory](/en/05-memory/persistent-memory) — snapshots and resume
- [Performance](/en/10-advanced/performance) — every bound and budget
