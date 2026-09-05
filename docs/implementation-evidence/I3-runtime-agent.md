# I3 progress — Runtime-bound agents, tools, skills and memory

Date: **2026-09-05** (Asia/Ho_Chi_Minh).

Status: **Public immutable `AgentRuntime` with runtime-bound agents, model
catalogs and local teams plus public memory/skill author surfaces; I3 is not
complete.**

## Implemented

- Runtime-bound agents resolve an explicit per-agent model target or a configured
  provider-route default. Reasoning-effort omission remains provider-owned. The
  same run-correlated logger now reaches model, tool and hook contexts.
- Full, route-only, unique default, ambiguous default, missing default and
  malformed target matrices reject independently of registration order and
  before provider setup. A continuity integration mutates caller provider
  options after construction, then proves retry and JSON snapshot/resume retain
  the captured target and that every canonical model-call report records the
  actual provider/model. Team members independently retain different models.
- `run()`/`stream()` use one eager, single-consumer handle with stable run/trace
  identity, independently awaitable result/report, idempotent abort and session
  idleness only after events, result and report settle. Sequential observers are
  bounded and used only by `run()`/`generate()`; rejection or timeout aborts
  active work with `RUN_EVENT_OBSERVER_FAILED` and retains the canonical report.
  Direct `stream()` consumption and manual compaction never invoke that callback.
  Abort tests cover provider, tool, hook and user-input waits, early/dropped
  iteration and oversized event enqueue without an unhandled rejection.
- Run-only `additionalInstructions` are detached and byte-bounded before runtime
  operation admission. Accepted bytes are preserved exactly and composed in the
  fixed agent → skill catalog → team → run overlay → core control order. The one
  captured value is reused across retries, host-tool rounds and automatic
  compaction, and included in local usage estimation without gaining provider,
  model, tool or approval authority. It is absent from history, memory,
  snapshots/resume, diagnostics, terminal reports, later runs and manual
  out-of-run compaction, including model-failure and active-abort paths.
- Local tool definitions expose readonly behavior fields and direct agent/session
  literals are detached at their binding boundary. Schema data and method
  references are captured once, method
  receivers are retained, and caller-owned objects remain mutable and unfrozen.
  Approval/user-input brokers, interceptors, hooks and usage estimators use the
  same method-table capture policy.
- Versioned `ToolSource` values are captured without ownership transfer. Each
  run takes exactly one synchronous generation snapshot, rejects source/tool
  collisions before model dispatch, has no implicit stale fallback and records
  only source ID/revision in terminal evidence. The combined generation is
  bounded by total tool count and public catalog bytes; accidentally async
  snapshots reject before model dispatch without leaving an unobserved rejected
  promise.
- Every executable collection now has its frozen snapshot-scoped identity
  namespace: `tool-source-id`, `tool-name`, `skill-provider-id`, `skill-id` and
  `team-member-name`, alongside the already-complete runtime provider/exporter
  namespaces. Definition/session/tool-source merges and team-injected tools are
  preflighted before model dispatch or member-session construction. Dynamic tool
  and skill collisions reject the candidate generation while leaving the prior
  successful report/catalog unchanged; a later valid generation can recover.
  Collision errors use stable family-specific codes and one immutable
  `CapabilityIdentityConflict` containing only namespace, the literal
  `[redacted]`, and zero-based first/second indices. Tests use endpoint-,
  credential-, content- and filesystem-shaped sentinels and prove none enters
  serialized error evidence; hostile metadata accessors are not invoked.
- The preserved marker-free `SkillProvider` remains available, while the new
  `SkillProviderPlugin` adds independent family/API validation, captured method
  receivers and required signal/logger inputs. A provider lists one bounded
  revision plus metadata-only JSON candidates; core detaches each locator and
  stamps exact references before lazy load/resource calls.
