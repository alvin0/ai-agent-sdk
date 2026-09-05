# Core + Capability Implementation Ledger

Status: **Implementation complete — release NO-GO pending the basic-agent bundle budget**

Last updated: **2026-09-05**

This ledger succeeds the completed historical
[`implementation-todo.md`](./implementation-todo.md) for the proposed package
architecture. It is intentionally gated: a phase cannot start until its design
and entry-evidence prerequisites are complete, and cannot finish until its
post-change exit evidence passes. Target tarballs and migrated import graphs are
exit evidence, not circular prerequisites for creating those artifacts.

## Implementation and evidence execution policy

The owner's latest implementation goal supersedes the earlier design-only
restriction. Targeted provider/network/runtime acceptance is owner-authorized,
including the existing signed-in Codex account. Investigate uncertain behavior
with bounded tests or primary sources instead of assuming it works. Historical
spike reports remain evidence, but their superseded executable source was removed
after coverage moved into maintained contract, package, benchmark, and human
tests. No publication is authorized.

Integration tests stay excluded from broad default test commands so ordinary
unit runs never unexpectedly spend provider usage. Invoke relevant live cases separately
with explicit turn/time/output limits. Do not print credentials or write them
into reports; use existing auth APIs and redact support artifacts. Preserve failed
attempts and their diagnosis rather than replacing them with an unexplained rerun.
Before choosing to execute any live or credentialed entrypoint, inspect its
behavior, required authority, resource bounds and output handling. Run clean builds before
tests that resolve workspace `dist` exports; never run those two tasks concurrently.

Prioritize human-test scenarios that produce inspectable websites/applications,
with source/output paths, commands, tool progress, model/usage, errors and terminal
result recorded. Research-quality review is separate from successful execution.
All new/modified product implementation files must stay at or below 700 lines,
group related code in named subfolders, reuse common helpers and keep configurable
constants at a clear local/common configuration owner. Do not introduce a global
miscellaneous utility module for unrelated domains.

## Dependency-ordered implementation slices

Current progress:

- [x] I0: owner approval and amended per-agent model contract recorded.
- [x] I1: seven base-observability files moved into core, six self-imports
      rewritten, canonical subpath built, old owner reduced to a route-complete
      re-export-only bridge. Whole-workspace build and 632 unit tests pass.
      See [I1 evidence](./implementation-evidence/I1-observability.md), including
      the retained failed concurrent build/test attempt and its sequential fix.
- [x] I2: all 49 baseline agent files moved to core, with 20 domain-local helper
      modules; every moved/new agent file is at most 675 lines. Both legacy
      routes are re-export-only bridges. Build, type, API, graph, 639 unit tests
      and seven deterministic human-harness regression tests pass.
      See [I2 evidence](./implementation-evidence/I2-agent.md).
- [x] I3: public `createAgentRuntime()` composition, provider/model selection,
      transactional identity/method preflight, lifecycle ownership, accounting,
      delivery, logging, diagnostics, memory, skills, native tools, and runtime-
      bound agents are implemented. Provider/capability transport is lazy,
      bounded and verified from installed tarballs, including native no-follow
      behavior on Node, Deno, Chromium and workerd. See
      [provider evidence](./implementation-evidence/I3-provider-foundation.md),
      [platform/lifecycle evidence](./implementation-evidence/I3-platform-lifecycle.md)
      [exporter/startup evidence](./implementation-evidence/I3-exporter-startup.md),
      [delivery evidence](./implementation-evidence/I3-delivery.md), and
      [runtime-agent evidence](./implementation-evidence/I3-runtime-agent.md), and
      [portable no-follow evidence](./implementation-evidence/I3-portable-no-follow.md).
- [x] I3 design reconciliation: added the owner-approved additive nested
      `observability.mode?: DeliveryMode` field. Omission is explicitly
      `operational`; exporter order and requirement flags never infer a mode.
- [x] I4–I7: provider/capability closure, consumer migration, and facade removal
      are complete. See [MCP capability evidence](./implementation-evidence/I5-mcp-capabilities.md),
      [human-harness migration evidence](./implementation-evidence/I6-human-harness-migration.md),
      and [facade-removal evidence](./implementation-evidence/I7-capability-facade-removal.md).
- [x] I8: final installed/live acceptance executed; release remains no-go only
      because the approved basic-agent bundle budget is exceeded. See the final
      gap matrix rather than treating task completion as a go decision.

These are mergeable source states after Phase 0 approval, not a second phase
model. A slice may start only when all listed predecessors are green. Every
slice must keep the repository buildable and must not weaken the target contract
to match an intermediate implementation.

| Slice | Depends on | Atomic source state | Required merge evidence |
| --- | --- | --- | --- |
| I0 — approval freeze | — | P0-01..P0-14 approved with attribution; ADR accepted | contract/docs drift gate |
| I1 — observability ownership move | I0 | atomically move the frozen seven-file base bus/privacy/logger/exporter root to `core/src/observability`; rewrite six core self-import files; old observability source becomes a root-only re-export bridge; advance its migration state | core + bridge tests; zero duplicate implementation; runtime boundary |
| I2 — agent ownership move | I1 | atomically move the frozen 49-file agent root to `core/src/agent` in dependency-first edit order; rewrite 31 core self-import files; old agent source becomes a route-complete re-export bridge for `.` and `./skill-validation`; advance its migration state | source-cycle, type, unit, API snapshot; zero duplicate implementation |
| I3 — composition root | I2 | add `AgentRuntime`, typed slots/markers, memory store, stream, diagnostics and explicit ownership semantics | deterministic rollback/lifecycle/accounting/privacy tests; design fixtures compile against real exports |
| I4 — provider closure | I3 | repoint providers, HTTP and protocols to bounded core peers; add IDs/routes; retain SSE dependency only in HTTP support | provider conformance, peer closure, multi-instance conflict/route tests |
| I5 — capability closure | I3 | repoint MCP, skills, exporters, auth and A2A; implement runtime tiers and caller/owned lifecycle rules | per-family conformance and packed deterministic closure tests |
| I6 — consumer migration | I4, I5 | migrate Edge website, Node harness, wrappers, fixtures, and active guides to exact selected packages; advance the documentation migration state atomically | human topology, compile/build, docs contract, visible typed events and usage checks |
| I7 — bridge/facade deletion | I6 | delete agent/observability bridges plus Node and unscoped facades; delete their classified READMEs and remove build entries | facade inventory reaches zero; graph/docs/pack checks |
| I8 — release evidence | I7 | no source ownership change; validate final packed artifacts and budgets | all static/deterministic gates plus separately recorded manual live acceptance |

Intermediate bridge invariants:

- a bridge may contain public re-exports and migration metadata only;
- it has one normal workspace edge to core and no copied source or independent
  runtime singleton;
- no new consumer may import a bridge, and its inventory must shrink monotonically;
- I7 is mandatory—passing I1/I2 does not make a bridge part of the target API;
- capability packages can migrate in parallel inside I4/I5 only when their
  manifests, packed fixtures, and target runtime classifications are independent.
- I1/I2 may be edited dependency-first locally, but a checked repository state
  never splits one frozen source root across old and new owners; state, target
  files, self-import rewrites, and its exact route-complete bridge land atomically.
- Documentation advances `pending → active-guides-migrated → complete`. I6
  rewrites every active guide in the frozen 27-file inventory, couples both human
  journeys to `target-achieved`, and proves every retained package's recommended
  import while facade READMEs remain present; I7 deletes those facade-owned
  READMEs. Historical records keep explicit status and may continue naming old
  routes.

## Phase 0 — Freeze decisions

Owner decisions are consolidated in
[`core-capability-phase0-approval.md`](./core-capability-phase0-approval.md) and
machine-checked by stable IDs.

- [x] Choose the user model: core + provider + selected capabilities.
- [x] Reject a generic global `Plugin`/service-locator contract.
- [x] Reject the global `@ai-agent-sdk/node` facade as the target experience.
- [x] Require a resolved per-agent model from an explicit target or an explicitly
      configured provider default; never select a hard-coded model in core.
- [x] Require one canonical registry and observation bus per runtime.
- [x] Make runtime construction awaitable for complete rollback.
- [x] Approve public composition names, model target, typed slots, diagnostics,
      and factory grammar (P0-01, P0-02, P0-06, P0-09, P0-10).
- [x] Approve package map, runtime tiers, Universal matrix, and A2A scope
      (P0-03, P0-12, P0-13, P0-14).
- [x] Approve facade removal with no replacement full facade (P0-04).
- [x] Approve family-scoped API markers, auth closure, recursive core peers, and
      current Node diagnostics ownership (P0-05, P0-07, P0-08, P0-11).
- [x] Add a shape-only v1 declaration and Edge/Node consumer fixture.
- [x] Amend P0-02 with owner-approved independent per-agent model overrides,
      provider defaults, runtime route selection and immutable resolved model;
      compile minimal omission and multi-account selection without changing
      legacy reusable-definition overloads.
- [x] I3/I4: implement and test full agent override, route-only default, unique
      configured default, multiple-default ambiguity, absent default and invalid
      explicit targets. Reject malformed/default routes before provider setup;
      reject missing/ambiguous binding before dispatch. No array/catalog-order
      selection, hard-coded model or error-time failover.
- [x] I3/I4: test provider-option mutation, model catalog refresh, team members
      with different models, session snapshot/resume and retries. Preserve each
      resolved target and record the actual provider/model in usage/trace evidence.
- [x] Validate declaration bodies with `skipLibCheck: false`: the mixed Node
      surface uses `NodeNext`; the ten-package Web/Browser base uses `Bundler`
      and compiles independently without Node types. Keep legacy Bundler
      consumer checks too; path aliases do not prove packed export resolution.
      Restore the five missing focused provider/observability type exports.
- [x] Track the full twelve-package Web/Browser declaration check separately:
      exactly two upstream MCP 2.0.0 `Buffer` errors remain an explicit debt
      baseline, not a passing Web gate; reject diagnostic/configuration drift.
- [x] Resolve MCP client/server public type portability for P0-12/I8, preserving
      existing API compatibility; require full-Web strict compilation without
      Node typings, ambient shims, or declaration-check waivers. A Node compile
      or import-graph pass cannot substitute for this check or packed runtime tests.
- [x] Trace both MCP errors to root-exported upstream shared-stdio
      `ReadBuffer.append(Buffer)`, not the HTTP consumer's own API. Record the
      upstream-first correction and compatibility conditions in design 10.4.1;
      adding a wrapper/alias or an unexported deep import is not a resolution.
- [x] Compile the core root plus six bounded author subpaths and forbid deep
      package-author imports from becoming the extension API.
- [x] Preserve `auth-node/env` beside the env-only root as an identity-preserving
      re-export, compile both routes, and keep `/codex` as the only route that
      requires the optional provider peer.
- [x] Freeze explicit target manifest export maps for the five multi-entry core,
      auth-node, A2A, MCP, and observability-node packages, including ESM/type
      conditions, `package.json`, no wildcard/deep route, and route-level
      optional-peer ownership for auth `/codex` and MCP `/server`.
- [x] Freeze exact root export maps for provider-http, OpenAI, Anthropic, and
      Codex; prove individual provider recipes select only core plus that
      provider while transport/protocol packages remain transitive.
- [x] Extend exact ESM/type/package-json export blueprints to all 18 target
      packages, including every single-entry protocol, MCP transport/server,
      skill and observation capability; derive output basenames from public
      routes and use `.mjs`/`.d.mts` for Node outputs.
- [x] Freeze non-TypeScript manifest surfaces: common packed files, auth-node's
      exact Codex-login binary mapping and additional `bin` directory, root
      `main`/`types` mirrors, and Node-only engine placement.
- [x] Freeze topology-to-manifest dependency encoding: normal implementation
      edges, required core peers plus development resolution, optional workspace
      peers plus `peerDependenciesMeta`, and exact catalog-backed external
      dependencies/peer development resolution. Reject overlaps, orphan optional
      peers, unclassified runtime elevation, and external version conflicts.
- [x] Freeze complete workspace, required-external, and effective-runtime install
      closures for all 25 target journeys, not only provider/auth examples; keep
      optional peers outside the closure until a journey selects them explicitly.
