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

- [x] Implement exact event envelope, fallback IDs, correlation context, synchronous `openSpan`/idempotent span handle, capture receipt, and delivery mode.
- [x] Implement usage counters, attempt/call report, validation, saturation, and coverage classifier.
- [x] Implement transactional `ModelRegistry.install(ModelProviderPlugin)` with a staging registrar: no live mutation/listener notification before atomic commit, full discard on setup failure, duplicate plugin/route rejection, contained listener errors, and reverse cleanup with stable install/cleanup error codes.
- [x] Add explicit `ModelInvocationContext` propagation through registry, prepared calls, middleware, and adapters.
- [x] Return `ModelCallHandle` with a report promise while retaining async-iterable compatibility.

Verify: contract tests for IDs, sequence, plugin rollback/disposal, direct-call reports, and no sink.  
Exit evidence: 515 deterministic tests passed; typecheck, core ownership graph, package graph, runtime boundary, supply-chain, six negative boundary fixtures, and a 75-file pack dry run passed; public API migration record confirms zero removed runtime exports and no concrete observability implementation import.
Commit: `feat(core): add observation accounting and provider plugin ports`

### C2 — Extract `@ai-agent-sdk/core`

Dependencies: C1  
Files: `packages/core/**`

- [x] Move core source except SSE parser.
- [x] Create exact manifest/exports/readme/license/build config.
- [x] Remove all external runtime dependencies.
- [x] Pack and install the tarball into standards-only, Worker, browser, and Node fixtures.

Verify:

```sh
pnpm --filter @ai-agent-sdk/core build
pnpm --filter @ai-agent-sdk/core test
pnpm --filter @ai-agent-sdk/core pack
pnpm check:runtime-boundaries
```

Exit evidence: 89 core tests and 515 compatibility tests passed; the seven-file ESM tarball installed and ran in independent standards-only, Cloudflare Worker, Chromium, and Node consumers; `publint`, ESM type-resolution, package/source graph, runtime-boundary, supply-chain, and six negative-boundary gates passed with zero findings; the tarball declares zero runtime, optional, or peer dependencies.
Commit: `refactor(core): extract universal core package`

## Phase A — Agent and canonical ledger

### A0 — Break the local-team cycle and naming ambiguity

Dependencies: C2  
Files: current `src/agent/a2a/**`, define/session imports

- [x] Rename local orchestration to `agent/team`.
- [x] Introduce structural `TeamSessionPort` and inward team contracts.
- [x] Keep deprecated export aliases for current names.
- [x] Prove define/session no longer depends on concrete team implementation.

Verify: agent/team unit tests and graph negative fixtures.  
Exit evidence: 516 tests passed; the canonical and deprecated barrels share runtime identity; `AgentSession` satisfies `TeamSessionPort` structurally; the agent boundary gate reports no define↔team cycle and the seventh negative fixture reconstructs and rejects the old cycle.
Commit: `refactor(agent): separate local teams from a2a protocol`

### A1 — Implement run ledger and run handles

Dependencies: A0, C1  
Files: `packages/agent/src/accounting/**`, run-turn, run-agent, session, events/outcomes

- [x] Implement exact operation state machine and resource limits.
- [x] Replace zero-initialized missing usage with required `usageReport`; make legacy `usage` optional and authoritative-only.
- [x] Implement `AgentRunHandle`, terminal report resolution, and internal closure independent of public event consumption.
- [x] Add usage policy `warn`/`estimate`/`fail`: with cumulative `maxTotalTokens`, warn stops before another dispatch using `usage-unavailable`, estimate controls only missing portions, and fail preserves the report before raising `USAGE_REQUIRED`.
- [x] Instrument turn, tool, compaction, hook, user-input/approval wait, skill, memory, credential, and integration boundaries with exactly one terminal state and safe default fields.
- [x] Close open operations as unknown with stable error code; test duplicate/orphan terminal detection.

Verify: all usage/state-machine cases in the observability design.  
Exit evidence: 533 root tests and 89 core tests pass; the focused ledger/handle suite covers missing/zero/estimated/fail usage, explicit-budget dispatch prevention, report identity, audit failure, shared monotonic sequencing, tool/hook/approval terminals, resource limits, duplicate/orphan rejection, and consumer-stop aborted closure. Typecheck, package/dependency/agent/runtime graphs, supply-chain validation, and all seven negative fixtures report zero findings. No successful run can render missing usage as zero; consumer-stop report resolves.
Commit: `feat(agent): add canonical run ledger and usage coverage`

