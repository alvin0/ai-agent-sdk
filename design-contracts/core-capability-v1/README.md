# Core + Capability v1 Compile Contract

This directory is a design artifact, not package implementation. It answers one
question before source migration: do the recommended package names and public
TypeScript shapes support the intended minimal Edge, extended Edge, minimal Node,
Node environment-credential convenience, and full Node harness journeys using
the imports that consumers would actually write? A provider-author journey proves
that a third-party Universal provider can compose through the public core,
transport, and protocol contracts without a generic plugin container. Another
core-only author journey subclasses the advanced adapter contract directly for
non-HTTP providers, including stream, model metadata, accounting, middleware and
cleanup. Another
journey composes two accounts from the same provider family through distinct
instance IDs/routes. A core-only author journey implements Universal credential
source/store, skill-provider, optimistic memory-store, observation-exporter, and live
tool-source families.

The declarations deliberately do not import current `agent` or `observability`
packages and the consumer fixtures do not receive an injected runtime factory.
`tsconfig.json` maps the proposed package names to local declaration-only stubs.
`topology.json` separately records each package runtime and the exact direct
selection for every journey. It also inventories every current code import of
all four removed packages—the agent and observability bridges plus the two
facades—so deletion cannot silently strand packages, fixtures, human tests, or
type tests. No JavaScript is emitted and no provider, network, package
installation, or runtime fixture is executed.

Declaration validation is separate from the legacy consumer-only `tsconfig.json`
(`skipLibCheck: true`). The checker also runs three strict configurations:

- `tsconfig.declarations-node.json`: all target declarations and consumers,
  `skipLibCheck: false`, `module`/`moduleResolution: NodeNext`, explicit Node types
  for the mixed Node package surface. The original consumer config still covers
  Bundler resolution; neither local path-mapped check proves packed export maps.
- `tsconfig.declarations-web-base.json`: all ten non-Node packages except MCP
  client/server, plus eight consumer/author fixtures; `skipLibCheck: false`,
  `types: []`. This includes Browser packages and is type evidence, not proof
  of Browser API availability in an Edge host.
- `tsconfig.declarations-web-full.json`: all twelve Universal/Browser packages,
  including MCP. The former two-error upstream `Buffer` closure is isolated by
  SDK-owned portable declarations, so this now passes with no Node ambient types,
  shim, diagnostic baseline or `skipLibCheck` waiver.

All three are compile-only, local checks; none replaces packed runtime acceptance.
P0-12/I8 is resolved through the reviewed portable-public-type boundary. Runtime
code remains on MCP 2.0.0, while emitted SDK declarations no longer name its
root-exported `ReadBuffer.append(chunk: Buffer)` closure. Installed-tarball
compilation plus packed Node/Chromium/Workerd tests provide the acceptance proof;
no installed dependency edit is retained as evidence. See composition design
section 10.4.1 for the decision and acceptance criteria.

`api-migration.json` is a separate exhaustive compatibility ledger. It freezes
417 current public API export occurrences and their generated declaration hashes:
415 root exports plus the two exports available only through
`@ai-agent-sdk/agent/skill-validation`. Journey declarations are intentionally focused and
cannot authorize deletion of an unmentioned symbol; preservation is the default,
and every removal needs an approved decision plus consumer migration.
After I1, `implementation-api-I1.json` separately freezes the complete emitted
core/bridge declaration closure. The original baseline hashes remain unchanged;
the migration checker validates original-to-current links and exact ownership
states before resolving the bridge's exports through canonical core. This accounts
for multi-entry declaration chunking without treating arbitrary hash changes as
compatible. Unit tests reject changed original/current hashes, extra declaration
sidecars and stale source states.
After I2, `implementation-api-I2.json` pins the core and both legacy bridge
declaration closures. The I1 record stays historical and unchanged. While its
phase is current, the checker compares that closure byte-for-byte; after the
explicit `currentImplementationSlice` advances, it treats the record as historical,
validates its structure and routes, then applies the exhaustive baseline/parity
checks to the current canonical declarations. This prevents a historical phase
snapshot from forbidding reviewed additive declarations in later slices. Six current
agent compatibility fixtures now resolve the canonical emitted agent declaration,
not a bridge aliased back to itself. The collision check compares the actual
shared declaration binding imported by both core entrypoints; negative tests
reject copied declarations and same-named imports from different owners.
The same inventory records canonical collisions and subpath routing. The public
root is a curated re-export-only facade with exactly 264 names: all 184 current
core-root exports plus 80 reviewed everyday composition additions. Focused core
subpaths and the public root are views over one internal canonical implementation
owner; they never own copied
classes, interfaces, registries, buses, or singleton state.