- [x] Probe all 17 retained non-core packages independently beside core and freeze
      each transitive workspace package, required external dependency/peer, and
      effective Universal/Browser/Node result; do not let the full Node harness
      mask a wrongly classified individual capability.
- [x] Parse all five public application `pnpm add` examples and require each documented
      package set to equal its exact compile journey; keep provider support
      packages transitive and prohibit a facade from reappearing in prose.
- [x] Add the sixth application recipe for Browser OpenTelemetry and require its
      `@opentelemetry/api@1.9.1` peer as a direct install; distinguish direct
      required peers from transitive provider/runtime dependencies.
- [x] Add direct compile/install journeys for `mcp-node-server` and
      `protocol-anthropic-messages`, the last two packages previously covered
      only transitively or by parity fixtures. Re-export the Universal MCP server
      constructor from the Node hosting package so its app recipe stays
      core-plus-one-capability.
- [x] Document and check three provider-author install paths—Responses-compatible,
      custom HTTP wire, and direct non-HTTP—against their existing compile
      journeys while keeping finished-provider consumer installs core+provider.
- [x] Add the fourth provider-author path for Anthropic Messages and require every
      one of the 18 target packages to appear directly in at least one compile
      journey.
- [x] Freeze non-executable manifest metadata for all 18 packages as topology-
      derived runtime, `coreApi: 1`, and exact plural roles from a checked
      16-role vocabulary; forbid treating metadata as runtime plugin discovery.
- [x] Freeze one recommended public entrypoint, typed composition point,
      application/authoring audience, and lifecycle ownership rule for every one
      of the 17 non-core packages; resolve each symbol through its exact target
      specifier and keep family-specific slots instead of a catch-all plugin array.
- [x] Freeze the 56-file source ownership transition: seven observability files
      to `core/src/observability`, 49 agent files to `core/src/agent`, 37 public-
      core self-import rewrites, dependency-first domain ordering, zero target
      collisions, I1→I2 state progression, and exact route-complete re-export
      bridges (one entrypoint for observability, two for agent).
- [x] Bind the machine Phase 0 record to the exact 18-package, 32-specifier and
      264-root-export counts so prose approval cannot outlive topology drift.
- [x] Extend the fixture with independently versioned provider, skill-provider,
      credential, memory-store, observation-exporter, and tool-source markers; keep inert
      inline values marker-free.
- [x] Add an exact-target-package compile-only matrix for minimal Edge, extended
      Edge, minimal Node, Node environment credentials, and full Node harness
      imports, including negative API contracts and no runtime execution.
- [x] Inventory every current code import of the two facades and the agent/base
      observability bridges so all four removals migrate known packages,
      wrappers, fixtures, type tests, and human journeys.
- [x] Freeze the exact 417-symbol public API baseline and declaration hashes:
      415 root exports plus the two agent `skill-validation` subpath-only exports;
      preserve by default and record the sole
      proposed removal (`DEFAULT_AGENT_CALL_CONFIG`) against P0-02.
- [x] Compare every preserved baseline name with its assigned target declaration
      and freeze the honest pending inventory by count plus sorted-name SHA-256.
- [x] Reduce target API parity to zero before Phase 0 approval: core root 0,
      agent root 0, agent skill-validation subpath 0, observability root 0.
      Canonical declarations and focused re-exports preserve all
      non-removed names; no duplicate type/value owner was introduced.
- [x] Freeze the other 19 current public entrypoints and 344 export occurrences
      with declaration hashes and exact target-route assignments.
- [x] Close the retained-package target parity gap: preserve same-specifier A2A
      subpaths and record every root
      move caused by P0-07/P0-14 as an explicit approved migration.
  - [x] restore canonical Responses and Anthropic protocol contracts before
    their provider consumers are migrated; preserve marker-free advanced
    `ProtocolDefinition` and add a marker-based intersection view on the same
    official value;
  - [x] restore Fetch, Browser, Node journal/diagnostic and OTel advanced APIs;
    keep exporter classes marker-free, expose new runtime factories as additive
    adapters, and preserve OTel as a caller-owned span/processor bridge;
  - [x] restore all MCP client/server and Node export occurrences; preserve
      `/client` and optional-peer `/server`, map server ownership to explicit
      packages, retain `close(): Promise<void>`, and add `closeWithReport()` for
      support-safe teardown evidence;
  - [x] restore all Auth root, `/env`, `/codex`, and provider-Codex public names;
      keep env results callable while adding the versioned source marker, retain
      `CodexAuthStore.read/write`, and add distinct revisioned credential-store
      and provider-plugin surfaces instead of repurposing existing names;
  - [x] restore all 76 A2A root, `/client`, and `/server` export occurrences
      through client/server canonical declarations and a combined root view;
      dual-compile representative client bounds and explicit server disposal;
  - [x] inventory all 53 root-to-capability moves by exact symbol and target
    route, preventing union parity from hiding accidental API relocation;
  - make auth `/codex`, MCP `/server`, and all role-specific subpaths re-export
    canonical owners rather than copy declarations or runtime state;
  - add same-source current/target compile fixtures per family before marking its
    name gap closed; filesystem skills already have name parity but still need
    this signature check;
  - update the per-entrypoint missing counts and aggregate hash only when the
    corresponding declaration change is reviewable in the same diff.
- [x] Close all 24 observability names with source-assignable advanced contracts;
      compile the current built module against `core/observability`, preserve the
      correlated schema-v1 envelope and place marker-based runtime delivery under
      distinct plugin/batch/ack/registration names.
- [x] Restore 45 canonical core message/content/brand symbols and compile one
      representative source against both the current and target core module,
      avoiding false incompatibility from duplicate test-only brand identities.
- [x] Restore the remaining 67 core provider/retry/error/registry/utility names;
      dual-compile the same advanced provider source against current and target,
      including 15 already-present signature-sensitive types.
- [x] Keep advanced `ModelProviderPlugin` and `ModelAdapter` marker-free; place
      family/API/route markers only on `ComposableModelProviderPlugin` returned
      by the recommended factory.
- [x] Restore the current agent tool pipeline and dual-compile 25 missing plus
      14 signature-sensitive tool symbols against current and target modules.
- [x] Preserve the current marker-free skill-provider protocol, move the new
      revision/reference protocol to distinct `SkillProviderPlugin` names, and
      dual-compile 21 missing plus nine signature-sensitive skill symbols.
- [x] Restore memory/history/compaction and hook contexts, including the public
      classes and projections; dual-compile 28 missing plus seven
      signature-sensitive symbols.
- [x] Restore accounting/trace contracts and preserve `GenerateOptions` as the
      usage-estimator request; dual-compile 16 missing plus eight
      signature-sensitive symbols.
- [x] Preserve current loop/mode/definition/session semantics and move the new
      composition event/definition/session protocol to distinct `Runtime…`
      names; dual-compile 27 missing plus 15 signature-sensitive symbols.
- [x] Preserve the current local/remote team, defined-team and managed-worker
      control planes while keeping composition teams under distinct `Runtime…`
      names; dual-compile 25 missing plus two signature-sensitive symbols.
- [x] Remove the `pnpm test`/`pnpm test:unit` spike reachability by relocating
      deterministic coverage or quarantining the historical test; only then set
      broad test commands AI-safe in the machine policy.
- [x] Inventory the sole cross-package symbol collision (`AgentMessageSource`),
      restore its canonical core-owned re-export from `core/agent`, and require every focused
      core subpath to be a re-export view with no duplicate declaration owner.
- [x] Compile a third-party Universal provider author journey against public
      core, HTTP transport, and protocol contracts.
- [x] Compile a core-only non-HTTP adapter author journey that preserves the
      current abstract adapter, stream/model/accounting contract, registration
      handle, middleware, cancellation, and teardown ergonomics.
- [x] Compile two installations of one provider family with distinct instance
      IDs/routes, and reject ambiguous exporter ownership at type-check time.
- [x] Compile third-party Universal skill-provider, observation-exporter, and
      live tool-source author values against core alone.
- [x] Add a core-only optimistic `MemoryStore` author/binding proof with an
      explicit isolation scope, binding identity, revision condition,
      cancellation, and reliability policy.
- [x] Add core-only credential source/store author proofs, reject direct resolver
      functions, and compile `envCredential()` through the same provider input.
- [x] Make Edge/Node compile journeys create runtime before opening borrowed MCP,
      clean runtime after connection failure, and close runtime before the tool
      source with a nested cleanup guard.
- [x] Encode all 18 retained target packages, runtime tiers, recursive core peers,
      normal/optional workspace closure, and exact external runtime dependencies.
- [x] Freeze target manifest policy: ESM-only `type: module`, side-effect-free,
      `types/import/default` exports with no `require`, explicit package.json
      export, no undeclared deep imports, bounded core peer, Node `>=22.12`, and
      `private: true` until publication is configured separately.
- [x] Consolidate all remaining owner choices into a 14-ID approval record and
      reject missing attribution or Markdown/JSON drift statically.
- [x] Draft ADR 0002 for package selection and runtime compatibility.

Exit evidence: API fixture, package map, compatibility ADR, and owner approval.

## Phase 1 — Historical audit-only executable evidence

This phase records historical evidence only. Do not blanket-rerun these commands.
When a concrete implementation question needs a targeted spike or live check,
use the owner's updated authorization and artifact/budget rules above; the new
result is evidence for the implementation under test, not a retroactive old pass.

- [x] Build an isolated composition-root prototype outside product packages.
- [x] Prove provider installation rollback and owned observation shutdown.
- [x] Prove required model target validation.
- [x] Prove bounded diagnostic eviction.
- [x] Prove close is idempotent and rejects new work.
- [x] Run one authenticated Codex call through the proposed composition shape.
- [x] Verify complete token usage, lifecycle correlation, privacy, and close report.
- [x] Store only support-safe spike artifacts under `.temp/`.
- [x] Reject an incompatible provider API before setup/allocation.
- [x] Re-run the authenticated provider through the API-v1 wrapper.
- [x] Build isolated contracts/basic-agent bundles and execute strict workerd.
- [x] Pack core locally and run a third-party-style provider consumer with
      install scripts disabled.
- [x] Pack external Universal/Node skill providers, run the Universal closure in
      strict workerd, and prove the Node selection exposes its built-in boundary.
- [x] Pack an external Universal observation exporter and prove privacy, usage,
      idempotent retry, ack identity, abort, family marker, and owned shutdown.
- [x] Add a native-fetch Workerd negative showing current `observability-fetch`
      shares the provider transport's `redirect: 'error'` incompatibility.
- [x] Replace formatting-sensitive emitted-import regexes with one AST-based,
      minified-syntax-self-tested detector and bound readiness probes.
- [x] Bundle and execute the real Universal Codex/provider closure in strict
      workerd with a mode-`0600` ephemeral credential binding.
