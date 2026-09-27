# SDK and sample live regression audit — 2026-09-28

All successful provider runs after the user's model-selection instruction used `gpt-6-luna`: Codex for the Node sample and SDK probes, OpenAI for the Edge sample. The earlier `gpt-4.1-mini` failure is retained solely as historical baseline evidence. No older working model was substituted. Existing provider-catalog fixtures remain unchanged; an SDK must still let application developers choose supported models.

## Defects reproduced and corrected

1. **Completion guidance changed constrained answers into process reports.** The accepted self-check observation foregrounded a substantive report. It now prioritizes the current user's or worker task's requested answer and format, keeping verification metadata in the self-check. Deep-mode reminders preserve the same contract. Acceptance, invalidation, resource limits, and verification gates remain active. The production Edge TeamAuto oracle still requires exact worker and lead answers across successive tasks.
2. **Compaction memory revived an obsolete task.** With a current request for the retained inventory marker, a real model answered the prior task's `LOADED` instead. Captured provider messages contained both the marker and the new request; the pinned memory preamble nevertheless required preserving the original objective. It now retains facts and constraints while following the latest user or assigned task. Raw history and archived observations remain available. The failing lifecycle run is retained alongside the corrected run and an independent repeat.
3. **Node sample counted a CSV header as a data row.** Production S12 returned `alpha` and `51`, with only a file read for the counting task. This was a numerical-answer failure; the evidence did not demonstrate conversation leakage. Sample instructions now require computation for row counts and aggregations and explicit treatment of headers and empty lines. Three repeats returned exactly `alpha` and `50`, each with actual `run_command` execution. The oracle now requires completed runs and exact answers.
4. **Node live harness reported failures with exit code 0.** It now returns code 1 when any selected scenario fails, and rejects unknown/empty selections and invalid repeat counts before seeding the workspace. Six negative CLI probes pass. A controlled local HTTP response containing a deliberately incorrect answer proves a false oracle yields exit code 1; this probe makes no model request and is separate from provider acceptance.

The prior package re-audit also corrected a missing optimization-result type in the core packed fixture. Its package-wide evidence remains in [the package re-audit](../package-re-audit-2026-09-27/findings.md).

## Evidence and acceptance

| Gate | Result | Evidence |
| --- | --- | --- |
| Node production, all workflows | 16/16 | `node-final/summary.json` |
| Node CSV isolation/count regression | 3/3 | `node-row-count-repeat/results.jsonl` |
| Edge production HTTP/SSE, tools, TeamAuto, recovery and cleanup | 8/8 | `edge-luna-final/results.json`, `cleanup.json` |
| SDK packing, paging, compaction/resume, reducer fallback, redaction and isolation | 5/5 | `optimization-lifecycle-after/results.json` |
| Compaction/recall independent repeat | 1/1 | `milestone-repeat/results.json` |
| Deep-mode successive JSON, number and exact-text responses | 3/3, accepted self-check each | `deep-format-final/results.json` |
| Root unit/contract suite after core fixes | 3,172 tests, 246 files | `checks/unit-all-final.log` |
| Sample boundary/session regressions after sample/harness fixes | 26 tests, 3 files | `checks/sample-targeted-final.log` |
| Root TypeScript and architecture lint | Pass | `checks/typecheck-final.log`, `typecheck-count.log`, `lint-final.log` |
| Core publint, types and packed Node/browser/workerd matrix | Pass | `checks/core-pack-final.log` |
| Both sample production builds | Pass | `checks/node-production-build-count.log`, `edge-production-build-final.log` |
| Harness negative configuration and false-oracle exit | 7/7 | `checks/node-harness-cli-negative.json`, `node-harness-false-oracle.json` |

The retained red Node run (`node-before-row-count-fix/summary.json`) is 15/16. The red SDK lifecycle run is 4/5. These files preserve the before/after failure evidence instead of replacing it with green results.

## Token and evidence results

In the live edit-and-test fixture, atomic execution used 3 model requests and 2 observations (1,134 authoritative tokens); fusion used 2 requests and 1 observation (838 tokens), a **26.1% reduction for this fixture**. Both paths performed the file edit and an actual test subprocess. See `fusion-reducer-live/report.json`.

The verified reducer retained the required log evidence while reducing 6,605 bytes to 225 bytes. It used `gpt-6-luna`, following the user's instruction, and consumed 4,136 extraction tokens. This verifies reduction and deterministic guardrails, **not cheaper-model savings or net cost savings**. The live lifecycle corrupt-reducer probe verifies fallback to original evidence.

Observation packing sent the full large result for the first two relevant provider requests, then referenced it with retrievable chunks. Compaction archived the completed milestone, denied retired handles, preserved the next request's marker, and resumed correctly. Token-saving metrics for those projections are estimates and must not be confused with billed usage.

## Scope and remaining limits

- Edge primary and secondary are both `gpt-6-luna`: this proves successive-request history retention, not a cross-model switch. The retained case ID includes “model-switch” for continuity, but no different successful model was used.
- Real provider runs are finite samples of stochastic behavior; passing these oracles does not prove every future model response is correct. Production applications should keep deterministic validation where they require exact numerical or structured results.
- This run validates production HTTP/SSE and provider behavior. Browser interaction evidence belongs to the earlier [sample harness audit](../sample-harness-audit-2026-09-27/findings.md); no new browser acceptance claim is made here.
- The previous 26-package matrix remains separate historical evidence. Current core source changes received fresh root checks and packed core runtime validation; unchanged packages were not all repacked again.
- Existing externally staged `.next-harness-audit` caches were preserved. A prior scan found four staged `.sst` files containing known credentials. Requested cleanup approval has not arrived; those generated caches must be resolved before a commit. Owned `.next-harness-build` directories are cleaned separately, and the four Next-generated source files are restored to their pre-run working-tree bytes.

`source-hashes.json` identifies the audited sources. `SHA256SUMS.json` covers the retained evidence. Evidence copies are scanned for known root-environment credential values and redact any matches; databases, credential stores, and Next caches are not copied.