- Activated versioned skills persist provider/source/ID/catalog revision/locator
  and resource-base identity, not their loaded instructions or resource bodies.
  Resume validates the complete reference and configured provider identity
  before provider code, then asks that provider to load the exact old reference.
  Stale, removed, forged and unavailable references fail before model use.
- Provider-native Web Search/Image Generation configs and tool-choice data are
  deeply detached bounded JSON. Invalid accessors, cycles, callbacks, unknown
  fields/names and credential-shaped fields fail before model dispatch. Native
  progress remains outside host scheduling, approval and interceptors. The
  public event preserves the actual provider route and stable call ID, detaches
  optional input/output through a bounded `JsonValue` envelope, and omits those
  payloads from base diagnostics.
- One ordered runtime event surface proves commentary, final-answer deltas, host
  tool calls/results, provider-native progress and exactly one terminal
  usage/report event with stable run/trace IDs and monotonic sequence.
- Runtime-owned local teams use the existing Universal control plane without an
  A2A dependency. All member metadata/session catalogs are staged before atomic
  attachment, so a late tool collision emits no partial roster event. Each
  member retains its selected model; mailbox count/byte bounds, observer
  containment, early idempotent close and runtime close component reporting are
  tested. Direct team run/message calls use `team-operation` leases. Linked
  transports are borrowed, their `send` receiver is captured once, operational
  state remains live, and runtime supplies an additive logger without calling a
  transport cleanup method.
- Runtime model catalogs are now route/plugin-instance scoped and enrich every
  snapshot with immutable route/plugin/family topology. Static, fresh, empty,
  stale and unavailable states, five-minute success TTL, bounded exponential
  failure retry, force refresh, last-good retention, single-flight waiter
  isolation and close-time generation sealing are implemented. Malformed,
  over-count and over-byte adapter results become support-safe `unavailable`
  snapshots before publication; failure recovery and stale expiry use controlled
  clocks. Explicit model invocation remains available when discovery fails.
- Root `createAgentRuntime()` returns a frozen seven-method facade and keeps the
  mutable registry, operations, resources and composition owner in a closure.
  Source, strict declaration and built ESM checks prove the root export alongside
  runtime agent/catalog/team types and `SdkLogger`.
- Root `defineAgent()`/`cloneAgent()` now use only the own-data `model` field as
  their overload discriminant. String/omission preserves the advanced
  `DefinedAgent`; a non-null target object produces an inert frozen reusable
  runtime definition; null, arrays and primitives fail synchronously before a
  capability field is touched. Runtime definitions retain exact model targets,
  do not materialize a reasoning effort, and do not execute ToolSource methods
  during define/clone.
- Policy integration captures approval and user-input requests, interceptor
  before/around/after stages, all four turn hooks, and usage estimation with the
  original receiver. Replacement before or during a run cannot redirect calls;
  runtime close cancels and settles parked approval and human-input operations.
- `MemoryStore` is a versioned borrowed executable family with a side-effect-free
  author helper and a real `@ai-agent-sdk/core/memory` entrypoint. Runtime binding
  captures load/commit once with the original receiver but never freezes or
  closes caller state.
- Agent-default and session `MemoryBinding | false` composition follows session
  override → agent default → none. Conversation scope uses a versioned JSON tuple
  `(namespace, agentId, conversationId)`; fixed scope requires the literal
  `sharedAcrossSessions: true`. Raw namespaces and keys do not enter snapshots,
  logs, errors or observation attributes.
- Every persisted-memory run loads once before model dispatch and commits once
  after successful model completion using `null` create-only or the exact loaded
  revision. A failed load never becomes not-found and never commits. Required
  failures reject through the canonical report; best-effort failures retain a
  successful model result, mark memory degradation and skip unsafe work.
  Cancellation reaches in-flight store calls, including runtime close.
