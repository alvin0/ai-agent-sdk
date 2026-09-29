# Context optimization

These are opt-in additions in **0.1.5**, currently unreleased. Use current
workspace typings or packed artifacts until that version is published to npm.
Automatic pressure compaction and immediate tool-output budgets remain separate.

## Pack repeated observations

Create one controller and one scoped store per conversation. The host supplies
the archive backend, model, ordinary tools, and application hooks in this example:

```ts
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'
import { createMemorySpillStore } from '@alvin0/ai-agent-sdk-core/tools'

const optimizer = createContextOptimizer({
  store: createMemorySpillStore(),
  archive: async (snapshot, milestone, signal) => {
    await archiveStore.save(milestone.id, snapshot, signal)
  },
})
const agent = runtime.agent({
  id: 'research', model,
  instructions: 'Use read_tool_output when retained evidence is needed.',
  tools: [searchTool, optimizer.retrievalTool],
})
const session = agent.createSession({ hooks: optimizer.wrapHooks(applicationHooks) })
```

Mount the retrieval tool explicitly. `wrapHooks` preserves application hooks,
redactions, rejection, prepend, and projection. It changes model requests,
not raw append-only history or checkpoint snapshots. Queued steering is delivered
before regular compaction and projection hooks.

| Default | Meaning |
| --- | --- |
| 10 KiB eligibility | UTF-8 size of an observation, not token count |
| Two full requests | Full observations are initially exposed in prepared requests |
| Approximately 1 KiB preview | Later requests can use a preview and retrieval locator |
| 64 observations / 128 milestones | Controller capacity bounds |

Required diagnostics/failure evidence must fit; otherwise text stays full.
Lost stores, failed reducers, and capacity limits also retain full text.
Independent tool-output budgets may spill/truncate earlier; configure them to
allow the initial observations you need. Retrieval offsets use Unicode code
points. Prepared-request counts include retries/final requests, not only
successful provider delivery. `metrics()` is an estimate, not billing evidence.

## Archive completed milestones

The host verifies completion and supplies an inclusive history boundary:

```ts
const snapshot = session.snapshot()
optimizer.completeMilestone({
  id: 'inventory', throughSeq: snapshot.history.entries.at(-1)!.seq,
  summary: 'Inventory read; no files changed. Preserve ACL constraints.',
  remainingTurns: 4, compactionCost: 0,
})
```

The archive must succeed before a projection is accepted. Estimated net token
savings, including summary size and expected reuse, must justify compaction
cost. Include model/archive costs in comparable units where appropriate.
Tool success alone does not establish milestone completion. Later source
redactions/removals invalidate summaries built from those messages.

## Reduce exact log evidence

Mount `createModelEvidenceReducer({ generate })` as `reducer` and supply the
optimizer's `log(toolName, text)` callback with authoritative `status` and
`requiredLines`. The host chooses the extractor model, disables its tools,
forwards cancellation, sets its timeout, and records its usage separately.

Logs over 4 KiB can be eligible. Candidate `{ line, text }` evidence must be
strictly increasing, preserve host status, and match original lines exactly.
Core reconstructs original evidence after validation. Malformed output,
missing evidence, changed status/text, provider failure, oversized results, or
no savings falls back to the full original. Unknown formats need a host parser;
generic diagnostic rules cannot prove every log semantically complete.
`reduceEvidence` and `diagnosticLineNumbers` also support deterministic extraction.

## Conversation lifecycle

Call `optimizer.dispose()` when the conversation ends. Reset/resume uses a
fresh controller and store scope; state is ephemeral and safely rebuilt from
raw history. Do not share controllers across conversations or concurrent
preparations. Disposal cancels cooperative work; the backend owns completion
and cleanup of its writes.

Read [upgrading from 0.1.4](/en/01-introduction/upgrading-from-0-1-4),
[program tools](/en/12-experimental/programmatic-tools), and the full
[application guide](https://github.com/alvin0/ai-agent-sdk/blob/main/docs/context-optimization.md)
for action fusion, reducer examples, and validation commands.