- [x] Record the honest negative Edge result: empty discovery,
      `redirect: 'error'` incompatibility, then Cloudflare HTML HTTP 403 after a
      fixture shim (separate from the provider's `AUTH` mapping).
- [x] Run the same credential/model through the Node control successfully.
- [x] Run live instruction-driven deep research: 7 searches, 28 URLs, 5 domains,
      22,071 report characters, and complete usage for both provider attempts.
- [x] Pack current MCP/Node closures, reproduce the agent-session catalog snapshot,
      compose two real stdio sources, and prove collision/API/lifecycle behavior.
- [x] Reproduce both MCP native-fetch failures in Workerd: unsupported
      `redirect: 'error'` and post-contact origin validation with fixture-header
      forwarding to an unallowed redirect target.
- [x] Pack the current auth closure and an audit-only target tarball; prove
      env-only, missing optional Codex peer, and explicit full-Codex journeys.

Exit evidence: hermetic test output plus a redacted live report. A spike may be
deleted or rewritten; it is not production implementation.

## Phase 2 — Core composition and observability

Prerequisites: D1, D2, and D6 entry evidence plus their owner decisions in the
architecture audit.

- [x] Move existing provider-neutral agent definition/session/runtime surfaces
      into core (I2); new composition behavior remains in the tasks below.
- [x] Add `AgentRuntime` and inject the canonical registry/observation instances.
- [x] Preserve common author/session ergonomics in core: `defineAgent`,
      `defineTool`, `defineSkill`, tool parse/render/meta/timeout/context controls,
      rich skill resource/invocation metadata, native tools, compaction options,
      session snapshot/resume/manual compaction, and bounded run controls.
- [x] Implement `additionalInstructions` as one exact host-owned run overlay:
      reject empty/whitespace or more than 65,536 UTF-8 bytes synchronously with
      `RUN_ADDITIONAL_INSTRUCTIONS_INVALID` before admission, history, ledger, or
      any capability method; never trim/rewrite an accepted value.
- [x] Compose system text in the frozen order agent → skill catalog → team → run
      overlay → core mode/control. Reuse the captured overlay for every request,
      retry and post-auto-compaction step in that run, then exclude it from
      history, memory, snapshots, resume, later runs and manual out-of-run
      compaction.
- [x] Include run overlays in provider/local-estimator input accounting but not
      default observations, diagnostics, errors, or artifacts. Prove they grant
      no auth, approval, tool/resource, model, budget, session, or memory authority.
- [x] Add deterministic boundary tests for absent, whitespace, exact-byte-limit,
      multibyte overflow, retry, tool-loop, automatic/manual compaction, failure,
      abort, snapshot/resume, privacy, estimation and next-run isolation.
- [x] Preserve Web-safe approval/user-input brokers, ordered tool interceptors,
      bounded turn hooks, required cancellation, and correlated request/response
      stream events; cancellation/close must settle every parked waiter.
- [x] Preserve `AgentInvocationOptions.onEvent` for `run()`/`generate()`:
      observe each event exactly once in order, await under the 30-second default
      observer timeout, abort/settle and reject stably on callback failure, retain
      the canonical report, and never treat this application callback as durable
      observability. `stream()` remains direct handle consumption and `compact()`
      emits no run events.
- [x] Make `stream()` eager with one stable pre-event run ID and one
      single-consumer event iterator. Preserve independent `result` and `report`
      promises while adding synchronous idempotent `abort()`; after terminal it
      is a no-op and early iterator return aborts plus boundedly settles.
- [x] On error/abort, reject result with `AgentRunError` carrying the canonical
      report while resolving the independent report and emitting exactly one
      support-safe terminal error event with that same report. Never serialize or
      inspect a raw abort reason into support content.
- [x] Mark a session idle only after event stream, result and report settle;
      contain internal unhandled rejections without consuming caller promises.
      Test abort before iteration, during provider/tool/hook/user-input work,
      repeated/late abort, dropped iteration and response-enqueue failure.
- [x] Make session snapshots explicit JSON-safe v1 envelopes; validate history
      lifecycle/bounds, agent identity, memory and activated-skill ownership on
      resume, while reinjecting all runtime dependencies.
- [x] Add runtime-owned Universal local teams with atomic member validation,
      bounded mailbox/observers, early idempotent close, runtime close reporting,
      and no dependency on the optional Node A2A transport.
- [x] Give `RuntimeAgentTeam` the same structural `linkAgent()` bridge and bounded
      `sendMessage()` path needed by A2A without importing A2A into core. Treat
      linked transports as borrowed: idempotent unlink and team/runtime close
      remove routing only, never close caller transport resources. Remote members
      use `sendMessage()`, not local `session()`/`run()`. Recommended A2A cleanup
      quiesces/closes runtime first and invokes additive idempotent
      `unlinkWithReport()` in `finally`, while retaining `unlink()` for
      compatibility; any separately injected transport resource remains
      caller-owned.
- [x] Remove Codex/model defaults from runtime-definition and high-level
      execution paths. Require explicit `runAgent.config`; preserve the
      owner-approved advanced legacy `defineAgent()` string/omission behavior
      recorded by amended P0-02.
- [x] Implement the overload discriminant without probing capabilities: a
      non-null model-target object selects `RuntimeAgentDefinition`, string or
      omission preserves advanced `DefinedAgent`, and other values fail
      synchronously. Keep both `defineAgent()` and `cloneAgent()` side-effect free,
      while `runtime.agent()` accepts runtime input directly.
- [x] Add the bounded metadata diagnostic ring with both event/byte limits and
      retained/evicted event/byte counters.
- [x] Keep `retainedEvents === events.length`, account serialized bytes before
      insertion, and test oversized-single-event rejection plus both eviction limits.
- [x] Preserve canonical usage coverage and strict missing-usage policy.
- [x] Route normal generation, retries, overflow recovery, and compaction
      summarization through the same run ledger; create one logical model-call
      report and one record per physical provider attempt, with no second addition
      from streamed/history `TokenUsage`.
- [x] Preserve disjoint input/output/cache-read/cache-write/reasoning counters;
      keep estimated counters separate and expose `authoritative: false` whenever
      coverage, validation, or overflow prevents an exact total.
- [x] Preserve the existing `warn | estimate | fail` missing-usage policy and
      local-only estimator input; estimates fill only absent counters, are never
      exported with their source request, and never become authoritative.
- [x] Freeze a delivery-free `RunTerminalRecord`, checkpoint it, then construct
      the caller-facing `RunReport` with the resulting delivery summary; never
      mutate either value or make a report depend on its own acknowledgment.
- [x] Make `ObservationDeliveryBatch` carry atomic `runRecords[]`, never one batch-level
      usage value; enforce unique run IDs per batch, acknowledge run IDs separately
      from event IDs, and keep batch/record identity stable across retry.
- [x] Use one `ObservationBoundary` vocabulary (`none | local-durable |
      remote-acknowledged`) across receipts, exporter declarations,
      registrations, close reports, examples, and tests; validate declared
      support before ownership transfer.
- [x] Preserve the full metadata-only observation envelope: run/trace/span IDs,
      per-run sequence, wall/monotonic timestamps, priority, phase, and JSON-safe
      post-privacy attributes; no raw host value crosses the exporter boundary.
- [x] Expose a runtime-bound `SdkLogger` without exposing the mutable bus; prevent
      resource/correlation override and inject active-run loggers into tool, hook,
      and model-invocation contexts.
- [x] Keep logger additions optional on preserved low-level context types for
      compatibility, while testing that every `AgentRuntime`-owned invocation
      actually supplies the bound logger.
- [x] Require a bound logger on the five versioned plugin contexts: provider
      setup registrar, credential operation, tool-source snapshot, skill-provider
      operation, and memory-store operation. Re-export its canonical type from
      focused author subpaths and compile one third-party-style use of each.
- [x] Add an optional `SdkLogger` to preserved caller-owned MCP HTTP/stdio client,
      MCP Web/stdio server, and A2A client/server options. Recommended
      runtime-oriented composition must create runtime first and pass a
      runtime-bound child logger before connect/link/serve; direct standalone use
      without a logger remains supported and must not enable a console sink.
- [x] Emit correlated start/terminal/support-safe error logs for runtime-active
      integration connect, authentication, reconnect, request/serve, send and
      stream operations. Use independent support-safe reports for close, unlink,
      and dispose after runtime logging has shut down.
      Prevent integrations from accepting correlation overrides, and test that
      cleanup evidence cannot replace the primary operation failure. Implement
      the frozen six-family/27-operation matrix, link every physical network or
      process attempt to one logical operation, and exclude credentials, headers,
      bodies, prompts, results, and agent-card content.
- [x] Type every first-party runtime-active integration field object with
      `core/observability` `IntegrationOperationEvidenceFields`; validate the
      frozen 64/128-character bounds, one-based attempt number, finite
      non-negative duration, static message, required terminal status, and
      balanced logical/attempt start-terminal cardinality before logger enqueue.
- [x] Keep lifecycle and active-operation correlation distinct: MCP connect/auth/
      reconnect uses its option logger, MCP execution uses runtime snapshot/tool
      context, A2A link/card resolution uses its option logger, and
      `RuntimeAgentTeam` always supplies the additive-optional
      `LinkedAgentSendInput.logger` for send/stream. Test direct legacy transports
      without that field and reject fabricated correlation IDs.
- [x] Preserve A2A `unlink()`/`dispose()` compatibility while adding bounded,
      idempotent `A2AUnlinkReport` and `A2ADisposeReport` paths. Add support-safe
      failure evidence to Node MCP server close reports. Never use the no-op
      post-runtime logger as teardown proof; retain capability and runtime reports
      independently.
- [x] Emit capability start/terminal/support-safe error evidence from core even
      when plugin code emits no logs. Never inject a logger into an observation
      exporter, where it would recurse through its own delivery path.
- [x] Route application/plugin logs through the same privacy, queue, priority,
      health and exporter path; invalid fields fail at the caller boundary while
      exporter failures remain contained health evidence.
- [x] Use info for required integration starts/successes and error for failures.
      Preserve advanced `ObservationHealthSnapshot`; expose an additive runtime
      projection with cumulative accepted/filtered/dropped/rejected integration
      counters. Count filtering before early return, never wrap counters, and
      preserve the difference between enqueue acceptance and export acknowledgment.
- [x] Add deterministic completeness cases for default info, warn-level filtering,
      queue eviction/rejection, missing or partial event-ID acknowledgments,
      unbalanced start/terminal pairs, diagnostic-ring eviction, and counter
      overflow. A green critical-checkpoint delivery summary or zero loss counters
      alone must not certify integration trace completeness. Retain unknown when
      expected instrumentation or delivery evidence is unavailable.
- [x] Never treat synchronous logger return as usage/accounting/durability proof;
      authoritative calls/tokens/errors remain terminal records and required
      delivery remains checkpoint/ack evidence.
- [x] Add deterministic accounting matrices for retry success, retry exhaustion,
      pre-dispatch rejection, post-dispatch abort/timeout, truncated streams,
      compaction success/failure/abort, counter overflow, and multi-run batches.
- [x] Preserve the primary model/provider failure when usage is also missing;
      report the coverage defect alongside it instead of replacing the cause.
- [x] Make privacy/redaction test sentinels structurally unique and outside random
      ID alphabets, or assert exact field absence. Ban short global substring
      assertions over whole reports containing random run/trace/span/attempt IDs;
      retain and classify first failures instead of erasing them with a rerun.
- [x] Implement bounded, idempotent runtime close and support-safe close reports.
- [x] Put agent runs, model-catalog refreshes, manual compaction, and local-team
      work behind one typed operation-lease registry. Admission and `closing`
      must share one atomic state decision; acquire the lease before executable
      method access and combine caller, runtime-root, and operation-deadline
      cancellation.
- [x] On close, reject admission, abort the runtime root, quiesce leases under the
      shared deadline, then seal unsettled generations before provider cleanup.
      Prove late catalog/compaction/team/run continuations cannot publish cache,
      ledger, result, or observation state after sealing.
- [x] Emit fixed-order close-report rows, including zero rows, for every operation
      kind; require `activeAtClose = settled + unsettled` and derive legacy run
      totals only from the `agent-run` row. Keep topology/final diagnostics/report
      readable after close, reject executable entry points, and make bound loggers
      closed no-op views that never reopen observation.
- [x] Make the first `close()` call synchronously start one irreversible shared
      terminal task. Treat its caller signal as a quiescence accelerator only,
      never as cancellation of cleanup or a reason to reject; concurrent/repeated
      calls join the same task and cannot replace options. Report `quiescenceEnd`
      and keep `deadlineReached` as the timeout-only compatibility projection.
- [x] Report each provider registration/exporter as closed, failed, or timed out
      plus final observation health; provider `timed-out` means the shared
      deadline expired before its synchronous disposer started, not that running
      JavaScript was preempted. Cleanup failures must not replace the primary
      run/provider error and repeated close returns one terminal report.
- [x] Validate provider plugin IDs/routes and exporter IDs atomically during
      preflight before setup, method access, ownership transfer or readiness;
      reject import-order shadowing and report no cleanup for pure conflicts.
- [x] Make normal runtime providers declarative `ComposableModelProviderPlugin`
      values whose inert route claims are snapshotted with IDs across the entire
      input before any setup lookup/invocation. Keep legacy `ModelProviderPlugin`
      installable only through the advanced registry compatibility surface.
- [x] Implement the helper's claim-scoped registrar: one-adapter authors register
      without repeating routes; multi-adapter registration/replacement stays
      within declared claims; every claim is covered exactly once by setup return,
      and missing/duplicate/undeclared claims fail transactional rollback.
- [x] Apply explicit snapshot-scoped namespaces to tool-source IDs, tool names,
      skill-provider/skill IDs and team member names; a refresh collision must not
      mutate the last valid catalog snapshot.
- [x] Return stable support-safe collision codes plus namespace, bounded/redacted
      key and first/second indices; never include credentials, endpoints, content,
      filesystem paths or object inspection output.
- [x] Separate the internal canonical core owner from its public root: preserve
      the 184 current core-root exports, add exactly 80 reviewed everyday
      composition exports, keep moved advanced agent/observability surfaces on
      focused subpaths, and require package-author declarations to use those
      focused views.
- [x] Treat the current low-level registry exports retained at root as explicit
      compatibility debt; move/remove them only through a separately approved
      breaking-version decision with demonstrated consumer migration.
- [x] Add frozen API, fault-injection, privacy, accounting, and lifecycle tests.
- [x] Require explicit exporter `borrowed | owned` registration; validate the
      marker before ownership transfer, close owned exporters on later rollback,
      and never close borrowed exporters.
- [x] Make `createAgentRuntime()` the exporter readiness boundary: validate the
      family marker and requested boundary first, transfer only explicit owned
      registrations, await optional `ready(signal)` under `startupTimeoutMs`, and
      publish no partially initialized runtime.
- [x] Combine optional caller cancellation with the startup deadline; an already
      aborted signal fails before setup/method access/ownership transfer, while a
      later abort runs the same reverse transactional rollback path.
- [x] Add a deterministic startup fault matrix for exporter ready success,
      rejection, timeout and abort across owned/borrowed registrations; prove
      reverse rollback, no borrowed shutdown, no pre-validation method access,
      and preservation of cleanup failures in `AgentRuntimeConstructionError`.
- [x] Stamp every observation batch/diagnostic snapshot with immutable runtime and
      SDK identity plus JSON-safe service metadata; reject reserved-key spoofing,
      invalid/oversized attributes, and credential-like resource fields.
- [x] Implement one marker-stamping, side-effect-free `define…` author helper per
      executable family; helper input omits `kind/apiVersion`, performs no I/O or
      registration, and returns a new frozen wrapper without freezing/mutating
      the caller's definition object.
- [x] During preflight create a private frozen handle that captures each
      executable capability's marker, ID, immutable configuration and method
      references once; invoke captured references with the original receiver and
      never reread public identity/method properties after validation.
- [x] Capture optional lifecycle methods and setup-returned cleanup immediately;
      post-preflight replacement/deletion must not redirect readiness, export,
      rollback or close, and borrowed objects must never be frozen by core.
- [x] Add deterministic mutation matrices for provider, credential, tool-source
      catalog, skill-provider, memory-store and exporter families. Prove stable
      routing/cleanup/ownership, last-valid dynamic snapshots, and support-safe
      containment of throwing property access without claiming a Proxy sandbox.
- [x] Add `ToolSource` with `apiVersion: 1`, keep local `tools` separate from executable
      `toolSources`, and snapshot/collision-check live sources once per invocation.
- [x] Replace multi-read live catalog composition with one captured synchronous
      `snapshot(signal)` call per source/invocation. Validate bounded revision,
      tool count/bytes/schema/names, capture schema and executable method refs from
      that one generation, and never read MCP's compatibility `.tools` view.
- [x] Reject snapshot failure without an implicit stale fallback; explicit source
      refresh becomes visible only next invocation. Record source ID/revision in
      `RunTerminalRecord` and exporter batches, never catalog/schema/args/results.
- [x] Add deterministic tool-source matrices for refresh during snapshot/use,
      changing getters/methods, async snapshot rejection, duplicate/invalid tools,
      revision bounds, abort-before-access, snapshot failure, and run evidence.
- [x] Treat local `ToolDefinition` as an executable marker-free core leaf, not
      inert data. Make behavior members readonly and have `defineTool()` return a
      new frozen wrapper that captures detached bounded schema plus parse/execute/
      render/meta/timeout/concurrency references with the original receiver,
      without freezing or mutating the caller object.
- [x] Apply the same capture to direct tool literals at runtime agent/session
      binding; never reread after capture. Add mutation/getter/receiver/schema-
      drift tests and prove local/source collisions fail before model dispatch.
- [x] Capture local executable policy leaves at agent/session binding: approval
      and user-input `request`, interceptor before/around/after, all turn hooks,
      usage policy configuration and estimator id/estimate. Make function fields
      readonly, preserve receivers, detach bounded config, and never freeze the
      caller or block legitimate internal operational state.
- [x] Add policy mutation matrices before/during run, including broker replacement
      while parked, interceptor replacement between stages, hook replacement
      between turns, estimator replacement after model completion, throwing
      getters and required cancellation/close settlement.
- [x] Preserve skill discovery metadata separately from lazy instruction/resource
      loading and enforce provider-issued candidate ownership.
- [x] Return an opaque revision with each bounded skill catalog, restrict candidate
      locators to bounded `JsonValue`, and let core stamp selected candidates into
      exact `SkillReference` values. Candidate provider IDs must match the owning
      provider; catalog/locator data never enters diagnostics.
- [x] Persist the exact skill reference in activated snapshots without loaded
      instructions/resources. On resume validate schema, bounds and provider
      identity before provider code, then require provider validation of revision/
      locator; unavailable references fail before model/resource use. Validate
      resource paths as bounded provider-relative no-traversal paths.
- [x] Add skill matrices for changing catalog revisions, removed candidates,
      forged provider IDs, malformed/oversized/circular locators, stale resume,
      resource traversal and cancellation during reference validation/load.
- [x] Require an `AbortSignal` for every skill-provider list/load/resource call;
      test abort before access, during I/O, and during runtime close.
- [x] Move bounded task memory into core and implement the borrowed `MemoryStore`
      slot: required/best-effort load and commit, compare-and-swap conflict,
      abort, no overwrite after failed load, and usage-preserving failure reports.
- [x] Replace implicit fixed memory keys with explicit `conversation | fixed`
      scopes. Derive conversation keys through a versioned collision-free tuple;
      require `sharedAcrossSessions: true` for fixed scope and exclude raw keys/
      namespaces from snapshots, logs, errors, and observation attributes.
- [x] Allow `AgentSessionOptions.memory` to supply a borrowed binding or `false`
      with precedence over the agent default. Persist only support-safe
      `memoryBindingId`; reject missing/mismatched resume bindings before store I/O
      and add cross-tenant, fixed-sharing, disable, resume, and delimiter-collision
      matrices.
- [x] Treat skill providers and memory stores as always borrowed in v1. A package
      with asynchronous backing connection keeps connect/close caller-owned and
      closes only after runtime quiescence; do not imply an ownership transfer
      until a typed registration boundary exists.
- [x] Preserve one typed streaming surface for commentary, assistant deltas, host
      tool calls/results, provider-native tool progress, and terminal usage.
- [x] Restore `NativeToolSchemaMap`, typed Web Search/Image Generation,
      `NativeToolName`, `ModelToolSchema`, and discriminated host/native
      `ToolChoice` across core/agent/provider declarations. Carry exact native
      definitions through `GenerateOptions` into wire protocols.
- [x] Validate native-tool configs as bounded deeply detached JSON-safe data at
      agent definition/binding; reject callbacks, host objects, circular values,
      credentials and unsupported names before dispatch. Treat absent model
      capability metadata as unknown and an explicit list as an allowlist.
- [x] Keep provider-native execution outside host scheduling/approval, preserve
      correlated native progress with bounded `JsonValue` caller payloads, and
      exclude those payloads from default observation export. Add mutation,
      capability, tool-choice, config-bound and host/native event matrices.
- [x] Add pre-allocation Web Platform feature preflight and one internal
      clock/random/timer adapter; remove `Math.random` ID fallbacks and clear all
      runtime-owned timers/listeners during close.

Exit evidence: core package tests, API snapshot, bundle budget, and Universal
consumer fixture.

## Phase 3 — Provider plugin contract

Prerequisites: D3 and D8 entry evidence.

- [x] Add capability/provider API compatibility metadata.
- [x] Validate each executable family marker at its composition point before
      calling package methods or allocating the owning core object.
- [x] Require a literal family `kind` plus independently versioned `apiVersion`;
      reject wrong-family values even when their numeric versions coincide, and
      make `define…` helpers stamp both fields.
- [x] Keep provider setup and registry cleanup synchronous. The recommended
      helper grammar uses `undefined`, not `void`, to reject accidental async
      callbacks at compile time; direct legacy implementations returning a
      Promise/thenable fail with stable async-unsupported codes.
- [x] Seal the registrar immediately after setup, discard all staged topology on
      async/invalid setup, contain late rejection, and reject every late mutation.
      Remove committed topology before invoking captured cleanup exactly once;
      an async cleanup result is a contained failure, never an implicit lifecycle.
- [x] Convert every runtime-valued core edge in `provider-http` and wire support
      packages to a bounded peer; recursively reject nested normal core copies.
- [x] Remove the four inventoried cross-package `instanceof AgentSdkError`/
      `ModelError` gates from `provider-http`. Normalize a bounded own-data failure
      envelope structurally and require outer/inner code agreement; malformed or
      accessor-backed foreign data becomes `UNKNOWN`, never a trusted retry code.
- [x] Treat `ModelAdapter` inheritance as authoring ergonomics, not nominal
      runtime admission. Add a deterministic structurally compatible adapter and
      isolated duplicate-module failure fixture; preserve code/status/retry/
      request ID without accepting arbitrary duck-typed error codes.
- [x] Preserve synchronous transactional topology setup.
- [x] Preserve the current `ModelAdapter` author surface: stream chunks, model
      catalog/resolution, retry policy, atomic `prepareCall`, invocation/physical-
      attempt accounting, registration handles and stream middleware.
- [x] Restore `provider-http` as a real extension kit: versioned wire protocol
      path/headers/serialize/translate methods, header and dynamic auth, injected
      fetch, bounded discovery/catalogs, dialect/model decoration, retry/transport
      bounds, error classification and the compatibility wire logger.
- [x] Implement `defineWireProtocol()` as a side-effect-free frozen wrapper and
      validate/snapshot its marker and method table before adapter allocation.
      Protocol packages remain structurally independent of provider-http while
      official provider packages pin compatible implementation dependencies.
- [x] Narrow v1 `serialize()` to one synchronous JSON object. Before dispatch,
      reject unsupported/circular/accessor-backed/non-finite graphs, enforce
      depth/member/byte bounds, deep-detach, and encode once per prepared logical
      call; reuse identical bytes for every physical retry. Serialization failure
      creates no provider attempt and default observations never retain the body.
- [x] Add deterministic protocol fixtures for root primitive, Promise, function,
      bigint, non-finite number, circular graph, accessor, unsupported prototype,
      depth/member/byte overflow, post-prepare mutation, retry byte identity, and
      compatibility-wire-logger header redaction and exact-body opt-in. Non-JSON
      upload contracts remain out of v1 rather than silently accepting `BodyInit`.
- [x] Keep exact `eventsource-parser@4.1.0` capability-local to `provider-http`
      under ADR 0001. Require `text/event-stream` (parameters allowed), preserve
      WHATWG streaming UTF-8 behavior, and ignore SSE `retry` as reconnect policy.
- [x] Add `maxSseEvents` (default 100,000) and `maxSseEventChars` (default
      1,048,576) beside total response-byte/raw-chunk limits. Replace callback
      queue `Array.shift()` draining with a linear cursor and map all limit
      failures to `HTTP_SSE_LIMIT_EXCEEDED`.
- [x] Drive one resettable per-attempt idle deadline from every non-empty body
      read, including comment-only heartbeats. Require one final `finish`; map EOF
      before it to `STREAM_CLOSED`, reject output after it, never retry after any
      downstream output, and preserve the primary failure if bounded cancellation
      also fails.
- [x] Add deterministic SSE matrices for missing/wrong/parameterized media type,
      split/invalid UTF-8, CR/LF/BOM, comment-only heartbeat, slow-loris overall
      deadline, one-chunk event flood, event-size/count/raw-chunk/byte bounds,
      parser `retry` isolation, early EOF, duplicate/post-terminal output,
      cancellation failure and retry-before-versus-after-first-output.
- [x] Port the core+provider-http custom author contract to real exports and test
      rotating header credentials, dynamic headers, discovery abort/bounds,
      retry configuration, stream termination and transactional registration.
- [x] Make every official preferred factory a synchronous inert wrapper over the
      complete adapter option surface plus `id`, `routes`, and injected `fetch`.
      Default to `id = family` and `routes = [id]`; validate explicit routes as
      non-empty unique aliases before any credential/discovery/setup work.
- [x] Preserve OpenAI organization/project/store/models, Anthropic
      version/beta/thinking budgets, Codex catalog/OAuth/prompt-cache settings,
      and common retry/request/response/SSE limits through the plugin factory.
      Keep adapter/protocol exports advanced but compatible; normal examples must
      import only core plus the official provider.
- [x] Treat Codex `promptCacheKey` as provider-plugin-instance scoped. Correct the
      current comment that implies separate conversations get separate keys; test
      shared-instance behavior and isolation between two plugin IDs/routes. Do not
      claim conversation/tenant isolation without a separately designed dynamic
      provider-session contract.
- [x] Add deterministic official-factory matrices for default identity, custom ID
      inferred route, explicit aliases, duplicate/empty claims, two accounts,
      lazy credential/discovery behavior, provider-specific option forwarding,
      fixed family identity, custom gateway, injected fetch and rollback.
- [x] Restore complete additive-capability option surfaces in their named
      factories: filesystem discovery/scan/I/O hooks, MCP lazy/connect/reconnect
      controls, IndexedDB bounds, fetch retry/batch/ack bounds, JSONL
      durability/retention/sync controls, and injected host functions. Constructors
      remain inert; real readiness/connect operations are explicit and abortable.
- [x] Keep filesystem skill providers borrowed/lazy, connected MCP tool sources
      caller-owned/closed after runtime quiescence, and exporters explicitly
      owned or borrowed per registration. Add construction-failure and active-run
      cleanup tests for each combination without a generic plugin array.
- [x] Use `fileSystemSkillProviderPlugin()` in the migrated high-level Node
      harness so normal runtime composition exercises API-version preflight;
      preserve marker-free `fileSystemSkills()` as the advanced compatibility
      path and keep its same-source dual compile.
- [x] Preserve OpenTelemetry as `createOpenTelemetryBridge({ tracer, meter,
      logger? })`, not a fabricated batch exporter. Add high-level typed
      `observability.openSpan`, `processors`, `redactors`, queue/batch bounds and
      timeout options; snapshot callbacks before runs and never shut down
      caller-owned OTel providers.
- [x] Add deterministic browser OTel+IndexedDB composition, fetch exporter fault/
      retry/ack, JSONL recovery/retention, filesystem lazy-I/O and MCP ownership
      matrices. Prove optional OTel logs are unused without a logger and exact
      required/optional peer errors are actionable in packed consumers.
- [x] Replace spread-order header merging with five case-insensitive ownership
      layers: transport, SDK attribution, wire protocol, endpoint static and auth.
      Reject invalid/reserved names and every cross-layer/case-variant collision
      with stable support-safe codes before dispatch.
- [x] Track authentication-produced header names as sensitive provenance. Redact
      all of them from wire logs/diagnostics even when names do not match token/
      key regexes; static endpoint credentials are rejected in favor of auth.
- [x] Capture endpoint plus auth headers once per prepared logical call; all
      physical retries reuse that atomic generation and a new logical call
      resolves afresh. Never forward credential headers across an origin. Test
      collision ordering, custom signature names, snapshot reuse/rotation, abort,
      discovery and manual redirect hops deterministically.
- [x] Make registrar mutation handles activation-scoped: setup and runtime-owned
      rollback/close only; retained handles reject mutation while active so API
      preservation does not create public hot-install/remove behavior.
- [x] Keep the normal runtime provider topology immutable after construction;
      reject duplicate IDs/routes atomically and expose no generic hot-install API.
- [x] Keep credential resolution and network discovery explicit/lazy.
- [x] Validate credential markers before resolution/store I/O; propagate one
      operation signal through resolve/read/refresh/commit and redact values.
- [x] Replace hard-coded `redirect: 'error'` with a portable no-follow transport
      policy and test it in workerd/browser/Deno/Node for providers and every
      other Universal HTTP capability, including `observability-fetch`.
- [x] Support and test explicit model metadata independently from dynamic catalog
      discovery, including empty and failed discovery.
- [x] Expose immutable `AgentRuntime.providers()` and typed `modelCatalog()`
      snapshots so normal Web/model-picker consumers never need the mutable
      registry. Preserve explicit model invocation when discovery is unavailable.
- [x] Keep adapter `ProviderInfo.id/name` as route/display compatibility metadata,
      but enrich runtime discovery with one row per route carrying explicit
      `route`, owning `pluginId`, and provider `family`. `modelCatalog(route)` must
      return that same row; official packages freeze family and custom plugins
      fall back to plugin ID without deriving any identity from credentials.
- [x] Key dynamic catalogs by provider plugin instance plus route; different
      accounts use different instances/routes. Static catalogs bypass discovery,
      successful empty is distinct from unavailable, and failure never overwrites
      the last good snapshot or inherits the five-minute success TTL.
- [x] Implement per-key single-flight refresh with waiter-isolated cancellation,
      abort only after all waiters detach, monotonic opaque revisions, opt-in stale
      retention, five-second bounded failure backoff, force refresh and prepublish
      entry/byte validation.
- [x] Add deterministic matrices for concurrent callers, one/all abort, route and
      account isolation, empty vs unavailable, oversized/malformed discovery,
      stale opt-in/expiry, failure recovery, force refresh and explicit invocation.
- [x] Define a support-safe provider failure envelope with stage/status/request-id,
      dispatch state, and usage coverage.
- [x] Support multiple installations through explicit plugin identity/routes.
- [x] Reject duplicate plugin IDs/routes transactionally before adapter exposure;
      prove two same-family accounts route independently and that Web discovery
      correlates both route-to-instance catalogs without guessing from names.
- [x] Publish a provider conformance suite usable by third-party packages.
- [x] Run OpenAI, Anthropic, and Codex provider contract suites.
- [x] Re-run live usage/correlation acceptance for at least one provider.

Exit evidence: packed third-party-style provider fixture and stable incompatibility
error tests.

## Phase 4 — Capability packages and facade removal

Prerequisites: D4 entry evidence, the approved package map, and migration ADR.

- [x] Keep Universal remote MCP separate from Node stdio/server hosting.
- [x] Make official MCP connections satisfy versioned `ToolSource` directly; keep
      connect/close caller-owned and never snapshot their catalog at session construction.
- [x] Preserve MCP reconnect/state/refresh/OAuth and all operation/catalog/result
      bounds in the target declarations; expose a catalog revision and apply
      refresh only to the next invocation snapshot.
- [x] Return one support-safe, bounded, idempotent `McpCloseReport` from the
      additive `closeWithReport()` method while preserving `close(): Promise<void>`; retain it
      separately from `RuntimeCloseReport` and never report a teardown timeout as
      successful closure.
- [x] Make `connectMcpHttp()`/`connectMcpStdio()` transactional: on partial
      startup failure run bounded reported rollback and throw one
      `McpConnectionError` retaining both the support-safe primary stage/failure
      and cleanup report. Re-export it from both recommended client routes; never
      let rollback replace startup or leak a partly opened generation.
- [x] Keep Universal `createMcpServer()` inert with no fabricated cleanup
      obligation. Keep the Node `serveMcpStdio()` handle host-owned, call its
      bounded `close({ signal })`, and inspect deadline/unsettled-request evidence.
- [x] Make every recommended MCP runtime recipe create runtime before connecting,
      pass `runtime.logger(...)` to the connection, and use nested cleanup guards
      that quiesce/close runtime first and still close the borrowed connection.
- [x] Change MCP HTTP redirect handling to manual pre-hop validation; prove an
      unallowed target is not contacted and capability headers cannot cross origin.
- [x] Keep filesystem skills explicitly Node-bound.
- [x] Keep file credentials explicitly Node-bound and injected into providers.
- [x] Preserve Codex auth `read/write` as the deprecated compatibility contract;
      add a distinct revisioned `CodexCredentialStore` `read/commit` path, use
      atomic file replacement, resolve concurrent refresh by reloading the winner,
      and never turn read failure into create/overwrite.
- [x] Make `auth-node`'s Codex provider dependency an optional peer so `/env`
      does not install an unrelated provider; test env-only and Codex closures.
- [x] Make the `auth-node` root env-only; keep Codex on `/codex` so root ESM
      resolution does not require the optional provider.
- [x] Keep browser persistence and remote telemetry exporter-specific.
- [x] Replace internal imports of `@ai-agent-sdk/node` with exact capabilities.
- [x] Remove or quarantine the two compatibility facades.
- [x] Apply `documentation-migration.json`: rewrite all active install/import
      examples, mark the four prior implementation/design documents historical
      or superseded, and advance its state only when no unclassified legacy
      example remains.
- [x] Document `createAgentRuntime`, `defineAgent`, and `SdkLogger` in core; make
      each of the 17 non-core READMEs show its exact recommended entrypoint,
      typed composition location, lifecycle ownership, and package install.
- [x] Preserve all 17 typed composition proofs when replacing target declarations
      with real exports. Each preferred factory must remain imported from its
      documented route, selected directly by the fixture, and wired into its
      actual provider/tool-source/skill/exporter/host/team slot.
- [x] Add negative runtime-boundary and dependency-closure fixtures per package.

Exit evidence: package graph diff shows each consumer installs only selected
capabilities; no hidden Node dependency reaches an Edge bundle.

## Phase 5 — Human acceptance

Prerequisites: D7 entry evidence and the packed package artifacts produced by
the prior migration phases.

- [x] Edge website installs only core, provider, and Universal capabilities.
- [x] Keep the browser artifact SDK-free by default; inject provider credentials
      only into the Edge Worker and never accept/return them through browser JSON,
      local storage, SSE, diagnostics, or raw errors.
- [x] Bind every conversation to trusted principal identity or a server-issued
      opaque handle; use one canonical session/history and exclude chat mode from
      its storage key.
- [x] Edge website streams assistant output and visible tool-call progress.
- [x] Give every SSE envelope schema version, SDK run ID, monotonic sequence and
      exactly one support-safe terminal outcome/report; render premature EOF as
      incomplete and do not replay automatically without a resume protocol.
- [x] Combine request abort, response `cancel()`, and runtime close through one
      owned controller; wait for session idle with a bounded deadline and prove
      no provider/tool operation survives disconnect.
- [x] Project tool input/result through explicit public JSON-safe bounds and
      never forward raw thrown/provider messages to the browser.
- [x] UI/telemetry project both host tool events and provider-native tool events;
      do not count searches by parsing model prose.
- [x] Edge deep-search consumer configures typed provider-native Web Search when
      supported, shows its progress distinctly, and proves the protocol receives
      the exact detached config; retain the host-search path for approval-controlled
      or provider-independent deployments.
- [x] Preserve stable call IDs and terminal statuses for both tool families so
      repeated search/read calls, failures, cancellations, and completed calls
      can be paired without fabricated lifecycle events.
- [x] Deep-search mode is a bounded host-owned run instruction overlay on the
      same session, not a hard-coded workflow, separate agent history, or raw
      browser-supplied system instruction.
- [x] Deep search performs multi-source search, page reading, coverage audit,
      contradiction audit, and a sourced final report.
- [x] Correct the historical Edge 16/16 evidence classification: it proves
      scripted SDK/UI behavior, not real-agent autonomy or semantic sufficiency.
- [x] Replace the fixture-only URL/topic audit oracle for real research; verify
      scoped successful read receipts, deduplicated source identity, partial-read
      status, claim support, contradictions and unresolved gaps per human-test
      design 4.2.1. Do not migrate the emulator's search/read/audit scheduler.
- [x] Manually assess real-agent planning and gap-driven follow-up using varied
      research requests; assert evidence relations and visible tool progress,
      not exact call sequences or canned report text. Record independent review
      and honest partial outcomes when budgets or missing evidence prevent completion.
- [x] Node harness installs core, provider, and explicit Node capabilities.
- [x] Node harness covers filesystem skills, MCP stdio, persistence, cancellation,
      token accounting, traces, and support diagnostics.
- [x] For every selected MCP/A2A capability, assert the frozen integration
      operation/attempt matrix, lifecycle versus active-operation correlation,
      public tool timeline, metadata-only privacy, no token double counting, and
      independent cleanup evidence. Keep server matrices hermetic and live
      provider acceptance manual.
- [x] Both journeys fail visibly on missing usage or observation degradation.
- [x] Historical Edge scripted SDK/UI behavior passes 16/16 invariants; agent
      autonomy, Internet reading and semantic research quality remain unverified.
- [x] Current Node behavior passes 7/7 invariants.
- [x] Record current and target package graphs in a machine-checked manifest.
- [x] Run authenticated Internet deep research through the Edge website under
      the owner's explicit implementation-goal authorization; retain bounded
      progress, sources, usage, failure and final report artifacts for review.
- [x] Run authenticated Internet deep research through the Node control and
      preserve its final Markdown report under `test-human/results/`.

Exit evidence: recorded human-test reports under their existing artifact policy.

## Phase 6 — Final release-readiness audit

- [x] Recount direct/transitive third-party runtime dependencies. The checked
      installed-tree report covers all 18 target packages and records 6 unique
      direct roots plus 20 unique installed third-party packages; run
      `pnpm check:runtime-dependencies` to reject drift. See
      [I8 dependency evidence](./implementation-evidence/I8-runtime-dependencies.md).
- [x] Re-audit `eventsource-parser`: retain exact `4.1.0` under ADR 0001 because
      the owned candidate failed all throughput gates; keep it out of core.
- [x] Run package, type, lint, supply-chain, Edge, browser, Node, recovery, and
      human coverage gates; execute only deterministic gates automatically and
      keep provider/network journeys manual. For AI-safe local evidence, run
      `node scripts/check-supply-chain.mts --skip-audit`; the root
      `check:supply-chain` command includes an external registry advisory query
      and remains a manual network gate.
      See [I8 deterministic release-gate evidence](./implementation-evidence/I8-release-gates.md).
- [x] Inspect packed tarball contents and conditional exports.
- [x] Compile installed ESM consumers without workspace `paths`: NodeNext with
      Node types, and Bundler Web consumers without Node types under `workerd`
      and `browser` conditions separately. Cover all supported public specifiers,
      including MCP HTTP root/client/server compatibility routes. No known-error
      baseline is permitted for this final acceptance gate; verify the resolved
      declaration files belong to the installed closure and no ambient Node types
      enter a Web compile. Keep runtime execution evidence separate.
- [x] Resolve core from every packed provider/support package and prove exactly
      one physical core path in the installed closure; reject nested normal core
      dependencies, embedded core modules and merely-semver-compatible duplicates.
- [x] Prove all public root/subpath/temporary bridge routes re-export canonical
      runtime values; do not add a global/Symbol singleton detector.
- [x] Diff generated API reports against the 417-symbol migration baseline before
      deleting either bridge; require compatible signature/value identity for
      every preserved symbol and an approved migration note for every removal.
- [x] Diff retained provider declarations against the frozen 84-symbol baseline;
      recommended plugin-factory docs are not authorization to remove adapter,
      protocol, OAuth, error, SSE or diagnostic author APIs.
- [x] Verify root/subpath exports resolve to identical values and type declarations
      for every duplicate route; reject subpath-local registries, buses, classes,
      wrappers, or declaration copies.
- [x] Render each migrated manifest from topology policy and compare exact export
      keys, normal dependencies, peers, optional-peer metadata, engine/runtime
      metadata, packed files, binary entrypoints, root `main`/`types` mirrors,
      non-executable `aiAgentSdk` runtime/coreApi/roles, and `private` state;
      publishing remains out of scope.
- [x] Inspect source and emitted artifacts to prove runtime code never imports
      package manifests, scans `aiAgentSdk` metadata, or auto-loads capabilities;
      metadata is for build/docs/release validation only.
- [x] Compare bundle sizes with approved budgets. Contract-only (13,154 gzip)
      and aggregate core runtime (124,530 gzip) pass; the basic public agent
      (96,014 gzip) exceeds its approved 70,000-byte budget and blocks go-live.
- [x] Add sampled workerd heap budgets (4 MiB contracts, 16 MiB basic peak,
      8 MiB basic delta) with explicit sampling limitations.
- [x] Check every public example installs the packages it imports; require the
      migrated documentation state and zero removed-package examples outside
      explicitly historical records.
- [x] Confirm no publish step is configured or executed in this workstream.
- [x] Produce the final gap matrix and explicit go/no-go decision. The current
      decision is no-go; see
      [I8 final gap matrix](./implementation-evidence/I8-final-gap-matrix.md).

## Decision log

| Date | Decision/evidence | Effect |
| --- | --- | --- |
| 2026-09-04 | Debug is filtered by default, info logs can be dropped, and critical-checkpoint delivery does not cover every integration event | preserve advanced health while adding runtime integration loss counters; require event-ID acknowledgments and balanced expected operations before claiming complete traces; keep ring diagnostics and token accounting distinct |
| 2026-09-04 | Current connected MCP factories attempt cleanup after startup failure, but a rejecting cleanup replaces the primary connect error and no report is returned | make connected factories use bounded reported rollback and throw a route-reexported `McpConnectionError` that retains support-safe primary stage/failure plus cleanup evidence |
| 2026-09-04 | The 27 integration operations still emitted free-form logger objects, so packages could disagree on logical/attempt IDs, phases, status or duration while type checks passed | add a focused `IntegrationOperationEvidenceFields` discriminated grammar with 64/128-character bounds and compile all four logical/attempt start/terminal variants without expanding the curated core root |
| 2026-09-04 | Runtime close shuts down its observation bus and logger, so a required MCP/A2A teardown log after runtime quiescence was impossible without unsafe ordering or a generic core cleanup locator | keep runtime-active operation logs, prove post-runtime teardown with independent support-safe reports, add A2A unlink/dispose report APIs and Node MCP server close errors, and retain all compatibility methods |
| 2026-09-04 | The shared runtime-before-integration cleanup policy was compiled for MCP but A2A only returned an unlink handle; runtime close already removes routing and must not imply ownership of an injected transport resource | compile runtime close before idempotent reported unlink in `finally`, retain link-versus-transport ownership separation, and leave any independently resource-owning client with its original caller |
| 2026-09-04 | A logger captured at integration construction has runtime lifecycle identity but cannot truthfully represent a later MCP tool run or A2A team send; human acceptance did not separate public tool progress from operational evidence | split lifecycle and active-operation correlation channels, add an optional compatibility logger to linked-agent send input that RuntimeAgentTeam must populate, and gate UI/CLI timelines independently from integration operation logs and token accounting |
| 2026-09-04 | Flagship Edge and Node fixtures connected caller-owned MCP before runtime existed, so connect/auth/reconnect could not use runtime correlation; server and A2A target options also lacked one consistent logging rule | create runtime before connection in recommended journeys, pass its bound logger to MCP/A2A client and server operations, close runtime before integration teardown with nested guards, and keep logger optional/no-console for standalone advanced use |
| 2026-09-04 | Runtime logging reached model/tool/hook contexts but versioned credential, memory, skill, tool-source, and provider-setup authors had no correlated logger; injecting one into exporters would recurse | require bound loggers in five safe capability contexts, retain core-owned lifecycle evidence, prohibit secrets/content/raw errors and exporter logger injection, and compile all author paths |
| 2026-09-04 | Both MCP server factories were labeled `host-owned`, although the Universal server is inert and exposes no cleanup handle; the Node proof never called its real close method | classify the Universal server as `inert-host-mounted`, retain Node hosting as a caller-closed handle, and compile deadline/unsettled close-report use |
| 2026-09-04 | Recommended-entrypoint checks proved only export presence; Universal `mcp-server` had no direct host journey and env convenience used `/env` instead of its recommended root | bind all 17 entries to compiled wiring fragments and direct journeys, add an Edge MCP server host as journey 25/recipe 13, and move normal env composition to the root while retaining `/env` compatibility proof |
| 2026-09-04 | Current doc checks allow stale facade examples and do not prove a usable entrypoint in each target README | freeze four route families across 27 Markdown files, assign rewrite/delete/history dispositions, and make I6/I7 documentation cleanup machine-checked |
| 2026-09-02 | Current Node facade pulls 17 workspace dependencies | remove global environment facade from target UX |
| 2026-09-02 | Registry setup is sync but exporter shutdown is async | runtime factory becomes awaitable; provider setup stays sync |
| 2026-09-02 | Both definition and high-level run paths default Codex/Luna | remove both defaults, not only `defineAgent()` |
| 2026-09-02 | Current memory exporter is unbounded | create a separate bounded diagnostic ring for core |
| 2026-09-02 | Core currently materializes medium effort before model resolution | let adapter model metadata supply the default when omitted |
| 2026-09-02 | Hermetic spike passed 5/5 tests | D2, compatibility, and diagnostic eviction evidence are available |
| 2026-09-02 | Live Codex spike: 166 authoritative tokens, 18 healthy events, clean close | D8 passed; composition shape is viable |
| 2026-09-02 | API v2 mismatch rejected before setup/observation access | compatibility validation must precede resource allocation |
| 2026-09-02 | Strict workerd exposes Buffer/process at the 2026 compatibility date | fixtures must unset globals and inspect emitted imports independently |
| 2026-09-02 | Contract/basic bundles are 11,982/62,928 gzip bytes with no externals; sampled peaks are 0.92/6.04 MB | D5 entry budgets pass provisionally; target tarball exit evidence remains open |
| 2026-09-02 | Edge 16/16 and Node 7/7 hermetic behavior pass | scripted behavior checks pass; two topology migrations remain, and Edge agent autonomy/research quality are not established |
| 2026-09-02 | Human checker required the Node facade | remove facade exception and track current/target graphs declaratively |
| 2026-09-02 | Packed external provider passes catalog/stream/usage/cancel/cleanup | current provider contract is consumable; future runtime testkit remains |
| 2026-09-02 | workerd rejects provider-http `redirect: 'error'` | Universal classification needs semantic fetch tests and a portable no-follow policy |
| 2026-09-02 | Edge Codex discovery is empty and request returns 403 after shim; Node control passes | do not claim direct Codex Edge support; separate catalog and invocation gates |
| 2026-09-02 | `usagePolicy: fail` masked the primary transport failure | primary error wins; missing usage remains correlated coverage evidence |
| 2026-09-02 | Live research: 7 native searches, 28 URLs, 5 domains, 76,856 tokens | native events, not model self-report, are the acceptance source of truth |
| 2026-09-02 | 20 manifests expose 7 unique external runtime/peer names | capability selection keeps those closures explicit; core alone remains zero-dependency |
| 2026-09-02 | Owned SSE parser passed correctness/fuzz but was 71.68%–83.13% slower | retain exact eventsource-parser 4.1.0 for 0.x under ADR 0001 |
| 2026-09-02 | Regex import inspection missed minified `}from"pkg"` and let an incomplete bundle reach Wrangler | use one AST parser with syntax self-tests and per-request probe timeouts |
| 2026-09-02 | Packed Universal/Node skill providers pass lazy loading, confinement, abort, and runtime elevation | typed capability composition is viable; target core-only peer/testkit remain open |
| 2026-09-02 | Executable `SkillProvider` had no marker because it lacks `setup()` | version executable protocols by family and validate at their composition point |
| 2026-09-02 | `auth-node/env` currently installs `provider-codex` through the package dependency | make Codex an optional peer and keep both packages explicit in the Codex recipe |
| 2026-09-02 | Outer providers could peer on core while `provider-http`/protocol helpers still normal-depend on it | require bounded core peers recursively for every support package importing runtime values |
| 2026-09-02 | D4/D5/D7 mixed pre-migration baselines with artifacts only producible after migration | split every phase gate into entry authorization and post-change exit evidence |
| 2026-09-02 | Packed `observability-fetch` passed with a mock while native Workerd rejects its `redirect: 'error'` | require a native-fetch semantic matrix for every Universal HTTP capability, not only providers |
| 2026-09-02 | Packed external exporter preserves usage/privacy and passes retry/ack/abort/shutdown with family marker | observation-exporter composition is viable; merged core-only peer validation remains exit evidence |
| 2026-09-02 | AgentSession copies an MCP-style live catalog at construction; a later tool is absent from the model request and never executes | add a distinct live `toolSources` slot and freeze one collision-checked snapshot per invocation |
| 2026-09-02 | Two packed stdio MCP servers compose and close live; collision and API-v2 fail before dispatch/method access | versioned `ToolSource` is viable and official connections should implement it directly |
| 2026-09-02 | Workerd follows an MCP 307 to an unallowed origin and forwards the fixture header before final-origin rejection | native fetch must use manual redirects and validate before each hop; final-URL validation is too late |
| 2026-09-02 | Standalone forced MCP bundling hits the upstream `pkce-challenge` exports resolver while Wrangler's packed-module path runs | add a supported-bundler closure matrix; do not confuse toolchain resolution with runtime compatibility |
| 2026-09-02 | Current env-only auth install contains 6 packages/998,762 bytes including Codex and `eventsource-parser`; staged target contains 2 packages/517,466 bytes and no external runtime dependency | core becomes a bounded peer, Codex an optional peer, root env-only, `/codex` explicit |
| 2026-09-02 | Staged `/codex` without provider fails with `ERR_MODULE_NOT_FOUND` naming `@ai-agent-sdk/provider-codex`; explicit full install constructs with zero network/write I/O | document the peer recipe and keep failure actionable; target source/pack gates remain open |
| 2026-09-02 | Exact-package compile matrix passes five consumer journeys plus negative contracts with zero emitted JavaScript | target import ergonomics are now concrete; export, closure, and live behavior remain post-migration evidence |
| 2026-09-02 | Executable spikes can interrupt the AI goal through external content classification | retain prior reports as history; automate only static/compile/deterministic checks and make live acceptance manual |
| 2026-09-02 | `pnpm test` and `pnpm test:unit` selected a unit file that imports the historical spike prototype | quarantine the file in shared Vitest routing and let the topology checker reject any future re-entry |
| 2026-09-02 | The first Node-minimal fixture pulled `auth-node`, and the first Edge fixture did not compile a progress stream | keep core+provider as the true minimal Node selection; model env auth as explicit elevation and freeze typed host/native tool events |
| 2026-09-02 | Facade imports are confined to known wrappers, package fixtures, tests, and human journeys inside this repository | remove only through the machine-checked migration inventory; external consumer knowledge remains an owner decision |
| 2026-09-02 | Third-party provider authoring initially lost contextual typing through `Object.freeze()` | document `satisfies ModelProviderPlugin`; public extension contracts now compile without a generic registrar or facade |
| 2026-09-02 | A final-text-only consumer could pass the package gate without proving traceable tool/error/usage projection | require correlated typed stream events plus post-run health and eviction diagnostics in the exact-package Edge and Node contracts |
| 2026-09-02 | Official capability consumers did not prove third-party family contracts were independently implementable | add a core-only author journey for skills, exporters, and tool sources; keep lifecycle and composition slots family-specific |
| 2026-09-02 | The first author contract reduced `SkillProvider` to eager full-definition listing | restore candidate discovery, lazy `load()`, advertised `readResource()`, abort input, and provider-owned locator flow before API freeze |
| 2026-09-02 | The first exporter author contract returned `Promise<void>` | restore batch/event identity, `ExportAck`, required abort signal, and `shutdown()` so the core merge cannot erase delivery/accounting semantics |
| 2026-09-02 | The first tool-source author contract exposed only get/has/names | restore model-safe schemas and fail-closed execution modes so external catalogs remain advertisable and schedulable |
| 2026-09-02 | The first machine topology covered only 11 journey packages | expand it to the complete retained target map and seven exact external runtime dependency/peer declarations before package-map approval |
| 2026-09-02 | Prototype defaulted to 256 diagnostics, but the benchmark exercised 32 and events allow 64 KiB each | propose P0-09 as 256 events plus 1 MiB, expose byte counters, and re-freeze from the migrated packed core |
| 2026-09-02 | Open Phase 0 choices were duplicated across audit/design/ADR prose | create stable decision IDs with owner attribution and a drift checker before any source migration |
| 2026-09-02 | Recommended MCP examples started `try` after runtime construction and closed MCP before runtime | protect caller-owned MCP across construction failure and quiesce runtime before closing the borrowed source |
| 2026-09-02 | Exporter registration had no ownership field despite the borrowed-by-default rule | require explicit ownership; transfer only after marker validation and rollback owned activation transactionally |
| 2026-09-02 | Provider design promised multiple accounts but official option declarations exposed no `id/routes` | add a two-instance compile journey and require explicit instance/route options on official providers |
| 2026-09-02 | Package/design prose promised memory plugins but the machine contract had no memory marker or composition slot | add a borrowed optimistic `MemoryStore` family with explicit isolation scope, reliability, abort, and compare-and-swap revision semantics |
| 2026-09-02 | Credential callbacks had optional cancellation and Codex auth exposed only blind `read/write` | add one credential source/store family with required abort, lazy marker validation, revisioned commit, and caller-owned lifecycle |
| 2026-09-02 | The target contract initially collapsed canonical six-bucket/attempt-aware accounting into a four-field `Usage` shape | preserve attempt, model-call, and run reports; keep estimates/coverage/delivery explicit and project the full terminal report on success and error |
| 2026-09-02 | Compaction currently invokes the registry directly and only stores stream usage in history/span output | require every compaction summarizer call to enter the canonical run ledger exactly once; do not separately sum its history projection |
| 2026-09-02 | The first target exporter batch attached one `usage` value although batches may mix runs or split one run | replace it with atomic per-run terminal records, unique by run ID and stable across delivery retry |
| 2026-09-02 | Putting caller-facing `RunReport.delivery` in the batch made the report depend on acknowledgment of itself | export/checkpoint a delivery-free `RunTerminalRecord`, acknowledge its run ID, then freeze the local `RunReport` with delivery summary |
| 2026-09-02 | Target exporter registration used `operational/acknowledged/durable` while receipts and run reports used `none/local-durable/remote-acknowledged` | separate delivery mode from one canonical boundary type and require exporters to declare supported boundaries |
| 2026-09-02 | Target observation events lost run/span sequencing and target skill-provider cancellation remained optional | preserve the canonical metadata envelope and require abort on every executable skill operation |
| 2026-09-02 | The first target session policy replaced current `warn | estimate | fail` with `report | fail` while still advertising estimated coverage | preserve the existing policy and local-only estimator contract; do not introduce an unrelated breaking rename during package migration |
| 2026-09-02 | The initial target declaration retained only minimal agent/tool/skill shapes and omitted existing high-value author/session behavior | preserve common helpers, tool policy hooks, skill metadata/resources, native tools, compaction, snapshot, and resume before moving source |
| 2026-09-02 | Design promised marker-stamping author helpers but the contract made authors hand-write markers for five families | add family-specific side-effect-free `define…` helpers; keep runtime slots typed rather than introducing a catch-all plugin helper |
| 2026-09-02 | Target core exposed a human-in-loop mode without brokers, interceptors, hooks, or pause events, and used the wrong mode literal | preserve `deep-human-in-loop`, Web-safe bounded brokers/policy hooks, required abort, and correlated approval/user-input stream events |
| 2026-09-02 | Target session snapshot stored history as `unknown` and target core promised teams without a composition API | freeze a JSON-safe v1 session envelope and add runtime-owned Universal local-team composition; keep remote A2A optional/Node-bound |
| 2026-09-02 | Target MCP declarations erased reconnect/state/refresh/bounds and returned no close evidence | preserve operational controls, catalog revision and a separate support-safe `McpCloseReport` while keeping connections caller-owned |
| 2026-09-02 | MCP client packages still installed server/hosting dependencies that their Edge and Node client journeys never import | split Universal and Node server hosting into `mcp-server` and `mcp-node-server`; client recipes remain client-only |
| 2026-09-02 | Edge fixture keyed history by `conversationId:mode`, trusted the client ID alone, exposed raw errors and had no response-cancel settlement or sequence/terminal-loss detection | freeze an Edge Worker deployment policy and compile-only core+provider journey; keep one principal-bound session and use host-mapped run instructions for deep search |
| 2026-09-02 | `additionalInstructions` was typed as a string but “bounded/appended” left byte limits, ordering, retries, compaction, persistence, privacy and authority undefined | freeze a core-wide 65,536-byte pre-admission run-instruction policy and require deterministic I3 behavior tests |
| 2026-09-02 | Target `AgentRunHandle` added `abort()` but omitted current source's independently awaitable `report`; the first Edge adapter also did not abort after downstream stream failure | retain run ID/result/report plus idempotent abort, freeze terminal identity/privacy/idle semantics, and abort+settle every downstream failure path |
| 2026-09-02 | The 415-symbol baseline checker validated only current declarations, so target contracts passed while missing 324 preserved names | resolve assigned target declarations, freeze exact missing count/hash, restore invocation/observability compatibility, and reject Phase 0 approval until the remaining 255 reaches zero |
| 2026-09-04 | The root-only 415-symbol inventory omitted `validateCandidate` and `validateSkillResourcePath`, which exist only at `@ai-agent-sdk/agent/skill-validation`; the generic one-file agent bridge would also delete that live route | expand the authoritative API inventory to 417, dual-compile the same consumer against current and target declarations, route the subpath to `@ai-agent-sdk/core/skills`, and require a two-entrypoint re-export-only agent bridge until I7 |
| 2026-09-04 | The root `check:supply-chain` script performs a registry-backed `pnpm audit` and can wait on external network even though most of the checker is deterministic | record the command hazard, use the checked `--skip-audit` path for AI-run pin/integrity/lifecycle/license evidence, and retain the online advisory query as an explicit manual gate |
| 2026-09-02 | Renaming invocation options removed the current `onEvent` convenience and would force simple UI users onto manual stream iteration | preserve sequential bounded `onEvent` for run/generate with stable failure/report semantics; keep it distinct from durable observability |
| 2026-09-02 | Name parity treated incompatible replacements of event/resource/batch/ack/exporter/health contracts as preserved observability APIs | retain the advanced marker-free bus unchanged on `core/observability`; give runtime plugins distinct exporter/delivery/registration names and compile current-to-target source assignability |
| 2026-09-02 | Core message/content primitives were still absent, while direct cross-alias comparison of branded IDs would fail only because two test modules own different private symbols | restore 45 canonical symbols, compile the same source once against current and target core, and restore the canonical `AgentMessageSource` agent re-export; remaining parity is 209 |
| 2026-09-02 | Target marker requirements silently broke current advanced provider plugins/adapters and the remaining 67 core names had no target owner | keep advanced provider surfaces marker-free, move markers to the composable wrapper, restore all core names, and dual-compile current/target provider consumers; remaining parity is agent-only |
| 2026-09-02 | Target tool and skill declarations thinned current author/runtime behavior; `SkillProvider` was also repurposed under the same public name | restore the tool surface, preserve marker-free `SkillProvider`, and give the revision/reference runtime protocol distinct `SkillProviderPlugin` names with dual-compile evidence |
| 2026-09-02 | Memory/history classes existed in the target root but were not exported from the agent/memory views, and history snapshots had been reduced to untyped JSON | restore typed history events/surfaces, public memory/compactor classes and focused re-exports with same-source dual compile |
| 2026-09-02 | Target usage estimation replaced current `GenerateOptions` with a reduced request type, risking lost accounting context and source breakage | preserve `GenerateOptions`, restore accounting/trace APIs, and dual-compile the 16 missing plus eight signature-sensitive symbols; remaining parity is 52 agent names |
| 2026-09-03 | Target reused `AgentDefinition`, `AgentRunEvent`, `AgentSession`, and team names for narrower composition protocols | preserve current advanced contracts, introduce explicit `Runtime…` names for composition-only projections, and keep `defineAgent()` overloaded as the convenient entry point |
| 2026-09-03 | The final loop/definition and team/messaging passes closed 52 missing agent names | freeze same-source dual compiles for 27/15 and 25/2 inventories; target parity is now core 0, agent 0, observability 0, with owner approval still pending |
| 2026-09-03 | The canonical 513-name declaration barrel was also mapped as the public core root despite the curated-root requirement | keep it as one internal owner, map root to an exact 264-name re-export facade (184 retained core names plus 80 ergonomic additions), require focused package-author imports, and compile negative non-leakage checks |
| 2026-09-03 | Default and unit Vitest routes still selected a historical test importing `spikes/`, so a broad deterministic run violated the no-spike evidence policy | explicitly quarantine that file in the shared Vitest config, freeze the quarantine and command routes in topology, and keep all executable/live/network evidence manual-only |
| 2026-09-03 | Design prose retained `auth-node/env`, but the target topology exposed only root and `/codex` even though repository consumers still import `/env` | restore `/env` as the 26th public specifier, make it re-export the env-only root identity, and compile both routes without the Codex closure |
| 2026-09-03 | Manifest policy named conditions but supplied no concrete export map, so packaging could still point core root at the 513-name barrel or collapse auth peer boundaries | add checked core/auth-node manifest blueprints with explicit routes, ESM/type targets, no wildcard/CommonJS route and no exported canonical owner |
| 2026-09-03 | P0-03 described specifier and facade counts only in prose while machine approval bound only the package count | add checked `targetSpecifierCount` and `coreRootExportCount` fields beside `targetPackageCount` |
| 2026-09-03 | API parity covered core/agent/base-observability and provider roots but skipped 19 public capability entrypoints; target placeholders were missing 301 of 344 export occurrences | freeze all current routes, declarations and names; restore six omitted subpaths; add five complete manifest blueprints; and keep I0 blocked until the exact hash-locked gap is restored or explicitly approved |
| 2026-09-03 | Protocol target placeholders preserved only three names each and would have replaced marker-free advanced contracts with marker-required runtime shapes | restore all 31 Responses and 34 Anthropic exports, keep `ProtocolDefinition` marker-free, type each official protocol value as an advanced/runtime intersection, and enforce same-source current/target compiles; retained gap falls to 239 |
| 2026-09-03 | New exporter factories had displaced current classes, durability/recovery/lifecycle controls, OTel log shapes and Node diagnostic subpaths; focused core observability also omitted `JsonValue` | restore all six observability entrypoints, keep advanced exporters marker-free, make runtime factories additive adapters, re-export canonical JSON types on the focused author path, and dual-compile one source against current/target; retained gap falls to 196 |
| 2026-09-03 | MCP split declarations omitted 42 export occurrences, changed `close(): Promise<void>` under the same name, reused `error` for a support-safe projection, and had no route-level signature proof | restore client/server APIs under canonical owners, preserve `/client` and optional-peer `/server`, use distinct `closeWithReport()` and `supportError`, dual-compile one source through current/target route aliases, and keep root moves under P0-14; retained gap falls to 154 |
| 2026-09-03 | Auth target declarations made callable env credentials non-callable and repurposed `CodexAuthStore.read/write` as revisioned `read/commit` under the same name | return a callable/versioned intersection, preserve blind-store and Node wrapper APIs, add distinct revisioned store/provider surfaces, dual-compile Auth/provider routes, and reduce the retained gap to the 76 A2A occurrences |
| 2026-09-03 | A2A target routes exposed only an invented placeholder and omitted all 76 existing client/server/root occurrences | restore canonical client and server declarations, retain the root as their combined view, dual-compile representative bounded client and disposable server use, and close the 344-occurrence retained ledger to zero |
| 2026-09-03 | The 84-symbol provider baseline checked only current declarations and allowed 24 target omissions; filesystem `fileSystemSkills()` was also repurposed as a marker plugin | compare every provider name against its target, restore the 22 HTTP and two Anthropic names, preserve the marker-free filesystem factory, add a distinctly named runtime adapter, and dual-compile filesystem usage |
| 2026-09-03 | Provider name parity hid callback, protocol marker/serializer, dynamic-auth, discovery-context, mutability, and adapter-return signature breaks | preserve current advanced HTTP/official-provider contracts, introduce distinct `Runtime…` HTTP contracts and composition overloads, and dual-compile one representative source against all four current and target provider packages |
| 2026-09-03 | Normal-install policy had only an OpenAI minimal journey and provider roots lacked exact export-map blueprints | add isolated Anthropic and injected-store Codex journeys, assert all three provider closures and both auth closures, and expand exact ESM/type/package-json blueprints from five multi-entry packages to nine packages including every provider root |
| 2026-09-03 | Nine export blueprints still left dependency sections and optional-peer metadata implicit, while P0-03 named only the original five blueprints | freeze topology-to-manifest section encoding, require every optional workspace peer to have an owning subpath, reject dependency/peer overlap and external-version conflict, and synchronize P0-03 with all nine blueprints |
| 2026-09-03 | Exact closure assertions covered provider/auth recipes but not extended Edge, Browser, Node harness, MCP routing, or extension-author journeys | add an independent 20-journey install-closure baseline for workspace packages, required external selections, and effective runtime |
| 2026-09-03 | Design promised `aiAgentSdk` capability metadata but topology froze only runtime, and the singular example could not describe legitimate multi-role packages | assign all 18 packages exact roles from a checked 16-role vocabulary and render descriptive runtime/coreApi/roles metadata without runtime scanning or auto-loading |
| 2026-09-03 | The documented direct-browser core+OpenAI+IndexedDB recipe was proved only by a larger fixture that also installed OpenTelemetry | add an exact three-package Browser journey, exclude OTel explicitly, and freeze its transitive/external closure independently |
| 2026-09-03 | Public `pnpm add` examples were review-only prose and could drift from the machine topology | parse all five recipe sections and compare their direct package sets with the associated compile journeys |
| 2026-09-03 | Nine single-entry protocol/MCP/skill/observation packages still relied on output-map convention rather than exact manifest blueprints | extend explicit types/import/default/package-json maps to all 18 packages and require blueprint owners to equal the complete topology |
| 2026-09-03 | Declaration parity could stay green while migration dropped auth-node's installed login command or omitted its packed `bin` directory | freeze common/additional packed files, exact binary mapping, root main/types mirrors and Node-only engine metadata; compare the binary with the current manifest |
| 2026-09-03 | Provider extension journeys compiled, but package authors had no explicit install recipes and support packages looked like unexplained internals | document Responses-compatible, custom HTTP and non-HTTP author paths; bind all three commands to exact compile journeys and closures |
| 2026-09-04 | I1/I2 named directories but had no exact file inventory, self-import rewrite ledger, atomic bridge transition, or machine state after the move | add a 56-file hashed source-migration map with 37 rewrite sites, dependency-valid group order, `pending/moved` checks, distinct observation/observability layers and I1-before-I2 enforcement |
| 2026-09-02 | Topology named packages/dependencies but did not freeze export conditions, side effects, engines, peer range, deep-import policy, or unpublished state | add schema-v5 manifest policy and make exact migrated-manifest comparison a release gate without configuring publication |
| 2026-09-02 | Target exporters exposed async readiness but runtime construction did not own or report that activation boundary | make `createAgentRuntime()` await bounded exporter readiness and return support-safe transactional cleanup evidence on failure |
| 2026-09-02 | Startup had a deadline but no caller cancellation, construction errors lacked failure reason/component, and observation batches lacked runtime/service identity | add a preflight-safe caller signal, structured failure classification, and immutable observation resource metadata |
| 2026-09-02 | Provider/exporter markers used only numeric `apiVersion: 1`, which cannot distinguish executable families at runtime | add literal `kind` discriminators and negative wrong-family contracts; helpers stamp both fields |
| 2026-09-02 | Target `ModelAdapter` was reduced to a marker and registrar registration returned `void`, erasing direct non-HTTP provider authoring, model binding, accounting, middleware and teardown | restore the current advanced provider surface on `core/provider`, add a direct adapter-author journey, and scope mutation handles to setup/cleanup phases |
| 2026-09-02 | Base logging was internal but the high-level runtime exposed neither a safe logger nor correlated logger contexts; prose still described injecting a second borrowed bus | keep one internal bus, expose a non-spoofable runtime-bound logger, inject correlated tool/hook/provider loggers, and retain low-level observability only on the advanced subpath |
| 2026-09-02 | Initial logger injection made preserved tool/hook context fields required and could be misread as a durability acknowledgment | keep fields additive-optional for legacy compatibility, guarantee them on composition-root paths, and reserve accounting/durability claims for terminal records/checkpoints |
| 2026-09-02 | Existing packages reject many duplicate IDs independently, but target composition had no unified namespace, preflight order, atomicity or support-safe conflict record—especially for exporters with ownership | define explicit per-scope identity namespaces, reject before side effects, preserve last valid dynamic snapshots, and add stable conflict/failure codes |
| 2026-09-02 | Readonly IDs did not prevent JavaScript from swapping executable methods after preflight; current skill helper returns the input object | helpers return new frozen wrappers and runtime captures a private immutable identity/configuration/method table without freezing borrowed capability state |
| 2026-09-02 | TypeScript permits async callbacks where provider setup/cleanup returns `void`, while a synchronous disposer cannot be preempted by `closeTimeoutMs` after it starts | keep direct API compatibility, make the named helper use strict `undefined` returns, reject/contain thenables at runtime, and define provider timeout only before disposer start |
| 2026-09-02 | Recursive core peers still left four nominal error checks in `provider-http`, so a duplicated compatible core could silently change failure/retry semantics | require one physical core in official packed closures, remove cross-package `instanceof` gates, validate bounded failure data structurally, and avoid global duplicate detectors |
| 2026-09-02 | The target provider-http protocol carried no serializer/translator and supported only bearer auth; retained provider APIs had no baseline | restore a versioned executable wire protocol and full extension seams, add a custom provider compile journey, and freeze 84 current provider exports |
| 2026-09-02 | HTTP headers were merged by last-spread-wins and wire redaction recognized names rather than auth provenance | introduce disjoint case-insensitive ownership layers, reject collisions/reserved names, provenance-redact every auth header, and forbid cross-origin credential forwarding |
| 2026-09-02 | The offline HTTP-provider gate failed because privacy sentinel `bad` appeared by chance inside a random span ID; focused rerun passed | replace short whole-report substring assertions with structural absence or unique non-ID sentinels and retain initial flake evidence |
| 2026-09-02 | AgentRuntime exposed no provider/model picker API, while provider-http cached failure as empty in one adapter-wide catalog | add high-level typed catalog snapshots, scope cache by plugin instance/route, separate empty/stale/unavailable, preserve last-good data, and single-flight refresh with isolated abort |
| 2026-09-02 | Wire protocols returned `unknown | Promise<unknown>` although the adapter always JSON-stringified them, leaving non-JSON values, hidden async work, mutation timing, and retry body identity undefined | require one synchronous bounded JSON object, validate/deep-detach/encode before dispatch, reuse exact bytes across retries, and keep exact-body logging explicit and high-risk |
| 2026-09-02 | The SSE wrapper ignored its own heartbeat activity callback, had no decoded-event count bound, drained one-chunk fan-out with O(n²) shifts, and did not enforce media type/terminal finish at the custom-protocol boundary | retain the exact parser but add provider-owned media/activity/event/terminal policies and deterministic adversarial fixtures |
| 2026-09-02 | Preferred official-provider declarations were too thin to prove provider-specific options survive plugin-first composition; multi-account examples repeated ID/route, and Codex described an adapter-wide cache key as conversation-isolated | carry adapter controls through inert plugin factories, infer the default route from ID, add an all-provider compile journey, and document cache scope honestly |
| 2026-09-02 | Additive capability stubs erased filesystem/exporter controls and invented an OTel batch exporter incompatible with the proven synchronous bridge; the high-level runtime exposed no processor/span slot | restore complete factory options, typed observation callbacks, explicit per-family ownership, and Browser OTel+IndexedDB compile composition |