`retained-package-api-baseline.json` closes the complementary inventory for A2A,
auth, MCP, filesystem skills, wire protocols and observation exporters. It
freezes 19 current public entrypoints, their declaration hashes and 344 export
occurrences. After restoring wire protocols, observation exporters, MCP routes,
Auth/Codex, and A2A, the target declarations miss zero of those occurrences.
The exact empty gap is hash-locked so later drift cannot silently reopen parity.

`provider-api-baseline.json` keeps its original 84-symbol inventory and hashes as
historical evidence. Current provider declarations must contain exactly that
baseline plus the named, reviewed I3 factory/protocol additions; the checker
rejects both missing legacy symbols and undeclared additions without pretending
that an old whole-file hash can remain equal after additive API work.
Root splits for auth and MCP are tied to P0-07/P0-14, while existing subpaths
remain same-specifier compatibility routes. The ledger separately inventories
all 53 intentionally moved export occurrences, so union parity cannot hide which
old root names leave a client-only or env-only closure.

The topology covers all 18 retained target packages and 32 public specifiers
after the four merge/removal
actions, including their core-peer rule, normal workspace closure, optional
peers, and seven exact external runtime dependency/peer declarations. Packages
not used by a current journey still receive a declaration ownership placeholder.
The existing A2A client/server, MCP client/server, and Node-observability
journal/diagnostic subpaths are retained explicitly rather than treated as
undeclared deep imports.
Schema v5 also freezes the Universal Web Platform, Browser, and Node 22.12 host
feature baselines so a runtime label cannot pass only because imports look clean.
`manifest-blueprints.json` additionally freezes explicit conditional export maps
for all 18 target packages. This includes every provider and support root plus
the five multi-entry packages core, auth-node, A2A, MCP, and observability-node.
MCP `/server` and auth `/codex` are optional-peer views; identity routes are
recorded separately. All 18 forbid wildcard or `require` routes and include an
explicit `package.json` export. Topology schema v5 also
defines the exact source-manifest encoding for normal dependencies, required core
peers, optional workspace peers and metadata, external runtime dependencies, and
required/optional external API peers. The checker rejects a dependency/optional-
peer overlap, an optional peer without an owning route, runtime elevation through
an unclassified optional route, and conflicting exact external selections.
`install-closures.json` separately freezes the resulting workspace, required-
external, and effective-runtime closure for all 25 compile journeys. It also
probes every one of the 17 retained non-core packages when selected directly
beside core, so one large Node journey cannot mask an incorrect package-local
runtime or hidden dependency. Optional peers enter only when directly selected.
Every target package also has a checked `manifestRoles` assignment. Manifests
render the non-executable `aiAgentSdk` object from topology using the package
runtime, `coreApi: 1`, and a bounded plural `roles` list. This is documentation
and release metadata only; runtime code never scans it or auto-loads plugins.
The same topology freezes one recommended named entrypoint, typed composition
slot, audience, and lifecycle/ownership rule for each of the 17 non-core
packages; the checker resolves every symbol through its exact public specifier.
Manifest policy also preserves non-TypeScript install surfaces: common packed
files, auth-node's Codex-login binary and `bin` directory, root `main`/`types`
mirrors, and Node-only engine metadata.
`source-migration.json` freezes the separate I1/I2 ownership transition for all
56 moved files. Its phase-tracked checker supports the future `pending` to
`moved` transition without accepting copied implementations, partial roots,
public-core self-imports, cycles, or anything beyond the exact route-complete
compatibility bridge at the old owner. Observability retains one bridge
entrypoint; agent retains `.` plus `./skill-validation`, both re-export-only.

The remaining entry choices are normalized as fourteen stable IDs in
[`phase0-decisions.json`](./phase0-decisions.json) and reviewed in
[`../../docs/core-capability-phase0-approval.md`](../../docs/core-capability-phase0-approval.md).
The checker rejects missing IDs, approval without owner/time attribution, target
package/specifier/root-export-count drift, diagnostics-budget drift, and
Markdown/JSON ID drift. The
record is now `approved` following the owner's explicit approval and per-agent
model-default amendment. Approval permits staged source migration; a passing
static contract alone is still not runtime or release acceptance.

Run the static gate:

```sh
pnpm check:core-capability-contract
```

The contract currently records these owner-approved choices:

- `AgentRuntime` / `createAgentRuntime`;
- independent per-agent `{ provider, id }` overrides, provider-configured defaults,
  and selected/unique-default inheritance via runtime binding; reusable
  `defineAgent()` overloads keep their existing discriminant;
- `tools`, `toolSources`, `skills`, and a borrowed optimistic `memory` store as
  separate typed slots;
- explicit borrowed/owned exporter registration and rollback-safe closure order
  for independently connected tool sources;
- explicit provider instance IDs/routes for multiple accounts in one family;
- literal or versioned/abortable credential inputs plus revisioned credential
  stores for refresh-safe auth packages;