### A2 — Extract `@ai-agent-sdk/agent`

Dependencies: A1  
Files: `packages/agent/**`

- [x] Move all agent source except filesystem skill.
- [x] Depend only on core.
- [x] Pack and run mock provider/tool/compaction/team flows in Worker and browser fixtures.

Exit evidence: `@ai-agent-sdk/agent` passes 229 focused tests; the 534-test compatibility suite also proves root/core/agent runtime identity. Typecheck, publint, ATTW ESM profile, package/source/runtime graph gates, and tarball installs in standards-only Node, Chromium, and Cloudflare Worker pass. The packed flow exercises one mock provider, a host tool, shared team attachment, canonical run usage, and manual history compaction; its manifest has exactly one runtime dependency on `@ai-agent-sdk/core`.
Commit: `refactor(agent): extract universal agent package`

## Phase P — HTTP, protocols, and providers

### P0 — Extract provider HTTP and isolate SSE

Dependencies: C2  
Files: `packages/provider-http/**`

- [x] Move HTTP base, errors, configurable provider, SSE parser.
- [x] Move env lookup out; accept injected credentials only.
- [x] Exact-pin `eventsource-parser@4.1.0` in this package and nowhere else.
- [x] Add provider-attempt start/end, success/error request ID capture, dispatch-state classification, audit pre-dispatch checkpoint, reliable/audit terminal checkpoint, and safe origin metadata.
- [x] Deprecate legacy exact-wire request logger in favor of observation; preserve one compatibility bridge.

Verify: HTTP success/error/retry/abort/resource-limit/audit tests; dependency grep.  
Exit evidence: 52 focused HTTP/SSE tests cover success, HTTP error, retry, credential failure, pre/post-dispatch abort, fetch rejection, resource rejection, parser framing/overflow, reliable/audit terminal delivery, durable-vs-memory-only receipts, and audit fail-closed before fetch. The 550-test compatibility suite preserves every root runtime export and proves root/package runtime identity. Publint and ATTW ESM checks pass; packed installs execute the same attempt-accounted mock request in standards-only Node, Chromium, and Cloudflare Worker. The packed manifest has only `@ai-agent-sdk/core@^0.1.0` and exact `eventsource-parser@4.1.0`; dependency grep finds no other direct owner.
Commit: `feat(provider-http): extract fetch pipeline and attempt accounting`

### P1 — Extract wire protocol packages

Dependencies: P0  
Files: protocol package directories

- [x] Move Anthropic wire/serializer/translator/dialect into one package.
- [x] Move Responses/Codex wire/serializer/translator/dialect into one package.
- [x] Delete provider↔protocol cycles and internal cross-imports.
- [x] Preserve fixtures for malformed/partial usage and protocol-specific omitted-cache semantics.

Exit evidence: both packed Universal packages have only `@ai-agent-sdk/core@^0.1.0` as a runtime dependency and execute serializer/translator fixtures in standards-only Node, Chromium, and Cloudflare Worker. Anthropic has 21 focused serializer/translator tests; Responses has 21. The fixtures cover split/partial reports, malformed counters, Responses cache-subset subtraction, and each protocol's authoritative omitted-cache-zero rule. The HTTP boundary has 54 focused tests and proves partial/malformed protocol usage is retained in provider-attempt accounting while never escaping as an exact public `TokenUsage`. The 559-test root compatibility suite passes. Publint and ATTW ESM checks pass; the six-package graph has nine allowed workspace edges and zero findings. Root compatibility preserves runtime protocol-object identity with the two canonical packages.
Commit: `refactor(protocols): extract provider wire packages`

### P2 — Extract provider plugins

Dependencies: P1  
Files: provider-anthropic/openai/codex packages

- [x] Export low-level adapters and preferred plugin factories.
- [x] Split Codex auth contract from filesystem/path/env implementation.
- [x] Require injected Codex auth store in Universal package.
- [x] Instrument catalog and credential operations with safe events.
- [x] Keep OAuth tokens and account details outside event/log fields.