- Runtime snapshots contain only the support-safe `memoryBindingId` in addition
  to the bounded in-run memory snapshot. Missing/mismatched resume bindings fail
  before store I/O. The explicit v1 envelope is JSON-round-trip tested and
  validates agent identity, bounded history lifecycle, memory shape and complete
  activated-skill ownership before store/provider I/O, then reinjects current
  runtime registry, policy and capability dependencies. Tests cover cross-tenant
  isolation, explicit fixed sharing, disable, resume and delimiter collisions.
- The common author path is now exercised through installed package specifiers,
  not only source-relative tests. Root/core-agent definitions preserve tool
  parse/execute/render/meta/timeout/context controls, rich inline skill resource
  and invocation metadata, provider-native tools, compaction configuration,
  snapshot/resume/manual compaction and bounded session/run options. The packed
  NodeNext consumer compiles these together without workspace path aliases.
- Low-level registry/plugin assembly at the core root is explicitly retained
  compatibility debt, not the recommended application surface. The frozen
  `api-migration.json` baseline keeps all 184 prior root names, records
  `@ai-agent-sdk/core` with `remove: []`, defaults every unlisted symbol to
  preserve, and requires a stable decision ID, replacement/rationale, consumer
  migration and owner approval for any future removal. The source barrel repeats
  that guard at the export boundary. Runtime and packed tests prove root
  `ModelRegistry` is the same value/type as `core/provider`; root-only legacy
  names such as `ModelRegistryOptions` and `REGISTRY_ERROR_CODES` remain intact.
  Moving or removing them therefore remains unavailable until a separately
  approved breaking-version decision adds a real consumer migration fixture.
- Provider setup and returned cleanup plus exporter `ready`/`stage`/`export`/
  `shutdown` are captured exactly once before activation/ownership transfer.
  Replacement or deletion after capture cannot redirect startup, delivery,
  rollback, or close; provider registrar handles remain activation-scoped and
  every borrowed caller object remains unfrozen.
- Deterministic mutation matrices now cover provider, credential source/store,
  direct/helper tool source plus nested tool generation, direct/helper skill
  provider, direct/helper memory store, and exporter. They prove original method
  references with live receiver state, replacement/deletion resistance, dynamic
  snapshot recovery, borrowed ownership, and support-safe getter-trap
  containment. Credential and tool-source definition failures now discard raw
  property-access exceptions rather than retaining them through `cause`. This is
  a TOCTOU boundary, not a claim that arbitrary Proxy traps or called package
  code are sandboxed. Credential consumption preflight in the future HTTP
  provider remains open, so the broader all-capability private-handle task is not
  closed by these tests.

The previously oversized `agent/define/session.ts` was split into the named
`session/runtime-binding.ts`, `session/runtime-memory.ts` and
`session/trace-accounting.ts` responsibilities. It is now exactly **700 lines**; every
new memory implementation file is at most **105 lines**.

## Verification

- `pnpm exec vitest run tests/unit/composition/runtime-memory.spec.ts`:
  **14 tests passed**.
- `pnpm exec vitest run tests/unit/composition/runtime-skill-provider.spec.ts`:
  **8 tests passed**. Legacy and Node-filesystem skill regressions add 30 passing
  cases.
- The wider session/tool regression across nine suites passed:
  **96 tests passed**.
- `pnpm exec vitest run tests/unit/composition`: **435 tests / 36 suites
  passed**.
- Composition plus tool registry/loop, model registry and both wire-protocol
  serialize/translate suites: **487 tests / 35 suites passed**.
- `pnpm exec tsc --noEmit -p tsconfig.json` passes under strict optional,
  unused-symbol and unchecked-index rules.
- `pnpm --filter @ai-agent-sdk/core build` emits `dist/memory.js` and
  `dist/memory.d.ts` plus the full `dist/skills` route. Direct package-specifier
  ESM checks prove root and focused routes share identical helper values and
  retain `validateCandidate`/`validateSkillResourcePath` for Node capabilities.
