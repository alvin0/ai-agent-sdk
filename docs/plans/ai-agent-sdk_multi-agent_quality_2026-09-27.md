# Multiple-agent quality follow-up — 2026-09-27

Status: v7 implementation and validation complete. Efficiency and zero-loss versus v10 gates pass; the global quality gate remains NOT MET because of two ZenMux losses versus original BASE.

The user requires improved task understanding/quality without worsening performance,
while keeping the SDK an extensible kit. The previous v10 cohort retains 11 new
primary pair losses and remains historical evidence; its grades are not changed.

## Diagnosed loss classes

- Failed producers have no payload, but their routing address is mistakenly used
  as source evidence. Dependency context must separate metadata, payload and status.
- A worker sends an update, then returns an acknowledgement instead of the caller's
  requested value. `send_message` is context delivery; the terminal response is the
  return value. Extra prose violates caller-specified output contracts.

Candidate changes generic managed-team protocol guidance and dependency
framing, preserves disabled-tool access, and leaves progress narration to host/model
policy by default (`commentary: auto`). Explicit `concise` and `off` remain available. No JSON schema, business workflow, provider-specific instruction, expected
aggregate value or source-ID oracle is added to production SDK code. Caller-defined
roles/tools/output formats and manual/full/reporting policy controls remain available.

## Frozen comparison

- BASE: prior plan-completion SDK at `artifacts/plan-completion-hHIqY2/candidate-sdk`.
- REFERENCE: SDK-neutral v10 at `artifacts/multi-agent-audit-n62xvl_w/final-sdk-v10`.
- CANDIDATE: `artifacts/multi-agent-quality-8c_f2p6p/candidate-sdk-v7`.
- Fixture bytes/oracle/languages/models/efforts/session limits unchanged from v1.
- Six lifecycle families × two languages × three repeats × three arms × two providers
  = 216 attempts. Six arm-order permutations are balanced; one workflow/provider.
- This is author-exposed regression evaluation after reviewing earlier losses, not
  a blind or domain-general result. Source freezes and raw failures remain retained.

## Gates

1. All public orchestration regressions, full tests, type/runtime/package checks pass.
2. Zero new primary pair losses against both BASE and REFERENCE in the final cohort.
3. No token/latency mean increase on the same complete-success pairs versus REFERENCE;
   retain all-attempt counters, subset size and coverage. Missing usage remains unknown.
4. Every raw loss is reviewed without primary regrading, selective retries or best-of.
5. Separate native lead/tool/dependency acceptance from exact terminal formatting.

Pilot v1 is only readiness evidence (12 attempts). Candidate answers are correct
on that small sample, but conditional token/latency gates are not all met; no
performance improvement is claimed from it. Final evaluation must settle the gates.

## Validation and ownership

33/33 candidate conformance cases and 236 files/3,042 tests pass. The refused-handoff
fixture was changed to reject its second lead→consumer delivery (required dependency
context), rather than match a prose prefix. An intermediate fixture mistakenly
rejected the initial commissioned task; that failed run is retained. Dispatch/failure
assertions were preserved. Root/core typechecks, architecture and packed gates are
recorded under the owned scratch directory.

No staging, commit, reset, stash or checkout changes are authorized or performed.
Index and production source hashes are captured separately. All live SDK trees are
immutable during their cohorts; credentials remain in the existing local auth/env
stores and are not copied into evidence.

## Full v1 outcome and v3 refinement

All 216 planned v1 attempts completed with bundle integrity unchanged. Versus
REFERENCE v10, Codex improved 29/36 to 35/36 (6 wins, zero losses), and ZenMux
improved 15/36 to 26/36 (14 wins, 3 losses). Versus original BASE, there remain
1 Codex and 4 ZenMux new losses. The quality gate therefore fails. Remaining
losses include metadata used as payload identifiers and exact JSON surrounded
by explanation; one ZenMux response substitutes worker addresses for evidence IDs.

Paired-success token means increased and the token gate fails. One REFERENCE
Codex row has incomplete usage, so full coverage also fails; it is retained as
unknown, not filled in. v3 shortens generic protocol/tool descriptions and marks
full versus truncated handoffs, explicitly identifying the reader as the same
retained observation. This aims to reduce unnecessary read calls without changing
payloads, task/oracle/limits or any runtime capability. v3 is an independently
frozen candidate; v1 rows and grades are never replaced.