Verify: mock provider suites; plugin transaction tests; packed Worker/browser tests.  
Exit evidence: Anthropic/OpenAI/Codex expose both low-level adapters and transactional plugin factories; the Universal adapters require injected credentials and Codex requires an injected `CodexAuthStore`. Package suites pass with 2/2/7 tests, including a real expired-token refresh path whose serialized credential events contain no old/new token, account id, or store location. All three tarballs install and execute an attempt-accounted mock stream in standards-only Node, Chromium, and Cloudflare Worker with `Buffer`/`process` removed. Publint and ATTW ESM checks pass for all packages; the root compatibility suite passes 569 tests after the documented additive facade update. Package/runtime/source/supply-chain gates report zero findings, and `provider-http`'s updated six-event packed matrix also passes.
Commit: `refactor(providers): extract universal provider plugins`

## Phase O — Concrete observability

### O0 — Implement Universal bus, processors, logger, health, and test exporter

Dependencies: C2, A2  
Files: `packages/observability/**`

- [x] Implement exact queue defaults, sync processor order, protected health path, priority eviction, flush/shutdown.
- [x] Implement required/best-effort exporter registration and validate that reliable/audit have at least one honest non-memory durability boundary; checkpoint waits for every required exporter only.
- [x] Implement privacy policy, secret/header redaction, depth/size/cardinality limits.
- [x] Implement scoped logger and safe errors; remove direct runtime `console.*` calls.
- [x] Implement trace/log/metric projections and in-memory/test exporters.
- [x] Prove checkpoint drains prior critical events through its sequence boundary; reliable failure preserves the result with incomplete delivery, while audit failure follows the documented pre/post-dispatch behavior without provider replay.

Exit evidence: 18 deterministic tests cover default batching, processor order/envelope immutability, protected failures, hostile schemas, content policies, inline/key/header secret redaction, depth/size/batch limits, priority eviction, required versus best-effort durability, sequence-bound checkpoints, reliable/audit report semantics, scoped log levels, bounded-cardinality projections, timeout health, and reverse idempotent shutdown. The 587-test compatibility suite passes. The packed tarball executes logging, privacy, trace and metric projections in standards-only Node, Chromium, and Cloudflare Worker with `Buffer`/`process` removed. Publint, ATTW ESM resolution, package/source/runtime graph, supply-chain, and seven negative-boundary gates report zero findings; production runtime source contains no direct `console.*` calls.
Commit: `feat(observability): add universal bus logging and health`

### O1 — Implement Fetch/Edge exporter

Dependencies: O0  
Files: `packages/observability-fetch/**`

- [x] Implement exact batch/ack/idempotency protocol and retry classification.
- [x] Add HTTPS/origin/redirect validation and injected fetch.
- [x] Add `waitUntil` helper without assuming a global platform object.

Exit evidence: 11 deterministic tests cover exact POST/ACK behavior, immutable retry bodies and idempotency keys, full-jitter/`Retry-After`, retryable versus permanent failures, request timeout, host cancellation, endpoint/header/redirect/origin validation, request/ACK resource limits, and explicit `waitUntil`. The reliable-registry test forces a 503 followed by 204 and proves one provider dispatch while the same observation batch is retried. The packed tarball reaches a `remote-acknowledged` checkpoint in standards-only Node, Chromium, and Cloudflare Worker with `Buffer`/`process` removed. Publint and ATTW ESM checks pass; the 598-test compatibility suite, full typecheck, package/source/runtime graph, supply-chain, and seven negative-boundary gates report zero findings.
Commit: `feat(observability-fetch): add acknowledged edge exporter`

### O2 — Implement Browser IndexedDB durability

Dependencies: O0  
Files: `packages/observability-browser/**`

- [x] Implement schema, transactions, recovery, limits, priority behavior, and opt-in lifecycle.
- [x] Test quota, blocked upgrade, crash/reopen, duplicate IDs, and audit checkpoint.

Exit evidence: the Browser tarball installs with only core/observability and passes a real Chromium two-page recovery test: page one commits an event and closes without exporter shutdown, then page two reopens the same origin/database and recovers it. The same packed test proves schema-v1 `events`/`batches`/`meta`, unique event identity rejection, required `local-durable` reliable and audit checkpoints, explicit batch acknowledgment, 2-event quota eviction ordering (verbose then normal, never critical), visible quota failure when only critical records remain, blocked-open failure, and opt-in visibility/pagehide lifecycle with disposal. A Universal bus contract test proves `stage()` starts during synchronous capture while checkpoint waits for committed export. Publint, ATTW, the 599-test compatibility suite, full typecheck, package/source/runtime graph, supply-chain, and negative-boundary gates pass with zero findings.
Commit: `feat(observability-browser): add indexeddb delivery queue`