- `tests/unit/core-author-ergonomics.spec.ts`: **2 tests passed** through the
  public root and `core/agent` routes. The installed compile fixture also imports
  `CapabilityIdentityConflict` from both routes. The full unit regression is
  **1,080 tests / 94 suites passed**.
- `pnpm --filter @ai-agent-sdk/core test:pack` passes with
  `packages/core/artifacts/core-packed-X6bCAc/ai-agent-sdk-core-0.1.0.tgz`.
  Its isolated NodeNext consumer compiles the complete author surface, and the
  same packed artifact passes the existing Node, Chromium and workerd runtime
  matrix. Nothing was published.
- No package was published.

## Retained failed attempts and corrections

1. The first logger regression showed the runtime rebuilt both model and tool
   contexts without their logger. Both context projections now preserve the
   same run-bound value; model/tool/hook identity is asserted.
2. The first detached-tool tests imported the stale built deprecated agent bridge
   bridge and failed three cases. Core and bridge were rebuilt sequentially;
   source and installed identities now exercise the same captured helper.
3. An explicitly unsupported native tool produced an error terminal report while
   high-level `result` still resolved. Runtime result projection now rejects
   whenever the canonical report status is non-success.
4. The initial late-abort oracle expected no abort calls, overlooking the one
   legitimate model-stream cleanup abort. The test now snapshots the terminal
   count and proves a later public abort adds none.
5. Initial memory typecheck failed because callback parameters nested under
   `Object.freeze` did not receive contextual typing. Explicit boundary types
   fixed the implementation without weakening compiler settings.
6. The first memory matrix found duplicate required-load errors: the same fatal
   error was attached to its operation and again as the run terminal cause.
   Fatal memory operations now retain their status while terminal finalization
   owns the single safe error; best-effort failures still attach operation error
   evidence because the run continues.
7. The first commit-failure oracle expected one provider attempt from a minimal
   adapter. Inspection proved that adapter reports complete logical-call usage
   but does not opt into physical provider-attempt accounting. The retained
   assertion now requires one complete logical call, zero declared attempts and
   all five reported tokens; no fake attempt was invented.
8. The first versioned-skill matrix required `list()` and `load()` to receive
   the same `AbortSignal` object. Tool execution correctly adds a child deadline/
   teardown signal; the contract requires propagation, not reference identity.
   Tests now assert a signal on every call and independently abort before list,
   during load and through runtime close.
9. A clean core build changed `/skills` from its narrow migration bridge to the
   complete target surface and exposed seven Node filesystem failures because
   two canonical validation exports were omitted. The full barrel now re-exports
   both functions; all seven original failures and the wider skill suite pass.
10. Changing `ToolDefinition` behaviors from method syntax to readonly function
    fields initially made heterogeneous tool catalogs fail strict variance
    checks. The public fields remain readonly while a named bivariant callback
    type preserves the established heterogeneous registry contract; strict
    typecheck and all registry/runtime tests pass without widening tool results.
11. Native-event audit found a hard-coded `provider-native` label and unchecked
    casts of provider input/content to `JsonValue`. Projection now uses the bound
    provider route and a shared strict bounded JSON clone. Oversized/invalid
    optional payloads are omitted while identity/status remain visible, and
    unique payload sentinels are absent from diagnostics.
12. The expanded overlay matrix initially failed three tests before adapter
    dispatch because its fixture advertised only `low` while the preserved agent
    default requested `medium`. The fixture now advertises that exact supported
    effort; no runtime validation was weakened. Ten focused overlay tests prove
    byte boundaries, frozen composition order, retry/tool/compaction reuse,
    accounting, failure/abort privacy and next-run isolation.
13. The first terminal-event failure injection exposed that a provider
    `finish:error` could close the legacy event source normally, causing runtime
    projection to emit terminal `usage` even though its canonical report was an
    error. Projection now selects terminal usage/error from report status. The
    error event, rejected `AgentRunError` and independent report all reference
    the same report object; enqueue-failure and abort paths use the same rule.
