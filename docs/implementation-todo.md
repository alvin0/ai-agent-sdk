# Monorepo and Observability Implementation TODO

Status: ready to execute  
Design inputs: [monorepo implementation](./monorepo-implementation-design.md), [observability implementation](./observability-implementation-design.md)  
Evidence baseline: [implementation spikes](./implementation-spike-evidence.md)

## How to use this backlog

Execute tasks in ID/dependency order. Do not combine commit gates: each gate must pass before the next task starts. Every completed task records its commit ID and a short command-output summary in the evidence table at the end.

Defaults in the design are decisions, not suggestions. If an external precondition fails (for example npm scope ownership), stop only that release task; do not rename packages or weaken a runtime/security gate. No production package is published before R3.

## Phase S — Resolved spikes and baseline

- [x] **S0 — Audit current package/dependency/runtime surface.** Evidence: 11 public entries; 3 production lock records; 153 dev-only lock records; Node leaks and source cycles recorded.
- [x] **S1 — Verify real Codex route.** `codex + gpt-5.6-luna` integration stream passed and asserted positive input/output usage.
- [x] **S2 — Verify human CLI execution path.** Found `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` before dispatch; task F1 owns the fix.
- [x] **S3 — Strict Worker MCP/A2A spike.** MCP HTTP passed without `Buffer`/`process`; A2A binary failed at upstream `Buffer.from`. Runtime classifications are closed.
- [x] **S4 — Close dependency/toolchain versions.** Exact versions and pnpm security configuration are recorded in the designs.
- [x] **S5 — Re-run current deterministic checks.** Typecheck passed; unit suite exposed one pre-existing OS-path assertion (470/471 passed), now owned by F0.

## Phase F — Freeze behavior and fix the executable baseline

### F0 — Capture the pre-migration contract

Dependencies: S0–S5  
Files: `tests/contract/**`, `tests/fixtures/public-api/**`, `docs/public-api-baseline.md`

- [x] Snapshot all current public exports and type signatures for the 11 subpaths.
- [x] Add import/behavior tests for model registry, providers, agent modes, skills, MCP, A2A, and request logger.
- [x] Make agentcode `list_files`/`grep_files` return POSIX-style relative paths on every OS and replace the hard-coded Windows-only assertion; test the contract on Linux and Windows.
- [x] Add fixture adapters for success, retry-before-output, partial-stream failure, missing usage, abort-before-dispatch, and abort-after-dispatch.
- [x] Record current error codes and JSON snapshot formats. Mark intentional observability shape changes separately.

Verify:

```sh
npm test
npm run typecheck
npm run build
npm pack --dry-run --json
```

Exit evidence: baseline tests pass; public API snapshot is committed; no architecture change.  
Commit: `test: freeze pre-monorepo public contracts`

### F1 — Make every current CLI executable without Node strip-only assumptions

Dependencies: F0  
Files: `src/**/*.ts`, `test-human/**`, `scripts/**`, package scripts

- [x] Remove TypeScript parameter properties from direct `node *.ts` source closures, including `StreamAbortError`, or build CLIs to JavaScript and execute built output.
- [x] Choose the design default: build CLI JavaScript; source rewrites are still allowed where trivial.
- [x] Add `--help`/`--dry-run` smoke tests that run through the same command users execute.
- [x] Assert a dry run makes no network or credential writes.

Verify:

```sh
npm run human -- --dry-run --provider codex --model gpt-5.6-luna
npm run provider:codex:status
```

Exit evidence: both commands exit with their documented status; no unsupported TypeScript syntax.  
Commit: `fix: compile executable cli entrypoints`

## Phase W — Workspace foundation

### W0 — Create the private pnpm/Turbo workspace

