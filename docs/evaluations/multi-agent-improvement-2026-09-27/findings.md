# Multiple-agent SDK audit — 2026-09-27

Status: audit, selected fixes, SDK policy controls, local/packed gates and the final live matrix are complete. Source/quality limitations and remaining strict-format failures are retained below.

## SDK boundary

The change supplies lifecycle mechanisms and host policy controls. It removes
mandatory planning, local critical-path work, workspace scaffolding, independent
worker strategy and prescribed synthesis/report formatting from injected team
guidance. The host supplies tasks, roles, tools, permissions and output contracts.
`ManagedAgentTeam` remains an optional helper over `AgentTeam` and sessions.

`autoLeadCoordination: false` lets the host end/restart lead turns explicitly;
`workerTeamTools: 'full' | 'reporting' | false` selects peer coordination access;
`requireWorkerText: true` opts into a textual-result requirement. Clean tool-only
completion is valid by default. Convenience defaults retain automatic lead
coordination and reporting-only worker tools. Write scopes are scheduling
coordination; tool/filesystem authorization belongs to the host.

## Current staged snapshot review

The staged managed source equals the immutable intermediate v4 SDK source.
Current cached production/sample patch SHA is `474dc8c9c36b582990a803d7f0bee17da75047fa9301f6d712399f7e3f25be49`.
It differs from the final working-tree bundle. The agent did not stage, commit,
reset or restore the index after it changed externally during this audit.