- a root-first 264-name curated application facade plus six bounded author
  subpaths, with no deep import or package-author dependency on the broad root;
- family-specific marker-stamping author helpers plus marker-free
  `defineAgent`/`defineTool`/`defineSkill` ergonomics, session snapshot/resume and
  manual compaction surfaces;
- the retained direct `ModelAdapter` author surface and activation-scoped
  registrar handles/middleware for non-HTTP provider packages;
- Web-safe approval/user-input policy, Universal local teams, and retained
  runtime/MCP close reports with caller-owned tool-source lifecycle;
- high-level provider/model catalog discovery plus one runtime operation-lease
  registry for agent runs, catalog refresh, manual compaction, and team work;
- one discovery row per route with separate route, plugin-instance, and provider-
  family identity for unambiguous multi-account Web composition;
- declarative provider route claims and a scoped helper registrar, proving normal
  runtime conflicts fail before setup while the legacy plugin stays advanced;
- explicit conversation/fixed memory scopes, per-session override, borrowed
  ownership, and snapshot binding identity for cross-tenant isolation;
- revisioned skill catalogs and bounded JSON-safe references that remain
  provider-validated and exact across session snapshot/resume;
- synchronous atomic tool-source snapshots binding schema and execution to one
  revision, with source/revision-only terminal evidence;
- marker-free local tool ergonomics with detached schema/method capture and no
  caller-object mutation or post-bind execution redirection;
- captured marker-free broker/interceptor/hook/estimator methods with original
  receivers and live operational state;
- typed merge-extensible native Web Search/Image Generation configuration carried
  from Edge agent definition into provider transport and distinct progress events;
- synchronous JSON-object-only wire serialization, bounded pre-dispatch
  validation/detachment, and one encoded request body reused across retries;
- exact-pinned provider-local SSE parsing with media-type, byte/chunk/event bounds,
  comment-heartbeat activity, linear draining and one required terminal finish;
- complete inert official plugin factories whose custom ID is also the default
  route, hiding transitive HTTP/protocol support without losing provider options;
- typed additive slots for lazy skills, caller-closed MCP, owned/borrowed
  exporters, and a caller-owned synchronous OTel span/processor bridge;
- atomic close admission, composed cancellation, late-generation sealing,
  deterministic per-kind close evidence, one caller-abort-safe shared close task,
  and post-close no-op loggers;
- streamed commentary, assistant deltas, host tool calls/results,
  provider-native tool progress, correlated safe errors, terminal usage coverage,
  physical-attempt/model-call/run accounting, atomic delivery-free per-run
  records in exporter batches, observation health, and bounded-diagnostic retained/evicted event and
  byte counts;
- `auth-node` root for environment credentials and `/codex` for Codex-specific
  filesystem auth-store injection;
- the retained `auth-node/env` compatibility route as an identity-preserving
  view of the env-only root, without pulling the optional Codex closure;
- existing provider/MCP/skill factory names where they already fit the target,
  plus uniform side-effect-free exporter factories for composition ergonomics;
- no catch-all `plugins` array and no global Node facade.

The package plan's eight `pnpm add` recipes are checked against exact journey
package sets: five application compositions and three third-party provider
authoring paths. This keeps support packages transitive for normal consumers
while making the extension surface directly approachable.

Passing this check proves compile-time composition only. It does not prove that
the future packages export these declarations, that their packed closures obey
runtime tiers, or that Edge/Node execution works. Those are post-migration exit
gates.

The topology also freezes deterministic evidence rules: privacy checks use
structural absence or non-ID sentinels, random-ID collisions remain recorded even
when a focused rerun diagnoses them, and live provider/network evidence is manual.
Same-source dual compiles cover core message/provider and every agent domain:
tool, skill, memory/history/compaction, accounting/trace, loop/definition, and
team/messaging, both Responses and Anthropic protocol packages, and all six
observability capability entrypoints, plus MCP client/server route mappings. The
parity ledger is zero for core, agent, base observability, protocols,
observability capabilities, and MCP.
Name presence alone remains insufficient: the dual-source fixtures and explicit
legacy/runtime protocol splits protect compatibility-sensitive semantics.

The historical runtime-spike unit file and its superseded prototype source have
been removed after their deterministic coverage moved into maintained contract,
package, benchmark, and human tests. The checker rejects restoration of that
obsolete test, so broad deterministic commands cannot enter the removed harness.
Historical reports remain evidence; live-provider, network and credentialed
paths remain explicitly bounded acceptance routes.

The checker rejects a Universal declaration importing a Node package/builtin,
an Edge journey elevated by a Node capability, undeclared or forbidden facade
imports, drift between `tsconfig` package mappings and topology, and direct
package selections that no longer match their documented recipe.
