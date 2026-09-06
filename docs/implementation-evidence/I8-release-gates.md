# I8 deterministic release-gate evidence

> Historical evidence: the migration-only core-capability contract and benchmark
> commands recorded below were retired after implementation completed. This file
> preserves the reviewed 2026-09-05 result; it is not the current command runbook.

## Scope

This record covers deterministic release-readiness checks for the 18-package
target topology. Publishing and live provider/network journeys are deliberately
outside this evidence. The registry advisory request in `pnpm check:supply-chain`
also remains a manual network gate; the local integrity/policy gate was run with
`--skip-audit`.

## Verified commands

The following commands passed on 2026-09-05:

```text
pnpm build
pnpm exec tsc --noEmit
pnpm lint
pnpm test:unit                       # 111 files, 1,232 tests
pnpm test:contract
pnpm check:core-capability-contract
pnpm check:boundary-fixtures
pnpm test:packages
pnpm test:pack
pnpm test:edge
pnpm test:browser
pnpm test:node
pnpm test:recovery
node scripts/check-supply-chain.mts --skip-audit
pnpm check:docs
pnpm check:human
pnpm check:installed-consumers
pnpm check:runtime-metadata
```

The final maintainability pass also replaced the 6,151-line contract checker
with a 117-line orchestration entrypoint and domain modules under
`scripts/contracts/core-capability/`. The largest checker module is 691 lines;
no implementation file under `packages`, `scripts`, or `test-human` exceeds the
700-line limit. The refactored checker and full TypeScript build both pass.

The installed-consumer gate packs all target packages without publishing,
installs them with lifecycle scripts disabled, and proves:

- all 18 tarballs contain only declared release paths and every export target;
- 32 public routes compile from installed artifacts under strict NodeNext;
- 20 Universal/Browser routes compile separately under Browser and Workerd
  Bundler conditions with `types: []` and no ambient Node declarations;
- every core peer resolves to one physical installed core;
- overlapping runtime exports across root/subpath routes have value identity;
- installed manifests retain the exact checked source release fields and no
  workspace or package defines a publish lifecycle script.

The contract gate separately proves the frozen 417-symbol migration ledger,
84-symbol provider ledger, exact topology-rendered manifests, supported route
declarations, documentation migration, and public examples. The metadata gate
parses both source and emitted runtime modules and found zero package-manifest
imports, `aiAgentSdk` runtime references, or non-literal runtime loaders across
380 source and 222 emitted files.

## Still open

This evidence does not close the bundle budget. The final benchmark now measures
the implemented public runtime instead of the audit prototype: contract-only is
13,154 gzip bytes and passes the 14,000-byte limit, while the basic public agent
is 96,014 gzip bytes and exceeds the approved 70,000-byte limit. The complete
core runtime payload is 460,199 raw bytes and 124,530 bytes when compressed as
one stable, sorted payload stream, below the 127,739-byte package limit.

Authenticated Edge Internet research is now complete through the real browser /
strict-workerd harness. The direct workerd request to the ChatGPT-backed Codex
endpoint remains a recorded HTTP-403 negative, so the successful acceptance uses
a test-only, loopback-only, fixed-target relay for upstream transport; the agent,
provider protocol, tool loop, evidence ledger, usage accounting, SSE and UI still
execute inside workerd. This relay is not a production recommendation.

`edge-live-relay-luna-15` passed every automated invariant and its independent
semantic review. The recovery acceptance then ran `gpt-5.3-codex-spark` as the
selected model. That primary performed 15 native searches and 28 reads but did
not finish its audit/report within the bounded budget. The runner classified the
model-quality failure, retained its failed artifact and usage, switched to
`gpt-5.6-luna`, and produced a separate passing artifact. The fallback performed
5 native searches, 12 reads across 4 domains and two evidence audits. Audit round
1 rejected a foreign receipt; round 2 repaired traceability and retained four
honest unresolved gaps. Independent review marked the primary `fail` and the
fallback `pass`.

The linked artifact is:

```text
test-human/results/edge-chat-live/edge-live-auto-recovery-16-recovery/summary.json
```

The full gap matrix and explicit no-go decision are recorded in
[I8-final-gap-matrix.md](./I8-final-gap-matrix.md).

The reproducible measurement is now a maintained checker rather than a
development spike:

```text
pnpm check:core-capability-benchmark
```

It intentionally exits non-zero while the approved basic-agent budget remains
unmet, after first writing `.temp/core-capability-benchmark/report.json`.