- **P1: unobserved factory rejection at an already-aborted setup boundary.**
  [Staged source](current-staged-managed.ts#L1682) throws before subscribing to
  a rejected promise. A host factory that aborts its caller synchronously and
  rejects causes an unhandled rejection; Node may terminate the host process.
  Reproduced by `aborted-setup-rejection-observed`, fixed in the worktree by
  retaining the rejection observer even when cancellation already won.
- **P2: legitimate replacement character erased by byte pagination.**
  [Staged source](current-staged-managed.ts#L1763) removes a trailing `�`, even
  when it belongs to the actual report. The final page becomes empty and
  `nextOffset` remains 7 instead of reaching null, enabling repeated tool calls
  without progress. Reproduced with `�😀𐍈中é�`; fixed by streaming UTF-8 prefix
  decoding and byte-aligned tail extraction.
- **SDK scope gap:** staged guidance imposes a fixed delegation strategy and
  treats clean empty-text completion as failure. New host policy cases show
  that the staged helper ignores manual coordination/tool-access selections;
  the final working tree implements those extension points.

## Deterministic and packed verification

| Snapshot | Public session/model-loop cases |
|---|---:|
| Previous plan-completion BASE | 5/33 |
| Current staged intermediate v4 | 28/33 |
| Final SDK-neutral working tree v10 | 33/33 |

This is an exposed regression cohort extended when audit findings were reproduced,
not a random or blind distribution. Four policy cases check actual tool offerings,
manual lead-turn lifecycle and a completed tool action without textual output.
The remaining cases cover concurrent admission, lifecycle ownership, original
producer identity after closure/address reuse, required handoff, cancellation,
quiet/report delivery, history limits, teardown, full scoped results and Unicode.

All **236 test files / 3,042 tests** passed. Root/core TypeScript, public type
resolution, publint, architecture/runtime boundaries, core packed runtime matrix
and the isolated 26-package workspace build passed. Exact named logs are retained
in `verification-logs`; `verification-v10.json` maps each gate. This does not
claim an application browser/UI or production validation.

## Final live results — frozen SDK-neutral v10

All 144 planned attempts completed. Built module hashes for all 26 packages were
unchanged; all 36 rows per arm/provider have complete authoritative token usage
and terminal/model totals reconcile. Historical cohorts are not pooled.

| Provider/model | BASE correct | Final correct | Pair wins / new losses | Both-success pairs | Conditional token change |
|---|---:|---:|---:|---:|---:|
| Codex gpt-6-luna (medium) | 21/36 | 30/36 | 12 / 3 | 18 | -22.47% |
| ZenMux dots3-note-prev | 15/36 | 17/36 | 10 / 8 | 7 | -40.91% |

Tokens and latency compare only the same successful pairs with complete usage.
Paired mean latency changed 11.95→10.02 seconds (Codex) and 10.32→8.16 seconds
(ZenMux). The ZenMux efficiency subset is only seven pairs. All-attempt reported
token totals, failures, calls and family breakdowns are in
[report.json](live-sdk-neutral-final-v4/report.json); these conditional reductions
are not a claim about all future tasks or dollar cost.

First prepared synthesis requests contain all required supplied source IDs in
**12/30→30/30** rows for each provider. This is a source-marker visibility measure,
not proof of complete numeric facts or provider acceptance. Closed-multi and
address-reuse families improve from 0/6→6/6 each on Codex, and 0/6→2/6 and 0/6→5/6
on ZenMux. The mechanics resolve the missing/wrong producer handoff; the model
still owns its answer generation.

Every one of **11 new pair losses** remains a primary failure and has been
inspected in [loss-adjudications.json](live-sdk-neutral-final-v4/loss-adjudications.json):
three Codex failures and one ZenMux failure return unknown/null but use the failed
worker address as sourceIds against the frozen empty-ID oracle; five ZenMux
failures contain otherwise exact correct JSON surrounded by prose; two return
terminal prose instead of the required JSON, claiming an update was sent to lead.
The last claim is not accepted as proof of the terminal output. In total, all
61 primary failures remain recorded, with secondary review kept separate.

**There is no blanket no-regression or domain-general superiority conclusion.**
ZenMux early-dependency control declines 6/6→2/6 and parallel control 4/6→3/6 on
strict terminal formatting despite model-visible source evidence. Host output
validation/format policy is an application concern; the SDK does not hard-code
the benchmark JSON schema or restore a prescribed delegation strategy to improve
this score. No failing row was replaced or favorably regraded.

Native lead-tool acceptance is separate: both providers actually spawn workers,
perform both measurement tools and commission a real dependent consumer.
Codex passes the requested exact final JSON. ZenMux produces correct embedded
JSON with extra prose and therefore **fails that fixture format check**. Its
three lifecycle/tool checks pass. Raw calls, commissioned conversation identities
and canonical terminal records remain in the two native evidence folders.

## Live method and remaining interpretation

The final matched cohort uses six lifecycle families, English/Vietnamese variants,
three repeats, 36 BASE/CANDIDATE pairs per provider and 144 workflow attempts.
Models are Codex `gpt-6-luna` / medium and ZenMux `dots-studio/dots3-note-prev`;
no model substitution, favorable retries or changed oracle. Host scheduling is
controlled; producer and synthesis sessions use real providers. All attempts,
canonical child usage, failure grades and pair losses remain in the evidence.

Fixture/workflow JSON, exact source IDs and numeric aggregation belong to this
benchmark, not to the SDK. Expected aggregates are never sent to the model.
Token comparisons use the same successful pairs with complete usage; missing
usage remains unknown. Cache/token definitions differ between providers, so no
USD or cross-provider billing claim is made.

Historical v1/v2 full cohorts remain separate. SDK-neutral intermediate v3 was
stopped for an additional generic-team guidance change: 28 started attempts,
26 recorded results and two interrupted attempts with unknown usage. These
attempts remain retained and are not pooled into the final comparison.

Known limitations: six author-exposed synthetic families do not establish
production or domain-wide superiority. Translations/repeats share facts. The
failure-family frozen task does not explicitly require empty source IDs while
its oracle does; returning the failed worker address remains a primary failure,
with the ambiguity disclosed in secondary review. Prose surrounding otherwise
correct JSON remains a strict-format failure. Effects=0 only describes the
read-only tools exposed here. Session budgets are not an aggregate workflow
spending cap. Timeouts cannot forcibly stop callbacks ignoring cancellation.

Final source freeze: `candidate-freeze-v10.json`; final production/sample patch
SHA `40bd9830b1011e0be18299039e15feb83b2648964b09a93dd2ff589ffc004294`.
`retained-artifacts.json` identifies immutable bundles/source archive and earlier
exploratory evidence. Source and hashes are retained for reproducibility.
