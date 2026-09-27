# Research spikes

Current decisions and gates: [spike closeout](../../docs/plans/ai-agent-sdk_spike_closeout_2026-09-26.md).

These scripts create unique timestamped directories under `artifacts/spikes`. They do not export production adapters or modify active user skills. Node 24.9.0 was tested; SQLite scripts use experimental `node:sqlite`.

Install the isolated research executor dependencies and pinned container image first:

```sh
rtk proxy npm install --prefix artifacts/spikes/quickjs-dependencies-v1 --ignore-scripts --no-audit --no-fund --save-exact quickjs-emscripten@0.32.0
rtk proxy docker pull node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
```

```sh
rtk proxy node --experimental-strip-types test-human/spikes/prepare-ptc.ts
rtk proxy node --experimental-strip-types test-human/spikes/ptc-probe.ts
rtk proxy node --experimental-strip-types test-human/spikes/ptc-root-relay.ts
rtk proxy node --experimental-strip-types test-human/spikes/durable-operation.ts
rtk proxy node --experimental-strip-types test-human/spikes/scoped-recall.ts
rtk proxy node --experimental-strip-types test-human/spikes/process-environment.ts
rtk proxy node --experimental-strip-types test-human/spikes/skill-proposal.ts
```

`prepare-ptc.ts` freezes 12 exposed development workloads; it is not conformance. `ptc-probe.ts` exercises a real QuickJS/WASM worker and reproduces a root-budget counterexample using fresh child sessions. A passing counterexample check means the candidate architecture is rejected. `ptc-root-relay.ts` tests six focused invariants with child requests lowered into the same root run. It does not implement full outer program lifecycle, model-history projection, MCP metadata or structured handle ownership. Neither script permits a live PTC utility benchmark.

`durable-operation.ts` uses actual AgentRuntime/session/interceptor execution, SQLite persisted intent and generation/owner CAS, separate SIGKILL workers, a service without mutation deduplication, independent receipt reconciliation, pending approval restart and HTTP delivery disconnect. Local process safety is not distributed exactly-once or full session-stack durability. Retention/migrations remain host work.

`scoped-recall.ts` joins SQLite keyword index hits to current authorized source revisions. Opaque references expire and are invalidated by revocation, revision change, undo/delete or close. Index lag may cause misses; no semantic retrieval efficacy claim.

`process-environment.ts` routes finite host-owned command modes through SDK execution backends to real local processes and restricted containers. Local execution retains host filesystem/network access. Container names are unique and cleanup targets only those owned by the harness. Missing container capability fails closed. Daemon failure is still a best-effort cleanup limitation; no arbitrary closure serialization, PTY or remote persistence.

`skill-proposal.ts` keeps learner draft authority separate from host publish/rollback. Source authority and target revision are checked at commit. The fixed numeric validator is illustrative, not evidence for general prompt/skill efficacy. Keep proposal-only until a consumer has independent held-out evidence.

`fixture-runtime.ts` supplies deterministic model blocks through actual AgentRuntime sessions. Scripted rounds do not represent remote model usage or quality. Broad frozen live regression remains in `../evaluation`; never rewrite its scores using development spike results.

Latest [result review](../../docs/plans/ai-agent-sdk_spike_improvement_2026-09-26.md) retains the failing pre-fix controls and new evidence separately. Guest bridge errors and cap exhaustion latch terminal failure even when guest code catches exceptions; request IDs reject stale replies.