### O3 — Implement Node journal and diagnostic wire log

Dependencies: O0  
Files: `packages/observability-node/**`

- [x] Implement symlink-safe unique per-process segments, permissions, exact payload-string checksum framing, modes/fsync, rotation, 1 GiB/7-day acknowledged-only retention, recovery, quarantine, cursor, and cleanup.
- [x] Implement explicit Node lifecycle helper and idempotent disposer.
- [x] Move exact-wire logger behind `content: full` + `allowWireBodies: true` hard opt-in.

Exit evidence: 11 Linux filesystem tests cover exact payload checksums, private permissions, unique UTC/process segments, byte/day rotation, reliable and audit `fdatasync` (including non-critical records), injected `EIO`, partial-tail truncation, final-line quarantine, fatal mid-file corruption, symlink rejection, bounded acknowledged-only cleanup, atomic cursor pruning, unacknowledged-cap failure, idempotent batch retry, lifecycle disposal, and the two wire-content opt-ins. Permission assertions run on POSIX and are conditionally inapplicable only on Windows; no durability behavior is skipped. The Node tarball installs with core/observability only and executes the `/journal` and `/diagnostic` entries; publint and ATTW ESM resolution pass. The 610-test compatibility suite, full build/typecheck, frozen 11-entry public API contract (one documented request-logger declaration change and zero runtime removals), package/source/runtime graph, supply-chain, core-cycle, and seven negative-boundary gates pass with zero findings.
Commit: `feat(observability-node): add durable journal and diagnostics`

### O4 — Implement OpenTelemetry bridge

Dependencies: O0  
Files: `packages/observability-otel/**`

- [x] Map internal events to caller-supplied tracer/meter/logger APIs.
- [x] Open actual tracer spans synchronously, return their IDs to SDK correlation, preserve explicit logical call/retry parent topology without AsyncLocalStorage, and flag no-op/invalid tracer contexts.
- [x] Enforce content opt-in and usage-source distinction.
- [x] Pin semantic mapping fixtures to the selected upstream commit.

Exit evidence: seven golden/failure tests prove synchronous caller-owned spans, unsampled W3C identity preservation, explicit run→logical-model→retry-attempt topology, terminal status/end, content-default privacy, cache-inclusive reported token accounting, estimated-source separation, correlated logs, stable invalid/no-op fallback, contained API diagnostics, pinned GenAI instruments, and unchanged global providers. The package imports only the OpenTelemetry APIs plus core/observability, owns no SDK/exporter/network path, and its tarball passes standards-only Node, real Chromium, and Cloudflare Worker execution. Publint, ATTW, the 618-test compatibility suite, full typecheck, package/source/runtime graph, supply-chain, core-cycle, and seven negative-boundary gates pass with zero findings.
Commit: `feat(observability-otel): add semantic convention bridge`

## Phase I — Integration protocols

### I0 — Extract and prove MCP HTTP Universal package

Dependencies: A2, W1  
Files: `packages/mcp/**`, strict Worker fixture

- [x] Move HTTP client/server bridge and direct MCP dependencies.
- [x] Convert the committed spike into a packed-package test.
- [x] Test initialize, list tools, call tool, abort, auth state, and bounds with Node globals removed.

Exit evidence: the package directly owns the exact MCP client/server dependencies and exposes combined, `/client`, and `/server` entries while stdio/Node HTTP remains outside. Seventeen package tests cover lifecycle, discovery/call, HTTP policy/bounds, auth/OAuth/scope states, protocol fallback, agents, teardown, and reconnect behavior. Tarball-only standards import, real Chromium, and strict Cloudflare Worker fixtures cover initialize, tools/list, tools/call, abort, invalid bearer state, catalog bounds, and no `Buffer`/`process`; the browser gate found and fixed frozen-schema incompatibility by cloning only at the mutable upstream validator boundary. Legacy client/server runtime exports are unchanged and identity tests prove they re-export the canonical package. Publint, ATTW, the 618-test compatibility suite, full typecheck, package/source/runtime graph, supply-chain, and strict runtime matrix pass with zero findings.
Commit: `refactor(mcp): extract universal http bridge`

### I1 — Extract A2A as Node-elevated package

