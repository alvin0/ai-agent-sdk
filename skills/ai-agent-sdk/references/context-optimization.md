# Context optimization and exact evidence

Opt-in additions in 0.1.5, currently unreleased. Use current typings or packed workspace
artifacts. These helpers are optional and remain portable across Node, browsers,
and Workers; the host supplies persistence, log interpretation, and models.

## One optimizer per conversation

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
  id: 'research', model, instructions: 'Read retained observations when needed.',
  tools: [searchTool, optimizer.retrievalTool],
})
const session = agent.createSession({ hooks: optimizer.wrapHooks(applicationHooks) })
```

`archiveStore`, model, ordinary tools, and application hooks are host-owned.
Mount the retrieval tool explicitly. Wrap existing hooks rather than replacing
them. The projection changes model requests, not raw history/checkpoint snapshots.
Application redactions/rejections stay effective; queued steering arrives before
projection and normal compaction.

An observation over 10 KiB receives two full prepared requests before a roughly
1 KiB preview is eligible. Independent tool-output budgets can truncate it
earlier, so configure those budgets to retain the initial evidence you need.
Bytes measure eligibility; retrieval offsets measure Unicode code points.
Lost stores, insufficient evidence capacity, or failed reduction leave full text.
`metrics()` reports prepared-context estimates, not billed token savings.

## Verified milestones

Only the host decides that a subtask has completed. After it does, take the
inclusive history boundary from `session.snapshot().history.entries`:

```ts
const snapshot = session.snapshot()
optimizer.completeMilestone({
  id: 'inventory', throughSeq: snapshot.history.entries.at(-1)!.seq,
  summary: 'Inventory read; no files changed. Preserve ACL constraints.',
  remainingTurns: 4, compactionCost: 0,
})
```

The summary must preserve constraints and evidence needed later. Projection
requires successful archival and positive estimated reuse savings. Include
summary/reducer cost in comparable units. Tool success alone is not milestone
completion. Changing/removing source messages invalidates their summaries.

## Reducers

`createModelEvidenceReducer({ generate })` invokes the host-selected extractor.
Forward its signal, set an application timeout, disable extractor tools, and
account for its usage separately. Supply `log(toolName, text)` on the optimizer
to identify eligible logs and return authoritative `status`/`requiredLines`.

The candidate must preserve host status and exact, increasing `{ line, text }`
evidence. Original lines are reconstructed only after validation. Omitted evidence,
changed text/status, malformed JSON, provider error, oversized output, or no
savings falls back to the full original. Unknown log formats are not presumed
complete; provide required lines for the host's format. `reduceEvidence` and
`diagnosticLineNumbers` can also serve deterministic extraction.

## Lifecycle

Controllers cannot be shared across conversations/concurrent preparations.
On conversation end call `optimizer.dispose()`; reset/resume uses a fresh
controller and scoped store. Optimizer state is ephemeral and rebuilt from raw
history, so resumed observations may be sent in full again. Disposal cancels
cooperative work; the store still owns cleanup and completion of its writes.

For mutation-plus-validation flows, `defineActionFusion` returns a tool/grant
pair for an exclusive program pipeline. Read [tools.md](tools.md) before using
it: child calls share root policy/budget and completed mutations are not rolled
back when a later step fails.
