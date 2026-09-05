# I3 progress — Platform resources and operation quiescence

Date: **2026-09-05** (Asia/Ho_Chi_Minh).

Status: **Partial implementation; public composition-runtime integration remains open.**

## Implemented behavior

- `core/src/platform` validates the twelve required Universal features before
  invoking constructors, timers, randomness or clocks. The immutable internal
  adapter captures callable references with original receivers; there is no public
  host-service locator. Missing features produce a bounded `UNSUPPORTED_RUNTIME`
  error rather than copying raw host errors into diagnostics.
- Domain-local configuration bounds timeout values, random-byte requests and
  all-zero random retries. Existing message, session, team, compaction and
  observation IDs now share Web Crypto generation without `Math.random` fallback.
  W3C IDs reject all-zero output; UUIDs set version/variant bits. Observation clocks
  share monotonic validation rather than silently falling back to wall time.
  `Math.random` remains only for retry jitter, not identifiers.
- `RuntimeResources` owns cancellation scopes, removable abort listeners and
  cancelable deadline timers. Ordinary settlement disposes without aborting a
  successful scope. Caller/deadline/owner cancellation releases owned resources;
  raw caller reasons are not propagated.
- `composition/lifecycle` admits all four operation kinds through one state
  gate, composes cancellation, and provides synchronous guarded state commits.
  Close locks admission synchronously, aborts every active lease, waits within one
  absolute deadline, and seals unsettled generations. The public-wait helper
  rejects sealed work while containing its later resolution or rejection.
- Quiescence reports contain immutable fixed-order rows, including zeros, with
  `activeAtClose = settled + unsettled`. Legacy run counters derive from the
  `agent-run` row. Repeated/reentrant close calls join the first promise without
  reading later options. Caller abort accelerates quiescence, not resource cleanup.
- The deadline includes time spent in synchronous abort callbacks. Resource
  shutdown is explicitly separate from quiescence so provider cleanup and
  observation delivery can run afterward.
- Provider activation now preserves `PROVIDER_CLEANUP_ASYNC_UNSUPPORTED` in both
  normal close and construction rollback. It no longer loses that distinction
  behind the registry's generic cleanup exception.
- All four concrete runtime operation paths now honor generation sealing. Catalog
  writes use the lease's synchronous publish guard. Manual compaction and team
  sends expose only the lease-raced public result, while compaction checks its
  aborted signal before history replacement and linked sends suppress late
  transport results/events. Agent streams additionally seal their internal
  ledger, resolve one canonical support-safe report, reject result with that same
  report and settle session idleness even when a model iterator ignores abort.
  An open model operation correctly makes the sealed report `unknown` rather
  than falsely claiming complete aborted accounting.
- Runtime close stops observation admission as soon as it rejects new work,
  aborts and quiesces/seals every lease, and only then begins reverse team and
  provider cleanup. Provider cleanup tests observe `closing` with zero active
  leases. Late model, catalog, compaction and linked-team values cannot change
  cache, public result/report, diagnostics or application team events.

The five new platform/lifecycle implementation modules are at most 172 lines;
all twelve platform/composition modules are at most 193 lines. Modified existing
agent implementation files remain within the 700-line requirement. The extracted
`session/run-seal.ts` is 44 lines and `agent/define/session.ts` is exactly 700.

## Verification

- `pnpm exec vitest run tests/unit/composition`: 109 tests / five suites passed.
  This includes 23 platform/resource tests, 16 operation lifecycle tests and two
  additional provider tests compared with the earlier 68-test foundation.
- A lifecycle/provider integration test uses the real `ModelRegistry`: runtime
  cancellation occurs while routes remain installed, generations seal next,
  then registrations close in reverse order. Each cleanup sees its own topology
  already removed and cannot commit a late catalog write.
- `pnpm build`: all 20 workspace packages built sequentially before tests that
  import emitted package entries.