Dependencies: A2, W1  
Files: `packages/a2a/**`, A2A spike

- [x] Move official A2A client/server bridge and declare Node runtime honestly.
- [x] Keep text/data/url/binary tests; binary must pass in Node.
- [x] Keep the strict Worker binary test as a promotion guard and expect it to fail only in a labelled negative fixture.

Exit evidence: `@ai-agent-sdk/a2a` directly owns exact `@a2a-js/sdk@1.1.0` and exposes combined, `/client`, and `/server` entries. Eleven protocol tests pass. Its packed Node fixture covers official raw-binary encoding plus SDK text/data/url/raw mapping; its strict Worker fixture removes `Buffer`/`process`, requires text success, and accepts only the labelled upstream binary failure as the negative promotion guard. Legacy client/server runtime exports remain unchanged and identity tests prove canonical re-exports. Publint, ATTW, package/source/runtime graph, supply-chain, and runtime-boundary gates pass; manifests and documentation consistently classify the package as Node-elevated.
Commit: `refactor(a2a): extract node-elevated protocol bridge`

## Phase N — Node capabilities

### N0 — Extract granular Node packages

Dependencies: A2, P2, O3, I0  
Files: `packages/auth-node/**`, skill-filesystem, mcp-node

- [x] Extract filesystem skill.
- [x] Implement `@ai-agent-sdk/auth-node` with env credential resolver, project-local Codex auth store using atomic writes/`0600` target mode, and Codex Node plugin/adapter wrappers.
- [x] Build the auth-node Codex login CLI to JavaScript.
- [x] Extract MCP stdio/Node HTTP package against the already extracted Universal MCP contracts.

Exit evidence: three Node packages own only their declared direct dependencies and all Universal/Browser closures remain clean. Six auth-node tests cover path precedence, lazy env lookup, compatibility identities, private atomic round-trip/replacement, symlink rejection, bounded/redacted failures, and Node Codex wrappers; eight filesystem tests retain lazy/bounded discovery behavior; the MCP Node unit protects the explicit stdio/HTTP boundary. Tarball-only consumers execute the built login CLI and private auth store, discover/load a real `SKILL.md`, and spawn a real MCP stdio child before discovering and calling a tool. All three packages pass publint and ATTW. The 625-test compatibility suite, full build/typecheck, frozen 11-entry public API contract with zero runtime changes, package/source/runtime graph, supply-chain, core-cycle, and seven negative-boundary gates pass with zero findings.
Commit: `refactor(node): extract filesystem auth env and mcp capabilities`

### N1 — Create full `@ai-agent-sdk/node` facade

Dependencies: N0, I1, O1–O4  
Files: `packages/node/**`

- [x] Re-export core, agent, providers, observability/fetch/node/OTel, filesystem, MCP, and A2A capabilities through documented subpaths; do not pull browser-only IndexedDB lifecycle code into the Node facade.
- [x] Default Codex Node plugin to project-local isolated auth, never the Codex CLI global file.
- [x] Add one full harness smoke using filesystem skill, provider mock, journal, and MCP stdio fixture.

Exit evidence: the facade contains only re-export entries and workspace dependencies, with documented `/core`, `/agent`, `/providers`, `/observability`, `/filesystem`, `/mcp`, `/a2a`, `/env`, and `/codex` boundaries. Identity tests prove core, agent, providers, auth, observability, filesystem, MCP, and A2A are the canonical leaf objects; IndexedDB/browser lifecycle exports and dependency are absent. A tarball-only consumer imports only `@ai-agent-sdk/node`, runs an agent with a lazily discovered filesystem skill and mock provider, records correlated agent/model events in the durable journal, spawns an MCP stdio child and calls its tool, confirms project-local Codex resolution, and proves the facade and leaf package share one `ModelRegistry` identity. Publint and ATTW resolve every entry; the full workspace closes at 54 test files and 627 tests with lint, typecheck, graph, boundary, integrity, and production-license gates green.
Commit: `feat(node): add batteries-included node facade`

## Phase V — Provider/observability live acceptance

### V0 — Re-run the real Codex acceptance after provider and observability extraction

Dependencies: P2, O0, N0  
Files: integration tests only

- [x] Use project-local Node auth-store wrapper with provider-codex.
- [x] Run exactly one filtered successful `gpt-5.6-luna` stream.
- [x] Assert run/model/attempt correlation, provider request ID when supplied, complete positive usage, and healthy observation delivery.
- [x] Keep exact-wire content logging disabled.

