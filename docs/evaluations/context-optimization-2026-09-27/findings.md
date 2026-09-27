# SDK context/tool optimization validation

Implemented four configurable application-facing capabilities in core:

1. `defineActionFusion`: sequential child calls under the existing experimental
   root scheduler, with one combined observation and explicit partial receipts.
2. `createContextOptimizer.completeMilestone`: host-verified checkpoints, net
   token ROI, complete tool pairs, protected initial/app context, and archive
   before model-only projection.
3. Observation packing: UTF-8 threshold, two full prepared requests, cached
   preview and retrievable post-policy originals, bounded per-session state.
4. `createModelEvidenceReducer` / `reduceEvidence`: host-selected model callback,
   exact source-line verification, authoritative status, required diagnostics and
   failure-tail retention, deterministic reconstruction, and raw fallback.

The guide is [docs/context-optimization.md](../../context-optimization.md).
Core stays universal; no provider, command, filesystem, or framework is selected
implicitly. The existing immediate output budget remains an independent safety
ceiling. Applications mount the returned retrieval tool and configure their
budgets for the initial full observations.

## Evidence retained

`report.json` contains a scripted control and one retained paired live smoke
using `codex:gpt-6-luna`. Each arm edited an actual temporary `.cjs` file exactly
once and ran an actual Node subprocess assertion exactly once. The two arms
were instructed to use their respective exposed workflow; this tests integration
and accounting, not unbiased model preference for fusion.

| Measurement | Atomic/full | Fused/packed | Evidence scope |
| --- | ---: | ---: | --- |
| Scripted workflow model requests | 3 | 2 | Real SDK scheduler, scripted model |
| Live workflow model requests | 3 | 2 | Real Codex provider |
| Live workflow observations | 2 | 1 | Real Codex provider |
| Live reported total tokens | 1,172 | 827 | One paired smoke, authoritative usage |
| Serialized observation request bytes | 27,594 | 1,682 | Third request; local projection |
| Reducer log bytes | 6,605 | 225 | Real model proposal, verified exact lines |

The retained live pair used approximately 29.4% fewer total reported tokens for
this small fixture. Both runs completed successfully. This is not a broad
cost/latency/quality benchmark, and caching/prices were not evaluated. The local
observation projection shrank approximately 93.9% from its third request; its
first two projections were equal and full. `milestone-raw.json` retains the
entire raw snapshot and exact 25,200-byte inventory. The final reduced failure
log is retained in `live-reduced-log.txt`.

The reducer itself reported **4,132 tokens** (4,024 input, 108 output). The smoke
used the same model as the primary agent, so it proves model offloading and
guardrails, not a cheaper-model price advantage. It would be uneconomic for a
one-off log in this fixture. Applications should choose a cheaper model and
expected reuse, or use deterministic extraction. Reducer usage is deliberately
recorded separately rather than hidden in context-savings metrics. Numbered
plain-text scaffolding was used instead of verbose per-line JSON input.

`spill-benchmark.json` measures the former array-materializing read algorithm
against the current memory store for 20 one-code-point prefix reads of a
2,600,000-byte Unicode log: approximately 203.7 ms versus 0.42 ms on this run.
This is a local algorithm microbenchmark, not end-to-end SDK or provider latency.
The change caches code-point counts at save time and scans only the requested
prefix rather than allocating an array of the full log on every small read.
Preview and reducer metadata are also cached across requests.

## Validation

- Core build and workspace `tsc --noEmit`: passed.
- Package graph, dependency graph, team boundary, runtime boundary: passed.
- Unit and contract suites: **3,097 tests / 238 files passed**.
- New context/fusion tests: **33 passed**, including actual file/subprocess
  validation; Unicode/lone-surrogate retrieval; failed/expired storage; capacity;
  failed archives; ROI after packing; consecutive milestones; protected app
  context; malformed and missing evidence; changed pass/fail; invalid line
  references; and reconstruction from source despite mutable proposals.
- Packed core matrix: passed with new optimization behavior in standards-only
  execution, Node, real headless browser, local Worker, and type consumers.
- Live Codex paired workflow and exact-evidence model reduction: passed.
- Final success-predicate hardening accepts only exact `true`; subsequent core
  build, workspace typecheck and all eight fusion tests passed.

The public API declaration fixture was regenerated intentionally for the new
core exports and optional `StepDecision.messages`. Other package snapshots
remained unchanged. Existing staged work was preserved; no commit or staging
was performed.

## Limits and ownership

Fusion uses an explicitly experimental scheduler grant and is not a filesystem
transaction. A denied/failed validation does not undo a completed edit. The
host marks actual plan milestones, provides state summaries, determines cost
units/remaining turns, parses authoritative build status and required evidence,
and owns scoped storage, TTL, cancellation and model budgets. Generic log rules
cannot prove semantic completeness for every log format; unknown formats or
unfit evidence retain raw output. Optimizer state is ephemeral and must be
recreated for reset/resume or a different conversation. Prepared-request counts
are not delivery confirmations or billed token counts.

No default provider or application behavior was changed, and no deployment was
performed. This evaluation does not establish production-wide performance.
