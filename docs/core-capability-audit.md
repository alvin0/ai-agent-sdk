# Core + Capability Architecture Audit

Status: **Phase 0 approved — staged migration authorized; implementation evidence still pending**

Last audited: **2026-09-04**

Related documents:

- [`core-capability-package-plan.md`](./core-capability-package-plan.md)
- [`core-capability-composition-design.md`](./core-capability-composition-design.md)
- [`core-capability-implementation-todo.md`](./core-capability-implementation-todo.md)

## 1. Verdict

The package plan plus composition design, compile contracts and dependency-ordered
TODO are detailed enough to begin the ownership migration after Phase 0 approval.
This is implementation-entry readiness, not proof that the target SDK is already
implemented or Edge-accepted. The minimum useful installation should be:

```text
@ai-agent-sdk/core + one provider package
```

`core` must include the agent runtime, model contracts, tools, canonical usage
ledger, and bounded metadata-only diagnostics. Everything that performs an
environment-specific action remains a capability package. Selecting a capability
induces the runtime requirement; users should not have to select a vague global
`node` edition first.

The remaining work is concrete. Historical runtime reports exposed transport,
capability-marker, and optional-auth-closure corrections that are now represented
in the frozen composition contract and acceptance design. Automated continuation
uses only static manifest/import audits, dependency-graph audits, compile-only
TypeScript contracts, and deterministic unit tests; provider/network/credentialed
acceptance remains a manual post-migration gate. Owner approval, a reusable
external conformance kit, portable redirect handling, Edge provider/upstream
compatibility, target tarball evidence, and topology migration remain open.
In particular, strict full-Web declarations still fail on the two MCP upstream
Buffer references (4.139–4.140), and scripted Edge research does not prove agent
autonomy or report quality (4.141). Neither is closed by the static contract pass.

Current entry state is unambiguous: all fourteen P0 decisions are approved,
including per-agent overrides and configured provider defaults;
both source-ownership roots and documentation migration are `pending`; both
human journeys remain `migration-pending`. The next source action is I1, not an
unbounded rewrite, under the recorded owner approval of I0. No additional broad
architecture document is needed; remaining decisions and exit evidence belong
in the existing Phase 0 record and implementation ledger.

## 2. Current dependency baseline

The workspace currently has 20 package manifests (publishing is out of scope):

- 5 product layers/facades: `core`, `agent`, `observability`, `node`, and
  `ai-agent-sdk`;
- 3 provider packages plus one shared HTTP transport;
- 2 provider wire-protocol packages;
- 4 observability delivery packages;
- 2 MCP packages;
- 1 Node credential package, 1 filesystem skill package, and 1 A2A package.

There are exactly **7 unique non-workspace runtime/peer package names** across
the 20 manifests. They are grouped by owner below (the three MCP names are one
integration family, and the two OpenTelemetry names are one peer family):

| Owner | Dependency | Runtime effect |
| --- | --- | --- |
| `provider-http` | `eventsource-parser` | Universal SSE parsing |
| `mcp` | MCP client/server packages | Universal remote MCP contracts/transports |
| `mcp-node` | MCP Node/client/server packages | Node stdio/process hosting |
| `a2a` | A2A SDK | Node-elevated A2A client/server bridge; not a Universal capability |
| `observability-otel` | OpenTelemetry API peers | Optional telemetry integration |