Verify:

```sh
pnpm vitest run --config vitest.integration.config.ts \
  -t "streams text and assembles a message" --reporter=verbose
```

Exit evidence: the single filtered Luna case passed in 3.149 seconds with three unrelated live cases skipped. The safe `0600` report contains one correlated, sent, complete-usage provider attempt; the supplied provider request ID agrees across the attempt report and terminal observation; input/output/total counters are positive; delivery is complete; observation health is healthy with no rejected critical event, processor failure, or exporter failure. Capture policy is `none`, no exact-wire observer is installed, and assertions prove neither prompt, system instruction, nor response text entered the observation stream. The ignored artifact is written to `AI_AGENT_SDK_LIVE_REPORT_DIR` or `.temp/live-acceptance`, never committed.
Commit: `test(provider-codex): verify live luna accounting`

## Phase K — Compatibility and package cutover

### K0 — Build `ai-agent-sdk` compatibility facade

Dependencies: all C/A/P/O/V/I/N tasks  
Files: `packages/sdk/**`

- [x] Re-export all current subpaths to their new package owners.
- [x] Keep regular facade dependencies limited to Universal core/agent/HTTP/protocol packages; declare every legacy leaf target as an optional peer so root-only installation cannot pull Node packages.
- [x] Keep root `.` import closure Universal and document the exact optional peer install command for every legacy subpath.
- [x] Remove the Node-only `apiKeyFromEnv` root symbol, preserve it as a deprecated alias in auth-node/node, and record this sole required root-symbol break in migration/type fixtures.
- [x] Add `./node`; document runtime of each subpath.
- [x] Run frozen F0 public API fixtures and list every intentional type change.

Exit evidence: `packages/sdk` owns the 12-entry compatibility surface plus package metadata. Its five regular dependencies are exactly core, agent, provider-http, and the two protocols; nine leaf targets are optional peers. The packed root-only fixture imports with `process` and `Buffer` removed, finds only those five scoped packages plus `eventsource-parser`, and proves no Node/filesystem/A2A/MCP/observability leaf was installed. The full packed fixture installs every optional peer, executes every legacy import and `/node`, proves canonical runtime identity, and compiles type-only imports for all entries. Frozen F0 runtime exports are exact except the approved root removal of `apiKeyFromEnv`; `/node` is the only added path. Four declaration hashes change for the documented root boundary, required injected Anthropic/OpenAI credentials, and request-logger public type ownership; every other legacy declaration hash remains byte-identical. Publint and ATTW resolve every entry.
Commit: `refactor: switch compatibility facade to workspace packages`

### K1 — Remove old source and npm lock

Dependencies: K0  
Files: old root `src/**`, old build config, `package-lock.json`

- [x] Delete only files proven replaced by package ownership.
- [x] Remove obsolete root entry config and npm lock.
- [x] Fresh clone/frozen pnpm install/build/test.

Exit evidence: package ownership and the K0 packed fixtures prove every deleted root implementation is replaced. The workspace has no root `src`, root `dist`, root `tsdown.config.ts`, or npm lock; root orchestration now targets only pnpm workspace packages. The migrated human tests, runtime spike, and unit imports pass the full 54-file/628-test suite plus root typecheck, lint, boundary fixtures, supply-chain checks, and packed SDK fixtures. An archive of commit `a063dcc` was extracted into a new temporary checkout with no ignored files, installed with the frozen pnpm lock (including allowed install scripts), rebuilt, passed all 54 files/628 tests, and passed root typecheck.
Commit: `build: complete pnpm monorepo cutover`

## Phase E — `eventsource-parser` ownership decision before 1.0

### E0 — Build an owned parser candidate as a non-production spike

Dependencies: P0  
Files: `spikes/sse-parser/**`, SSE conformance fixtures

- [x] Implement the WHATWG field/line state machine with non-fatal streaming UTF-8 `TextDecoder`; default bounds are 256 KiB pending line, 1 MiB assembled event data, and 1 MiB total undecoded/pending storage, with typed resource-limit failure.
- [x] Cover start-only BOM, CR/LF/CRLF split boundaries, split/invalid UTF-8 replacement, comments/activity, multiline data, event/id/retry, NUL in ID, digit-only retry, unknown fields, empty values, EOF truncation, cancellation, and hostile long lines.
- [x] Differential-test at least 100,000 generated chunk partitions against exact-pinned parser where behavior is intended to match.
- [x] Fuzz at least 1,000,000 deterministic seeds under memory/time bounds.
- [x] Benchmark representative streams; candidate may not regress throughput or peak memory by more than 20% without a documented security/correctness reason.