Dependencies: F1  
Files: root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`, `.changeset/**`, shared tsconfigs, `scripts/build-config.ts`

- [x] Add every exact catalog pin from the monorepo design, including `pnpm@11.25.0`, Turbo `2.10.12`, Changesets `3.0.1`, publint `0.3.24`, ATTW `0.18.5`, dependency-cruiser `18.2.0`, Playwright `1.62.1`, Wrangler `4.127.1`, OpenTelemetry API development peers, and the existing exact compiler/test tools.
- [x] Add all security settings exactly as specified, including an initially empty `allowBuilds`, strict release age, no-downgrade trust, untrusted lockfile verification, registry-only transitive sources, strict catalog, and workspace cycle rejection. The audited `esbuild`/`workerd` exceptions are recorded in `docs/dependency-policy.md`.
- [x] Generate one reviewed lockfile from a clean install. Do not remove `package-lock.json` yet.
- [x] Add shared Universal and Node tsconfigs and shared build factory.
- [x] Add Changesets fixed group with every planned public package name, initially private.

Verify:

```sh
pnpm install --frozen-lockfile
pnpm config get minimumReleaseAge
pnpm config get trustPolicy
pnpm config get strictDepBuilds
```

Exit evidence: clean frozen install passes with no unreviewed build script; config values match design.  
Commit: `build: establish secured pnpm workspace`

### W1 — Add graph and runtime-boundary enforcement

Dependencies: W0  
Files: `scripts/check-package-graph.mts`, `scripts/check-runtime-boundaries.mts`, dependency-cruiser config, lint config, CI

- [x] Enforce package edge allowlist and fail type-only cycles too.
- [x] Reject Node builtins, `Buffer`, `process`, `__dirname`, and `__filename` in Universal source and emitted closure.
- [x] Reject undeclared package imports and imports through another package's internal path.
- [x] Make runtime/graph checks Turbo tasks and required CI checks.
- [x] Add lockfile-only supply-chain check for integrity, registry-only sources, exact direct runtime versions, install scripts, reviewed runtime licenses, and high/critical production advisories; document any exception with package/version/owner/expiry.

Verify:

```sh
pnpm check:graph
pnpm check:runtime-boundaries
```

Exit evidence: checks pass on baseline allowlist and fail intentional negative fixtures.  
Commit: `build: enforce package and runtime boundaries`

## Phase C — Core contracts and package

### C0 — Break the core internal cycle

Dependencies: W1  
Files: current `src/core/runtime/settlement.ts`, all importers

- [x] Move bounded settlement to inward `core/async` ownership.
- [x] Update registry, stream, retry, MCP, agent, and provider imports.
- [x] Prove the core directory graph is acyclic.

Verify: core unit tests, typecheck, graph check.  
Exit evidence: no `core/runtime` ↔ `core/stream` edge.  
Commit: `refactor(core): move async settlement primitive inward`

### C1 — Implement observation, usage, and provider-plugin contracts

Dependencies: C0  
Files: `packages/core/src/observation/**`, `packages/core/src/plugin/**`, registry/adapter contracts

- [ ] Implement exact event envelope, fallback IDs, correlation context, synchronous `openSpan`/idempotent span handle, capture receipt, and delivery mode.
- [ ] Implement usage counters, attempt/call report, validation, saturation, and coverage classifier.
- [ ] Implement transactional `ModelRegistry.install(ModelProviderPlugin)` with a staging registrar: no live mutation/listener notification before atomic commit, full discard on setup failure, duplicate plugin/route rejection, contained listener errors, and reverse cleanup with stable install/cleanup error codes.
- [ ] Add explicit `ModelInvocationContext` propagation through registry, prepared calls, middleware, and adapters.
- [ ] Return `ModelCallHandle` with a report promise while retaining async-iterable compatibility.

Verify: contract tests for IDs, sequence, plugin rollback/disposal, direct-call reports, and no sink.  
Exit evidence: public types match design; no concrete observability import.  
Commit: `feat(core): add observation accounting and provider plugin ports`

### C2 — Extract `@ai-agent-sdk/core`

Dependencies: C1  
Files: `packages/core/**`

- [ ] Move core source except SSE parser.
- [ ] Create exact manifest/exports/readme/license/build config.
- [ ] Remove all external runtime dependencies.
- [ ] Pack and install the tarball into standards-only, Worker, browser, and Node fixtures.

Verify:

```sh
pnpm --filter @ai-agent-sdk/core build
pnpm --filter @ai-agent-sdk/core test
pnpm --filter @ai-agent-sdk/core pack
pnpm check:runtime-boundaries
```

Exit evidence: packed Universal matrix passes; tarball has zero runtime dependencies.  
Commit: `refactor(core): extract universal core package`

## Phase A — Agent and canonical ledger

### A0 — Break the local-team cycle and naming ambiguity

Dependencies: C2  
Files: current `src/agent/a2a/**`, define/session imports

- [ ] Rename local orchestration to `agent/team`.
- [ ] Introduce structural `TeamSessionPort` and inward team contracts.
- [ ] Keep deprecated export aliases for current names.
- [ ] Prove define/session no longer depends on concrete team implementation.

Verify: agent/team unit tests and graph negative fixtures.  
Exit evidence: agent internal graph has no define↔team cycle.  
Commit: `refactor(agent): separate local teams from a2a protocol`

### A1 — Implement run ledger and run handles

Dependencies: A0, C1  
Files: `packages/agent/src/accounting/**`, run-turn, run-agent, session, events/outcomes

- [ ] Implement exact operation state machine and resource limits.
- [ ] Replace zero-initialized missing usage with required `usageReport`; make legacy `usage` optional and authoritative-only.
- [ ] Implement `AgentRunHandle`, terminal report resolution, and internal closure independent of public event consumption.
- [ ] Add usage policy `warn`/`estimate`/`fail`: with cumulative `maxTotalTokens`, warn stops before another dispatch using `usage-unavailable`, estimate controls only missing portions, and fail preserves the report before raising `USAGE_REQUIRED`.
- [ ] Instrument turn, tool, compaction, hook, user-input/approval wait, skill, memory, credential, and integration boundaries with exactly one terminal state and safe default fields.
- [ ] Close open operations as unknown with stable error code; test duplicate/orphan terminal detection.

Verify: all usage/state-machine cases in the observability design.  
Exit evidence: no successful run can render missing usage as zero; consumer-stop report resolves.  
Commit: `feat(agent): add canonical run ledger and usage coverage`

### A2 — Extract `@ai-agent-sdk/agent`

Dependencies: A1  
Files: `packages/agent/**`

- [ ] Move all agent source except filesystem skill.
- [ ] Depend only on core.
- [ ] Pack and run mock provider/tool/compaction/team flows in Worker and browser fixtures.

Exit evidence: graph and packed Universal gates pass.  
Commit: `refactor(agent): extract universal agent package`

## Phase P — HTTP, protocols, and providers

### P0 — Extract provider HTTP and isolate SSE

Dependencies: C2  
Files: `packages/provider-http/**`

- [ ] Move HTTP base, errors, configurable provider, SSE parser.
- [ ] Move env lookup out; accept injected credentials only.
- [ ] Exact-pin `eventsource-parser@4.1.0` in this package and nowhere else.
- [ ] Add provider-attempt start/end, success/error request ID capture, dispatch-state classification, audit pre-dispatch checkpoint, reliable/audit terminal checkpoint, and safe origin metadata.
- [ ] Deprecate legacy exact-wire request logger in favor of observation; preserve one compatibility bridge.

Verify: HTTP success/error/retry/abort/resource-limit/audit tests; dependency grep.  
Exit evidence: every fetch invocation has an attempt report; no other package resolves eventsource-parser directly.  
Commit: `feat(provider-http): extract fetch pipeline and attempt accounting`

### P1 — Extract wire protocol packages

Dependencies: P0  
Files: protocol package directories

- [ ] Move Anthropic wire/serializer/translator/dialect into one package.
- [ ] Move Responses/Codex wire/serializer/translator/dialect into one package.
- [ ] Delete provider↔protocol cycles and internal cross-imports.
- [ ] Preserve fixtures for malformed/partial usage and protocol-specific omitted-cache semantics.

Exit evidence: both packed Universal packages depend only on core and pass translator/serializer suites.  
Commit: `refactor(protocols): extract provider wire packages`

### P2 — Extract provider plugins

Dependencies: P1  
Files: provider-anthropic/openai/codex packages

- [ ] Export low-level adapters and preferred plugin factories.
- [ ] Split Codex auth contract from filesystem/path/env implementation.
- [ ] Require injected Codex auth store in Universal package.
- [ ] Instrument catalog and credential operations with safe events.
- [ ] Keep OAuth tokens and account details outside event/log fields.

Verify: mock provider suites; plugin transaction tests; packed Worker/browser tests.  
Exit evidence: provider packages are Universal and contain no Node global/builtin references.  
Commit: `refactor(providers): extract universal provider plugins`

## Phase O — Concrete observability

### O0 — Implement Universal bus, processors, logger, health, and test exporter

Dependencies: C2, A2  
Files: `packages/observability/**`

- [ ] Implement exact queue defaults, sync processor order, protected health path, priority eviction, flush/shutdown.
- [ ] Implement required/best-effort exporter registration and validate that reliable/audit have at least one honest non-memory durability boundary; checkpoint waits for every required exporter only.
- [ ] Implement privacy policy, secret/header redaction, depth/size/cardinality limits.
- [ ] Implement scoped logger and safe errors; remove direct runtime `console.*` calls.
- [ ] Implement trace/log/metric projections and in-memory/test exporters.
- [ ] Prove checkpoint drains prior critical events through its sequence boundary; reliable failure preserves the result with incomplete delivery, while audit failure follows the documented pre/post-dispatch behavior without provider replay.

Exit evidence: deterministic queue/privacy/health/lifecycle tests pass in Worker and browser.  
Commit: `feat(observability): add universal bus logging and health`

### O1 — Implement Fetch/Edge exporter

Dependencies: O0  
Files: `packages/observability-fetch/**`

- [ ] Implement exact batch/ack/idempotency protocol and retry classification.
- [ ] Add HTTPS/origin/redirect validation and injected fetch.
- [ ] Add `waitUntil` helper without assuming a global platform object.

Exit evidence: fake-server tests prove identical retry batch IDs and no provider re-dispatch.  
Commit: `feat(observability-fetch): add acknowledged edge exporter`

### O2 — Implement Browser IndexedDB durability

Dependencies: O0  
Files: `packages/observability-browser/**`

- [ ] Implement schema, transactions, recovery, limits, priority behavior, and opt-in lifecycle.
- [ ] Test quota, blocked upgrade, crash/reopen, duplicate IDs, and audit checkpoint.

Exit evidence: packed Chromium tests pass with browser restart simulation.  
Commit: `feat(observability-browser): add indexeddb delivery queue`

### O3 — Implement Node journal and diagnostic wire log

Dependencies: O0  
Files: `packages/observability-node/**`

- [ ] Implement symlink-safe unique per-process segments, permissions, exact payload-string checksum framing, modes/fsync, rotation, 1 GiB/7-day acknowledged-only retention, recovery, quarantine, cursor, and cleanup.
- [ ] Implement explicit Node lifecycle helper and idempotent disposer.
- [ ] Move exact-wire logger behind `content: full` + `allowWireBodies: true` hard opt-in.

Exit evidence: filesystem fault-injection/recovery tests pass on Linux; platform-specific permission assertions are conditional but behavior is never silently skipped.  
Commit: `feat(observability-node): add durable journal and diagnostics`

### O4 — Implement OpenTelemetry bridge

Dependencies: O0  
Files: `packages/observability-otel/**`

- [ ] Map internal events to caller-supplied tracer/meter/logger APIs.
- [ ] Open actual tracer spans synchronously, return their IDs to SDK correlation, preserve explicit logical call/retry parent topology without AsyncLocalStorage, and flag no-op/invalid tracer contexts.
- [ ] Enforce content opt-in and usage-source distinction.
- [ ] Pin semantic mapping fixtures to the selected upstream commit.

Exit evidence: golden spans/metrics/logs pass; bridge installs no global provider and performs no network I/O.  
Commit: `feat(observability-otel): add semantic convention bridge`

## Phase I — Integration protocols

### I0 — Extract and prove MCP HTTP Universal package

Dependencies: A2, W1  
Files: `packages/mcp/**`, strict Worker fixture

- [ ] Move HTTP client/server bridge and direct MCP dependencies.
- [ ] Convert the committed spike into a packed-package test.
- [ ] Test initialize, list tools, call tool, abort, auth state, and bounds with Node globals removed.

Exit evidence: strict Worker and Chromium round-trips pass.  
Commit: `refactor(mcp): extract universal http bridge`

### I1 — Extract A2A as Node-elevated package

Dependencies: A2, W1  
Files: `packages/a2a/**`, A2A spike

- [ ] Move official A2A client/server bridge and declare Node runtime honestly.
- [ ] Keep text/data/url/binary tests; binary must pass in Node.
- [ ] Keep the strict Worker binary test as a promotion guard and expect it to fail only in a labelled negative fixture.

Exit evidence: Node suite passes; manifests/docs do not claim Universal.  
Commit: `refactor(a2a): extract node-elevated protocol bridge`

## Phase N — Node capabilities

### N0 — Extract granular Node packages

Dependencies: A2, P2, O3, I0  
Files: `packages/auth-node/**`, skill-filesystem, mcp-node

- [ ] Extract filesystem skill.
- [ ] Implement `@ai-agent-sdk/auth-node` with env credential resolver, project-local Codex auth store using atomic writes/`0600` target mode, and Codex Node plugin/adapter wrappers.
- [ ] Build the auth-node Codex login CLI to JavaScript.
- [ ] Extract MCP stdio/Node HTTP package against the already extracted Universal MCP contracts.

Exit evidence: no Node implementation leaks back into Universal package closures; Node packed tests pass.  
Commit: `refactor(node): extract filesystem auth env and mcp capabilities`

### N1 — Create full `@ai-agent-sdk/node` facade

Dependencies: N0, I1, O1–O4  
Files: `packages/node/**`

- [ ] Re-export core, agent, providers, observability/fetch/node/OTel, filesystem, MCP, and A2A capabilities through documented subpaths; do not pull browser-only IndexedDB lifecycle code into the Node facade.
- [ ] Default Codex Node plugin to project-local isolated auth, never the Codex CLI global file.
- [ ] Add one full harness smoke using filesystem skill, provider mock, journal, and MCP stdio fixture.

Exit evidence: one-package Node consumer works from tarball and no duplicate SDK core instance exists.  
Commit: `feat(node): add batteries-included node facade`

## Phase V — Provider/observability live acceptance

### V0 — Re-run the real Codex acceptance after provider and observability extraction

Dependencies: P2, O0, N0  
Files: integration tests only

- [ ] Use project-local Node auth-store wrapper with provider-codex.
- [ ] Run exactly one filtered successful `gpt-5.6-luna` stream.
- [ ] Assert run/model/attempt correlation, provider request ID when supplied, complete positive usage, and healthy observation delivery.
- [ ] Keep exact-wire content logging disabled.

Verify:

```sh
pnpm vitest run --config vitest.integration.config.ts \
  -t "streams text and assembles a message" --reporter=verbose
```

Exit evidence: selected live case passes; safe report snapshot is stored as CI artifact, not committed credentials/content.  
Commit: `test(provider-codex): verify live luna accounting`

## Phase K — Compatibility and package cutover

### K0 — Build `ai-agent-sdk` compatibility facade

Dependencies: all C/A/P/O/V/I/N tasks  
Files: `packages/sdk/**`

- [ ] Re-export all current subpaths to their new package owners.
- [ ] Keep regular facade dependencies limited to Universal core/agent/HTTP/protocol packages; declare every legacy leaf target as an optional peer so root-only installation cannot pull Node packages.
- [ ] Keep root `.` import closure Universal and document the exact optional peer install command for every legacy subpath.
- [ ] Remove the Node-only `apiKeyFromEnv` root symbol, preserve it as a deprecated alias in auth-node/node, and record this sole required root-symbol break in migration/type fixtures.
- [ ] Add `./node`; document runtime of each subpath.
- [ ] Run frozen F0 public API fixtures and list every intentional type change.

Exit evidence: root-only tarball install contains no Node-only dependency; a second fixture installs optional peers and proves every current import path.  
Commit: `refactor: switch compatibility facade to workspace packages`

### K1 — Remove old source and npm lock

Dependencies: K0  
Files: old root `src/**`, old build config, `package-lock.json`

- [ ] Delete only files proven replaced by package ownership.
- [ ] Remove obsolete root entry config and npm lock.
- [ ] Fresh clone/frozen pnpm install/build/test.

Exit evidence: no duplicate runtime implementation or stale import remains.  
Commit: `build: complete pnpm monorepo cutover`

## Phase E — `eventsource-parser` ownership decision before 1.0

### E0 — Build an owned parser candidate as a non-production spike

Dependencies: P0  
Files: `spikes/sse-parser/**`, SSE conformance fixtures

- [ ] Implement the WHATWG field/line state machine with non-fatal streaming UTF-8 `TextDecoder`; default bounds are 256 KiB pending line, 1 MiB assembled event data, and 1 MiB total undecoded/pending storage, with typed resource-limit failure.
- [ ] Cover start-only BOM, CR/LF/CRLF split boundaries, split/invalid UTF-8 replacement, comments/activity, multiline data, event/id/retry, NUL in ID, digit-only retry, unknown fields, empty values, EOF truncation, cancellation, and hostile long lines.
- [ ] Differential-test at least 100,000 generated chunk partitions against exact-pinned parser where behavior is intended to match.
- [ ] Fuzz at least 1,000,000 deterministic seeds under memory/time bounds.
- [ ] Benchmark representative streams; candidate may not regress throughput or peak memory by more than 20% without a documented security/correctness reason.

Exit evidence: reproducible report includes seed corpus and every semantic difference.  
Commit: `spike(sse): evaluate owned event stream parser`

### E1 — Apply deterministic keep/replace rule

Dependencies: E0

- [ ] Replace the dependency only if every conformance, differential, fuzz, resource, cancellation, and provider integration gate passes and code review finds no weaker bound.
- [ ] Otherwise keep exact-pinned `4.1.0`, archive the failing evidence, and retain all supply-chain controls. Do not merge an almost-compatible parser.
- [ ] If a high/critical advisory affects the pinned version before the candidate qualifies, suspend release; do not auto-upgrade or bypass the gate.

Exit evidence: dependency graph and ADR record one outcome with test evidence.  
Commit: `security(sse): finalize parser ownership decision`

## Phase R — Full verification and release

### R0 — Full deterministic matrix

Dependencies: K1, E1

- [ ] Frozen install, lint, typecheck, unit, contract, graph, runtime boundary, build.
- [ ] Pack every public package; run publint and ATTW on tarballs.
- [ ] Install tarballs in Worker, Chromium, oldest supported Node, and current Node fixtures.
- [ ] Run journal/IndexedDB crash recovery and audit fail-closed tests.
- [ ] Run `pnpm audit --prod`; triage every finding.

Verify:

```sh
pnpm install --frozen-lockfile
pnpm turbo run lint typecheck test:unit test:contract build
pnpm check:graph
pnpm check:runtime-boundaries
pnpm test:pack
pnpm test:edge
pnpm test:browser
pnpm test:node
pnpm audit --prod
```

Exit evidence: every required task is green from a clean checkout.  
Commit: `test: complete monorepo runtime and package matrix`

### R1 — Live provider acceptance

Dependencies: R0

- [ ] Check project-local Codex status without printing account/token details.
- [ ] Run filtered `gpt-5.6-luna` success case.
- [ ] Verify usage coverage complete, positive counters, terminal closure, correlation, and exporter health.
- [ ] Run no additional costly live cases unless the selected test fails and diagnosis requires one retry.

Exit evidence: safe live acceptance summary attached to release artifacts.  
Commit: `test: verify release candidate against codex luna`

### R2 — Documentation and self-audit

Dependencies: R1

- [ ] Update package READMEs with runtime labels and explicit installation examples for Edge/browser/full Node.
- [ ] Run the requirements checklist below and search release-facing docs for `TBD`, placeholder, runtime-unverified, contradictory package names, or stale dependency counts.
- [ ] Verify every documented command against the release candidate.

Exit evidence: zero unresolved documentation finding.  
Commit: `docs: finalize package runtime and observability guidance`

### R3 — Scope preflight and prerelease

Dependencies: R2

- [ ] Verify authenticated npm identity and `@ai-agent-sdk` scope publish rights without exposing tokens.
- [ ] Remove `private: true` only from publishable packages in one reviewed commit.
- [ ] Changesets prerelease, provenance publish, then fresh registry install smoke.
- [ ] If scope ownership fails, leave packages private and stop R3. Do not rename or publish under an unreviewed scope.

Exit evidence: provenance-backed prerelease packages install and pass Edge/Node smoke.  
Commit: `release: publish monorepo prerelease`

## Requirements self-audit checklist

- [ ] Edge/browser users can install only Universal packages and run a harness without Node APIs.
- [ ] Full Node users have one facade and granular capabilities.
- [ ] Provider extensions install explicitly through a transactional core plugin contract.
- [ ] Adding filesystem/env/stdio/journal/A2A capability elevates runtime visibly.
- [ ] Core and agent remain Universal and do not fork their execution loop.
- [ ] Every model/provider/tool/compaction/integration operation has terminal tracking.
- [ ] Missing usage is never numeric zero and possibly billed retries are counted.
- [ ] Logs, traces, metrics, and ledger are correlated but have distinct semantics.
- [ ] Privacy defaults exclude content and secrets before exporter fan-out.
- [ ] Observer/exporter failures are visible through health and delivery reports.
- [ ] Operational/reliable/audit claims match actual queue/durability behavior.
- [ ] Exact request-body logging is disabled by default and hard opt-in.
- [ ] `eventsource-parser` is isolated, pinned, and either replaced by a fully qualified parser or retained with evidence.
- [ ] MCP is proven Universal and A2A is not falsely advertised as Universal.
- [ ] Real Codex `gpt-5.6-luna` acceptance passes on the release candidate.
- [ ] Packed package tests, not source aliases, prove the published artifacts.
- [ ] No runtime/package cycle, undeclared import, Node leak, open decision, or unreviewed install script remains.

## Completion evidence table

Fill this during implementation; do not mark the implementation complete with blank required rows.

| Gate | Commit | Evidence summary |
|---|---|---|
| F baseline and CLI |  |  |
| W workspace/security |  |  |
| C core |  |  |
| A agent/ledger |  |  |
| P/V providers and live spike |  |  |
| O observability/exporters |  |  |
| N/I Node/MCP/A2A |  |  |
| K compatibility cutover |  |  |
| E SSE ownership |  |  |
| R deterministic matrix |  |  |
| R live Luna acceptance |  |  |
| R docs/scope/prerelease |  |  |
