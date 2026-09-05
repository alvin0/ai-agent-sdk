# I3 progress — Exporter preflight and transactional capability startup

Date: **2026-09-05** (Asia/Ho_Chi_Minh).

Status: **Internal composition implementation; I3 is not complete.**

## Implemented

- `composition/exporter` owns the distinct marker-bearing runtime exporter,
  explicit owned/borrowed registrations and typed delivery/run-terminal-record
  shapes. The existing marker-free advanced-bus exporter remains unchanged.
  Declaring the delivery shapes does not implement their delivery/checkpoint logic.
- Provider and exporter identities are validated across the whole runtime before
  the first executable property is read. Exporter IDs, requested/supported
  boundaries, ownership and requirement are bounded and validated as own data.
  Conflicts are support-safe and do not transfer ownership or run cleanup.
- Every exporter behavior reference, including optional readiness/staging/shutdown,
  is captured once on a detached frozen view and retains its original receiver.
  Failed partial capture cannot be retried. Cancellation during method capture
  prevents the next method lookup. Caller objects and operational state are not
  frozen.
- Internal `defineObservationExporter` stamps and captures a new frozen wrapper
  without invoking lifecycle behavior. Public export wiring remains pending.
- `RuntimeExporters` explicitly receives ownership only after preflight. Readiness
  is awaited sequentially under one deadline; a failed, timed-out or cancelled
  readiness never yields a usable capability activation. Close aborts readiness,
  joins one shared promise and shuts down only owned registrations in reverse
  order, including owned exporters whose readiness had not begun.
- `activateRuntimeCapabilities` coordinates the actual `ModelRegistry`, supplied
  canonical logger and managed resources. Setup remains synchronous. A failure
  rolls back provider registrations before exporter shutdown, retaining the
  primary error classification and all contained cleanup rows. Cancellation
  between preflight and activation transfers nothing; cancellation at the final
  activation boundary is reported as activation, not inert preflight.
- Startup uses one absolute deadline across provider setup and exporter readiness.
  Rollback receives a separate bounded cleanup budget, established once and shared
  across any provider-internal rollback, outer rollback and exporter shutdown.
  The cancelled startup signal is not forwarded to cleanup.
- Provider cleanup always removes topology; when the shared deadline is already
  exhausted it skips the user disposer and reports `timed-out`. A synchronous
  disposer that began within budget is not described as preempted even if it
  consumes the remaining time. Later components still observe the exhausted budget.
- The domain-local asynchronous boundary checks time before dispatch and after
  resolution, races cancellation, and observes late promises. On expiration it
  aborts the supplied operation signal and clears owned timers/listeners; raw
  exceptions and abort reasons are not exposed.

New implementation files are grouped by exporter/lifecycle domain, with startup
and preflight at the composition root. Shared callable capture is in
`composition/common/data.ts`; exporter bounds/constants have explicit config
owners. The largest changed composition implementation file is 218 lines.

## Focused verification

`pnpm exec tsc --noEmit` and `pnpm exec vitest run tests/unit/composition` pass:
**161 tests / eight suites** (52 additional tests since the platform/lifecycle
checkpoint). The new cases include:

- duplicate exporter/provider identities with throwing behavior getters;
- cross-family namespace independence and invalid marker/boundary/ownership;
- class receivers, detached metadata and method mutation, capture read counts,
  optional non-callable lifecycle values and cancelled partial capture;
- readiness success, rejection, timeout and caller abort for owned and borrowed
  registrations, including unresolved work and late rejection;
- reverse rollback, not-yet-ready owned cleanup, no borrowed shutdown,
  mutation-resistant teardown and idempotent/reentrant close;
- exact provider/exporter rollback ordering, shared budgets, expired disposer
  suppression with route removal, and non-preemptible synchronous cleanup;
- no dispatch after a queued microtask's deadline, timeout signal abortion,
  release of every managed timer/listener and preservation of primary failures.

These are deterministic source-level tests on the real registry, not provider
network traffic or installed target-export evidence.

## Workspace regression evidence

- All 20 packages passed the final sequential `pnpm build` before emitted-entry
  tests. Core source typechecking and whole-workspace `tsc --noEmit` passed.
- Full unit regression: **800 tests / 65 suites passed**.
- Core package regression: **503 tests / 30 suites passed**.
- Package graph: 20 packages / 61 edges, zero findings; emitted dependency
  analysis: 68 modules / 137 dependencies, zero violations. Agent boundary passed.
- Core ownership graph: acyclic, 15 groups / 59 edges.
- Runtime boundary scan: 13 Universal/Browser packages, 229 source/emitted files,
  zero findings. This is not Edge-host execution of the new internal helpers.
- Core-capability/API contract passed against the unchanged I2 declaration
  snapshot. Strict NodeNext and base Web declarations pass. The same two tracked
  upstream MCP `Buffer` errors remain unresolved, so full-Web is not passing.
- Documentation gate: 49 Markdown files / 20 package READMEs, zero findings.

Exporter lifecycle tests use controlled clocks even for successful startup, so
their intentionally short failure budgets do not depend on machine load.

## Retained failures and corrections

1. The first exporter capture suite had two fixture defects: proxy metadata counts
   included later operational `calls` writes, and a negative shutdown-getter test
   reread that getter in its assertion. Assertions now measure capture before
   execution and retain the original shutdown spy. No product rule was relaxed.
2. Root typechecking found a helper's inferred return type referencing workspace
   symlink types; explicit source-owned fixture return types fixed it. A later
   test helper inferred mock-specific `undefined` cleanup signatures; it now
   uses the real structural provider interface and synchronous `() => void`
   cleanup contract rather than requiring production types to match a mock.
3. A targeted final-activation cancellation test reproduced an incorrect
   `stage: preflight` despite owned provider cleanup. The product now classifies
   that late boundary as `activation`; the regression passes with cleanup retained.

## Still required

The public `createAgentRuntime` constructor does not yet use these internal
pieces. Its resource/observability option preflight, canonical plugin delivery
bridge, per-item acknowledgments, run-terminal staging/checkpoints, final health
and diagnostics, closed no-op loggers, bound agents/sessions/teams, and complete
close orchestration remain open. The exporter owner manages lifecycle only; it
does not claim delivery or durability for an event/run record.

The new capability types/helper are not publicly emitted yet. Their full target
declaration parity and installed provider/exporter conformance are later I3/I5
evidence, not proven by source tests. No public stub runtime, alternate facade,
ambient Node shim or waiver was added. Live Codex and human-built application
acceptance remain required later in the full ledger; no publication occurred.
