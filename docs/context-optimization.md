# Configurable context and tool optimization

This guide describes opt-in additions introduced in **0.1.5**.
Check the installed package typings when adopting these helpers.
For existing applications, see [upgrading from 0.1.4](upgrading-from-0.1.4.md).

These APIs are opt-in application building blocks in `@alvin0/ai-agent-sdk-core`.
Existing sessions keep their current behavior. No provider, model price, shell
command, source extension, or test framework is assumed by core. The core stays
portable across Node, browsers, and Workers.

## Fuse an edit and its validation

```ts
import { defineActionFusion } from '@alvin0/ai-agent-sdk-core/tools'

const fusion = defineActionFusion<{ patch: string }>({
  name: 'edit_and_test',
  description: 'Apply a patch, then run the application-selected validation.',
  parameters: {
    type: 'object', properties: { patch: { type: 'string' } },
    required: ['patch'], additionalProperties: false,
  },
  parse(raw) {
    if (typeof raw !== 'object' || raw === null
      || !('patch' in raw) || typeof raw.patch !== 'string') throw new TypeError('patch required')
    return { patch: raw.patch }
  },
  steps: [
    { tool: 'apply_patch', arguments: args => ({ patch: args.patch }) },
    { tool: 'run_validation', arguments: (_args, previous) => ({ editReceipt: previous[0] ?? null }),
      accept: value => typeof value === 'object' && value !== null
        && 'exitCode' in value && value.exitCode === 0 },
  ],
})

// applyPatch and runValidation are your ordinary SDK tool definitions.
const agent = runtime.agent({
  id: 'editor', model: { provider: 'your-provider', id: 'your-model' },
  instructions: 'Use edit_and_test for source edits.',
  tools: [fusion.tool, applyPatch, runValidation],
})
const session = agent.createSession({ experimentalPrograms: [fusion.grant] })
```

To trigger validation on every call to your public edit API, give the fused tool
that API's name and register the actual mutation under a distinct child name.
The second step runs automatically in the same scheduler execution, without an
intermediate model observation. Applications choose validation arguments based
on the edit receipt; SDK never infers or executes a command from prose intent.

Fusion uses the existing **experimental** nested-tool scheduler. The outer call
and non-exempt children spend the same root budget; each child passes through
policy, approval, checkpointing, cancellation, timeout, and post-policy output
handling. Pipelines are exclusive and sequential. They stop on denied/failed
children or a rejected success predicate. Their JSON contains `ok`,
`completedSteps`, receipts in `results`, and any failed step. A successfully
executed pipeline can return `ok: false`; inspect that field for workflow success.
Already completed edits remain committed when validation fails. There is no
transactional rollback or automatic replay of mutations. A durable execution
interceptor can still provide host-selected operation identities for each child.
Argument mapping and acceptance callbacks are synchronous. Returning a Promise
fails the step; its rejection is observed to avoid crashing JavaScript hosts.

## Pack repeated observations and compact completed milestones

```ts
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'
import { createMemorySpillStore } from '@alvin0/ai-agent-sdk-core/tools'

// Create one controller and one scoped store for EACH conversation.
const optimizer = createContextOptimizer({
  store: createMemorySpillStore(),
  // The host implements persistence. Core does not open files.
  archive: async (rawSnapshot, milestone, signal) => {
    await localLog.save(milestone.id, rawSnapshot, signal)
  },
})
const agent = runtime.agent({
  id: 'research', model: { provider: 'your-provider', id: 'your-model' },
  instructions: 'Use read_tool_output for retained observation chunks.',
  tools: [searchTool, optimizer.retrievalTool],
})
const session = agent.createSession({ hooks: optimizer.wrapHooks(applicationHooks) })

// Your plan/task coordinator supplies verified state and an actual log boundary.
const snapshot = session.snapshot()
optimizer.completeMilestone({
  id: 'inventory-read', throughSeq: snapshot.history.entries.at(-1)!.seq,
  summary: 'Read inventory; identified auth.ts; no files changed. Preserve ACL constraints.',
  remainingTurns: 4, compactionCost: 0,
})
```

Use the history snapshot's inclusive `seq` after the sub-task completes.
The initial user message and application-owned context sections are protected.
Tool calls and results must form complete pairs. An incomplete range, an archive
failure, a future sequence boundary, or an uneconomic summary leaves the original
context in place. Consecutive milestones can summarize consecutive ranges.
Normal pressure compaction can run alongside this controller; when it shadows a
range, its persisted summary takes ownership of that range.

The ROI check uses **net tokens removed**, including the replacement summary:

```text
compactionCost < (estimatedHistoryTokens - estimatedSummaryTokens)
                  * remainingTurns * historyTokenCost
```

Costs must use the same units. Defaults treat one history token as one cost unit.
For a free host-authored checkpoint summary, use `compactionCost: 0`. For a model
summary, include input and output costs and relative model prices in your
estimate. The host owns summary correctness, remaining-turn estimates, and plan
completion; core does not equate a tool success with completion of a plan step.
Archive succeeds before the projection is accepted. The raw append-only history
and checkpoint snapshots remain unchanged.

Observation defaults are **10 KiB**, two full prepared model requests, then an
approximately **1 KiB** preview with a `read_tool_output` locator. The threshold
uses UTF-8 bytes. Retrieval offsets and limits use Unicode code points, as in
the existing spill API. The saved text is the finalized, post-policy text the
model was allowed to see. Images and other blocks stay intact. Retrieval output
is not packed recursively. Diagnostic/status lines and the complete failure
tail are retained; if required evidence cannot fit the preview, output stays
full. Failed/expired stores and controller capacity limits also leave text full.