All v3 local gates pass: 236 files/3,042 tests; 33/33 public conformance; root/core
typecheck; architecture lint; core pack, publint and public types. Isolated builds
for v1, v2 and v3 remain separate. v2 was built but not measured live.

## Full v3 outcome and v4 refinement

All 216 v3 attempts completed, unchanged SDK bundles, all usage complete and
reconciled. Codex is 36/36, zero new paired losses against both baselines, and
both paired token/latency gates pass. ZenMux is 28/36 (v10 REFERENCE 12/36),
with 3 new losses versus BASE and 2 versus REFERENCE. Conditional token/latency
means on 10 complete-success pairs increase, so v3 is not the final accepted
result. All failures remain raw primary failures.

v4 moves caller-format guidance to the end, labels the reader name as a worker
address, and emits paging guidance only for actually truncated payloads. Its
final handoff line returns attention to the assigned task/output contract. Missing
payloads now state only that no result data was returned; no claim about side
effects or unreported observations is made. No API capability, schema/oracle,
model, effort, payload or limit changes. All v4 local gates pass; full three-arm
evaluation runs against immutable v4.

A v3 observer helper started before runs.jsonl existed and failed; the main
cohort ran to completion. Recovery of the observer scheduled each native check
once, without repeating model attempts. Failed helper and recovery source/logs
are retained. v4 startup waits for local gates and the observer waits for its
result file. The initial v4 precheck failed before creating a cohort or model
attempt; restarting that local guard does not retry any benchmark row.

## Full v4 outcome and evidence-backed v7 correction

The v4 cohort completed all 216 attempts. Codex remained 36/36 with no new
paired losses. ZenMux was 20/36 with 4 new losses versus BASE and 5 versus
REFERENCE; conditional token and latency means increased. The gates failed.

A controlled public-model-boundary probe identified a concrete SDK policy conflict:
`concise` was the default and appended mandatory progress narration after caller
output instructions. Providers without separate commentary phase metadata can return
that prose with the final result. v7 changes the default to `auto`, preserving
explicit `concise` for hosts that want progress (the chat sample already selects it).
No output stripping, schema, provider-specific workaround, reasoning reduction or
iteration-limit reduction is introduced. Four tests verify style policy through
an actual tool round with unchanged tools and caller instructions.

The same probe found `workerTeamTools:false` hid tools but attachment normalization
converted false to full access, advertising disabled verbs. v7 preserves false in
the private access type and attachment normalization. Its controlled probe confirms
no hidden SDK tool verbs are advertised; reporting and full remain available.
v6's incomplete first fix failed typechecks and was blocked from live measurement.
v2/v5 were built but not measured live. All failed evidence is retained.

v7 passes 236 files/3,046 tests, 33/33 public conformance, root/core typechecks,
architecture lint, core packed runtime/publint/public types, and an isolated build
of all 26 packages. Live gates still require the full unchanged three-arm cohort.

## Final v7 measured outcome

All 216 attempts completed; all loaded SDK package hashes unchanged. Codex
improves from BASE 19/36 and REFERENCE 31/36 to 36/36, with zero new paired
losses against either. ZenMux improves from BASE 9/36 and REFERENCE 18/36 to
30/36, with zero new paired losses against REFERENCE, but two against BASE.
Both BASE losses and all six candidate failures are failed-dependency source-ID
provenance errors: unknown/null values are correct, but the worker address is
returned as an evidence identifier. They remain primary failures. The task's
empty-ID requirement is underspecified; its unchanged grade is not dismissed.

On 31 Codex complete-success pairs versus REFERENCE, reported tokens decrease
10.97% and latency decreases 13.28%; on 18 ZenMux pairs, tokens decrease 29.29%
and latency decreases 9.54%. All-attempt usage coverage is complete/reconciled.
These conditional means and author-exposed families do not prove universal or
statistical superiority. The paired efficiency gate passes; the global zero-loss
quality gate does not. Both native checks pass real spawn, both measurement tools,
dependency consumer and exact final answer.

The final conformance assertion checks offered tools AND advertised system verbs
for false/reporting/full access. It fails on the old reference (32/33) and passes
on v7 (33/33). The CLI now returns nonzero when any case fails after retaining
all results; reference exit 1 and candidate exit 0 are verified. Root types pass
after this harness-only change. Production source still matches the frozen v7
patch, and the staged index remains unchanged.

Portable raw evidence, every cohort/failure, source freezes and validation records
are retained in `docs/evaluations/multi-agent-quality-2026-09-27/findings.md`.
