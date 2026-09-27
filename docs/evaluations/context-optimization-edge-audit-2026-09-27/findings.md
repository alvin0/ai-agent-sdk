# Context optimization edge audit — 2026-09-27

The audit found and corrected boundary defects in the opt-in optimization APIs,
their session/model-loop integration, and the optimized memory spill reader.
Ten initial regression cases were executed against the pre-audit implementation
and failed before the corresponding fixes. The final source passes all gates below.

## Corrections

| Boundary | Correction and regression coverage |
| --- | --- |
| Live input during maintenance | Refresh session messages after append-only changes; append late steering to projected model context in chronological order. |
| History replacement during projection | Reconcile the current surface; remove shadowed messages and preserve application redactions on surviving messages. |
| Same-ID redaction or revoked evidence | Fingerprint milestone inputs; invalidate a cached summary when its source messages change or disappear. |
| Regular pressure compaction | Transfer range ownership to the current persisted surface; do not retain a superseded milestone summary. |
| Disposal while storage/model work awaits | Cancel cooperative archive/reducer work and prevent late save/read/archive/reducer completion from publishing controller state. Host backends own pending write cleanup. |
| Hook composition after disposal | Keep the application's message projection and prepend intact. |
| Concurrent or cross-history controller use | Reject overlapping preparations and mismatched history anchors. Keep controller/store scoped to one conversation. |
| Hook deadlines | Forward cancellation to callback signals before bounded teardown; a cooperative deadline returns `HOOK_TIMEOUT` without aborting the parent conversation. |
| Fusion configuration | Reject sparse pipelines and non-string child names before execution. |
| Fusion callback failures | Retain actual edit receipts after argument mapping failure, a thrown acceptance predicate, or a truthy result other than exact `true`; stop subsequent work. |
| Reducer verification oracle | Capture text, verdict and required lines before asynchronous storage/model callbacks can mutate host objects. Reject invalid runtime verdicts and invalid required line indexes before model execution. |
| Spill paging compatibility | Preserve original `Array.slice` semantics for fractional, negative, NaN and infinite ranges without allocating the entire code-point array. Cover emoji and lone surrogates. |

Additional coverage includes the exact 10 KiB threshold, future/overlapping
milestones, archive failure, split tool pairs, ROI after observation packing,
storage expiry/capacity/failure, failed host checkpoints, absent fusion grants,
policy denial, root budget exhaustion, changed model status/text/line numbers,
missing evidence, mutable candidate getters, and reducer input/output byte limits.
The full suite also exercises existing nested scheduler fatal latching,
checkpoint ownership, cancellation, timeouts, and output contracts.

## Validation

- Core build and workspace `tsc --noEmit`: passed.
- `pnpm lint`: package graph, dependency, agent ownership and universal runtime boundaries passed.
- `pnpm exec vitest run tests/unit tests/contract`: **3,126 passed in 239 files**.
- Optimization-specific tests: **62 passed** — 25 context/reducer tests, 26 edge audit tests and 11 fusion tests.
- Packed core consumer matrix: standards, Node, real headless browser, local Worker and TypeScript consumers passed. See `packed-core.log`.
- `git diff --check`: passed.
- Final provider smoke: live Codex `gpt-6-luna`, actual temporary file mutation and Node subprocess assertion; both atomic and fused runs completed with one edit and one test each. See `report.json`.

The first broad test run caught an invalid privacy sentinel in the new test
fixture. The fixture was corrected to use the repository's structural sentinel
format; the full suite was rerun successfully. Production assertions were not
relaxed.

## Live functional evidence

| Metric | Atomic | Fused |
| --- | ---: | ---: |
| Model requests | 3 | 2 |
| Main-agent observations | 2 | 1 |
| Provider-reported total tokens | 1,128 | 827 |
| Actual edits / subprocess tests | 1 / 1 | 1 / 1 |

Observation packing retained two full prepared requests and reduced later
serialized request payloads from 27,594 to 1,682 bytes for the fixture. Those
figures include message JSON overhead. Raw history was retained separately.
The live reducer preserved verified evidence from a 6,605-byte log in 225 bytes;
the extraction call itself consumed 4,132 provider-reported tokens.

This single paired smoke establishes functioning provider/tool integration;
it is not a general cost or quality benchmark. The extractor used the same
model as the main agent, so this run does not establish cheaper-model economics.
Generic diagnostic rules cannot establish completeness for arbitrary log
formats: applications must supply required evidence lines and authoritative
status. Applications also own archive persistence, store authorization/TTL,
regex-search execution bounds in their chosen spill backend, and summary
correctness. No hosted deployment or exhaustive proof over all possible inputs
is claimed. `SHA256SUMS.json` binds the retained evidence to the audited source.