Mount the returned retrieval tool yourself. Do not also expect the immediate
output budget to preserve two full requests: that independent safety ceiling can
spill/truncate a larger result immediately. Set your tool-result token/byte
budgets to allow the initial observations you want to retain.

`wrapHooks()` runs application hooks first, honors rejection/projection/prepend,
and counts exposure after a successful application checkpoint. The count is of
prepared requests, including retry/final requests, rather than successful
provider delivery. `metrics()` reports prepared-context estimates, never billed
token savings. Defaults retain at most 64 observations and 128 milestone IDs.
The caller owns store TTL/retention and authorization. Call `dispose()` when the
conversation ends; dispose/reset/resume require a fresh controller and store
scope. Optimizer state is ephemeral; a resumed session can safely rebuild from
raw history and receive initial observations again.

Controllers reject concurrent preparations and reuse with a different history.
Disposal cancels cooperative reducer/archive work and prevents pending backend
operations from publishing projection state. Store backends still own completion
and cleanup of their own writes. Milestone summaries are invalidated when the
application changes or removes the messages they summarize, including redaction
with unchanged message IDs. Late user steering remains at the request tail;
history replacement reconciles the current surface while preserving application
redactions on surviving messages.
Queued steering is delivered before both regular compaction and application
projection hooks. An internal projection-source identity prevents input that a
hook deliberately filtered from being reinserted as unseen late steering.
Each preparation has its own identity baseline, including when applications
reuse the same frozen projection decision across parallel sessions.

## Offload logs to a selected model, then verify exact evidence

```ts
import { createModelEvidenceReducer } from '@alvin0/ai-agent-sdk-core/tools'

const reducer = createModelEvidenceReducer({
  generate: async ({ system, prompt, signal }) => {
    // A fresh, tools-disabled session on an application-selected inexpensive model.
    const result = await cheapExtractor.createSession().run(system + '\n' + prompt, { signal })
    recordReducerUsage(result.usage) // Keep reducer cost in your application's ledger.
    return result.text
  },
})
const optimizer = createContextOptimizer({
  store: conversationStore,
  reducer,
  log: (toolName, text) => toolName === 'run_validation'
    ? { status: parseAuthoritativeExitStatus(text), requiredLines: parseRequiredEvidenceLines(text) }
    : undefined,
})
```

Use a JSON response schema for the extractor when your chosen model supports it;
the runnable consumer in `test-human/context-optimization/run.ts` demonstrates
that configuration. No model output is trusted as free-form summary prose. The
candidate must report the exact host-supplied status and strictly increasing
`{ line, text }` entries. Core checks every selected line against its original
index and text and reconstructs the compact observation from original lines.
All recognized diagnostic/status lines, nearby context, the complete failure
tail, and host-required evidence lines must be selected. An unknown log format
with no identified evidence is not reduced. The host parser should mark required
lines for its own test/build format; generic rules cannot establish semantic
completeness for every application log.

Logs over **4 KiB** are eligible only when the host `log` callback identifies
them and a reducer is mounted. Observations over 10 KiB still receive their two
initial full requests first. A reducer is attempted once per retained output.
Malformed JSON, changed status/text/line numbers, omitted evidence, provider
failure, oversized input/output, and summaries with no savings all fall back to
the full original on this and later requests. Logs remain retrievable in full.
Model input/output defaults are bounded at 256/64 KiB. Forward cancellation and
configure a model timeout in the application callback; the enclosing SDK hook
also enforces its existing timeout/teardown policy.
Its deadline is forwarded to hook callback signals so cooperative model or
archive work can stop without cancelling the parent conversation. Host status
and required line numbers are captured before asynchronous storage/reduction;
invalid runtime labels or required line numbers are rejected before model use.

Offloading itself consumes tokens. Choose its model and eligibility based on
expected reuse and price; a one-off log can be cheaper to send unchanged.
`diagnosticLineNumbers()` and `reduceEvidence()` also support a deterministic
extractor when a model call would not be economic.

## Reproduce validation

```sh
pnpm --filter @alvin0/ai-agent-sdk-core build
pnpm exec vitest run tests/unit/action-fusion.spec.ts tests/unit/context-optimization.spec.ts tests/unit/context-optimization-edge.spec.ts
node --experimental-strip-types test-human/context-optimization/run.ts --output /tmp/sdk-optimization
# Optional real provider; uses the SDK's local Codex credential store.
node --experimental-strip-types test-human/context-optimization/run.ts --output /tmp/sdk-optimization-live --live
# Real primary-model requests with paging, milestone recall/resume and reducer fallback.
node --experimental-strip-types test-human/context-optimization/lifecycle-live.ts --output /tmp/sdk-optimization-lifecycle
# Isolate checkpoint recovery and steering that supersedes the retained original objective.
node --experimental-strip-types test-human/context-optimization/lifecycle-live.ts --output /tmp/sdk-steering-live --case checkpoint-retry-steering-supersedes-original-objective
```

The local script uses actual temporary files and subprocess tests and retains raw
milestone logs. Its scripted model validates lifecycle/observation mechanics;
its optional live mode separately records provider usage. A single paired live
smoke is functional evidence, not a broad model-quality or cost benchmark.
