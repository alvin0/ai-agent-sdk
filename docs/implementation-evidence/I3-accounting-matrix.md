# I3 evidence — Deterministic accounting matrix

Status: **Implemented and verified**

The canonical model-call ledger and terminal-delivery projection are exercised
across every outcome frozen by Phase 2. Tests assert physical-attempt rows rather
than inferring accounting from emitted text or retry callbacks.

| Required outcome | Executable evidence | Accounting assertion |
| --- | --- | --- |
| Retry succeeds | `http-provider.spec.ts` physical-attempt suite; `delivery-terminal.spec.ts` `retry` row | one logical call, two numbered attempts, first missing/sent error and second complete/sent success; only the second usage is reported |
| Retry exhausts | `http-provider.spec.ts` retry-ceiling case; `delivery-terminal.spec.ts` `retry-exhausted` row | two sent error attempts, missing coverage, two possibly-billed attempts, terminal error retained |
| Pre-dispatch rejection | `http-provider.spec.ts` abort, request-byte, credential and audit-admission cases | no physical attempt, `not-applicable` coverage and zero possibly-billed attempts |
| Post-dispatch abort/timeout | `http-provider.spec.ts` in-flight abort and request-timeout cases | one unknown-dispatch attempt, aborted/error status, missing usage and one possibly-billed attempt |
| Truncated stream | `http-provider.spec.ts` incomplete Responses SSE case | one sent error attempt with `STREAM_CLOSED`, missing coverage and one possibly-billed attempt |
| Compaction succeeds | `memory-compaction.spec.ts` overflow recovery and manual compaction cases | maintenance call is recorded once, its usage joins the run ledger, and committed generation/history are consistent |
| Compaction fails | `memory-compaction.spec.ts` oversized/failed summary cases | failed lifecycle is retained, no summary generation is committed, and primary failure remains visible |
| Compaction aborts | `memory-compaction.spec.ts` abort-during-maintenance case | one failed/aborted maintenance path, zero committed summary and no hidden retry |
| Counter overflow | `usage-accounting.spec.ts`; `delivery-terminal.spec.ts` `overflow` and `aggregate-overflow` rows | counters saturate, `authoritative` becomes false and `USAGE_COUNTER_OVERFLOW` survives terminal projection |
| Multiple runs per batch | `delivery-batch.spec.ts` mixed event/run batch | two immutable atomic run records retain independent complete/missing usage; no batch-level token total exists |

Verification after a clean core build:

- Core: 61 suites, 794 tests passed.
- Provider HTTP: 3 suites, 80 tests passed.
- The provider tests use real `ModelRegistry`/`ModelCallHandle` reports and a
  deterministic injected fetch; no network or provider credential is involved.
- The installed provider-http runtime matrix continues to pass Node, Chromium,
  workerd and the strict Worker negative fixture.

The first provider run after adding the timeout assertion failed because the
nested expected error object was exact instead of an asymmetric matcher; the
actual report correctly contained the required `TIMEOUT` code plus safe type and
message fields. The assertion was corrected without changing product behavior,
and the full package suite then passed 80/80.
