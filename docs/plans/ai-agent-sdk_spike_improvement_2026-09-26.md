# Spike result review and improvement — 2026-09-26

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.

> **Superseded on 2026-09-27.** This review covers the same-root relay candidate. The scheduler-owned nested admission replaced it and passed the architecture gate. See the [closeout update](ai-agent-sdk_spike_closeout_2026-09-26.md#cập-nhật-27092026-productization-và-ev-01). This file is kept unchanged below for audit.

## Findings reproduced before the fix

The old executor oracle accepted three dispatched calls even when a guest caught the hard-cap error and returned `done`. A new terminal-result requirement exposed that false success. A second negative control made the host bridge fail on the first request: the old guest caught it, dispatched three times and returned `false-success`.

Frozen [before evidence](../evaluations/spike-improvement-2026-09-26/before-executor.json): 13/15 checks passed, with both new requirements failing. These are research-executor bugs, not evidence of an SDK production regression. Previous frozen baseline and closeout results remain unchanged.

## Changes

- Latch host bridge failures, program call-cap exhaustion, non-JSON replies and oversized replies for the lifetime of the guest program. Catching the exception cannot resume host dispatch or publish success.
- Correlate replies with the current request ID; stale replies cannot settle a later request. This is correlation within an owned Node worker, not a cross-owner authorization mechanism.
- Reject undefined/function/symbol/nonfinite data instead of silently converting it to lossy JSON. Bound program source bytes, CPU configuration and call-cap configuration before creating QuickJS.
- Strengthen root-relay oracles to require exact body/forward counts and terminal results, plus actual worker termination events. Unexpected infrastructure exceptions now fail the harness rather than becoming empty reports.
- Add a same-root host-failure case: a catching guest dispatches one body, forwards no value, and terminates with `ROOT_ADMISSION_DECLINED`.

## Verification

[After executor](../evaluations/spike-improvement-2026-09-26/after-executor.json): 18/18. Added stale-reply, undefined and nonfinite controls. Host failure now produces one dispatch and `BRIDGE_FAILURE`; hard-cap exhaustion produces three dispatches and `PROGRAM_CALL_CAP`.

[After root relay](../evaluations/spike-improvement-2026-09-26/after-root-relay.json): 6/6, through actual SDK root sessions, policy hooks and checkpoints. Root limit 3 includes the outer call and allows exactly two read bodies. Budget-exempt reads still stop at the program cap of three.

`pnpm exec tsc --noEmit` passed. `pnpm exec vitest run tests/unit/neutral-evaluation.spec.ts tests/unit/tool-output-budget.spec.ts`: 29/29. Source and artifact hashes are in [verification](../evaluations/spike-improvement-2026-09-26/verification.json); raw run directories retain source snapshots.

## Decision and next gates

Keep SP-01 `needs-review`, architecture gate false and live utility benchmark disabled. The fresh-child-session candidate remains rejected: it still reproduces ten tool bodies under a parent limit of three. The same-root relay is a feasibility protocol whose outer tool returns `started`, not a finished nested program result.

These changes are deterministic conformance improvements. They do not establish model quality, latency or cost gains. `USAGE_MISSING` in relay reports comes from the synthetic adapter and cannot support provider-usage conclusions. SP-02 through SP-05 were not changed or rerun in this iteration; their previous local fixture evidence and limits remain in the closeout.

Before implementation or a live comparison, still prove the full PTC-A01…15 matrix: catalog/authority revision checks across awaits, approval abort and stale decisions, owned sibling cancellation/drain, handle owner/revision/TTL/close, outer lifecycle and canonical history, MCP schema/metadata capture, startup failure and portability. Host-error latching here is conservative for every bridge error; it is not yet production classification of recoverable versus fatal/unknown outcomes. Configured QuickJS heap limits are not a total process RSS guarantee.