Exit evidence: `spikes/sse-parser/report.json` records the Node 26.8.1 Linux x64 run. Ten conformance groups, typed default-bound checks, cancellation, 100,000 partitions (`0x5eed2026`), and 1,000,000 fuzz seeds (`0xf0222026`, 4.31 seconds, 114.6 MB peak RSS under a 30-second/512-MiB gate) passed. Provider-visible differential semantics have zero differences. The 12,724 archived optional-diagnostic differences come from the reference's documented early discard of impossible unknown-field prefixes and do not change events/activity. The three isolated throughput workloads regressed 75.65%, 71.68%, and 83.13%; peak RSS regressed 2.72%. The candidate therefore fails the 20% performance gate and cannot replace production code.
Commit: `spike(sse): evaluate owned event stream parser`

### E1 — Apply deterministic keep/replace rule

Dependencies: E0

- [x] Replace the dependency only if every conformance, differential, fuzz, resource, cancellation, and provider integration gate passes and code review finds no weaker bound.
- [x] Otherwise keep exact-pinned `4.1.0`, archive the failing evidence, and retain all supply-chain controls. Do not merge an almost-compatible parser.
- [x] If a high/critical advisory affects the pinned version before the candidate qualifies, suspend release; do not auto-upgrade or bypass the gate.

Exit evidence: ADR 0001 applies the predeclared rule and retains exact `4.1.0` as the only direct SDK-owned parser dependency, isolated in `provider-http`; the owned candidate stays outside production. The archived E0 report shows every correctness/resource/cancellation gate green but all three throughput workloads 71.68%–83.13% slower than the exact pin. Package/supply-chain/runtime checks remain green. `pnpm audit --prod --json` on 2026-09-01 reports 19 production dependencies and zero advisories at every severity, so release suspension is not currently triggered. The ADR separately discloses upstream MCP's transitive `eventsource-parser@3.1.1` instead of conflating it with direct ownership.
Commit: `security(sse): finalize parser ownership decision`

## Phase R — Full verification and release

### R0 — Full deterministic matrix

Dependencies: K1, E1

- [x] Frozen install, lint, typecheck, unit, contract, graph, runtime boundary, build.
- [x] Pack every public package; run publint and ATTW on tarballs.
- [x] Install tarballs in Worker, Chromium, oldest supported Node, and current Node fixtures.
- [x] Run journal/IndexedDB crash recovery and audit fail-closed tests.
- [x] Run `pnpm audit --prod`; triage every finding.

Verify:

```sh
pnpm install --frozen-lockfile
pnpm workspace:build
pnpm workspace:typecheck
pnpm build:cli
pnpm lint
pnpm exec tsc --noEmit
pnpm test:unit
pnpm test:contract
pnpm test:packages
pnpm check:graph
pnpm check:runtime-boundaries
pnpm test:pack
pnpm test:edge
pnpm test:browser
pnpm test:node
pnpm audit --prod
```

Exit evidence: archive checkout `97987c2` installed from the frozen lock and passed workspace build/typecheck for all 20 publishable packages, CLI build, root typecheck, graph/runtime lint, 615 unit tests, 13 contract tests, every package-owned suite, seven negative boundary fixtures, the full supply-chain gate, and recovery/audit tests. All 20 tarballs pass publint and ATTW ESM profiles, then install and execute through their package-owned Worker, Chromium, Node, protocol, provider, and compatibility fixtures. Current Node is v26.8.1. The official Node v22.12.0 Linux x64 archive passed SHA-256 `22982235e1b71fa8850f82edd09cdae7e3f32df1764a9ec298c72d25ef2c164f`, and the packed full Node facade harness passed under that oldest supported runtime, including filesystem skills, journal recovery, MCP stdio, A2A/provider imports, and token accounting. The production audit reports 19 dependencies and zero findings at every severity. R0 itself found and fixed a missing package-local `ObservationResource` type import plus nondeterministic duplicate root/package builds and parallel Worker port contention; the final task graph excludes root duplication and serializes runtime fixtures.
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