- `pnpm exec vitest run tests/unit`: 748 tests / 62 suites passed after that build.
- Core package tests: 451 tests / 27 suites passed.
- Core source typecheck and root `tsc --noEmit`: passed.
- Package graph: 20 packages / 61 edges, zero findings. Dependency analysis:
  68 modules / 137 dependencies, zero violations. Agent boundaries passed.
- Core ownership graph: acyclic, 15 groups / 57 edges.
- Runtime boundaries: 13 Universal/Browser packages, 220 source/emitted files,
  zero findings. This alone is not actual Edge execution evidence.
- Core-capability contract gate: passed with the unchanged I2 emitted declaration
  snapshot. Strict NodeNext and base Web declarations pass; the two tracked
  upstream MCP `Buffer` declaration errors still prevent a full-Web pass.
- `timeout 120s pnpm --filter @ai-agent-sdk/core test:pack`: passed. The freshly
  packed core was installed into isolated standard-global, Node, Chromium and
  workerd consumers. Browser/workerd fixtures verify trace IDs, call success and
  exact usage without `Buffer` or `process`. These fixtures exercise the existing
  public core registry/observation paths, not the unexported composition helpers.
  Artifact: `packages/core/artifacts/ai-agent-sdk-core-0.1.0.tgz` (local only;
  nothing was published), SHA-256
  `237e748c8c0263dd82d7a25440e47848099d3d03356e0cf63aeb60b31960f700`.
  The browser fixture imports the installed emitted entry
  directly, so it is not proof of the complete target conditional-export map.
- Documentation gate: 48 Markdown files / 20 package READMEs, zero findings.
  `git diff --check`: passed.
- The current concrete close matrix passes **41 focused tests / four suites**;
  the complete composition suite passes **417 tests / 36 suites** and the full
  unit suite passes **1,062 tests / 94 suites**. Strict `tsc --noEmit` and a clean
  `@ai-agent-sdk/core` build pass.

## Retained failures and fixes

1. Initial platform tests: three failed because a shadow global inherited Node's
   receiver-sensitive `crypto` getter. The fixture now obtains `crypto` and
   `performance` on the real global and supplies their values explicitly. The
   product continues to capture callable methods with their original receivers.
2. Initial lifecycle root typecheck: a deliberately unread options getter returned
   explicit `undefined`, incompatible with `exactOptionalPropertyTypes`. The
   fixture now returns a valid signal; compiler strictness was not relaxed.
3. A targeted regression test reproduced an abort-order defect: with an
   already-aborted close caller, the first cooperative settlement could seal and
   remove later leases' root listeners before they received cancellation. The
   test failed with a remaining signal still un-aborted. Quiescence evaluation now
   waits until synchronous root abort dispatch finishes. The regression passes.
4. The first concrete uncooperative-run regression showed runtime close reporting
   one sealed unsettled run while both public `result` and `report` remained
   pending until the fake adapter was manually released. An internal run-seal
   path now finalizes the ledger once, closes the event buffer and settles both
   public artifacts without waiting for the late iterator.
5. The first strengthened report oracle expected `aborted`; the actual sealed
   report was `unknown` because a model-call operation had no terminal event.
   That is the required integrity behavior. The test now requires `unknown`, the
   support-safe `RUNTIME_OPERATION_ABORTED` error and result/report object
   identity, without weakening the missing-terminal evidence.

## Scope still outstanding

The public runtime now connects these foundations to agent, model-catalog,
compaction and team entrypoints, and platform preflight precedes plugin metadata
and allocation. Exporter identity/readiness, startup rollback, provider component
status, final observation flush/health, closed-no-op loggers and the terminal
close report are implemented in the linked I3 evidence increments.

Legacy native timers have not all been migrated to `RuntimeResources`; that
timer-ownership work and later provider/capability package closure remain outside
this verified operation-generation seal.

No live provider, autonomous deep-search, full target tarball topology or human-built
website/application acceptance is claimed. I3 and the complete implementation
goal remain open.