14. The first runtime-team link matrix exposed a mistaken capacity equal to the
    initial local-member count, which made every later remote link impossible.
    Runtime teams now retain the fixed eight-address bound while independently
    limiting their prevalidated local input. A follow-up atomicity audit replaced
    direct attachment with a staging port so a later member catalog collision
    cannot leave an earlier member attached.
15. Initial catalog all-abort/close tests cancelled before the scheduled provider
    microtask began, correctly producing no provider signal and a settled close
    row. The fixtures now wait for confirmed provider entry before cancellation,
    proving one-waiter isolation, all-waiter shared abort and sealing of a truly
    uncooperative in-flight refresh.
16. The first author-surface regression incorrectly required root
    `defineAgent()` to have the same function identity as the advanced helper.
    The root is intentionally an overload dispatcher for runtime model-target
    objects plus legacy string/omission inputs. The test now requires canonical
    identity only for the direct tool/skill helpers and proves both agent grammar
    and behavior through the compiled consumer.
17. The first broad unit run also exposed an actual temporary Node-facade star
    export collision between core and agent `defineAgent`. The facade now
    explicitly re-exports `defineAgent`/`cloneAgent` from the compatibility agent
    package, preserving leaf identity until mandatory I7 facade deletion.
18. The first namespace full-unit run found one legacy skill test parsing the
    text `duplicate skill`. It now routes on `SKILL_ID_CONFLICT` and the frozen
    redacted conflict record, so support-safe messages need not expose skill or
    provider identity.
19. The first packed namespace compile used stale `dist` and correctly rejected
    missing `CapabilityIdentityConflict` exports from root and `core/agent`.
    A clean core build emitted both frozen routes; the same isolated consumer and
    Node/Chromium/workerd matrix then passed. No test or frozen contract was
    weakened.
20. The first credential-store replacement fixture returned `undefined`, which
    did not match the original method's inferred record type under strict
    assignment. The replacement now returns a valid but distinguishable record;
    the test still proves it is never called rather than weakening the type.
21. A first Vitest matcher required an own `cause: undefined` property even
    though a safely constructed `Error` correctly has no such property. The
    focused getter-trap matrix now checks `error.cause` directly and proves it is
    absent together with the private sentinel.
22. P0-02's final owner-approved amendment preserves the advanced legacy
    `defineAgent()` string/omission overload, so its Codex/Luna compatibility
    values are deliberately not treated as composition defaults. The separate
    high-level `runAgent()` path now requires an explicit `CallConfig`, no longer
    exports `DEFAULT_AGENT_CALL_CONFIG`, and never materializes medium reasoning.
    The runtime-definition path continues to resolve omission only through a
    configured provider default. Focused mode/definition/overload tests pass
    23/23 and the strict workspace typecheck passes.
23. The runtime-team A2A closure now uses a structural `A2ALinkableTeam`, keeps
    synchronous `unlink()` compatibility, and adds idempotent support-safe
    `unlinkWithReport()`. Runtime-team tests prove that remote members cannot be
    reached through local `session()`/`run()`, linked sends run through the
    bounded team operation with a runtime logger, and team close removes routing
    without closing the borrowed transport. The A2A executor also has the
    additive reported disposal surface; the combined MCP/A2A cleanup checklist
    remains open until Node MCP close evidence is implemented. The focused
    runtime/A2A matrix passes 21/21, the real built declarations compile the
    `node-a2a-runtime-team.ts` journey under NodeNext, and the packed A2A
    Node/negative-Worker matrix passes.

## Still required

The composition owner remains internal behind the public facade. Runtime
definition overloads, remaining provider/capability migrations and later
installed/human acceptance phases remain open. The memory and skill entrypoints
prove their capability author contracts, not completion of I3. Unified runtime
timer ownership also remains open: low-level model/tool/team paths still own
local timers outside `RuntimeResources`, so the platform checkbox is deliberately
not closed yet.