The exact names are `eventsource-parser`, `@a2a-js/sdk`,
`@modelcontextprotocol/client`, `@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, `@opentelemetry/api`, and
`@opentelemetry/api-logs`. Workspace packages are not counted as third-party
dependencies. Optional/transitive installed packages are a separate lockfile
closure and remain covered by the supply-chain check.

`eventsource-parser` is not structurally mandatory. ADR 0001 already evaluated a
local replacement: correctness, resource, differential, and fuzz gates passed,
but all three mandatory throughput gates failed by 71.68%–83.13%. Therefore 0.x
retains exact `4.1.0`, owned only by `provider-http`. Package splitting does not
itself reduce this risk: the dependency remains reachable through every HTTP
provider, but not through core alone. Replacement requires a new candidate that
passes the full ADR gate; it is not blocked by architecture or required for this
monopackage migration.

The current `@ai-agent-sdk/node` facade depends on 17 workspace packages. That is
the strongest evidence for removing the global facade: installing one name hides
nearly the entire optional capability graph and weakens supply-chain review.

## 3. Requirement coverage matrix

This matrix separates specification from implementation evidence. **Frozen** means
machine-checked contracts; owner approval is recorded separately. **Historical** means a
prior current-package/prototype run, not the migrated artifact. No row below
certifies completion of the target migration. I0–I8 refer to the existing TODO.

| Requirement | Design/contract evidence now | Evidence still required for target completion |
| --- | --- | --- |
| Basic agent needs only core + provider | Frozen 18-package/32-specifier map, 25 journey closures and 13 install recipes | I4/I6/I8: install the actual selected packages without workspace aliases and run an agent |
| Core is Web Standards/Edge safe | Strict Web/Browser base declarations pass without Node types; historical Worker prototype evidence | I3/I8: migrated core tarball host tests; MCP full-Web type debt remains open for extended Edge |
| Full Node harness is additive | Frozen explicit-capability selections and typed NodeNext consumers | I6/I8: replace old facade imports and verify the installed full harness |
| Providers attach as plugins | 17 recommended non-core entrypoints and typed composition proofs; retained provider API parity | I3–I5/I8: real plugin factories, installation rollback and compatible external-package conformance |
| Independent agent models and configured defaults | Full agent target overrides a provider default; omission uses selected/unique configured default; reusable advanced overloads preserved | I3/I4: deterministic resolution, ambiguity/invalid-target rejection and no core-owned defaults or failure-time model switching |
| Agent and base logging live in core | Frozen 56-file ownership map and route-complete bridge plan; both roots pending | I1/I2/I7: move canonical implementations, preserve API identity and remove temporary layers |
| Missing/incorrect token usage is visible | Frozen ledger, attempt identity and coverage contracts; historical provider control | I3/I8: migrated runtime tests for retries, missing/malformed usage, overflow and compaction; selected live acceptance |
| Base diagnostics cannot grow forever | P0-09 proposes both 256 events and 1 MiB; bounded diagnostic types | I3/I8: implemented byte/event eviction, close evidence and remeasured packed budgets |
| Tool/provider/agent lifecycle is correlated | Six integration families, 27 operation rows, five teardown-report routes and typed loss counters | I3/I5/I8: balanced actual operations, exact delivery acknowledgments and independent teardown evidence, not only zero counters |
| Capability runtime follows selection | Frozen package/runtime/peer metadata, install closures and independent non-core probes | I5/I8: installed emitted/runtime AND declaration closures match those selections; A2A remains Node |
| Capability names are understandable | Owner-approved core + provider + named capability model; no replacement Node facade | I6: migrated guides and examples use the approved entrypoints |
| Third-party capabilities can conform | Frozen family markers/contracts plus historical external-plugin experiments | I3–I5/I8: reusable testkit and real migrated runtime conformance; historical prototypes are insufficient |
| Failed construction rolls back fully | Async construction and support-safe failure/rollback reports specified | I3/I5: deterministic tests against actual runtime/exporter/provider/MCP construction paths |
| Close is bounded and idempotent | Ownership, admission leases, report identity and teardown ordering specified | I3/I5/I8: actual cancellation/timeout/concurrent-close tests and packed resource settlement |
| Edge website supports agentic deep search | Typed website boundary and human-test design; historical 16/16 scripted SDK/UI invariants | I6/I8: same-session mode, complete stream/progress behavior, real-agent read/audit evidence and independently reviewed report; manual live gate |
| Node CLI supports a full coding harness | Historical 7/7 hermetic behavior; target additive selection frozen | I6/I8: migrated skills/MCP/persistence/usage/trace/close evidence from installed packages |
| Dependency exposure is inspectable | Current 20 manifests and seven external names recounted; target 18-package graph and exact dependency roles frozen | I4/I5/I8: recount installed transitive closure, integrity and physical core identity after migration |
| Bundle impact is bounded | Budgets specified; historical prototype size/heap measurements recorded | I8: measure migrated packed artifacts under the specified workloads; old measurements are not new-package results |

Authoritative inventories: [`topology.json`](../design-contracts/core-capability-v1/topology.json),
[`install-closures.json`](../design-contracts/core-capability-v1/install-closures.json),
[`source-migration.json`](../design-contracts/core-capability-v1/source-migration.json),
[`phase0-decisions.json`](../design-contracts/core-capability-v1/phase0-decisions.json),
and [`human package topology`](../test-human/package-topology.json).

## 4. New findings from the second audit

### 4.1 Runtime construction must be awaitable

`ModelRegistry.install()` is intentionally synchronous and transactional, but an
owned observation exporter has asynchronous shutdown. If provider number two
fails after provider number one installs, a synchronous runtime factory cannot
truthfully guarantee that all owned resources were rolled back before it throws.

Decision: `createAgentRuntime()` returns `Promise<AgentRuntime>`. Provider setup
remains synchronous and side-effect free; the async boundary exists for complete
rollback only.

### 4.2 Provider neutrality requires two removals

Removing defaults from `defineAgent()` is insufficient. The current high-level
`DEFAULT_AGENT_CALL_CONFIG` also supplies Codex, `gpt-5.6-luna`, and medium effort.
Both paths must require explicit model binding. Reasoning effort may remain a
caller override, but `medium` cannot remain a core default. The live/hermetic
spike confirmed that omission should flow to the adapter so exact model metadata
can provide a supported default.

### 4.3 Base logging needs two bounded stores

The event delivery queue is bounded today, but the convenient
`MemoryObservationExporter` retains exported events and batches without a bound.
It therefore cannot become core's default diagnostic sink. Core needs a separate
fixed-capacity diagnostic ring that evicts oldest metadata events and reports its
eviction count. It is for support snapshots, not durability.

The canonical run ledger must also retain its current hard limits. A bounded
export queue alone does not bound per-run accounting state.

### 4.4 Capability compatibility cannot rely on npm alone

Typed contracts prevent a generic service locator, but an independently released
capability can still load against an incompatible core contract. The first draft
limited runtime markers to providers/active setup. The packed skill spike showed
that this is too narrow: `SkillProvider` executes package methods but has no
`setup()`, and its manifest metadata is unavailable to bundled Edge runtime code.
Each executable capability family therefore needs:

- a core capability API version or supported version range;
- composition-time rejection with a stable error code;
- an external conformance suite that can run from a packed consumer project;
- explicit ownership and async readiness declarations;
- negative tests proving Node-only packages do not enter Universal bundles.

Markers are independently versioned per family (`provider`, `skill-provider`,
`observation-exporter`, and future executable adapter protocols). Inline skills
and core-owned leaf tool definitions stay marker-free; executable tool references
still require structural validation and capture.

### 4.5 A universal package may still be operationally unsafe

Avoiding `node:*` imports is necessary, not sufficient. Edge gates also need to
catch unbounded buffering, browser-incompatible conditional exports, oversized
bundles, hidden environment reads, timers that keep isolates alive, and dependency
side effects. Runtime classification and operational budgets must be separate
columns in the package manifest policy.

### 4.6 Workerd success no longer proves Web Standards purity

With Wrangler 4.127.1 and compatibility date 2026-09-01, the benchmark observed
`Buffer` and `process` in workerd without an explicit Node compatibility flag.
Therefore a Worker fixture that merely runs cannot detect accidental reliance on
those globals. Strict fixtures must deliberately unset both globals before
loading/exercising the SDK, while bundle inspection independently rejects
`node:*` and unresolved external imports.

### 4.7 The human coverage checker protected the architecture being removed

The previous checker required every Node Codex import to use
`@ai-agent-sdk/node`. This would make the intended migration fail its own test.
The facade exception has been removed. A new topology manifest derives actual
scoped imports and records current versus target selections, currently reporting
two honest pending migrations.

### 4.8 Fetch API presence does not imply fetch semantic portability

The Universal Codex/provider HTTP closure bundles and evaluates in strict
workerd with no external import or Node builtin. Its first live request still
failed before dispatch because workerd rejects `RequestInit.redirect = 'error'`;
the current provider HTTP pipeline hard-codes that value. A fixture-only shim
using `redirect: 'manual'` plus explicit rejection of every 3xx preserved the
no-follow security policy and exposed the next layer.

Decision: Universal HTTP transport must have a cross-runtime no-redirect
contract, not merely a `fetch` type. The implementation should inject or wrap
fetch and use a tested portable policy. Redirects must never silently follow and
forward authorization to another origin.

### 4.9 Provider catalog discovery and invocation are separate capabilities

The Codex model-catalog endpoint returned an empty catalog under local workerd,
while the Node control using the same credential returned nine models. An
explicit Edge fixture catalog was required to preserve exact reasoning/native
tool capability validation. Known-model invocation must be configurable without
pretending dynamic discovery succeeded; an empty or unavailable picker is not
evidence that an explicit model target is invalid.

Provider packages therefore need distinct conformance cases for static model
metadata, dynamic discovery, empty discovery, and stale/unsupported capability
metadata. Core must continue rejecting a requested reasoning effort or native
tool when the selected model metadata does not advertise it.

### 4.10 Missing-usage policy must not replace the primary failure

With `usagePolicy.onMissing = 'fail'`, the failed Edge transport was initially
reported only as `USAGE_REQUIRED`, because a request that failed before usage
could not satisfy the policy. Switching the audit fixture to warning mode exposed
the primary `TRANSPORT` failure and then HTTP 403 after the redirect shim. The
latest support-safe classifier identifies a 6,633-byte Cloudflare HTML response;
the provider maps it to `AUTH`, but the evidence does not establish an API auth
failure.

Decision: missing usage remains a first-class coverage defect, but on an already
failed model/provider attempt it must not replace the primary terminal error.
Support-safe reports retain both facts: primary failure/status/request id and
usage coverage/possibly-billed state.

### 4.11 Native provider tools are a separate public event family

The live deep-research run produced seven `assistant-native-tool` web-search
events, not host `tool-call` events. UI projection, telemetry, and acceptance
must count both families without coercing provider-native work into the host-tool
execution contract. The event ledger is authoritative: model prose claimed five
distinct searches while the actual event stream recorded seven calls.

### 4.12 Streaming delivery is not durable execution

The live research run took 137.9 seconds, issued two provider attempts, consumed
76,856 total tokens, and produced a 22,071-character report. A portable core may
stream such a run, but cannot promise that one Edge request, isolate, socket, or
in-memory session survives until completion. Resume/event persistence, queues,
actors, and workflows remain explicit host capabilities rather than a hidden
core workflow engine.

### 4.13 Emitted-import inspection must parse minified JavaScript

The first import gate used a formatting-sensitive regular expression and missed
valid minified ESM such as `import{a}from"package"`. That allowed an incomplete
consumer bundle to be reported as having zero external imports and then hang in
Wrangler resolution. The audit now parses emitted JavaScript with the bundler's
AST parser, self-tests static/dynamic/require cases, and gives every readiness
probe a per-request timeout. The corrected detector was rerun against both strict
Worker benchmark bundles and the retained live Edge bundle; all three contain
zero unresolved imports. Future gates must reuse this parser rather than copy a
regular expression.

### 4.14 Optional auth subpaths currently hide a provider closure

`@ai-agent-sdk/auth-node/env` is a small Node credential resolver, but the package
currently has a normal dependency on `@ai-agent-sdk/provider-codex`. Therefore an
OpenAI or Anthropic application selecting only the env subpath still installs an
unrelated provider. This contradicts capability-selected dependency closure.

Decision: retain the understandable feature/runtime package name for now, peer
on core, and make `provider-codex` an optional peer used by `/codex`. The Codex
harness already lists both packages explicitly. Packed env-only and Codex recipes
must prove the two closures after migration. The package root is env-only in the
target; Codex stays on the explicit `/codex` subpath. Otherwise a normal root
import would still resolve the optional provider eagerly and make the smallest
documented auth install fail at startup.

An audit-only staged tarball now proves the package-manager behavior before any
product migration. The current env-only journey contains six runtime packages,
including `provider-codex`, `provider-http`, `protocol-responses`, and
`eventsource-parser`, occupying 998,762 installed bytes in the fixture. The
staged target root and `/env` both run with only core plus auth-node, zero external
runtime packages, and 517,466 installed bytes. Importing `/codex` without its
optional peer fails with `ERR_MODULE_NOT_FOUND` naming
`@ai-agent-sdk/provider-codex`; installing the explicit Codex closure constructs
the adapter without network or credential writes. This is entry evidence only:
the source manifest and root export have not been migrated.

### 4.15 Support packages can reintroduce a second core identity

The proposed provider packages peer on core, but today `provider-http` and both
wire-protocol packages have normal core dependencies and import core runtime
values. Merely changing the outer provider manifest would therefore leave a
nested path capable of resolving a second core copy.

Decision: providers keep support packages as normal implementation dependencies,
while every support package that imports core runtime values uses the same
bounded core peer plus an exact workspace dev dependency. A protocol may omit
the peer only if packed emitted-code inspection proves every core import is
type-only. The package graph gate checks this recursively rather than inspecting
only first-class capability manifests.

### 4.16 Migration gates must not require artifacts they are meant to create

The earlier audit wording said no source could move until every D gate passed,
while D4, D5, and D7 included relocated tarballs, post-merge bundle measurements,
and migrated human import graphs. Those artifacts cannot exist before their
corresponding migration phase, creating a circular gate.

Decision: every D gate has **entry evidence** that authorizes its scoped phase
and **exit evidence** required before that phase is accepted. Baseline bundles,
budgets, test plans, and negative fixtures are entry evidence. Relocated packed
exports, post-merge budgets, and target consumer graphs are exit evidence. A
phase cannot claim completion because its entry gate passed, and a future exit
artifact cannot block creation of the source state needed to measure it.

### 4.17 Portable fetch semantics are capability-wide, not provider-only

The provider spike first exposed Workerd rejecting `redirect: 'error'`. The
current `observability-fetch` implementation uses the same mode. Its packed
runtime matrix passed because an injected mock fetch returned fixture responses
without delegating to native fetch, so it proved serialization/retry behavior but
not host compatibility.

The new native-fetch negative reproduces the rejection in strict workerd. A
packed external exporter using `redirect: 'manual'` plus explicit redirect/origin
rejection passes the same runtime while preserving privacy, usage, idempotency,
ack identity, abort, and shutdown. The transport rule therefore applies to every
Universal HTTP capability: provider, exporter, remote skill, MCP HTTP, and future
adapters. Mock-fetch tests remain useful but cannot close the runtime-semantic
gate alone.

### 4.18 MCP needs a live tool-source slot, not a copied `ToolCatalog`

The current MCP connection deliberately exposes one stable, live `ToolCatalog`:
refresh and reconnect replace its registrations while preserving the catalog
object. `AgentSession` currently defeats that guarantee by enumerating an
additional catalog once during construction and copying the definitions into a
new registry. A packed public-API fixture created a session with an empty catalog,
registered `late_tool` afterward, then ran the agent. The source reported the
tool, but the first model request advertised no tools and execution count stayed
zero. Connecting or reconnecting MCP after session construction is therefore
silently invisible to that session.

Decision: core v1 separates marker-free local `tools` from executable borrowed
`toolSources`. Official MCP connections implement versioned `ToolSource` directly. Core
retains the source and creates one immutable, collision-checked catalog snapshot
at each invocation boundary. Reconnect/refresh appears on the next invocation,
while one active invocation cannot observe a half-changed schema/implementation.
Caller ownership of `connect()`/`close()` remains explicit.

An audit-only composer validated the shape with two independently spawned packed
stdio MCP servers. Both namespaced tools dispatched correctly (22 and 42), the
catalog reflected each close without copying, a duplicate name failed closed,
and API-v2 was rejected before any source method ran.

### 4.19 Current MCP redirect validation occurs after the security boundary

`createGuardedMcpFetch()` validates the initial URL, delegates to native fetch,
then validates `response.url`. With default redirect following, the second origin
has already been contacted by the time that last check runs. The packed Workerd
fixture sent a 307 from an allowed local origin to a different unallowed origin.
The target received the POST and a synthetic `x-capability-token` header; only
then did MCP reject the final origin. No real credential was used. With
`allowRedirects: false`, the same host rejects the emitted `redirect: 'error'`.

Decision: the default no-follow path uses `redirect: 'manual'` and rejects an
observable redirect. Any future opt-in follow policy must manually bound and
validate every hop before contact and remove sensitive headers on origin change.
Final-URL validation remains defense in depth, not the primary boundary. The
standalone forced bundle also exposed an upstream `pkce-challenge` exports
resolution issue while the existing packed Wrangler path runs; supported bundler
closure needs its own matrix and must not be conflated with runtime behavior.

### 4.20 Node host runtime and Node capability selection are different claims

The first exact-package matrix mislabeled an environment-credential recipe as
“minimal Node”. That recipe installed `auth-node`, so it correctly elevated the
selected closure to Node but failed to prove the product promise that a normal
Node HTTP service needs only core plus one Universal provider.

Decision: the contract now has two separate journeys. `node-minimal` selects only
`core + provider-openai`; it demonstrates that running on Node does not require a
Node edition. `node-env` adds `auth-node` explicitly and is therefore classified
Node. The topology checker derives the effective runtime from selected packages
and rejects either journey if those selections drift.

### 4.21 Package ergonomics include observable execution, not only construction

The initial exact-package Edge fixture compiled runtime construction and a final
`generate()` result, but it did not prove the public event grammar required by a
ChatGPT-like interface. A consumer could therefore pass the package/API gate and
still lack typed commentary, host tool progress, provider-native tool progress,
or authoritative terminal usage.

Decision: the recommended core contract now includes one `AsyncIterable` run
handle with typed commentary/assistant deltas, host `tool-call`/`tool-result`,
`assistant-native-tool`, and usage events. The extended Edge journey compiles an
injected web-search tool, a live MCP tool source, strict missing-usage policy, and
event projection. Usage coverage is required even when individual token counts
are unavailable. Every event also carries run/trace/sequence correlation; typed
errors expose only the support-safe envelope and usage coverage. Both extended
Edge and full Node journeys compile retrieval of observation health and bounded
diagnostic eviction counts after the run.

The same static gate inventories both compatibility facades. Current imports are
confined to known facade wrappers, packed compatibility fixtures, tests, and the
Node human journey; no independent application package exists in this repository.
This is enough to define the internal migration list, but it cannot prove that an
unpublished checkout is not consumed outside the repository. That final knowledge
remains an owner decision.

### 4.22 Provider extensibility needs an author journey, not only provider consumers

The first direct-import matrix proved official provider selection but never
compiled a third-party provider implementation. It therefore could not verify
that core owns a sufficient registrar/adapter contract, that the support packages
stay Universal, or that an author can compose transport and protocol packages
without importing a facade or catch-all registry.

Decision: a sixth compile-only journey now builds a provider from
`core + provider-http + protocol-responses`, stamps the provider-family marker,
and registers an adapter through the typed core registrar. It exposed one small
TypeScript ergonomics issue: `Object.freeze({...})` loses contextual typing unless
the literal uses `satisfies ModelProviderPlugin`. The accepted author example now
uses that pattern. This proves only the public type grammar; recursive peers,
packed dependency closure, conformance behavior, and the provider-owned SSE
dependency remain exit evidence.

### 4.23 Every executable capability family needs an author-side type proof

Official skill, exporter, and MCP consumers showed that the SDK could return
typed values, but they did not prove that an external package could implement
those core contracts without importing current split packages or receiving a
generic registrar. That omission could recreate an ecosystem where only official
packages have access to practical internal types.

Decision: a seventh compile-only journey implements a Universal skill provider,
observation exporter, and live tool source using `core` alone. Each value carries
only its family marker, uses its dedicated method surface and composition slot,
and needs no catch-all `Plugin` type. Provider authors remain a separate journey
because HTTP/protocol support packages are optional extension-kit dependencies.

The first version of that author journey exposed another false simplification:
`SkillProvider.list()` returned full instruction bodies. The corrected contract
preserves metadata-only candidates, provider-owned opaque locators, lazy `load()`,
advertised `readResource()`, and abort/cwd lookup inputs. Runtime candidate
ownership, traversal rejection, and packed peer metadata remain post-migration
conformance evidence.

The exporter shape had the same problem: a `Promise<void>` result erased the
acknowledgment identity needed for retry and durability claims. It now preserves
batch/event ids, returns `ExportAck`, requires an abort signal for export, and
uses explicit `shutdown()`. This keeps provider usage, privacy, retry, health, and
delivery-boundary evidence representable after base observability moves into core.

The first tool-source shape exposed only lookup and names. It now also requires
model-safe schemas and a fail-closed `parallel | exclusive` execution mode for
each call. Without those methods an external live catalog could compile while
still being impossible to advertise safely or schedule through the canonical
tool pipeline.

### 4.24 A journey subset cannot freeze the monorepo package map

The first machine topology contained only the eleven packages imported by the
five consumer and two author journeys. It omitted Anthropic/provider protocol,
browser durability, OpenTelemetry, and A2A. That was sufficient to check example
ergonomics but too weak to authorize a monorepo migration: an omitted package
could retain the old agent/observability dependency or an incorrect runtime tier
without affecting any journey.

Decision: the topology schema covers every retained target package
after merging/removing `agent`, base `observability`, the Node facade, and the
unscoped facade. It records Universal/Browser/Node tier, bounded core-peer rule,
normal workspace dependencies, optional peers and subpath requirements, and
seven exact external runtime dependency/peer declarations. Journey runtime is
derived from its complete normal workspace closure, not only direct imports.

This is still a target graph, not evidence that current manifests already match
it. Product migration must rewrite and pack the manifests before the graph can be
accepted as exit evidence. Exact A2A public methods and exporter factory aliases
also remain API-freeze decisions; their declaration files currently establish
only target ownership and dependency direction.

### 4.25 A count-bounded diagnostics ring is not necessarily memory-bounded

The prototype defaults to 256 diagnostic events, while the retained Workerd
benchmark explicitly configured 32 and observed 864 evictions. Current privacy
processing hard-limits each serialized observation event to 64 KiB. Therefore a
count-only 256-event ring could retain approximately 16 MiB before JavaScript
object overhead—the entire provisional sampled peak budget for the basic Edge
agent. The benchmark does not justify that default.

Decision proposal P0-09 adds a second limit: provisionally 256 events **and**
1 MiB retained serialized bytes, with explicit retained/evicted event and byte counters.
Canonical per-run usage/error reports remain outside the evictable support ring.
The value is intentionally pending owner approval and must be re-frozen against
representative plus maximum-size events in the packed migrated core.

### 4.26 Caller-owned capability examples must survive construction failure

The first Edge-capability and Node-harness compile journeys connected MCP before
constructing the runtime, but entered `try/finally` only after runtime
construction succeeded. A provider/exporter validation or setup failure would
therefore skip `mcp.close()`. Their shared `finally` also closed MCP before the
runtime, even though an active run being quiesced by `runtime.close()` could still
need that borrowed tool source.

Decision: recommended journeys now wrap runtime construction inside the borrowed
connection's outer `try`, then use an inner runtime lifetime. Runtime closes and
quiesces active runs first; the caller closes MCP afterward. The static contract
checks this ordering in both representative journeys. Product implementation
still needs deterministic construction-failure and active-run teardown tests;
the compile fixture proves the documented control-flow shape, not runtime cleanup.

This was the correct intermediate fix before runtime-bound integration logging
was designed. Finding 4.131 supersedes its bootstrap order for the target API:
runtime is now created first, so construction failure opens no MCP connection;
connection failure instead triggers runtime cleanup. The runtime-before-MCP
teardown rule remains unchanged.

### 4.27 Plugin convenience requires explicit identity and ownership

The composition design promised two installations of one provider family through
distinct IDs/routes, but official provider declaration stubs accepted only
credentials and fetch. Separately, the design declared passed instances borrowed
by default while exporter registration had no ownership field and described the
observation bus as shutting exporters down. Both gaps would force consumers to
guess semantics precisely where the plugin model should be predictable.

Decision: OpenAI, Anthropic, and Codex factory contracts now accept optional
instance `id` and `routes`; an eighth compile journey creates two OpenAI accounts
with independent routes. Exporter registration requires `ownership: 'borrowed' |
'owned'`, and a negative contract rejects omission. Owned transfer occurs only
after family-marker validation and is rolled back on later construction failure;
borrowed exporters are never closed by runtime. P0-05 and P0-06 now carry these
details without creating a second approval list.

### 4.28 Memory was promised in prose but absent from the executable contract

The package plan names `/memory`, `MemoryProvider`, and future memory/storage
packages, while the composition design treats memory as a typed plugin family.
The machine contract initially exposed neither a marker nor an agent/session
composition slot. Its core-only capability-author journey could therefore pass
even though an external memory package had no public API to implement.

Decision: v1 now distinguishes bounded in-run `AgentMemory` from a borrowed
`MemoryStore` persistence capability. The store has its own family marker,
explicit scoped key policy, required abort signal, not-found versus failure
distinction, and compare-and-swap revision on commit. A binding also selects `required` or
`best-effort`; failed loads must never become create/overwrite attempts. The
author journey implements the store and binds it to an agent using core alone.
Runtime conformance for conflict, retry, failure reporting, bounds, and shared
lifecycle remains post-migration evidence.

### 4.29 The current graph requires explicit intermediate ownership states

Current source/manifests show MCP, A2A, and filesystem skills still consuming
`@ai-agent-sdk/agent`, while browser/fetch/Node/OTel exporters consume
`@ai-agent-sdk/observability`. Deleting either split package in the same first
move would force a repository-wide rewrite too large to isolate ownership,
behavior, and packaging regressions. Copying implementation into core while the
old package remains active would be worse: two runtime identities could pass
types while splitting accounting or lifecycle state.

Decision: the implementation ledger now defines I0 through I8. Observability and
agent move as single-owner source transfers, each leaving only a time-bounded
re-export bridge. Composition root follows those moves; provider and capability
closures then repoint independently; consumers migrate before all bridges and
facades are deleted. Every intermediate state stays buildable, bridge imports
shrink monotonically, and no bridge is accepted as final architecture.

### 4.30 Root ergonomics did not prove the package-author subpaths

The package plan already limited core to root plus `/agent`, `/tools`, `/skills`,
`/memory`, `/observability`, and `/provider`, but the first machine topology
mapped only `@ai-agent-sdk/core`. Consumer journeys could pass while the migrated
package omitted every author subpath or forced integrations to deep-import source
files—an especially costly mistake once third-party plugins exist.

Decision: the topology schema records all seven core specifiers, each backed
by a declaration entry, and a ninth journey imports the complete advanced author
surface without internal paths. Getting-started remains root-only; subpaths group
stable contracts and do not represent extra packages or installation choices.
Packed `exports`, publint/ATTW, and tree-shaking proof remain I3/I8 exit evidence.

### 4.31 Credential plugins lacked cancellation and concurrency semantics

The compile contract originally accepted API-key callbacks whose `AbortSignal`
was optional, while `envCredential()` returned an unversioned function. The
Codex auth-store shape exposed only `read()` and `write()`. That was convenient
but too weak for the documented conformance claims: a model cancellation could
be lost during secret resolution, and two simultaneous refreshes could both use
one rotating refresh token then blindly overwrite the newer file.

Decision: a sixth executable family now covers `CredentialSource` and generic
`CredentialStore<Value>`. Literal strings remain the minimal API. Executable
sources carry a marker and receive a required operation signal; an arbitrary
unmarked resolver function remains a negative contract, while the retained
`envCredential()` result is a callable/marked intersection. Stores are borrowed,
return opaque revisions, and commit with create-only or compare-and-swap
semantics. `provider-codex` exposes the distinct `CodexCredentialStore`
specialization for `CodexAuthFile`, while `auth-node/codex` supplies the Node
implementation and retains `CodexAuthStore` for compatibility. Product
conformance must prove signal propagation, atomic
replacement, refresh conflict reload, redaction, and no overwrite after read
failure.

### 4.32 The close contract could not account for capability cleanup

The design required a bounded complete close report, but its declaration exposed
only run counts and a deadline flag. Provider disposer failures, owned exporter
shutdown failures/timeouts, and final observation health were therefore absent
from the compile contract. A full Node harness could finish a response while
silently discarding exactly the teardown evidence operators need.

Decision: `RuntimeCloseReport` now contains support-safe per-component entries
for owned provider registrations/exporters with `closed | failed | timed-out`
status, plus final observation health. The representative Edge and Node journeys
retain and return that report after closing runtime before borrowed MCP. Owned
cleanup failures are reported rather than thrown over a primary provider/run
failure; repeated close resolves one idempotent terminal report. Deterministic
fault and deadline tests remain I3 exit evidence.

### 4.33 Provider plugin composition needs an explicit mutation policy

Multiple provider instances and route conflicts were specified, but the normal
runtime API never stated whether providers could be installed or removed after
construction. Leaving this implicit invites a later `runtime.install(anything)`
escape hatch, changes model routing under active sessions, and makes disposer
ownership difficult to audit.

Decision: normal provider topology is immutable after awaited runtime
construction. Credential rotation uses `CredentialSource/Store`; live MCP changes
appear through invocation snapshots; a different provider set creates a new
runtime. Low-level transactional registry replacement may remain internal or on
an advanced surface, but it is not the user-facing plugin grammar. P0-06 records
this owner-reviewable choice.

### 4.34 “Universal” lacked an explicit host-feature baseline

The runtime-boundary checker rejects Node imports, but that alone cannot prove a
runtime has the Web APIs core actually uses. Current source mixes
`crypto.getRandomValues`, `randomUUID`, `Math.random`, wall/monotonic clocks,
`AbortSignal.any/timeout`, streams, structured clone, and several timer paths.
Without a frozen baseline, one environment can fail halfway through runtime
construction or produce weaker/inconsistent correlation IDs while still being
labelled Universal.

Decision: topology schema v5 records exact Universal, Browser, and Node 22.12
feature baselines. Runtime construction will preflight Universal requirements
before plugin access/allocation and use one internal clock/random/timer adapter.
The target removes `Math.random` identity fallbacks, clears owned timers/listeners
on close, keeps fetch at HTTP capability boundaries, and adds no public host
service locator. Packed Workerd/Chromium/Node plus Deno/Bun standards checks
remain P0-12/I8 evidence.

### 4.35 The first target `Usage` shape erased canonical billing evidence

The initial declaration contract exposed only coverage plus input/output/total.
Current accounting already distinguishes cache-read, cache-write, and reasoning
counters; physical attempts and dispatch state; logical model calls; missing or
possibly billed attempts; reported versus estimated counters; delivery health;
and whether the aggregate is authoritative. Collapsing these fields during the
core merge would make a clean API at the cost of the token tracking the migration
is meant to preserve.

Decision: core exports the attempt/model-call/run report hierarchy and the full
six-counter projection. Estimates remain separate from reported values, retry
attempts remain individually visible, terminal success and error events carry the
same `RunReport`, and the static contract rejects a simplified `Usage` interface.

### 4.36 Compaction currently bypasses the run ledger

Normal generation obtains a `ModelCallReport` from the model-call handle and
records it through `RunLedger.recordModelCall()`. `ContextCompactor.summarize()`
instead calls `registry.prepareCall()` directly, consumes the stream, and copies
only assembler usage into history and span output. Automatic compaction can
therefore spend tokens inside a run without adding its model call/attempts to the
canonical run usage; idle `session.compact()` has no run report at all. Summing
the history value afterward would risk double counting once the path is unified.

Decision: implementation must route every provider-backed compaction request
through the same model-call reporting boundary exactly once. Automatic compaction
joins its active run ledger; any retained public idle-maintenance API returns a
separate terminal maintenance/run report. History/span usage is a projection and
is never independently added to totals. Deterministic success, retry, failure,
abort, and missing-usage matrices are Phase 2 gates.

### 4.37 Export batches cannot own one usage total

The first target `ObservationBatch` attached one `RunUsageReport`. A delivery
batch can mix events from several runs, while one long run can cross multiple
batches. The scalar therefore had no correct owner and could silently attribute
one user's usage to another batch/run.

Decision: batches carry zero or more atomic terminal records, unique by `runId`
within a batch and stable across exporter retry. Per-run usage remains on the run
handle even if operational events are evicted. The exporter author contract and
static checker enforce this shape.

### 4.38 Native-tool progress needs stable identity

The first target event reduced provider-native tools to provider/name/status even
though the current content block retains a provider item ID. Repeated deep-search
calls with the same name could not be paired or distinguished, and a host tool
result had no explicit terminal status.

Decision: both host and provider-native progress preserve stable call IDs and
terminal status. Native structured input/output remains optional on the caller
event stream and passes through privacy processing before observation export.
Consumers count tool events, never assistant prose, and never fabricate a start
event when a provider emitted only a completed item.

### 4.39 The first target policy silently removed estimation

The declaration fixture initially changed current `warn | estimate | fail` into
`report | fail` while continuing to advertise `estimated` coverage. That both
removed a behavior and introduced an unrelated rename during a package-only
migration.

Decision: retain the existing policy values and a typed local-only estimator
contract in core. Estimator requests are never retained/exported, estimates fill
only missing counters, and any estimated report remains non-authoritative.

### 4.40 Exporting `RunReport.delivery` creates a checkpoint cycle

Replacing batch usage with whole `RunReport` values fixed attribution but created
a deeper impossibility: `RunReport.delivery` is known only after the terminal
checkpoint, while the proposed terminal checkpoint needed to export that same
report. Freezing it before export leaves stale/pending delivery; mutating it after
acknowledgment violates report identity and retry determinism. The acknowledgment
also named only event IDs, so it could not prove acceptance of a run report.

Decision: core first freezes a delivery-free `RunTerminalRecord`, stages and
checkpoints that record, and requires `ExportAck.acceptedRunIds` alongside event
IDs. It then creates the caller-facing immutable `RunReport` by adding the
resulting delivery summary. Export retries retain batch/record identity and
cannot rewrite accounting authority or delivery history.

### 4.41 Delivery modes and durability boundaries were conflated

The target registration used `operational | acknowledged | durable`, while
receipts and run reports used `none | local-durable | remote-acknowledged` and
mode separately used `operational | reliable | audit`. An exporter factory could
therefore compile an ambiguous claim, and the target interface omitted the
current `supportedBoundaries` declaration needed for configuration validation.

Decision: mode and boundary remain separate. All packages use one
`ObservationBoundary` union, exporters declare supported boundaries, and runtime
construction rejects an unsupported selection before setup/ownership transfer.
The Edge and Node journeys now select `remote-acknowledged` and `local-durable`
respectively.

### 4.42 The first target observation/skill shapes weakened diagnosability

The simplified `ObservationEvent` retained only id/type/attributes, losing
run/trace/span correlation, sequence, timestamps, priority, and phase already
present in the current canonical envelope. Separately, `SkillLookupOptions`
advertised abort but made its signal optional, allowing every external skill
operation to ignore run cancellation while still satisfying the type.

Decision: the target envelope retains the full metadata needed to order and
correlate events without capturing content. Skill-provider list/load/resource
operations require a signal; the runtime supplies it and conformance covers abort
before access, during I/O, and during close.

### 4.43 Minimal declaration shapes would regress the full SDK

The target contract initially proved only basic object construction. Compared
with the current Universal agent surface it omitted tool parse/render/UI-meta,
cooperative timeout and context controls; rich skill resources/invocation policy;
marker-free `defineAgent/defineTool/defineSkill`; native tools, compaction and run
bounds; and session snapshot/resume/manual compaction. A core-plus-provider app
could compile while the Edge chat and full Node harness lost key behavior.

Decision: the compile contract now preserves these high-value author/session
surfaces and checks their declarations. Low-level current internals are not
automatically frozen merely because the unpublished package exports them; each
advanced surface still needs a demonstrated consumer before migration.

### 4.44 Plugin authors should not hand-stamp family markers

The prose promised marker-stamping helpers, but only credential sources had one;
the author fixture manually copied `kind/apiVersion` into credential store,
memory, skill, exporter, tool-source, and provider objects. This is repetitive,
easy to version incorrectly, and undermines the convenience goal.

Decision: core exposes one side-effect-free `define…` helper for every executable
family. Helper inputs omit marker fields and return the exact typed capability;
they perform synchronous validation only. Runtime composition still validates
the returned marker before method access or ownership transfer, and no generic
plugin helper/container is introduced.

### 4.45 A human-in-loop mode without brokers cannot power a harness

The target declaration included a misspelled/simplified `human-in-loop` mode but
omitted the current `deep-human-in-loop` contract, user-input and approval
brokers, interceptors, hooks, and pause events. The existing human CLI depends on
a bounded broker and `abortAll()` to prevent a cancelled run from leaving a
parked request. A nominal mode alone could not implement an interactive web/CLI
agent.

Decision: core preserves Web-safe fixed/interactive brokers, ordered tool policy
interceptors, bounded turn hooks and correlated approval/user-input events. Every
executable broker request receives a required signal; deny remains distinct from
abort. The Edge journey compiles HIL request/response projection and the Node
harness compiles approval policy composition.

### 4.46 `history: unknown` is not a resumable session contract

The target snapshot initially claimed resume while typing history as `unknown`
and omitted activated skill state. That gives persistence adapters no stable
schema and lets incompatible/unbounded history reach runtime allocation.
Separately, the package plan promised Universal team contracts but the target had
no team composition point.

Decision: `AgentSessionSnapshot` is a JSON-safe versioned envelope with validated
history, memory, agent/conversation identity and activated-skill locators; runtime
resources are reinjected. `runtime.team()` owns bounded local teams and reports
their cleanup, while remote A2A remains an explicit Node capability. The Edge
journey compiles snapshot/resume and the Node journey compiles local team create/
early-close.

### 4.47 Minimal MCP types hid operational and teardown state

The first target MCP declarations exposed only URL/command and `close(): void`,
although current source supports reconnect policy, auth states, tool refresh,
catalog/result/operation limits and bounded teardown. A user could compose the
plugin but could not observe which catalog generation a run used or whether close
timed out.

Decision: the target retains support-safe MCP state, monotonically increasing
catalog revision, reconnect/refresh/OAuth and explicit bounds. Connections remain
borrowed/caller-owned. The later compatibility audit preserves existing
`close(): Promise<void>` and adds bounded idempotent `closeWithReport()` for the
separate `McpCloseReport`; examples close runtime first, then MCP, and retain both
reports.

### 4.48 MCP client selection still installed server code

The sixteen-package target separated Universal and Node runtimes but not client
and server roles. `@ai-agent-sdk/mcp` declared both MCP client and server runtime
dependencies, while `mcp-node` declared client, Node hosting and server
dependencies. The Edge and Node harness journeys import only clients. Export
subpaths cannot fix this because package managers install dependencies for the
whole package before bundling/tree-shaking.

Decision: topology schema v5 has eighteen packages. `mcp` and `mcp-node` are
client-only; `mcp-server` owns the Universal server closure and
`mcp-node-server` owns Node stdio/HTTP hosting. The client journeys statically
reject either server package, and P0-14 records the owner decision. This adds two
packages to the ecosystem but zero choices to users who only install core plus a
provider or an MCP client.

### 4.49 A package graph is not yet an installable manifest contract

Topology v4/v5 recorded package names, runtime tiers and dependency ownership,
but initially left module format, export conditions, side-effect metadata, Node
engine, core peer range, deep-import policy and unpublished/private state to each
implementation commit. Two packages with the same graph could therefore behave
differently under Node, a bundler or package-manager resolution.

Decision: schema v5 freezes an ESM-only manifest policy with `type: module`,
`sideEffects: false`, `types/import/default` conditions and no `require`, explicit
`./package.json`, no undeclared deep imports, `workspace:^` core peer during the
monorepo migration, and Node `>=22.12` for Node packages. Every target remains
`private: true` because publishing was explicitly excluded; release readiness
compares generated manifests but does not configure or execute publication.

### 4.50 Async exporter readiness needs one transactional owner

The target exporter family gained optional `ready(signal)`, but the design still
told the host to remember to call it before the first run. That makes readiness
order differ between official and third-party exporters, permits a partially
initialized runtime to escape, and leaves ownership ambiguous when readiness
fails after another component has activated.

Decision: `createAgentRuntime()` owns exporter activation. It validates the family
marker and requested durability boundary before any exporter method, transfers
only explicit `owned` registrations, awaits readiness within `startupTimeoutMs`,
and rolls back transferred owned components in reverse order on rejection,
timeout, or abort. Borrowed exporters are never shut down. A support-safe
`AgentRuntimeConstructionError` preserves the primary stage and structured
cleanup outcomes, so a rollback failure is observable without masking the cause.

### 4.51 Startup cancellation and logging identity were underspecified

The readiness timeout bounded startup but offered no caller cancellation. The
construction error exposed only a broad stage, so a host could not distinguish
abort, timeout, validation failure, or the failing plugin. Separately,
`ObservationBatch` contained correlated run/event identity but no immutable
runtime/SDK/service resource, making a shared exporter ambiguous across runtime
instances. The composition snippet also still exposed mutable registry and
observability escape hatches absent from the machine contract.

Decision: runtime options accept an optional caller signal combined with the
startup deadline. Pre-abort fails before setup, method access, or ownership
transfer; later abort uses transactional rollback. Construction errors add a
support-safe reason and optional provider/exporter identity. Every batch and
diagnostic snapshot carries runtime-generated runtime/SDK identity plus bounded
JSON-safe service metadata. The public runtime keeps its canonical registry and
observation bus internal. Export-visible event attributes are also restricted to
post-privacy `JsonValue` rather than arbitrary host objects.

### 4.52 Numeric API versions are not family markers

The target provider and exporter shapes initially carried only `apiVersion`.
Because every independently versioned family currently uses numeric value `1`,
that field cannot prove whether a value is a provider, exporter, skill source, or
other executable protocol before method access. Structural methods help
TypeScript consumers but do not provide a fail-closed runtime discriminator.

Decision: every executable family carries a literal `kind` plus its independent
`apiVersion`. Provider and exporter helpers stamp both fields, while helper inputs
omit both. Runtime composition rejects absent, wrong-family, or unsupported
markers before setup, readiness, allocation, I/O, or ownership transfer. The
negative declaration journey now proves a value cannot impersonate a provider by
sharing only numeric version `1`.

### 4.53 Provider plugins need a real adapter author contract

The target registrar initially accepted a `ModelAdapter` interface containing
only `kind` and returned `void`. That was enough for an official HTTP factory to
type-check, but it erased the current SDK's direct adapter stream, model
catalog/resolution, retry policy, atomic generation binding, invocation/physical-
attempt accounting, registration handle, middleware and teardown surfaces. A
non-HTTP provider author could compile a plugin with no executable model method.

Decision: `@ai-agent-sdk/core/provider` preserves `ModelAdapter` as an abstract
class and the existing advanced provider vocabulary. A new core-only compile
journey implements a direct adapter, emits the terminal stream protocol, registers
two routes, inserts middleware and returns deterministic cleanup. Registrar
mutation is activation-scoped: setup plus runtime-owned rollback/close; retained
handles reject active-state mutation. This maintains provider extensibility while
keeping the normal runtime topology immutable.

### 4.54 Compile journeys are not a public API migration inventory

The target declaration journeys represented only 29 of 184 current core exports,
62 of 207 agent exports, and 5 of 24 base-observability exports. That does not mean
the other 319 symbols should disappear; it means example-driven contracts were
being mistaken for an exhaustive compatibility ledger. A migration could delete
classes, helpers, message/content types, low-level tool/agent APIs or observability
projections while every journey remained green.

Decision: `api-migration.json` freezes 417 current public API export occurrences:
the 415 root exports plus two exports available only through
`@ai-agent-sdk/agent/skill-validation`, with SHA-256 hashes of every generated
declaration baseline. Preservation is the default. Removal
requires a stable decision ID, replacement/rationale, consumer migration and
owner approval. Core remains on the core root; agent and observability symbols
move to bounded core subpaths. The sole proposed removal is the implicit-model
`DEFAULT_AGENT_CALL_CONFIG` under P0-02. Final API-report/signature comparison is
an exit gate; the recommended target declaration remains an ergonomic contract,
not permission to delete unmentioned public API.

### 4.55 Preserved names can still split runtime/type identity

An exact symbol inventory catches deletion but not two declarations with the same
name. After merging packages, duplicating a class/interface under root and a
focused subpath could break `instanceof`, declaration merging, registry identity,
error routing, or plugin compatibility even though both exports exist. The
current baseline has one cross-package overlap: agent exports
`AgentMessageSource`, but it already imports and re-exports core's declaration.

Decision: `api-migration.json` records the collision, canonical owner and re-export
route. Core root retains its existing API; moved package roots map to assigned
subpaths; focused subpaths are canonical re-export views only. The checker rejects
local declarations in all six core subpath files. Final packed/API tests must
compare both type identity and runtime value identity wherever one symbol is
reachable through multiple supported specifiers.

### 4.56 Base logging needs a safe high-level entry point

The target runtime kept canonical accounting and diagnostics but exposed no
logger. Applications and third-party plugins would either create a second
observability bus—splitting resource/trace identity—or log elsewhere, making SDK
support reports incomplete. Stale shutdown/design prose still described injecting
a borrowed whole-bus option that had already been removed from the machine
contract.

Decision: the normal runtime owns one non-public bus and exposes
`runtime.logger({ scope, fields })`. Callers cannot override resource or
correlation identity. Tool, turn-hook and model-invocation contexts receive
active-run-bound loggers. All log fields are JSON-safe and flow through the same
privacy, priority, queue, health and exporter path; exporter failure is contained,
not thrown from the logger. The low-level current `SdkLogger`, `LoggerContext`,
`Observability` and `createObservability` remain preserved on
`core/observability` for advanced standalone use, but cannot replace the runtime's
canonical bus through the common composition API.

### 4.57 Logger injection must not break contexts or impersonate accounting

The first target logger revision made `logger` required on existing public tool
and hook context types. That would break callers constructing test/mocked contexts
even though logging is an additive capability. A second ambiguity was semantic:
the synchronous logger API returns no receipt, so treating a successful call as
token completeness or durable delivery would recreate missing-usage/tracking gaps.

Decision: logger fields stay optional on preserved low-level context types, while
all `AgentRuntime`-owned paths guarantee an injected bound logger and compile
journeys demonstrate tolerant access. `SdkLogger` records operational events only.
Canonical call/token/error truth remains in terminal run records, and durability
is proven only by checkpoints/export acknowledgments. Logger queue/export failure
remains visible through observation health without falsifying either claim.

### 4.58 Plugin identity conflicts need one fail-closed contract

Current provider, observability, tool, skill and team implementations already
reject many duplicates, but the target composition contract specified atomic
provider routes and tool snapshots without defining all identity namespaces or a
support-safe collision shape. Duplicate exporter IDs were especially dangerous:
close/health reports could be ambiguous and ownership rollback could appear to
target the wrong instance.

Decision: every executable collection has an explicit scoped namespace. Provider
plugin IDs/routes and exporter IDs validate in runtime preflight before methods,
allocation, ownership or readiness. Tool-source/tool and skill-provider/skill
collisions fail one immutable invocation/catalog snapshot; team member names fail
before session creation. No import-order winner or shadowing exists. A stable
failure code plus `CapabilityIdentityConflict` records namespace, bounded key and
input indices; pure preflight conflicts have no cleanup entries and reveal no
object inspection, endpoint, credential, content or filesystem data.

### 4.59 Readonly types did not close capability TOCTOU

The target interfaces made identity fields readonly, but method syntax remained
assignable at runtime and the current `defineSkillProvider()` validates then
returns the caller's original object. A provider/exporter/source can therefore
pass marker and collision preflight and subsequently replace `setup`, `export`,
`shutdown`, `list`, `load`, `resolve`, or a nested catalog method. Re-reading the
object during execution or close would invalidate preflight, ownership, and
cleanup evidence. Deep-freezing the caller object is not acceptable either: it
mutates a borrowed value and can break legitimate internal connection/catalog
state.

Decision: family helpers create new frozen wrappers, while runtime composition
creates a private frozen identity/configuration/method-reference handle for any
valid direct implementation. Core never mutates the caller object and never
rereads identity or method properties after preflight; returned cleanup is
captured immediately. Capability-owned operational state remains mutable and
dynamic data advances only through family methods at documented snapshot
boundaries. This does not claim to sandbox hostile JavaScript proxies or package
code. The topology and compile-only negative contract now make the policy
machine-checked; deterministic post-preflight mutation tests remain product-phase
exit evidence.

### 4.60 `void` allowed async provider lifecycle callbacks

Provider topology is intentionally synchronous, and the current registry already
contains returned thenables from both setup and cleanup. However, TypeScript
allows an `async` function where a callback returns `void`, so the target helper
grammar could compile an authoring mistake that runtime would reject. Separately,
the implementation TODO listed every provider disposer as potentially timed out,
which overstates what a JavaScript deadline can do once synchronous package code
has begun executing.

Decision: retain the broad `void` signature on direct `ModelProviderPlugin` for
source compatibility, but make `defineModelProviderPlugin()` accept a stricter
`undefined | (() => undefined)` setup result. Compile-only negative contracts now
reject async setup and cleanup through the recommended author path. Runtime still
rejects/contains thenables from direct implementations, seals the registrar,
discards staged topology, removes committed topology before cleanup, and exposes
stable async-unsupported codes. A provider is `timed-out` only if the shared close
deadline expires before its synchronous disposer starts; an already-running
disposer cannot be preempted. Async owned resources remain separate capability
objects rather than hidden provider-registry lifecycle.

### 4.61 One core peer did not eliminate nominal plugin boundaries

The package plan correctly requires recursive bounded core peers, but package
resolution and runtime interoperability are separate facts. Current
`provider-http` still contains two `instanceof AgentSdkError` and two
`instanceof ModelError` checks on values crossing the core/provider boundary. A
duplicated but API-compatible core can therefore pass family markers and still
lose a model failure's code/status/retry semantics by being rewrapped as a
transport error. Conversely, adding a global singleton token would introduce
import-time global state and false conflicts between independent apps/realms.

Decision: official packed closures must prove exactly one physical core
resolution recursively, with no embedded core implementation and canonical
re-export value identity. Independently, executable protocols and failure
envelopes validate structurally; `ModelAdapter` is not an `instanceof` gate.
Foreign failure data is trusted only from bounded own data properties whose code
agrees with the outer error, otherwise it normalizes to `UNKNOWN`. No global
duplicate-core detector is added. I4 removed the four nominal checks; the
machine-counted inventory now freezes each constructor count at zero. Deterministic
structural-adapter and independent-module failure fixtures provide the runtime
exit evidence.

### 4.62 The target HTTP extension kit could not implement a provider

The first target `provider-http` declaration reduced a protocol to only `id` and
`defaultDialect`, and authentication to `none | bearer`. It omitted the methods
that choose an endpoint, serialize requests, translate SSE, and supply protocol
headers, while also dropping header/dynamic auth, discovery bounds, retry and
transport controls. The official protocol declarations were similarly inert.
The compile journey passed only because it consumed a named protocol value; the
declared object could not actually power the adapter. Retained provider packages
also had no API baseline, so dozens of current extension exports could disappear
without the then-415-root-symbol moved-core gate noticing.

Decision: restore a structural, versioned `http-wire-protocol` contract and a
provider-http `defineWireProtocol()` helper; validate/snapshot it at adapter
construction. Restore the configuration seams required by current header,
dynamic-auth, discovery, retry, bound, and diagnostic use cases, with required
cancellation and core `CredentialInput`. Add a core+provider-http custom author
journey. Freeze 84 current public exports from provider-http/OpenAI/Anthropic/
Codex in a separate preserve-by-default baseline so recommended factory-focused
docs do not become accidental API deletion authority.

### 4.63 Header spread precedence could leak custom credentials

The current configurable HTTP adapter builds connection headers by spreading SDK
attribution, protocol headers, endpoint headers, and auth headers in order, then
spreads them over transport defaults. Later layers silently overwrite earlier
ones. A static endpoint header can replace protocol/attribution metadata, and a
dynamic auth resolver can replace `content-type`. More seriously, exact-wire
logging redacts by a sensitive-name regex only; a credential returned under an
unfamiliar custom header name can be persisted unredacted.

Decision: target HTTP composition has five case-insensitive ownership layers and
rejects every cross-layer collision instead of choosing a winner. Transport and
SDK headers are reserved, static sensitive headers must use an auth scheme, and
all auth-produced header names are sensitive by provenance. Wire logging applies
both provenance and conservative name redaction. Credential headers are captured
atomically with their endpoint once per prepared logical call; physical retries
reuse that generation and the next logical call resolves afresh. AUTH remains
non-retryable by default. Headers never cross origins and each redirect hop
validates before contact. The machine topology freezes these rules and requires
deterministic case-variant collision, custom-name redaction, prepared-snapshot and
redirect tests.

### 4.64 The composition root hid catalog state from Web applications

`AgentRuntime` exposed agent/team creation, logging, diagnostics, and close but no
provider/model discovery. A ChatGPT-style site using the recommended
`core + provider` installation would have to import the advanced mutable
`ModelRegistry`, undermining the composition root. Current provider-http also
uses one adapter-wide cache, stores discovery failure as a successful empty array
for the full success TTL, and has no single-flight or caller-isolated abort. One
adapter registered to multiple routes can therefore share the wrong account/
route catalog, while UI cannot distinguish a valid empty result from outage or
bound rejection.

Decision: add high-level `providers()` and typed `modelCatalog()` snapshots with
`static | fresh | empty | stale | unavailable` state. Cache per plugin instance
and route; different accounts use distinct instances/routes. Static metadata
bypasses discovery, failures preserve but never overwrite last-good data, stale
serving is opt-in, and failure backoff is separate from fresh TTL. Concurrent
refresh is per-key single-flight with independent caller cancellation. Explicit
model targets remain runnable when discovery is unavailable. A twelfth compile
journey now proves Web model-picker ergonomics without registry escape.

### 4.65 Runtime close tracked runs but not catalog refreshes

Adding high-level `modelCatalog()` exposed a shutdown race that the run-only
wording did not cover. A dynamic catalog refresh can still be resolving
credentials or reading the network when `close()` disposes its provider. If it
publishes afterward, it can repopulate a closed runtime cache, emit misleading
success evidence, or retain provider state past cleanup. The same class of race
exists for manual compaction and local-team operations.

Decision: every runtime-owned asynchronous entry point acquires a typed operation
lease before capability method access. Admission and close share one atomic state
transition; admitted operations combine caller, runtime-root, and deadline
signals. Close rejects new admission, aborts the root, waits under one deadline,
then seals every unsettled generation before provider cleanup. Late continuations
are contained and cannot publish. The terminal report carries deterministic rows
for agent-run, model-catalog, manual-compaction, and team-operation, while legacy
run totals are derived from the agent-run row. Post-close topology/diagnostics/
report reads remain available; executable entry points reject and loggers become
closed no-op views that never reopen observation.

### 4.66 Caller cancellation could make runtime close ownership ambiguous

The proposed `close({ signal })` shape exposed no rule for an already-aborted
signal, concurrent close calls, or a signal that aborts during quiescence. If it
rejected or stopped cleanup, callers could observe a closed-looking API while
provider/exporter ownership remained unresolved. If a later call replaced the
budget, close would no longer be idempotent or deterministic.

Decision: the first call synchronously starts one shared irreversible close task.
Its caller signal may accelerate the quiescence boundary, but cannot cancel
provider/exporter cleanup or reject close by itself; unresolved generations are
sealed and the task still resolves one terminal report. Concurrent/repeated calls
join that task and cannot change its options. `quiescenceEnd` records `settled`,
`timeout`, or `caller-abort`, while the retained `deadlineReached` boolean is
strictly the timeout projection.

### 4.67 Provider discovery collapsed route and plugin instance identity

The first high-level `providers()` contract reused adapter `ProviderInfo`, whose
`id` is actually the registry route. It did not expose the plugin ID that owns the
route or the provider family. Two OpenAI accounts could execute independently,
but a Web model picker could not correlate `openai-team-a` with its installed
instance, group both accounts under OpenAI, or explain which catalog failed.
Treating route, plugin instance, and family as one string would reintroduce the
same ambiguity under a different name.

Decision: retain adapter `ProviderInfo` for compatibility, and add enriched
runtime topology rows with explicit `route`, `pluginId`, and `family`. Runtime
returns one row per route; multi-route rows share instance/family. Official
provider packages freeze family identity, custom plugins may declare one and
otherwise fall back to plugin ID. `modelCatalog(route)` returns a runtime catalog
snapshot carrying the same enriched row. Route alone selects models, plugin ID
alone identifies lifecycle/account ownership, family is grouping metadata, and
no identity is credential-derived. The two-account compile journey now discovers
and loads both catalogs through these fields.

### 4.68 Route collision preflight was impossible with routes hidden in setup

The design repeatedly required all provider route collisions to fail before
plugin setup, method access, or side effects. But `ModelProviderPlugin` exposed
only `id`, `displayName`, and `setup`; routes appeared only when plugin code called
`registrar.registerAdapter()` inside setup. Runtime could stage and roll back the
failure, but it could not know a cross-plugin route conflict before executing the
first setup callback. The documented fail-closed guarantee was therefore
unimplementable, and a malicious or merely eager plugin could perform effects
before an already-determinable conflict surfaced.

Decision: normal `createAgentRuntime()` input is a
`ComposableModelProviderPlugin` with declarative inert route claims. All IDs and
route claims validate across the complete input before any setup lookup/invocation.
`defineModelProviderPlugin()` returns this shape and supplies a claim-scoped
registrar, so the common author path does not repeat routes. Every claim must be
registered exactly once by setup return; undeclared/missing/duplicate claims fail
and rollback. The legacy direct plugin remains only for advanced registry
compatibility, and a negative compile contract proves it cannot enter the normal
composition root without declarative claims.

### 4.69 Memory composition could silently share or rebind conversations

The target `MemoryBinding` contained one opaque `key` on the agent definition,
although prose promised agent/session composition. `AgentSessionOptions` exposed
no memory slot. Reusing one runtime-bound agent for two conversations therefore
reused the same persistent key unless the user cloned the whole agent, and the
API gave no signal that this was shared state. Snapshots also carried memory
contents but no support-safe binding identity, so resume could be reinjected with
a different tenant/store key without a detectable mismatch.

Decision: memory bindings now carry explicit `bindingId` and a scope.
`conversation` uses a versioned collision-free tuple of namespace, agent ID, and
conversation ID; `fixed` requires `sharedAcrossSessions: true` to acknowledge
sharing. Session options accept a full borrowed binding or `false`, overriding
the agent default. Snapshot stores only the support-safe binding ID and resume
requires an exact match before store I/O; keys/namespaces are never serialized or
logged. The capability-author journey now creates a tenant-scoped session without
cloning an agent. Skill-provider ownership wording was also corrected to always
borrowed because v1 defines no transfer registration for that slot.

### 4.70 Activated skill snapshots had no serializable locator or revision

`SkillCandidate.locator` was typed `unknown`, while `ActivatedSkillSnapshot`
stored only ID/provider/source/resource base. This contradicted the claim that
snapshots carry activated-skill locators. A resumed session could not identify
the exact provider candidate it had activated, and accepting an arbitrary
`unknown` locator would permit non-JSON host objects or unsafe path-shaped data.
Bare-array discovery also supplied no catalog revision, so a provider update
could silently change resumed instructions/resources.

Decision: skill discovery now returns `SkillCatalogSnapshot` with an opaque
revision and bounded candidates. Locator is `JsonValue`; core stamps the selected
candidate into a revisioned `SkillReference`, and activated snapshots extend that
reference. Provider `load`/`readResource` accept the exact reference and validate
restored locator/revision before I/O. Invalid or unavailable references fail
before model/resource use, provider-relative paths reject traversal, diagnostics
exclude locators, and snapshots exclude loaded instructions/resource contents.
The author journey proves revision and locator validation.

### 4.71 ToolSource promised atomic revision evidence but exposed a live catalog

The target `ToolSource` held only `tools: ToolCatalog`, whose `names()`,
`schemas()`, `get()`, and `executionMode()` methods could observe different MCP
refresh generations. Core could read the `tools` property once and still combine
a generation-A schema with generation-B execution. The generic contract also had
no revision even though design required source ID/revision in every invocation;
only MCP state happened to expose a numeric revision, and `RunTerminalRecord`
could not carry it.

Decision: normal composition uses one synchronous `snapshot(signal)` call per
source per agent invocation. It returns a bounded string revision and bounded full
tool definitions; core captures schema and executable references from that one
result before model dispatch. Refresh remains explicit/source-owned and appears
next invocation; failure has no implicit stale fallback. Terminal run evidence
contains source ID/revision only. MCP retains `.tools` solely as a direct-caller
compatibility view that core never reads. Positive author and negative async-
snapshot compile contracts freeze the grammar.

### 4.72 Marker-free ToolDefinition was incorrectly treated as inert

The design called inline tools “plain inert data”, while `ToolDefinition` contains
`parse`, `execute`, `render`, `meta`, and a concurrency classifier. Current
`defineTool()` is a pass-through and `ToolRegistry` retains the original object.
After schema enumeration, caller/package code can replace `execute()` or mutate
parameters, producing the same schema/implementation generation split just fixed
for MCP. Absence of a family marker does not make executable references inert.

Decision: tools remain marker-free for first-class inline ergonomics because they
are a structurally validated core leaf contract with no independent lifecycle.
Function properties become readonly in the public contract. `defineTool()`
returns a new frozen wrapper capturing a detached bounded schema and all behavior
references while preserving the original receiver; it never freezes the caller.
Direct literals remain supported and runtime performs the same capture at agent/
session binding. Post-capture mutation has no effect, and local plus source tools
share one invocation collision namespace. A negative compile contract rejects
normal reassignment of the bound `execute` reference.

### 4.73 Session policy objects were shallow-copied but their methods stayed live

Current session construction copies interceptor arrays and some hook containers,
but retains interceptor, broker, and estimator objects. Tool dispatch reads
`before/around/after` later, approval and HIL paths read `request` when they park,
and missing-usage handling reads `estimate` at ledger finalization. Caller/package
mutation after session creation could therefore change approval decisions,
interceptor order behavior, hook checkpoints, or token estimation within one run.
Shallow `Object.freeze()` on the array/container does not bind those methods.

Decision: approval/user-input brokers, interceptors, turn hooks, and usage
estimators remain marker-free core leaf contracts. Their public runtime methods
become readonly, and agent/session binding captures bounded configuration plus
runtime-used function references once with original receivers. Operational state
remains live—interactive broker resolve/abort and stateful policy internals still
work—and caller objects are not frozen. Post-bind method replacement has no
effect. Positive estimator composition and negative approval-method reassignment
compile proofs freeze this policy.

### 4.74 A privacy test sentinel collided with random correlation identity

The selected offline unit gate produced one failure in
`http-provider.spec.ts`: it serialized the whole report and asserted that the
three-character malformed value `bad` was absent. The invalid usage value was in
fact removed, but a cryptographically random span ID happened to contain
`0bad...`. An immediate focused rerun passed with a different ID, confirming a
test-oracle collision rather than product leakage. Treating that rerun as if the
initial suite had passed would weaken evidence and leave a probabilistic gate.

Decision: privacy tests inspect the exact rejected field structurally or use a
long unique sentinel containing characters outside generated ID alphabets. They
never apply a short global substring assertion across random correlation fields.
When a random collision occurs, retain the initial failure, classify it with a
focused diagnostic rerun, and fix the oracle before claiming the whole suite
green. The machine contract records this evidence policy; live network/provider
checks remain manual-only under the existing automation restriction.

### 4.75 Target native tools lost the existing typed provider transport contract

The target reduced current `NativeToolSchemaMap`, typed Web Search/Image
Generation definitions, `NativeToolName`, and `ToolChoice` to one
`NativeToolDefinition` with `[option: string]: unknown`. `GenerateOptions` omitted
`nativeTools` entirely, so an agent definition could accept provider-native tools
but a third-party HTTP protocol had no typed route to serialize them. Arbitrary
unknown options also admitted callbacks/host objects and shallow copies allowed
nested mutation between model capability validation and request serialization.

Decision: restore the merge-extensible current native-tool vocabulary and typed
built-ins, use it in agent input, model metadata, `GenerateOptions`, provider HTTP
catalog metadata, and discriminated host/native `ToolChoice`. Runtime validates
and deeply detaches bounded JSON-safe configuration before model resolution; an
explicit model capability list is an allowlist, absent remains unknown. Native
execution stays provider-owned and distinct from host approval/scheduling.
Application progress payloads are bounded `JsonValue` and excluded from default
observations. Edge and custom HTTP-provider journeys now prove native Web Search,
tool choice, visible native progress, and transport serialization; a negative
contract rejects arbitrary callback options.

### 4.76 Wire serialization admitted values the transport could not define

Both the current and first target `WireProtocol.serialize()` declarations
returned `unknown | Promise<unknown>`, while `provider-http` unconditionally
awaited the value and passed it to `JSON.stringify`. That surface appeared open
to alternative protocols but did not define whether a string was a JSON string
or a raw body, what happened to `undefined`, bigint, non-finite numbers,
accessors, class instances or circular data, when mutation was observed, or
whether an asynchronous serializer could perform hidden I/O. It also left retry
body identity implicit: rebuilding or re-encoding from mutable state could send
different logical requests under one attempt/accounting generation.

Decision: v1 serialization is a synchronous pure function returning one JSON
object. `provider-http` must validate a bounded finite JSON graph, reject
accessors and unsupported prototypes, deep-detach it and encode it once before
dispatch. The exact detached object/bytes join the prepared endpoint/auth/header
generation and are reused for every physical retry. Invalid serialization and
encoded overflow have distinct stable pre-dispatch codes with zero provider
attempts and no network retry.
`application/json` is transport-owned; non-JSON bodies require a future versioned
contract. Default observations omit request bodies, while the preserved
compatibility logger is explicit and bounded, exposes the exact body, and redacts
headers by credential provenance. The compile
contract now rejects an async protocol serializer and the topology freezes the
runtime evidence policy.

### 4.77 SSE bounds did not cover activity, event fan-out, or terminal proof

ADR 0001 correctly retained exact `eventsource-parser@4.1.0`, but auditing the
SDK wrapper found gaps outside the third-party parser. `parseSse()` reports raw
reads and comments through `onActivity`, yet `HttpModelAdapter` does not pass that
callback; its idle wrapper observes only yielded protocol events. A valid
comment-only provider heartbeat can therefore time out while bytes are arriving.
The parser queue is bounded only indirectly by one raw response chunk and drains
with repeated `Array.shift()`. One legal-sized chunk containing many tiny events
can create high memory fan-out and quadratic CPU work. The adapter also does not
validate `text/event-stream` before parsing, so a 200 HTML/JSON response can fall
through as an empty stream unless a protocol translator catches EOF. Official
translators do catch truncated EOF, but the public custom-protocol boundary does
not enforce one terminal `finish` itself.

Decision: retain the exact parser dependency and fix the provider-owned wrapper
contract instead of substituting an unqualified internal parser. Validate SSE
media type, preserve WHATWG streaming UTF-8 semantics, ignore parser retry fields
for reconnection, and add configurable 100,000-event/1,048,576-character defaults
beside existing response-byte/raw-chunk limits. Drain callbacks linearly. One
per-attempt idle deadline resets on every non-empty body read, including comments,
while the overall request deadline remains authoritative. The adapter enforces
exactly one last `finish`, treats EOF before it as `STREAM_CLOSED`, forbids retry
after visible output, and preserves primary failure over secondary teardown
failure. The machine policy and Phase 3 deterministic matrix now freeze these
requirements without running a live provider spike.

### 4.78 Recommended official factories did not prove their real option surface

The install topology correctly lets a normal consumer select only
`core + provider-openai|anthropic|codex`, and the 84-export declaration hashes
protect current provider APIs from silent deletion. However, the target compile
declarations for the preferred factories exposed only credential, fetch, ID and
routes. They did not prove that custom gateways, OpenAI organization/project/store,
Anthropic beta/thinking budgets, Codex discovery/OAuth/cache controls, model
metadata, retry or transport bounds survive through the plugin-first path. An
implementation could therefore pass the ergonomic journey while forcing real
users back to advanced adapters; the final API hash would catch this late rather
than guide the implementation correctly.

Identity was also unnecessarily repetitive: the two-account journey supplied the
same string as both `id` and its only route. Meanwhile current Codex creates one
`promptCacheKey` per adapter but documents it as though separate conversations do
not collide. In reality every session sharing that adapter also shares the key;
it is an instance-scoped cache/routing hint, not conversation isolation.

Decision: official target declarations now carry the provider-specific and common
operational options through the preferred plugin factory, while retaining advanced
adapter/protocol exports. Factory calls remain inert and lazy. Defaults are
`id = family`, `routes = [id]`; a custom ID alone is sufficient for a second
account, with explicit route arrays reserved for aliases. A new Universal compile
journey builds OpenAI, Anthropic and Codex plugins using custom endpoint, reasoning,
catalog, credential-store, SSE and cache options without importing HTTP/protocol
support. Codex cache-key scope is documented honestly as plugin-instance scope.
Runtime identity/option-forwarding/rollback matrices remain Phase 3 implementation
evidence.

### 4.79 Additive factory stubs erased controls and misclassified OpenTelemetry

The same thin-target problem extended beyond providers. `fileSystemSkills()`
required only roots and omitted project/user discovery, scan caps and explicit I/O
telemetry. Browser/fetch/JSONL exporter stubs exposed one or two options while the
current implementations depend on quota, retry, batching, acknowledgment,
retention and durability bounds. MCP was substantially better, but target
declarations omitted its lazy advanced constructors. Without compile proofs, an
implementation could make the simple example work while removing the controls
that make capability packages usable in production.

More seriously, target `observability-otel` invented
`openTelemetryObservationExporter({ serviceName })`. The current proven bridge
requires caller-provided tracer/meter/optional logger and returns a synchronous
`openSpan` backend plus event processor. Treating it as a batch exporter would
lose real parent span IDs, pre-queue metric/log projection and explicit external
provider ownership. High-level `AgentRuntimeOptions.observability` simultaneously
omitted `openSpan`, processors, redactors and queue/batch/timeout controls, so the
actual bridge had no composition path through the recommended runtime.

Decision: target capability declarations now preserve operational option bags and
advanced lazy constructors while keeping normal named factories concise. Core
restores typed observation processors/redactors/span backend and bounded queue
options. OTel retains `createOpenTelemetryBridge`; the host owns and shuts down
its OTel providers, while runtime captures only callbacks. A new Browser journey
composes OpenAI, an owned IndexedDB exporter, and caller-owned OTel bridge. The
static checker was also corrected to allow only exact external imports declared
as package dependencies/peers—necessary for the real `@opentelemetry/api` type
peer—while continuing to reject undeclared external imports. Skill/MCP/exporter
runtime behavior remains post-migration deterministic evidence, not a live spike.

### 4.80 The Edge website boundary could split history and outlive the browser

The current hermetic Edge fixture keys its session map as
`conversationId:mode`. Switching a visible conversation from automatic to deep
search therefore creates a different server history while the browser continues
to render one transcript. The client-generated conversation ID is also the only
server lookup identity; it is not bound to an authenticated principal. Request
abort reaches the agent, but the returned `ReadableStream` has no `cancel()`
hook that aborts and waits for the run, so the UI reset test does not prove that
provider/tool work settled after disconnect.

The stream itself sends no schema version or monotonic sequence, emits raw
thrown messages on error, and has no support-safe terminal report for failure.
Arbitrary tool-result metadata can cross the browser boundary. A visually
working page can therefore hide sequence loss, incomplete accounting, internal
error leakage, or orphaned work.

Decision: the browser is a static SSE client by default and installs no SDK;
the Edge Worker owns core/provider/capabilities and injected credentials. The
trusted host supplies principal identity. One `(principal, conversation)` maps
to one canonical session regardless of mode. Deep search is a bounded,
host-mapped `additionalInstructions` overlay on the same session; it remains an
adaptive agent instruction, not a host workflow and not browser-controlled
system text. A compile-only Edge Worker journey now proves core+provider package
selection, SDK run ID plus application sequence, stable 409 admission, public
tool projection, support-safe terminal reporting, and response cancellation with
bounded idle settlement. The machine topology freezes this deployment policy.
Current human-test source migration stays in I6; no live/provider spike is run
during this audit.

### 4.81 Run-scoped instructions were typed but behaviorally undefined

The Edge Worker contract introduced `additionalInstructions` to keep one session
while changing research policy per run. Its first declaration said only
“bounded” and “appended”. It did not define a byte limit, validation point,
composition order relative to skill/team/core-mode text, reuse after retry or
compaction, persistence, privacy, accounting, or authority. A product could
therefore compile while appending different prompts on later steps, recording
the overlay in snapshots, allocating a run before rejecting an oversized value,
or accidentally treating prompt text as tool authorization.

Decision: freeze a core-wide run-instruction policy, not an Edge-only convention.
The optional string is captured exactly once before admission, must be
non-whitespace and at most 65,536 UTF-8 bytes, and rejects stably before history,
ledger, or capability access. Its order is base agent → skill catalog → team →
run overlay → core mode/control. It is reused for every request/retry and after
automatic compaction, but excluded from manual out-of-run compaction, history,
memory, snapshots, resume, later runs, default observations and support
artifacts. Provider/local-estimator input accounting still includes it. It never
changes authorization, approvals, tools, resources, model, budgets, session
identity, or memory binding. The topology checker and negative type contract now
freeze these semantics; deterministic runtime evidence remains an I3 exit gate.

### 4.82 The target run handle could cancel but could not prove settlement

Current source exposes eager `runId`, `result`, and a separate `report` promise,
but no explicit handle `abort()`. The first target contract added `abort()` for
the Edge response adapter while accidentally omitting `report`. That shape lets a
host request cancellation but forces it to infer accounting/observation
settlement from a rejected result or session state. It also left repeated abort,
abort-after-terminal, iterator abandonment, raw abort-reason privacy, event
terminal identity, and unhandled rejection behavior undefined. The compile-only
Edge adapter itself initially failed to abort the run if response encoding or
enqueue failed, allowing work to survive a broken downstream transport.

Decision: retain both control and evidence. The v1 handle is eager and
single-consumer, publishes a stable run ID before its first event, exposes
idempotent synchronous `abort()`, success-oriented `result`, and independently
awaitable terminal `report`. Error/abort rejects result with a stable run error
carrying the same report; the terminal event references it too. Early iterator
return aborts and settles; abort after terminal is a no-op; raw reasons never
become support content. Session idle follows all three event/result/report
settlements. The Edge compile journey now aborts on response failure/cancel,
waits bounded idle, and observes `handle.report`. Deterministic I3 tests must
prove these rules in product source.

### 4.83 The 415-root-symbol baseline did not verify its target declarations

`api-migration.json` correctly froze the three root declaration hashes and 415
public root symbols at that audit point, but the checker only compared that inventory back to the current built
packages. It never resolved each assigned target specifier and checked that the
preserved names were actually exported there. Consequently every shape journey
could pass while the target declarations omitted 136/184 core symbols, 171/206
non-removed agent symbols, and 17/24 observability symbols. The green output
reported “415 API baseline symbols” even though it proved inventory, not parity.

Decision: add an exact target-parity ledger to topology. The checker resolves
each target declaration through the contract tsconfig, subtracts only approved
removals, sorts missing names, and freezes both count and SHA-256. After restoring
`AgentInvocationOptions`, the first honest pending inventory was 323 symbols.
Re-exporting 29 already-canonical root symbols through the assigned focused
subpaths first reduced the gap to 294. The signature-safe observability pass then
restored its complete advanced surface and 24 missing core observation symbols.
The core message/content source-compatibility pass then restored 45 more core
symbols and restored the canonical agent-subpath re-export, reaching 209. The
provider/retry/utility pass in 4.88 then closes core parity. The agent tool,
skill, memory/history, accounting/trace, loop/definition and team/messaging
passes in 4.89–4.94 close the then-known root remainder: core 0, agent 0,
observability 0. Section 4.118 adds and closes the separate skill-validation
subpath route.
Drift in any name now fails. Phase 0 cannot change
to approved while the total is nonzero. This avoids pretending that representative
consumer journeys authorize silent API deletion; each symbol must instead be
declared/re-exported canonically or receive the full approved removal record.

### 4.84 Invocation event convenience disappeared during the rename

The current agent package exports `AgentInvocationOptions.onEvent`, and
`run()`/`runPending()` sequentially drain the eager handle while awaiting that
observer. The target renamed the options to `AgentRunOptions` and dropped
`onEvent`. This was invisible to the old parity checker and would force simple
applications to switch from `generate()` to manual stream iteration merely to
render progress—a direct regression in the composition convenience the package
redesign is meant to improve.

Decision: preserve `AgentInvocationOptions` as an extension of the new bounded
run options and export it canonically from `core/agent`. `run()`/`generate()`
invoke `onEvent` sequentially once per event and await it under
`observerTimeoutMs` (default 30 seconds). `stream()` callers consume the returned
handle directly and `compact()` emits no run events, matching the current
documented distinction. Observer failure aborts/settles the active run and
rejects the convenience method with `AGENT_EVENT_OBSERVER_FAILED`; raw callback
errors never become support content. The canonical report remains accounted.
This callback is an application progress observer, not an observation exporter
or durability acknowledgment. A minimal Edge compile journey now exercises it.

### 4.85 Name parity hid incompatible observability semantics

The new target had already exported names such as `ObservationEvent`,
`ObservationResource`, `ObservationBatch`, `ExportAck`, `ObservationExporter`,
`ObservationExporterRegistration`, and `ObservationHealthSnapshot`, so a name
inventory counted them as preserved. Their signatures were not preserved:
correlated schema-v1 events had become a different id/type/attributes envelope,
the SDK resource literal changed, batch and acknowledgment identity changed, and
the previously marker-free advanced exporter gained runtime markers plus explicit
ownership under the same public name. Adding the remaining 15 names would have
made observability name parity reach zero while existing source still failed.

Decision: never repurpose an existing public name for the new runtime protocol.
`core/observability` now preserves the complete current advanced bus surface and
its correlated event/resource/batch/ack/health contracts. A compile-only module
imports the current built observability declaration beside the target subpath and
checks mutual interface/function assignability plus public class/constructor
compatibility. The recommended composition path uses distinct
`ObservationExporterPlugin`, `ObservationDeliveryBatch`,
`ObservationDeliveryAck`, and `RuntimeObservationExporterRegistration` names;
official exporter factories return the plugin type. This mirrors the provider
split between an advanced direct contract and the declarative runtime plugin,
keeping simple named factories without silently breaking extension authors.

This pass closes all 24 observability baseline names and restores 24 related core
observation names, reducing total target name parity from 294 to 255. Signature
compatibility is now machine evidence for observability, not inferred from that
count. Equivalent domain-by-domain signature fixtures remain required for core
messages/provider primitives and the agent surface.

### 4.86 Broad test commands still reach a historical spike

The written audit policy correctly forbids automated AI runs from invoking
`spike:*` scripts or entrypoints under `spikes/`, but the repository routing was
not actually safe for broad test commands. Both `pnpm test` and
`pnpm test:unit` select
`tests/unit/core-capability-runtime-spike.spec.ts`, which imports the prototype
and import inspector directly from `spikes/core-capability-runtime/`. Although
those particular cases are deterministic, running them violates the explicit
no-spike boundary and can re-trigger the external classification failure that
interrupts this goal.

Resolution: the historical test was first quarantined, then removed together
with the superseded prototype after its useful coverage moved into maintained
contract, package, benchmark, and human tests. The machine topology now requires
an empty quarantine inventory and rejects restoration of the obsolete test.
Broad deterministic tests are eligible for automation; live providers, external
network and credentialed acceptance remain separately bounded. Existing reports
remain read-only historical evidence.

### 4.87 Core message parity needed same-source evidence, not cross-module brands

The remaining core gap contained the canonical content blocks, message/source
maps, branded message/tool/provider IDs, finish reasons, replay envelopes and
message constructors. These values sit underneath providers, agents, history,
tools and browser projection, so leaving them until source migration would make
every higher-level package appear composable while silently changing the data
model. A direct mutual-assignability test between aliased current and target
modules would also be invalid evidence for `Branded<T>`: each declaration module
owns a distinct private `unique symbol`, even though a real in-place core upgrade
retains one canonical module identity.

Decision: restore 45 current message/content names canonically at the target core
root and compile one consumer source twice—once resolving
`@ai-agent-sdk/core` to the current built declaration and once to the target
contract. The fixture exercises branded constructors, all content/source maps,
message creation/freezing, tool results, replay/failure shapes, and exact public
vocabularies. The machine policy freezes the 45-symbol coverage inventory and
both compiler configurations. Restoring the missing canonical
`AgentMessageSource` re-export then reduced target parity from 255 to 209 (core
67, agent 142 at that checkpoint, observability 0) while avoiding a false failure caused only by two
test module identities. Remaining core provider/retry/error/utility domains and
the agent surface still require their own signature evidence.

### 4.88 Provider markers were attached to the advanced compatibility name

The remaining 67 core names covered retry policy, registry preparation, model
metadata, errors, usage validation, stream assembly, API-key hygiene,
attribution, and general Web-safe utilities. During signature review, the target
also revealed a semantic incompatibility hidden behind an already-present name:
it required `kind` and `apiVersion` on the existing `ModelProviderPlugin`, and a
separate checker required a `model-adapter` marker on `ModelAdapter`. Current
advanced plugins and adapter subclasses carry neither. This contradicted the
design's own split between the marker-free advanced registry and the recommended
preflightable composition wrapper.

Decision: preserve `ModelProviderPlugin` and `ModelAdapter` as the current
marker-free advanced surfaces. `ComposableModelProviderPlugin` alone adds the
provider family marker, API version and inert route claims; `AgentRuntime`
accepts that composable shape, while direct `ModelRegistry.install()` retains the
legacy atomic route-in-setup contract. The named factory still returns the
frozen composable wrapper and uses its stricter synchronous setup grammar.

All remaining 67 core names are now canonical target declarations. A second
same-source dual-compile fixture covers those restored names plus 15
signature-sensitive existing provider/report/stream types, including a legacy
marker-free plugin and `ModelAdapter` subclass. Core and observability name parity
are both zero. Subsequent agent-domain passes below close the remaining name gap
without repurposing current loop/session/team contracts.

### 4.89 Tool parity had preserved names but lost the executable pipeline

The target tool declarations retained a convenient `defineTool()` shape but had
thinned current call identity, authorization, preparation, dispatch, finalization,
typed success/failure, registry errors and filters. This would let simple examples
compile while removing the APIs harnesses use to display and control tool progress.

Decision: restore 25 missing tool symbols and freeze 14 already-present,
signature-sensitive symbols. One deterministic source now compiles unchanged
against current `@ai-agent-sdk/agent` and target `@ai-agent-sdk/core/agent`.
Function properties remain readonly in the target design, approval cancellation
remains optional on the legacy public broker, and the composition runtime still
guarantees a signal on its own paths.

### 4.90 `SkillProvider` had been repurposed under an existing public name

Current `SkillProvider` lists metadata candidates, loads a candidate and may read
a resource. The first target used the same name for a revision/reference runtime
protocol. Name parity would therefore report success while existing providers
failed structurally and changed meaning.

Decision: preserve the marker-free current provider and helper. The versioned
revision/reference protocol is additive under `SkillProviderPlugin`,
`RuntimeSkillCandidate` and related names. Twenty-one missing and nine
signature-sensitive skill symbols now have same-source dual-compile evidence;
filesystem skills may return the new plugin without changing the advanced API.

### 4.91 Memory/history declarations existed but were not a usable public surface

The target root contained partial memory and compaction types, but the focused
agent/memory views did not expose the current `AgentMemory`, `History`,
`ContextCompactor`, projections, token estimates or typed history log. The target
snapshot also reduced entries to generic JSON, losing compaction and tool-pairing
structure needed for resume and audit.

Decision: restore 28 missing memory/history/compaction symbols and freeze seven
signature-sensitive ones. History snapshots again contain typed `HistoryEntry`
values; hook contexts preserve current fields with additive optional loggers.
The same deterministic source compiles against current and target declarations.

### 4.92 Accounting compatibility must retain the complete model request

The target already named usage estimators and run reports, but changed
`UsageEstimationInput.request` from current `GenerateOptions` to a reduced request
shape. That could omit provider-neutral generation controls and break existing
estimators during precisely the migration intended to improve token tracking.
Trace tree and low-level run-accounting contracts were also absent from the
focused target surface.

Decision: keep `GenerateOptions` as the estimator request, restore 16 missing
accounting/trace names and freeze eight signature-sensitive reporting names with
same-source dual compile. At this checkpoint the ledger had 52 missing agent
symbols, with core and observability both zero. No live provider or executable
spike was used for this evidence.

### 4.93 Composition convenience had silently repurposed agent/session names

The final agent inventory exposed a more serious issue than missing exports. The
target used `AgentDefinition`, `AgentRunEvent`, `AgentResponse`, `AgentSession`
and related names for a smaller composition-root projection, while the current
package already assigns those names to the advanced definition, event loop and
stateful session. Restoring only names would either produce incompatible merged
interfaces or make existing code compile against the wrong lifecycle semantics.

Decision: preserve current advanced names and introduce `RuntimeAgentDefinition`,
`RuntimeAgentRunEvent`, `RuntimeAgentResponse`, `RuntimeAgentSession` and related
`Runtime…` option types for the composition projection. `runtime.agent()` consumes
the runtime definition and returns the simple runtime agent. `defineAgent()` keeps
one familiar entry point through overloads, so the split does not add another
factory users must discover. A same-source fixture now covers 27 restored and 15
signature-sensitive loop/mode/definition/session symbols against current and
target modules.

### 4.94 Team composition also required distinct legacy and runtime protocols

The same collision existed for `AgentTeamOptions` and `AgentTeamEvent`. Current
teams support local sessions, remote linked transports, quiet/wakeup delivery,
auditable mailboxes, defined static teams and dynamically managed worker teams.
The first target reduced those names to a runtime-owned local member list and a
small lifecycle event union. That would break harness and A2A authors while
appearing convenient in simple examples.

Decision: restore all 25 missing team/messaging names plus the two current
signature-sensitive team types. The composition-owned projection is now
`RuntimeAgentTeamOptions`/`RuntimeAgentTeamEvent`, still reached conveniently as
`runtime.team(...)`. A same-source fixture exercises linked transport, mailbox,
defined-team and managed-team construction without network execution. Target API
parity is now zero for core, agent and observability. This clears the machine API
precondition only; all P0 owner decisions remain pending and product source
migration remains unauthorized.

### 4.95 Compatibility overloads need a runtime discriminant

Keeping `defineAgent()` convenient for the new model-object grammar while also
preserving the current string/omitted-model grammar creates a runtime overload,
not only a TypeScript concern. Without a frozen discriminator, JavaScript callers
could receive a different definition shape after capability access or future
normalization changes.

Decision: a non-null own model-target object selects the runtime definition;
string or omission selects the advanced compatibility definition; all other
values reject synchronously before capability access. Both `defineAgent()` and
`cloneAgent()` remain side-effect free. The normal two-package journey calls
`runtime.agent()` with runtime input directly, so compatibility complexity does
not leak into getting started. The topology and checker now freeze this grammar.

### 4.96 The canonical declaration barrel was accidentally the public root

The design said the root should be curated and advanced authors should use
focused subpaths, but the compile contract mapped `@ai-agent-sdk/core` directly
to the canonical declaration file. Because that file owns every moved agent,
team, history and observability declaration, autocomplete at the basic root would
have exposed the entire 513-name canonical surface. The focused subpaths were
organizational aliases rather than real public-surface boundaries.

Decision: keep one internal canonical declaration/implementation owner, but map
the public root to a re-export-only facade. The facade preserves all 184 current
core-root exports and adds exactly 80 reviewed everyday composition names, for
264 exports total. A compile fixture proves normal runtime/tool/skill/report/log
imports remain on the root while `ManagedAgentTeam` and mutable `Observability`
remain focused-only. The checker freezes the exact root set, rejects duplicate
declarations, and rejects package-author declarations that import the broad root.
This is a contract/design correction only; no product package source changed.

### 4.97 The target topology silently omitted the existing auth `/env` route

The package plan and ADR repeatedly promised `@ai-agent-sdk/auth-node/env`, but
the machine topology and TypeScript paths exposed only the auth root and
`/codex`. This was not an unused alias: current unit, type, human and package
fixtures import `/env`. Implementing the 25-specifier map would therefore have
created an undocumented compatibility break even though the root intentionally
mirrors the same environment-only API.

Decision: retain `/env` as the 26th target specifier. It is a re-export-only view
of the same env factory owned by the root, while `/codex` remains the sole route
with the optional provider peer. A compile journey imports both forms and the
checker requires identical export names, one canonical declaration source and
an explicit core selection. No second auth implementation or extra runtime
dependency is introduced.

### 4.98 Abstract manifest policy did not prevent a wrong packaged facade

Topology required ESM, conditions and bounded subpaths, but it did not describe
the concrete export maps of multi-entry packages. An implementation
could satisfy those booleans while mapping core `.` back to its 513-name
canonical barrel, omitting a focused entry, adding a wildcard, or making auth
root load Codex transitively.

Decision: add machine-checked manifest blueprints for every multi-entry target:
core, auth-node, A2A, MCP, and observability-node. Core
has one curated root plus six explicit focused routes and no exported canonical
owner. Auth has root, `/env`, `/codex`, declares root and `/env` as identity
routes, and associates the optional provider peer only with `/codex`. MCP keeps
root and `/client` as client-only identity routes while `/server` alone requires
the optional `mcp-server` peer. A2A and observability-node retain their existing
role-specific subpaths. Every code
route carries `types`/`import`/`default`, `import` equals `default`, paths are
bounded under `dist`, `package.json` is explicit, and wildcard/`require` routes
are rejected. Root-only packages continue to follow the general manifest policy.

### 4.99 Machine approval did not bind the new topology dimensions

The Phase 0 JSON already froze `targetPackageCount`, but P0-03's newly precise
specifier and root-facade decisions existed only in prose. An approval could
therefore remain machine-green after losing `/env`, adding an accidental deep
route, or expanding root beyond 264 names.

Decision: add `targetSpecifierCount` and `coreRootExportCount: 264` to the
machine approval record and compare both against topology/root policy on every
contract run. The later retained-entrypoint audit expands the bound specifier
count from 26 to 32. These are approval guards, not approval itself; all fourteen
owner decisions remain pending.

### 4.100 Retained capability packages had no exhaustive API ledger

The zero-gap API statement covered only core, agent, base observability and the
four provider roots. It did not include A2A, auth, MCP, filesystem skills, wire
protocols or observation exporters. Several target declarations were taxonomy
placeholders with one to nine names even though their current public entrypoints
exported substantially more. A migration could therefore pass the existing gate
while deleting supported APIs.

Decision: freeze all 19 current public entrypoints for those eleven packages,
including declaration SHA-256 and exact export names. The baseline contains 344
export occurrences. It is derived from the current manifest export maps rather
than a hand-selected package-root list, and the checker rejects a lost or newly
unaccounted public route.

### 4.101 Package splitting must preserve established subpath routes

The first target topology kept only package roots for A2A, MCP and
observability-node. Current manifests also expose A2A `/client` and `/server`,
MCP `/client` and `/server`, and observability-node `/journal` and `/diagnostic`.
These are declared public exports, not unsupported filesystem deep imports.

Decision: expand the target from 26 to 32 specifiers and provide explicit
manifest blueprints for all five multi-entry packages. MCP `/server` becomes an
optional-peer compatibility view of `mcp-server`; normal MCP root and `/client`
selection stays client-only. The other five routes remain same-package views.

### 4.102 The initial retained-package target was missing 301 exports

Route preservation alone does not preserve API. Comparing the 344-entry baseline
against the union of each assigned target route finds 301 missing occurrences.
The gap includes nearly all A2A APIs, Codex auth operations, legacy MCP server and
Node-host utilities, wire protocol types, and exporter diagnostics. Some root
moves are intentional candidates under P0-07/P0-14, but none is approved yet.

Initial snapshot:

| Family | Current export occurrences | Missing in target declarations |
| --- | ---: | ---: |
| A2A root/client/server | 76 | 76 |
| Auth root/env/Codex | 82 | 78 |
| MCP Universal/Node | 61 | 42 |
| Filesystem skills | 6 | 0 |
| Responses/Anthropic protocols | 65 | 62 |
| Fetch/browser/Node/OTel observability | 54 | 43 |
| **Total** | **344** | **301** |

These are entrypoint occurrences, so a symbol intentionally re-exported by a
root and a focused subpath is counted in both. Implementation should restore one
canonical declaration/value owner and make subpaths re-export it; it must not
create hundreds of duplicate implementations to make the counter reach zero.

Decision: hash-lock the exact sorted `source-specifier:symbol` missing inventory
and keep Phase 0 API parity marked not ready. Implementation must restore the
same-specifier surfaces or add explicit approved migration records with
replacement imports and consumer updates. A constant missing count without the
hash is insufficient because one removed symbol could be exchanged for another.

### 4.103 Protocol marker adoption could have broken advanced authors

The initial target declarations reduced each wire protocol to one marker-based
object with only three public names. That made normal provider composition look
simple, but removed 62 established type/helper exports and risked repurposing the
marker-free generic `ProtocolDefinition`. Replacing the existing official value
with a second wrapper would also create identity and configuration ambiguity for
providers that re-export it.

Decision: restore all 31 Responses and 34 Anthropic current exports with their
advanced signatures. Keep `ProtocolDefinition` marker-free, add distinct
provider-specific runtime definition views carrying `kind`/`apiVersion`, and type
each official protocol constant as the intersection of both views. Thus one
object works for legacy authors and the composable HTTP provider. Same-source
fixtures compile against both current and target declarations, including wire
request unions, dialect controls, reasoning state, native tools, serialization
and streaming translation. Protocol missing counts are now zero; the aggregate
retained-package gap falls from 301 to 239.

### 4.104 Exporter factories could have silently replaced durability APIs

The initial Fetch, Browser and Node target declarations exposed only new
marker-based factory functions. They omitted the current exporter classes,
recovery/statistics methods, lifecycle hooks, error codes, Edge `WaitUntil`
helper and exact-wire diagnostic logger. Reusing the old class names for runtime
plugins would also be semantically wrong: advanced exporters exchange
`ObservationBatch`/`ExportAck`, while runtime plugins deliver atomic run records
through the distinct delivery batch/ack protocol.

Decision: restore all 54 export occurrences across Fetch, Browser, Node root,
Node `/journal`, Node `/diagnostic`, and OTel. Existing classes and lifecycle
helpers remain marker-free advanced APIs. The three new ergonomic factories are
explicit adapters to `ObservationExporterPlugin`, not renamed constructors or
same-name replacements. OTel retains its caller-owned synchronous
span/processor bridge, exact log record types, semantic-convention constant and
error class; it is not modeled as a batch exporter. Node subpaths re-export the
root canonical identities.

The diagnostic logger also exposed a focused-core omission: its public record
uses `JsonValue`, but `core/observability` did not re-export that canonical type.
Add `JsonValue` and `JsonObject` to the focused observability author view so a
capability package never needs the broad core root. A same-source fixture now
compiles all six current entrypoints against both current and target modules.
Observability capability missing counts are zero and the aggregate gap falls
from 239 to 196.

### 4.105 MCP route parity exposed same-name close and error repurposing

The split-package design correctly separated client and server dependency
closures, but its first declarations omitted 42 of 61 current MCP export
occurrences. More subtly, it changed `McpClientConnection.close()` from
`Promise<void>` to `Promise<McpCloseReport>` and changed `McpClientState.error`
from `Error` to a support-safe record. Both changes reuse existing names for new
semantics and break valid explicitly typed consumers even if common `await`
usage appears to compile.

Decision: preserve the advanced client class, constructor, `withClient`, connect,
refresh, OAuth, transport negotiation, bounds, result/error and
`close(): Promise<void>` APIs. Add ToolSource marker/snapshot fields on that same
connection object, but use distinct `closeWithReport()` and `supportError` names
for runtime evidence. `core/tools` now re-exports canonical `JsonValue` and
`JsonObject`, allowing MCP's focused package declaration to avoid broad core.

Universal server APIs move to `mcp-server`; Node server/host utilities move to
`mcp-node-server`. The established `mcp/client` route remains an identity view,
and `mcp/server` remains an optional-peer re-export view over `mcp-server`.
Current MCP and MCP-Node root server imports are explicit P0-14 migrations rather
than hidden client dependencies. The retained-package ledger lists each of the
six Universal and eight Node moved server exports explicitly; together with 39
auth moves it now guards 53 routed export occurrences rather than trusting union
parity alone. One compatibility source is compiled through
four aliases mapped first to current routes and then to the target client/server
owners, covering all current names and representative signatures. The checker
also resolves external SDK subpath imports to their declared package owner rather
than misclassifying them as undeclared packages.

All four current MCP entrypoints now have zero missing names. The aggregate
retained-package gap falls from 196 to 154; only A2A and auth remain.

### 4.106 Auth parity exposed two incompatible same-name upgrades

The first Auth target declaration made `envCredential()` return a non-callable
marker object even though the current result is a zero-argument string resolver.
It also redefined the established `CodexAuthStore` from `location/read/write` to
the generic revisioned `read/commit` contract. Name parity would have hidden both
breaks: existing provider options, custom secret stores, mutable auth-file code,
and direct callback assignments would stop compiling.

Decision: the environment factory returns one callable value intersected with
`CredentialSource`; `apiKeyFromEnv` remains the same deprecated factory identity.
The `auth-node` root and `/env` stay env-only and identity-preserving. The 39
Codex names formerly on the root remain explicitly routed to `/codex` under
P0-07 rather than pulling the optional provider into the root closure.

`CodexAuthStore` keeps its current blind contract. New revision-safe composition
uses the distinct `CodexCredentialStore`, `CodexRevisionedAdapterOptions`,
`fileCodexCredentialStore`, and Node provider-plugin surface. Existing adapter,
plugin, memory/file-store, OAuth, refresh, constants, mutable records, and Node
wrapper signatures remain available. A single source now compiles through four
Auth/provider aliases mapped once to current declarations and once to target
declarations. The normal Node harness selects the revisioned store; compatibility
code can still select the old store without falsely claiming compare-and-swap
guarantees.

All three current Auth entrypoints now have zero missing names. The aggregate
retained-package gap falls from 154 to 76, entirely the A2A root/client/server
surface. Product implementation is still unauthorized until P0-07 and the other
Phase 0 decisions receive owner approval.

### 4.107 A2A placeholders erased the complete public integration surface

The target A2A files originally exposed one invented `A2aAgentHandle` placeholder.
That omitted all 76 established export occurrences across root, `/client`, and
`/server`, including official SDK identities, endpoint and stream bounds, team
linking, request-context session ownership, server assembly, and explicit
executor disposal. A route existing in an export map was therefore not evidence
that its users could migrate.

Decision: `/client` canonically retains discovery, transports, `A2AAgentLink`,
linking, endpoint policy, and request/stream bounds. `/server` canonically retains
the official request/event/task identities plus DefinedAgent executor/card/server
adapters, isolation limits, error policy, and `dispose()`. The root remains the
established combined compatibility view rather than becoming a third owner.
Focused core imports use `/agent` and `/provider`; the external A2A SDK remains
the single exact dependency already declared by topology.

One representative source compiles against both the current three routes and the
target three routes, covering client construction/options and server disposal.
Together with the exact per-entrypoint export ledger, this reduces the final
retained-package gap from 76 to zero. This closes declaration design parity, not
Phase 0 authorization or packed/runtime implementation evidence.

### 4.108 Provider and filesystem checks still confused inventory with target proof

The 84-symbol provider baseline verified only that current declarations had not
changed. It never compared those names with target declarations, so the contract
reported a retained provider inventory while target packages actually omitted
24 names: 22 HTTP extension APIs and two Anthropic protocol types. The checker
now resolves every provider baseline symbol at its target package and rejects a
missing target owner. All 84 names are present again; deeper same-source provider
signature coverage remains a separate open audit item.

The filesystem-skill target also reused `fileSystemSkills()` for a marker-based
`SkillProviderPlugin`, replacing its current marker-free `SkillProvider` return.
Decision: preserve `fileSystemSkills()` and `discoverFileSystemSkills()` with
their current option/result contracts, and add `fileSystemSkillProviderPlugin()`
as the composition adapter. One source compiles against both current and target
declarations. This follows the same additive rule already applied to observation,
skill, Auth, MCP, and agent protocols.

### 4.109 Provider name parity still hid ten signature incompatibility classes

A same-source fixture across provider-http, OpenAI, Anthropic, and Codex exposed
breaks that the 84-name target check could not see: unmarked credential callbacks
were rejected, `WireProtocol` suddenly required runtime markers and synchronous
serialization, dynamic auth changed from positional arguments to an options
object, discovery changed `baseUrl` from string to URL and made its signal
required, catalog/options became readonly, and every official adapter widened
from `HttpModelAdapter` to `ModelAdapter`.

Decision: established extension contracts remain marker-free and source
compatible under `CredentialSource`, `WireProtocol`, `AuthScheme`,
`ModelDiscoveryContext`, `HttpProviderOptions`, and `createHttpProvider()`.
The stricter composition path uses distinct `RuntimeCredentialSource`,
`RuntimeWireProtocol`, `RuntimeAuthScheme`, `RuntimeModelDiscoveryContext`,
`RuntimeHttpProviderOptions`, and `createRuntimeHttpProvider()` names. The runtime
factory keeps ergonomic contextual typing for dynamic auth without an ambiguous
overload.

Official OpenAI and Anthropic adapters again accept existing callback credentials
and return `HttpModelAdapter`. Their plugin factories use overloads: legacy
options retain `ModelProviderPlugin`, while separately named provider options
require core `CredentialInput` and return a composable plugin with inert route
claims. Codex follows the same separation through legacy versus revisioned store
options. One source now compiles unchanged against all four current packages and
all four targets, including mutable option/catalog use and exact adapter result
types. This is declaration evidence; behavior and packed closure evidence remain
implementation-phase gates.

### 4.110 Provider install ergonomics lacked exact manifest and per-provider proof

The topology said normal users install core plus one official provider, but
machine evidence covered only OpenAI's minimal closure. The four provider roots
also had no exact export-map blueprints, so an implementation could retain the
right dependency graph while publishing a wrong ESM condition or missing package
metadata route.

Decision: exact manifest blueprints now cover provider-http, OpenAI, Anthropic,
and Codex in addition to the five multi-entry packages. Every provider root has
only `.` and `./package.json`, explicit `types/import/default`, identical ESM
import/default targets, no wildcard/CommonJS path, and no exported internal owner.

Separate minimal journeys prove OpenAI, Anthropic, and injected-store Codex each
require only direct `core + provider` selection. Their transport and protocol
packages remain transitive, all three stay Universal, and the only external
runtime dependency is the exact SSE parser owned by provider-http. The Universal
Codex recipe explicitly excludes auth-node. Independent closure assertions also
prove auth env-only remains core plus auth-node with no external dependency,
while selecting auth `/codex` adds exactly provider-codex, provider-http, the
Responses protocol, and the SSE parser.

### 4.111 Export blueprints did not fully specify dependency-section rendering

The nine checked blueprints froze public ESM routes, but a correct export map
could still be paired with an incorrect source manifest: core could remain a
normal dependency, an optional provider could omit `peerDependenciesMeta`, or an
external runtime package could move silently between dependency and peer
sections. P0-03 also still described only the five multi-entry blueprints after
the four provider roots had been added.

Decision: topology schema v5 now freezes the manifest-section encoding as well
as dependency ownership. Normal workspace implementation edges render as
`dependencies` with `workspace:^`; core renders as a required peer plus a local
development resolution; optional workspace peers render as peers with
`peerDependenciesMeta.optional`; exact external runtime dependencies resolve
through the strict catalog; and external peer APIs retain compatible peer ranges
plus exact development/catalog resolution. Every optional workspace peer must be
owned by at least one explicit public subpath, cannot also be a normal dependency,
and cannot elevate a package to an unclassified higher runtime. The checker also
rejects duplicate dependency entries and conflicting exact external versions.
At that audit point P0-03 was synchronized with those nine blueprints and this
topology-to-manifest render rule; section 4.114 closes the remaining single-entry
coverage.

The earlier closure assertions covered the three official providers and two auth
shapes but could miss drift in extended Edge, Browser observability, Node harness,
MCP routing, or extension-author recipes. `install-closures.json` now freezes all
24 journeys independently: complete workspace closure, required external closure,
and effective runtime. Optional peers remain absent until a journey explicitly
selects them. This makes dependency growth reviewable rather than allowing it to
hide behind an unchanged direct-import example.

### 4.112 Package capability metadata had no frozen vocabulary

The composition design promised non-executable `aiAgentSdk` metadata for release
and documentation checks, but topology recorded only runtime. Its singular
`capability` example was also insufficient for packages that intentionally own
two related roles, such as MCP client plus tool source, Node exporter plus
diagnostics, or credential source plus credential store.

Decision: each of the 18 packages now has an exact, nonempty `manifestRoles`
assignment selected from a checked 16-role vocabulary. Source manifests render
`aiAgentSdk: { runtime, coreApi: 1, roles }` directly from topology. This metadata
is descriptive only: runtime discovery, package scanning, and automatic plugin
loading remain forbidden. The checker freezes every package-to-role assignment,
rejects duplicate/unknown roles, and ensures the vocabulary has neither unused
nor undeclared entries.

### 4.113 One documented browser install was proved only by a larger closure

The package plan recommends a direct-browser BYOK recipe containing core,
OpenAI, and IndexedDB observations. The only Browser compile journey also
selected OpenTelemetry, so it could not prove that the advertised three-package
selection was independently usable or that the OTel peer was absent.

Decision: add a dedicated `browser-durable-minimal` compile journey using exactly
core, provider-openai, and observability-browser. It configures an owned bounded
IndexedDB exporter with the `local-durable` boundary, imports no OTel package,
and freezes a five-package transitive workspace closure plus only
`eventsource-parser@4.1.0` externally. At that audit point the closure ledger
covered 21 journeys; section 4.124 extends it to 23. The checker also parses the
public `pnpm add` blocks in the
package plan and requires each package set to equal its associated compile
journey, so prose cannot silently add a facade, omit core, or expose a transitive
support package as a normal user choice.

### 4.114 Single-entry packages still relied on export-map convention

Blueprint coverage had grown around the highest-risk roots—providers and
multi-entry packages—but nine single-entry support/capability packages still had
no exact output map. A wrong `.js` versus `.mjs` target, missing `import`
condition, or omitted `./package.json` export could therefore survive design
review until the post-migration pack gate.

Decision: extend `manifest-blueprints.json` to all 18 target packages. The two
wire protocols, MCP server and Node transports, filesystem skills, Fetch/Browser
exporters, and OTel bridge now have the same explicit `types/import/default` and
package-metadata routes as the previously covered packages. Node packages use
`.mjs`/`.d.mts`; Universal and Browser packages use `.js`/`.d.ts`. The checker
derives the exact output basename from each public route and rejects swapped or
arbitrary targets in addition to requiring blueprint owners to equal the full
topology package set. No new package can enter the target graph without an exact
export map.

### 4.115 Type declarations did not protect the installed CLI surface

The retained API ledgers freeze TypeScript exports, but `auth-node` also exposes
the `ai-agent-sdk-codex-login` executable. Export-map parity alone could drop its
`bin` mapping or omit the `bin` directory from packed files while every compile
contract remained green. The same manifest gap applied to base packed files,
root `main`/`types` compatibility fields, and Node engine placement.

Decision: manifest policy now freezes `dist`, `README.md`, and `LICENSE` for
every package; adds `bin` only to auth-node; preserves the exact
`ai-agent-sdk-codex-login` to `./bin/ai-agent-sdk-codex-login.mjs` mapping;
mirrors root import/types targets into legacy `main`/`types` fields; and applies
Node `>=22.12` only to packages classified Node. The checker compares the binary
mapping with the current package so this non-TypeScript public surface cannot
disappear before migration evidence exists. Publishing remains out of scope.

### 4.116 Provider authors had contracts but no install recipe

Three compile journeys already proved Responses-compatible HTTP, custom HTTP
wire, and direct non-HTTP provider authoring. The package plan nevertheless gave
copy-paste installation commands only to application users. This made the
extension-kit packages look like unexplained transitive internals and weakened
the goal that providers attach to core as approachable plugins.

Decision: document three explicit author paths. Responses-compatible packages
select core, provider-http, and protocol-responses; custom HTTP wire packages
select core plus provider-http; direct non-HTTP packages select core only. The
checker binds each command to its existing compile journey and frozen closure.
Together with the provider-author recipes, all twelve documented `pnpm add`
commands are machine-checked. A finished provider's consumers still install
only core plus that provider; support packages remain transitive.

### 4.117 I1/I2 named source moves but not an executable ownership transition

The implementation ledger said to move base observability and agent domains into
core, but it did not freeze the exact source inventory or define how its checker
should transition. A partial directory move could strand relative imports, copy
an implementation into both packages, or leave 37 current self-importing files
pointing back through the public core package boundary. Treating the existing
low-level `core/src/observation` contracts as the destination would also collapse
two useful internal layers and collide with its barrel.

Decision: `source-migration.json` now freezes all 56 files: seven base-
observability files and 49 agent files, with exact sorted-list hashes. Base bus,
logger, privacy, projections, and advanced exporters move to the distinct
`core/src/observability` implementation layer; the existing
`core/src/observation` contracts/ports stay lower-level. Agent preserves relative
paths under `core/src/agent`.

The map records 6 observability and 31 agent files whose public-core imports must
become relative internal imports, a dependency-first order for all 12 agent
groups, zero target collisions, and I1 before I2. Each root has a checked
`pending | moved` state. A moved state requires every baseline file at the target,
zero core/self-bridge package imports, an acyclic target, and its exact
route-complete source bridge containing only re-exports to canonical core
subpaths. Observability has one root entrypoint; agent has `.` plus
`./skill-validation`. The state
machine forbids agent moving before observability and avoids deleting or weakening
the baseline merely to let implementation start.

### 4.118 Root-only API and generic bridge rules missed a live agent subpath

The current agent manifest and build config expose
`@ai-agent-sdk/agent/skill-validation`, and `skill-filesystem` imports it. Its
declaration owns `validateCandidate` and `validateSkillResourcePath`; neither is
present in the agent root declaration. Therefore the former 415-root-symbol
inventory was not the complete public package API, and replacing agent source
with only `src/index.ts` would break an existing internal consumer even though
root parity remained green.

Decision: expand the authoritative migration ledger to 417 occurrences and
hash-lock the subpath declaration. Both functions now route to
`@ai-agent-sdk/core/skills` and a same-source fixture compiles against the current
subpath and target declaration. `source-migration.json` now defines exact bridge
entrypoints rather than a generic file count: observability keeps only `.`, while
agent keeps `.` and `./skill-validation` until mandatory I7 deletion. Each
temporary manifest must remain private, ESM, side-effect-free, depend at runtime
only on core, add no peer/optional dependencies, and expose exact conditional
routes after the move. The removed-package inventory also maps every observed
legacy specifier to its canonical replacement and rejects an unowned new route.

### 4.119 The default supply-chain command is not fully local

The root `check:supply-chain` script first performs deterministic manifest,
lock-integrity, lifecycle-script and production-license checks, then invokes
`pnpm audit` against the registry unless `--skip-audit` is present. In an
AI-automated audit this can wait on external network and violates the existing
manual-only classification for external-network evidence.

Decision: record `check:supply-chain` as a command hazard in the machine policy.
AI-safe verification uses
`node scripts/check-supply-chain.mts --skip-audit`; this does not claim advisory
coverage. The registry-backed vulnerability result remains an explicit manual
gate. The local-only run currently passes 390 lock integrity records, three
production license expressions, and all lifecycle/version rules with zero
findings.

### 4.120 The full Node harness masked package-local runtime elevation

The closure ledger proved the full Node harness was Node, but that selection
contains auth, stdio MCP, filesystem skills, and Node observability together. A
wrong runtime label or hidden transitive dependency on any one package could
remain invisible because another selected package still elevated the aggregate
journey. The generic `Universal + Node = Node` rule was therefore stronger than
its package-by-package evidence.

Decision: extend `install-closures.json` with 17 independent probes—every
retained non-core package selected directly beside core. Each probe freezes its
complete transitive workspace set, required external dependency/peer set, and
effective runtime. This proves, among other cases, that filesystem skills and
Node observability independently elevate to Node with no third-party runtime
dependency; browser observability independently elevates only to Browser; fetch
observability remains Universal; and selecting each official provider keeps a
Universal closure while pulling only its HTTP/protocol implementation plus
`eventsource-parser`. Optional auth/MCP server peers remain absent until their
specific routes are selected.

### 4.121 The recommended Node harness bypassed skill-plugin API preflight

The target capability policy distinguishes the preserved marker-free advanced
`SkillProvider` from the independently versioned `SkillProviderPlugin` used by
normal runtime composition. However, the main Node harness fixture still called
`fileSystemSkills()`. That remained type-compatible because runtime skills
intentionally accept the legacy surface, but it meant the flagship plugin
example did not exercise the family/API marker it requires third-party plugin
authors to implement.

Decision: keep `fileSystemSkills()` and its current signature intact, but use
`fileSystemSkillProviderPlugin()` in the target Node harness. The former remains
the advanced compatibility route and retains its same-source dual compile; the
latter becomes the recommended high-level composition route and is now a
machine-checked harness invariant. This preserves existing users without making
the easiest new example bypass version preflight.

### 4.122 Required external peers were counted but not install-checked

Install closures intentionally include both transitive runtime dependencies and
required external peers. The documented recipe checker, however, compared only
workspace packages. `browser-observability` therefore compiled and its closure
correctly listed `@opentelemetry/api@1.9.1`, while no checked `pnpm add` command
required the application to select that peer directly. This could produce a
missing-peer install despite a green closure report.

Decision: journeys now declare exact direct external selections separately from
workspace package selections. The checker derives every required external peer
from the full workspace closure and demands an exact match, while transitive
runtime dependencies remain absent from the user's command. A ninth checked
recipe installs core, the provider, Browser/OTel observation packages, and the
exact OTel API peer. The optional logs peer stays absent unless a logger-specific
route is selected.

### 4.123 Tool-source terminology drifted from the authoritative declaration

Normative design and implementation text still named the plugin contract
`ToolSourceV1`, while the target declaration exposes `ToolSource` with a literal
`apiVersion` marker. No `ToolSourceV1` symbol exists. Package authors following
the prose would therefore import a nonexistent name even though MCP journeys
compiled against the declaration.

Decision: standardize the public term on `ToolSource`; its family version is
`TOOL_SOURCE_API_VERSION`/`apiVersion: 1`, not a type-name suffix. Update package,
design, TODO, and audit text, and make the contract reject reintroduction of a
`ToolSourceV1` declaration. Official MCP connections continue to implement the
versioned `ToolSource` directly without an adapter wrapper.

### 4.124 Two retained packages had no direct composition journey

The 17 package-local closure probes covered dependency and runtime metadata, but
`protocol-anthropic-messages` appeared in application journeys only transitively
through the official Anthropic provider, and `mcp-node-server` appeared in none.
Name parity and a transitive closure do not prove that a package author's public
entrypoint can actually be imported and composed.

Decision: add compile-only journeys and checked recipes for an Anthropic
Messages-compatible provider and a Node stdio MCP server host. The Node hosting
package now re-exports `createMcpServer` and its public definition/server types
from its normal Universal `mcp-server` dependency; applications install and
import only core plus `mcp-node-server`, while the implementation layer stays
transitive. The checker now requires the union of direct journey selections to
cover all 18 target packages. The closure ledger consequently grows from 21 to
23 journeys and the documented recipe set from nine to eleven; section 4.125
adds the explicit runtime-team A2A path, reaching 24 and twelve respectively.

### 4.125 A2A could not compose with the new runtime team

The design promised an optional Node A2A transport for teams, but the target
`RuntimeAgentTeam` exposed only local `session()`/`run()` operations, while
`linkA2AAgent()` accepted only the preserved legacy `AgentTeam`. Existing A2A
name parity and dual-compilation remained green because they exercised only the
legacy signature. The first-class A2A package therefore had no callable bridge
to the new composition root.

Decision: add `linkAgent()` and bounded `sendMessage()` to
`RuntimeAgentTeam`, and widen target `linkA2AAgent()` through the structural
`A2ALinkableTeam` contract accepted by both team generations. Remote messages
run under the existing `team-operation` lease; `session()`/`run()` stay local.
Links and transports are borrowed: unlink is synchronous/idempotent, team or
runtime close removes routing but never closes caller transport resources. A new
core-plus-A2A compile journey and twelfth install recipe prove this path without
executing network code.

### 4.126 Package roles did not identify the recommended callable path

Runtime metadata and the package taxonomy said what each package owned, but they
did not bind a new user's normal factory to a typed slot and lifecycle rule. A
package could keep the right role and export count while renaming its usable
factory, exposing only an advanced constructor, or drifting from borrowed to
owned semantics. Individual journeys covered common combinations but did not
form a complete package-to-entrypoint inventory.

Decision: topology now freezes one recommended public entrypoint for every one
of the 17 non-core packages, including its exact specifier, symbol, typed
composition point, application-versus-authoring audience, and ownership model.
The checker resolves each symbol from the target declaration and compares the
whole mapping exactly. This makes the normal routes explicit—from provider
plugins and filesystem skills through MCP host/client, observation exporters,
credentials, protocols, and A2A—without introducing a generic plugin array.

### 4.127 Documentation cleanup had no phase-tracked migration contract

The source inventory could reach zero while public Markdown continued teaching
the removed agent, base-observability, Node, or unscoped facades. The release-doc
checker only verified that a referenced package exists in the current workspace,
so it could not distinguish an intentional historical mention from a stale
install/import example. Replacing every match immediately would also be wrong:
the target product exports do not exist before I1–I5, while ADRs and API
baselines must preserve old names as evidence.

Decision: add a separate three-step documentation migration state with exact executable
surface parsing for fenced blocks, inline code, and install commands. The pending
baseline currently covers four removed-package route families and 27 classified
Markdown files. Each file has one disposition: rewrite at I6, delete with its
facade at I7, mark the prior design superseded, or retain as a migration record.
`active-guides-migrated` requires both human journeys to reach their target and
keeps facade READMEs present; `complete` requires those READMEs to disappear with
I7. Both post-I6 states reject legacy examples outside their allowed records and
also require core's agent/logger ergonomics plus the recommended composition import
in every retained package README. This closes both halves of the failure mode:
stale facade guidance and packages that technically exist but remain hard to use.

### 4.128 Export presence did not prove that the preferred API composes

All 17 recommended symbols existed in their target declaration, but the checker
did not require a consumer to import the preferred route, select that package
directly, or place the returned value in its advertised typed slot. This hid two
real ergonomics gaps: the Node env journey used the compatibility `/env` route
instead of the recommended auth root, and Universal `mcp-server` had no direct
Web host journey even though Node hosting consumed its constructor through a
transport-package re-export.

Decision: bind every recommended entrypoint to an exact compile fixture and
package-specific wiring fragments. The proof now covers provider registration,
protocol-to-adapter composition, MCP client ownership, Universal and Node server
hosting, skills, observation exporters/processors, credentials, and A2A team
linking. Normal env composition imports the auth root while a separate fixture
retains `/env` identity. A new core-plus-`mcp-server` Request/Response host raises
the matrix to 25 journeys and 13 install recipes without adding a Node package.

### 4.129 MCP server lifecycle labels collapsed inert and resource-owning hosts

The recommended map labeled both `createMcpServer()` and `serveMcpStdio()` as
`host-owned`. The Universal value only exposes a Web `handle()` method and has no
cleanup resource, while the Node transport returns a real close handle. The
existing Node proof returned that handle but never compiled the close/report
path. A user could therefore read the same ownership label as either “nothing to
close” or “caller must close”, exactly the ambiguity the package split is meant
to remove.

Decision: classify the Universal server as `inert-host-mounted`; the host owns
where it is mounted but receives no fabricated cleanup API. Keep the Node stdio
server `host-owned` and require its proof to call bounded `close({ signal })`,
observe `deadlineReached` and `unsettledRequests`, then return the structured
report. The package guide now states both lifecycles explicitly.

### 4.130 Versioned capability authors lacked correlated logging contexts

The target already injected `SdkLogger` into model, tool, and hook execution,
but credential sources/stores, memory stores, skill providers, tool sources, and
provider setup received only operation data or cancellation. Core could observe
the outer call, yet an extension could not add internal structured diagnostics
to the same correlation tree without capturing an unrelated logger. This made
the “application/plugin logs use one bus” claim incomplete.

Decision: require a runtime-bound logger in five versioned contexts: provider
setup registrar, credential operation, tool-source snapshot, skill-provider
operation, and memory-store operation. The author fixture compiles real logger
use for every context, with canonical `SdkLogger` re-exported from focused skill
and memory author paths. Core still emits start/terminal/support-safe failure
evidence independently, and logs never become accounting truth. Correlation is
runtime-owned; credentials, content, and raw errors remain forbidden fields.
Exporter plugins receive no logger because that would recurse through the active
export path; the observation bus records exporter health/failures externally.

### 4.131 Caller-owned integration bootstrap escaped runtime correlation

The flagship Edge and Node fixtures connected MCP before constructing
`AgentRuntime`. That order ensured a pre-opened connection could be closed if
runtime construction failed, but it also made connection, authentication, and
initial catalog discovery happen before the runtime-bound logger existed. A
failure at the most operationally fragile boundary could therefore be absent
from the same trace/health path used by the subsequent agent run. MCP server and
A2A target declarations likewise had no uniform logger rule, so package authors
could fall back to an unrelated logger or implicit console output.

Decision: recommended runtime journeys now construct runtime first, connect or
link the caller-owned integration inside its lifetime guard, and pass a bound
child logger explicitly. If runtime construction fails no integration exists; if
connection fails the runtime is still closed. Nested cleanup attempts runtime
quiescence first and then integration teardown even when the first cleanup path
fails. Optional logger fields preserve direct standalone MCP/A2A compatibility,
where omission is supported and enables no console sink. The machine contract
checks both client journeys, Universal/Node server hosts, and A2A client/server
fixtures, while keeping correlation runtime-owned and accounting in terminal
records rather than logs. A six-family/27-operation evidence matrix prevents an
implementation from satisfying the contract by logging only connection setup:
it also covers authentication, catalog/reconnect attempts, client/server calls,
streaming, unlink, cancellation, disposal, and close without recording content.

### 4.132 One integration logger cannot represent both lifecycle and active runs

Passing `runtime.logger()` at MCP/A2A construction fixes bootstrap visibility,
but that logger is scoped before any agent run or team send exists. Reusing it
for later MCP tool calls or A2A messages would produce apparently correlated
events without the active run/span or team-operation identity. The acceptance
design also required visible tool progress and correlated lifecycle evidence but
did not distinguish those user-facing and operational channels, so a UI could
pass by inferring activity from final text while the underlying integration log
remained incomplete.

Decision: freeze separate correlation sources. MCP connection/auth/reconnect uses
the connection-option logger, while snapshot/tool execution uses the logger from
the runtime-owned tool context. A2A link/card lifecycle uses its option logger;
`RuntimeAgentTeam` guarantees an active logger on the additive-optional
`LinkedAgentSendInput.logger`, retaining direct legacy transport compatibility.
Server request loggers are children of the configured host logger, while embedded
agent work keeps its own run context. Human acceptance now independently checks
public tool timelines, lifecycle and physical-attempt records, active-operation
correlation, no content leakage, no token double counting, and cleanup evidence.

### 4.133 The shared integration cleanup rule was not proved for A2A

The new caller-owned policy said runtime work must quiesce before integration
teardown, but only MCP fixtures compiled that order. The A2A proof returned an
unlink handle and stopped there. This was especially ambiguous because runtime
team close already removes the borrowed link while deliberately not owning any
transport resource; “close the integration” could be misread as either unlinking
the roster twice or shutting down a caller-injected client.

Decision: retain the existing ownership distinction. Runtime/team close removes
routing but never closes caller transport resources; the returned unlink is
synchronous and idempotent. The recommended A2A fixture closes runtime first and
calls the additive `unlinkWithReport()` in `finally`, proving quiescence and
support-safe caller cleanup without inventing transport ownership. The existing
`unlink()` remains available. Any injected transport client with its own resource
lifecycle remains outside runtime and must be closed by its original owner under
that client's contract.

### 4.134 Post-runtime teardown cannot be proved by a runtime logger

The integration matrix initially required close/unlink/dispose operation logs
after the runtime had quiesced and closed. But runtime close also flushes and
shuts down the observation bus, and the design correctly makes every retained
runtime logger a no-op afterward. The two requirements were impossible to satisfy
together without either closing MCP/A2A too early or adding a generic cleanup
service locator to core.

Decision: keep core thin and preserve the safe ownership order. Runtime-active
integration operations use start/terminal/error logs; caller-owned teardown after
runtime close uses bounded idempotent capability reports. MCP clients already
have `McpCloseReport`; Node MCP server close gains support-safe error evidence;
A2A adds `A2AUnlinkReport`/`A2ADisposeReport` and reported methods while retaining
its existing void methods. The Universal Web MCP server remains inert. Human and
deterministic gates retain each capability report beside `RuntimeCloseReport` and
explicitly reject a post-close runtime log as teardown evidence.

### 4.135 Free-form logger fields did not prove logical/physical call pairing

The 27-operation matrix named required events, but `SdkLogger` still accepted an
arbitrary `JsonObject`. One package could emit `operation_id`, another `callId`,
and a third omit retry identity or terminal duration entirely while all target
declarations compiled. That would make “every physical attempt is visible” a
prose claim rather than a queryable cross-package contract.

Decision: add `IntegrationOperationEvidenceFields` on the focused
`core/observability` authoring surface, not the curated core root. The union
distinguishes logical start, attempt start, attempt terminal, and logical
terminal; attempt rows require stable ID and one-based number, terminal rows
require status and finite non-negative duration. Family/operation values are
bounded to 64 characters; IDs/error codes to 128; logger messages are static and
contain no user data. A compile-only author proof exercises all four variants,
while implementation tests must still enforce bounds, balanced cardinality and
the no-content policy at runtime.

### 4.136 Failed MCP connect rollback could hide the primary failure

The current `connectMcpHttp()` and `connectMcpStdio()` correctly construct a
client, await connect, and attempt `close()` on failure. But the cleanup await is
inside the catch path: if it rejects, that teardown error replaces the original
transport/authentication/handshake/catalog failure, and no connection or cleanup
report reaches the caller. The runtime-first fixture then closes runtime but
cannot recover evidence from the lost partial MCP generation.

Decision: the target connected convenience factories use bounded
`closeWithReport()` rollback and reject with `McpConnectionError`. The error
contains a stable support-safe stage/failure plus the independent
`McpCloseReport`; cleanup never replaces the primary failure. Both the Universal
client route and Node stdio route re-export the error for normal composition.
Advanced constructed-client/manual-connect APIs retain their lower-level behavior.
Deterministic implementation tests must inject connect plus rollback failure,
timeout, abort and repeated-close cases before this is considered achieved.

### 4.137 A valid log envelope still did not prove a complete trace

The existing logger filters debug before allocating an observation event; info
is normal priority and can be evicted by queue pressure. Its unit test confirms
that debug disappears at the default info threshold. Meanwhile
`ObservationDeliverySummary` reports critical checkpoints, not every normal log.
Thus even a typed integration envelope and `delivery.complete: true` could hide
missing start/attempt evidence. The original health type has no integration-level
filter counter and is frozen by same-source compatibility checks.

Decision: leave that advanced type intact and add
`RuntimeObservationHealthSnapshot` to runtime diagnostics/close with cumulative
accepted, filtered, dropped and rejected integration evidence counters. Required
starts/successes use info, failures error. Count recognizable records before
filtering and never treat enqueue acceptance as acknowledgment. Complete trace
requires independently verified operation/attempt pairs, exact event-ID delivery,
and teardown reports; zero loss counters or a critical checkpoint alone is
insufficient. The diagnostic ring remains an evictable support view, not an audit
log. The author proof compiles loss inspection; deterministic target-runtime
filter/queue/ack/overflow tests remain implementation exit evidence.

### 4.138 Consumer compilation skipped invalid declaration bodies

Running the design contract with `skipLibCheck: false` exposed five missing
focused exports: `ModelModality`, `ModelReasoningInfo`, and `ProviderRequestId`
on core/provider; `ObservationPort` and `SafeErrorRecord` on core/observability.
HTTP and OpenTelemetry target declarations imported these names, but ordinary
consumer compilation had silently skipped the invalid imports.

Decision: re-export the existing canonical types without widening the curated
264-name root. Add strict declaration-body checks for the entire mixed Node
surface and a separate ten-package Web/Browser base with `types: []`. Both pass.
Keep the legacy consumer config for compatibility comparisons; it is not enough
to establish declaration validity by itself.

### 4.139 Universal MCP declarations still require a Node global

The strict full-Web target check fails on two `Buffer` references in the local
2.0.0 upstream MCP client/server declarations. This is a type-portability failure,
not evidence that their emitted HTTP runtime necessarily imports Node. The mixed
Node check passes because Node types legitimately exist in that environment;
it cannot certify Edge consumers. A2A remains Node-classified and is not included
in this Web check.

Decision: keep a separate full-Web check and exact two-diagnostic unresolved
baseline, printed as BLOCKED by the contract checker. Do not inject Node typings,
invent ambient Buffer shims, or disable declaration checking to claim success.
P0-12/I8 must choose an upstream correction or reviewed portable type boundary,
preserve compatibility, and remove this debt only after strict Web compilation
passes. Packed runtime acceptance remains independent and unexecuted here.

### 4.140 Type portability needs a dependency-boundary fix, not a new helper

Both local MCP 2.0.0 root declarations explicitly import and export `ReadBuffer`;
its shared-stdio declaration has `append(chunk: Buffer): void`. The upstream
public export maps have root, stdio, validators and shim routes, but no HTTP-only
type route. Our client and server declarations reference those roots, so an HTTP
consumer still validates the stdio declaration. Type-only aliases or choosing a
different factory within the same SDK declaration cannot cut this dependency.

Decision: design 10.4.1 prefers an upstream correction while preserving the
18-package/32-specifier SDK layout. A portable owned boundary is a separately
reviewed fallback, not permission to erase advanced APIs or class identity.
No installed-dependency edit, private deep import, new Web facade, or Node ambient
shim is accepted as proof. The two diagnostics remain open.

Resolution audit (2026-09-05): the SDK-owned portable boundary was selected
after a patch spike proved package-manager patches do not propagate to installed
tarball consumers. Runtime code stays on MCP 2.0.0, but emitted SDK declarations
no longer import its client/server roots. Strict full-Web and NodeNext target
checks pass; an isolated tarball consumer passes with `types: []` and
`skipLibCheck: false`; upstream Node `Buffer` parsing and packed
Node/Chromium/Workerd journeys pass. The diagnostic patches were removed. Thus
4.139–4.140 remain the discovery record, while this evidence closes the debt.

The earlier mixed Node declaration check inherited Bundler resolution. A separate
local run with NodeNext passed; the checked Node configuration now freezes
NodeNext explicitly, while existing consumer checks retain Bundler coverage.
Workspace path mappings still bypass installed package export maps. Final I8
acceptance must compile installed ESM consumers with no workspace paths, Web
conditions separately, strict declaration checking and zero diagnostic waivers.

### 4.141 Scripted research evidence was overstated as agent autonomy

The human acceptance design and Edge README said the hermetic test proved
instruction-driven deep search. In the current source, `deepSearchResponse()`
chooses search/read/audit/report transitions with branches, `researchTopics()`
recognizes only two fixture topics, and `audit_research` maps supplied corpus URLs
to those topics without verifying read receipts or semantic sufficiency. The
unit test fixes the exact six-call/two-audit sequence. This is useful deterministic
SDK/UI coverage, not proof that a real model interpreted instructions or developed
an adaptive plan. Historical counts and native-search URL lists alone cannot
prove source reading or report quality either.

Decision: correct those claims, classify scripted evidence separately from
research autonomy/quality, and retain the target instruction-driven design. The
application must not adopt the emulator's scheduler. Add read-receipt provenance,
independent assessment and non-prescribed model-action acceptance criteria to
the human-test design. Existing 16/16 historical results stay valid within their
original narrow scope; no live provider or historical spike is rerun here.

## 5. Remaining decisions and evidence

The package/lifecycle design is broad enough that no third architecture document
is required. The machine public API inventory and root-facade freeze is complete,
but full-Web declaration portability still has the two MCP issues in 4.139,
and the owner has approved the design with the per-agent default-model amendment. The
authoritative owner checklist is
[`core-capability-phase0-approval.md`](./core-capability-phase0-approval.md).
The following grouped **entry decisions** are approved:

1. public API and composition grammar: P0-01, P0-02, P0-05, P0-06, P0-10;
2. package/compatibility ownership: P0-03, P0-04, P0-07, P0-08, P0-11, P0-13, P0-14;
3. diagnostics and supported runtime gates: P0-09 and P0-12.

The exact-target-package declaration matrix now compiles seven direct consumer
journeys, official-protocol HTTP, custom HTTP extension, direct-adapter and all-
official-factory provider-author journeys, a two-instance provider journey, and a core-only
skill/memory/exporter/tool-source author
journey. It also checks typed stream/tool/usage
projection, attempt/model-call/run accounting, per-run exporter records, stable
tool-call identity, negative API contracts, explicit exporter ownership, borrowed MCP
closure order, runtime elevation, and all four removed-package inventories. It is a
owner-approved v1 compile contract, not evidence of implemented runtime behavior.

Its topology companion now covers the complete eighteen-package retained target
map rather than only packages exercised by those journeys.

The core-ownership parity ledger reports **zero preserved symbols missing** at
core, agent root, agent skill-validation, and base-observability target routes.
The retained-package ledger is
now complete by name: zero of 344 export occurrences are absent from their assigned
targets. All fourteen P0 decisions now have explicit owner attribution and timestamp;
I0 approval is no longer a blocker. The provider-default amendment is included
in target declarations, fixtures and composition design 4.1.1.

The following are **post-change exit evidence**, not blockers to starting the
source phase that creates them:

1. reusable conformance testkit runs against the merged target runtime;
2. packed target tarballs, conditional exports, runtime metadata, recursive peer
   closure, and emitted-import audits pass;
3. post-merge bundle/heap/diagnostics measurements pass and re-freeze budgets;
4. both human consumers use their recorded target package selections;
5. manual Edge/provider and deep-research acceptance succeeds through the target
   API, with visible tool progress, usage, correlation, and final report evidence.

The existing [`implementation-todo.md`](./implementation-todo.md) remains useful
evidence for the current architecture, but it is not the execution ledger for
this package migration.

## 6. What to copy from Mastra — and what not to copy

Current Mastra material confirms the useful product pattern: `@mastra/core`
contains the central orchestration object and the normal agent/tool primitives,
while storage, memory, observability, MCP, sandboxes, and concrete backends can be
installed and passed into that composition root. Examples commonly add only the
capabilities a feature needs, such as `@mastra/memory` plus `@mastra/libsql`.

References:

- [Mastra core package](https://github.com/mastra-ai/mastra/blob/main/packages/core/README.md)
- [Mastra coding-agent composition](https://mastra.ai/blog/introducing-create-coding-agent-helper)
- [Mastra storage composition](https://mastra.ai/blog/mastra-storage)
- [Mastra observability composition](https://mastra.ai/blog/introducing-feedback-and-feedback-analytics)

This project should copy the discoverability and central composition root, not
Mastra's exact dependency surface. Mastra core includes workflows, memory, MCP,
server, storage, voice, and browser bases and targets Node 22 in its repository.
Our requirement is stricter: the minimum agent package must remain Edge-safe, so
concrete persistence, filesystem, process, server, and stdio implementations stay
outside core.

Mastra's release guidance also recommends keeping its related packages on the
same release channel. That validates the need for explicit capability/core
compatibility checks here rather than assuming semver deduplication will protect
the runtime.

A June 2026 public issue in the Mastra repository reported malicious package
versions in its npm scope. That report is a threat-model input, not evidence that
monorepos or plugins are inherently unsafe. The actionable controls here remain:
small dependency closures, exact ownership, lockfile/integrity review, provenance
when publishing is eventually authorized, no install scripts, and the ability to
replace small dependencies such as the SSE parser.

Reference: [Mastra repository security report](https://github.com/mastra-ai/mastra/issues/18044)

## 7. Audit gates

Product migration is now owner-authorized. Each phase may start only after its **entry** evidence and
owner decisions pass; it may finish only after its **exit** evidence passes.

| Gate | Entry evidence/state | Exit evidence still required | Scoped phase |
| --- | --- | --- | --- |
| D1 | owner-approved shape and exact-package journey matrix compile, including model defaults | approved public snapshot exported by implemented target core | core merge |
| D2 | rollback/close fault injection passes | merged-runtime rerun | composition root |
| D3 | ADR, provider fault/pack, Universal/Node skill and Universal exporter packs pass | reusable target-runtime testkit | external capability contracts |
| D4 | AST-inspected baseline and negative runtime bundles pass | relocated packed conditional exports/import closure | package relocation |
| D5 | sampled size/heap baselines and provisional budgets pass | target tarball measurement and budget re-freeze | core export expansion |
| D6 | metadata privacy/eviction spike passes | merged-core default diagnostics tests | base logging merge |
| D7 | acceptance design, offline Edge, historical Node research pass | target package graphs plus manual direct Edge provider/research acceptance | facade/consumer migration |
| D8 | historical provider usage/correlation evidence passes | manual acceptance through the frozen target API | provider API freeze |

## 8. Spike evidence — 2026-09-02

The audit-only prototype source was removed after implementation and coverage
migration. It never modified or exported product source; the following retained
reports describe the historical measurements.

Hermetic evidence: 5/5 tests passed for composition, authoritative accounting,
rollback, owned shutdown, required model target, diagnostic eviction, idempotent
close, and rejection of new work after close.

Authenticated Codex evidence:

- catalog models: 9;
- call status: success;
- usage: 155 input, 11 output, 166 total;
- coverage: 1 complete, 0 partial, 0 missing, 0 possibly billed without usage;
- observations: 18 events, healthy before close, no exporter/processor failure;
- content privacy assertions: prompt, instructions, and completion absent;
- close: no deadline, no unsettled runs, no provider cleanup failure, observation
  state closed.

Support-safe artifact:
`.temp/core-capability-spike/4ee35d5da67ab1770b23a7b7113ea543/report.json`
(mode `0600`). It stores response length/hash, not response content.

Additional executable evidence:

- the now-removed frozen declarations and two consumer journeys compiled against
  the proposed public API;
- 5/5 composition tests pass, including unsupported API rejection before setup
  or observation allocation;
- isolated bundle report at `.temp/core-capability-benchmark/report.json` records
  11,982-byte gzip contracts and 62,928-byte gzip basic-agent bundles, zero
  external imports/Node built-ins, 64 strict-Worker runs, 384 authoritative tokens,
  32 retained diagnostics, and 864 evictions. Inspector samples record 915,692
  bytes for the contracts peak and 6,041,364 bytes for the basic-agent peak, with
  a 4,749,400-byte basic-agent delta; the 4/16/8 MiB sampled budgets pass;
- current Edge and Node behavior reports pass, while the topology checker reports
  two target migrations pending.
- `.temp/core-capability-provider-conformance/report.json` proves a locally packed
  third-party-style provider with scripts disabled, bounded core peer range,
  API/runtime metadata, valid stream ordering, complete usage, normalized
  cancellation, and idempotent cleanup. It does not yet exercise a packed future
  `AgentRuntime` because that artifact does not exist.
- `.temp/core-capability-skill-conformance/report.json` proves packed external
  Universal and Node skill providers installed with scripts disabled. The
  Universal closure is 22,310 raw/7,525 gzip bytes with zero external/Node
  imports and passes strict workerd discovery, lazy activation, resource,
  traversal, candidate-ownership, abort, and portable redirect checks. The Node
  closure reads a confined directory and its Edge-negative bundle exposes
  `node:fs/promises` and `node:path`. Both values carry the proposed
  skill-provider API marker; the target core-only peer remains pending.
- `.temp/core-capability-exporter-conformance/report.json` proves a packed
  external Universal observation exporter with scripts disabled. Its 10,330-byte
  gzip strict-Worker closure has zero external/Node imports, preserves usage while
  excluding prompt/token content, retries idempotently, validates ack identity,
  propagates abort, rejects API mismatch before execution, and shuts down once.
  The paired 4,122-byte gzip native-fetch negative proves current
  `observability-fetch` uses `redirect: 'error'`, which workerd rejects; the mock
  packed matrix had not exercised that host behavior.
- `.temp/core-capability-edge-live/report.json` is a mode-`0600` negative live
  artifact. The 80,676-byte gzip provider bundle contains `eventsource-parser`,
  no external import/Node builtin, and runs with `Buffer`/`process` unset. Dynamic
  discovery is empty; workerd rejects `redirect: 'error'`; the policy-equivalent
  fixture shim reaches the Codex endpoint but receives Cloudflare HTML HTTP 403.
  The provider maps it to `AUTH`; the audit records those as separate facts. The
  temporary credential binding is mode `0600`, absent from process arguments/artifacts, and
  removed after the run.
- `.temp/core-capability-mcp-composition/report.json` is a mode-`0600` packed
  audit artifact. It reproduces the current session snapshot loss, composes and
  dispatches two real stdio MCP sources, proves live caller-owned close,
  collision/API fail-closed behavior, and runs native MCP HTTP in Workerd with
  Node globals unset. The redirect target is contacted once and receives only a
  synthetic fixture header before final-origin rejection; the no-follow branch
  independently reproduces Workerd rejecting `redirect: 'error'`.
- `.temp/core-capability-auth-closure/report.json` is a mode-`0600` packed
  package-manager artifact. It records the current six-package env-only closure,
  the staged two-package/zero-external target, root and `/env` execution, an
  actionable missing optional-peer failure, and explicit full-Codex construction
  with no login, network call, credential read, or credential write.
- `test-human/results/human/core-capability-node-deep-research/summary.json`
  records the successful control: seven native searches, 28 unique URLs across
  five domains, a 22,071-character report, accepted deep completion, and two
  fully accounted HTTP-200 provider attempts totaling 76,856 tokens.

The implementation-stage benchmark, since retired after its evidence was
recorded, used AST parsing and a built-in minified-syntax
self-test. After correcting the former regex blind spot, the contract and
basic-agent benchmark bundles were regenerated and still report zero external
imports/Node built-ins; the retained live Edge provider bundle was re-inspected
with the same parser and also remains clean.

## 9. Ongoing audit protocol

Every implementation phase ends with a fresh audit, not merely a checkbox pass:

1. compare the package graph and public API snapshot with this matrix;
2. automatically run only static graph/import checks, compile-only contracts,
   and deterministic fault/privacy/accounting tests;
3. after product source exists, run deterministic packed consumer checks that do
   not contact a provider or external network;
4. record live provider/Edge/browser journeys as explicit manual acceptance gates;
5. record evidence and any new risk in the implementation ledger;
6. do not advance while a regression is explained only as “tree shaking should
   remove it” or “the host should remember to close it.”
