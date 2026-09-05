# ADR 0002: Core, Capability Packages, and Runtime API Compatibility

Status: **Approved — owner accepted Phase 0 with per-agent model-default amendment on 2026-09-04**

Date: **2026-09-02**

Approval record: [`../core-capability-phase0-approval.md`](../core-capability-phase0-approval.md)

## Context

The SDK must support a minimal Web Standards agent, a full Node coding harness,
and third-party providers/capabilities without making users install a global
environment edition. The current `@ai-agent-sdk/node` facade hides 17 workspace
dependencies, while the current split between core, agent, and observability
forces normal users to assemble canonical runtime identities manually.

Package semver alone cannot protect an application from a bundled or incorrectly
resolved capability built against an incompatible core contract. Conversely, a
single generic plugin registrar would hide capability-specific readiness,
ownership, and runtime requirements.

## Decision

The owner approved P0-01 through P0-14. Each runtime agent may choose its own
model; omission may use an explicitly configured provider default. Explicit
agent choice wins, ambiguous defaults require a selected runtime provider route,
and neither core-owned model defaults nor automatic error failover are introduced.
The complete resolution/compatibility contract is in composition design 4.1.1.
This approval does not authorize npm publication or automated live/spike runs.

### Consumer packages

The target product surface is:

| Package family | Target role | Runtime |
| --- | --- | --- |
| `@ai-agent-sdk/core` | complete basic agent, tools, usage ledger, bounded base diagnostics | Universal |
| scoped provider packages | explicit model provider plugin | Universal unless documented otherwise |
| `@ai-agent-sdk/mcp` | remote MCP client/tool source | Universal |
| `@ai-agent-sdk/mcp-server` | Web Standards MCP server hosting | Universal |
| `@ai-agent-sdk/mcp-node` | stdio MCP client transport | Node |
| `@ai-agent-sdk/mcp-node-server` | stdio and Node HTTP MCP hosting | Node |
| scoped skill packages | typed skill source/provider | declared per package |
| scoped auth packages | explicit credential store/resolver; optional provider subpaths do not pull unrelated providers | declared per package |
| scoped observability packages | exporter/durability capability | declared per package |
| `@ai-agent-sdk/a2a` | A2A integration | classified by its actual dependency closure |

The unpublished `@ai-agent-sdk/agent` and `@ai-agent-sdk/observability` source
ownership moves into core. The global `@ai-agent-sdk/node` facade is removed.
The unscoped `ai-agent-sdk` facade is removed unless a repository consumer audit
proves a temporary compatibility need.

Feature-specific runtime suffixes such as `mcp-node` and `auth-node` remain: they
identify both the capability and its environmental requirement. No replacement
`full`, `node`, or `batteries` package may silently reinstall the entire graph.

### Composition model

Normal usage is exactly one core runtime, one or more explicit provider plugins,
and typed capability values:

```ts
const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
  observability: {
    mode: 'reliable',
    exporters: [{
      exporter: remoteExporter({ endpoint }),
      ownership: 'owned',
      requirement: 'required',
      boundary: 'remote-acknowledged',
    }],
  },
})

const agent = runtime.agent({
  id: 'assistant',
  model: { provider: 'openai', id: 'gpt-5.4' },
  instructions: 'Help the user.',
  skills: [remoteSkills],
  memory: { store: remoteMemory, key: sessionKey, requirement: 'required' },
  toolSources: [remoteMcp],
})
```

There is no catch-all capability array and no package scanning or automatic
registration. Auth stores enter provider factories, exporters enter
observability, skills enter skill slots, and MCP contributes typed tools/resources.
Independently opened async connections remain explicitly owned by the caller.

### Runtime API versions

Core exports independently versioned integer API constants, initially:

```ts
export const PROVIDER_PLUGIN_API_VERSION = 1 as const
export const CREDENTIAL_CAPABILITY_API_VERSION = 1 as const
export const SKILL_PROVIDER_API_VERSION = 1 as const
export const MEMORY_STORE_API_VERSION = 1 as const
export const OBSERVATION_EXPORTER_API_VERSION = 1 as const
export const TOOL_SOURCE_API_VERSION = 1 as const
```

Every package-supplied executable protocol includes its family marker. Core
validates provider markers before allocating an owned observation bus or calling
any plugin `setup()`, exporter markers before bus construction, credential
sources/stores before resolution or I/O, memory stores before binding/load, and
skill providers before agent/catalog construction.
Unsupported, absent, hostile, or throwing markers fail with:

```text
code = CAPABILITY_API_UNSUPPORTED
```

The error includes only support-safe capability id/kind and expected/received
integer versions. It never includes plugin configuration or credentials.

The constants are family-scoped so a breaking skill-provider change does not
invalidate model providers or exporters. This applies even when a protocol has
no `setup()` method: a skill provider or exporter still executes package code
across a versioned method boundary. Plain inert values such as messages, inline
skill definitions, schemas, and tool definitions do not receive decorative
version fields; their TypeScript/runtime validation is their contract. Core
authoring helpers stamp markers on executable values.

Type-level readonly markers are insufficient against post-validation JavaScript
mutation. Each family helper returns a new frozen wrapper and does not mutate or
freeze its input. Runtime preflight then captures marker, version, ID, immutable
configuration, and public method references in a private frozen handle for both
helper-created and direct implementations. Identity and method properties are
not reread after validation; optional lifecycle methods and returned cleanup are
captured immediately. Calls preserve the implementation receiver so capability-
owned operational state can evolve, while dynamic data becomes visible only via
family methods at documented snapshot boundaries. This is deterministic
composition behavior, not a sandbox for hostile proxies or installed code.

Normal application documentation imports `@ai-agent-sdk/core`. Advanced and
third-party authors may use only these bounded subpaths: `/agent`, `/tools`,
`/skills`, `/memory`, `/observability`, and `/provider`. Deep internal imports
are unsupported, and core does not grow integration/runtime-specific subpaths.

The package root is a curated view, not the canonical internal barrel. The v1
contract preserves all 184 current core-root exports and explicitly adds 80
everyday composition exports, for an exact 264-name facade. One internal
canonical module owns declarations and runtime identity; the root and six
focused subpaths only re-export it. Package-author declarations must use the
focused subpath for their capability family, preventing accidental reliance on
unrelated root compatibility exports.

### Package compatibility

Official capabilities declare:

1. a bounded peer range on `@ai-agent-sdk/core`;
2. an exact workspace development dependency on core;
3. non-executable `aiAgentSdk` manifest metadata with capability kind, runtime,
   and core API version;
4. no install/postinstall scripts;
5. no second bundled copy of core runtime identity.

Optional subpaths must not add unrelated closures. `@ai-agent-sdk/auth-node/env`
peers on core but does not install `provider-codex`; the package declares Codex
as an optional peer for `/codex`, and the Codex Node recipe explicitly installs
both `auth-node` and `provider-codex`. The root export is env-only and does not
re-export `/codex`, preventing ESM resolution from turning an optional peer into
a startup requirement.

Peer ownership is transitive across support layers. A provider may have normal
dependencies on `provider-http` and a wire protocol, but any such package that
imports core runtime values declares the same bounded core peer instead of a
normal core dependency. Only a package proven to import core types exclusively
may omit that peer. This prevents a helper package from installing a second core
identity behind an otherwise correct provider manifest.

Packed official closures must prove exactly one physical core resolution and no
provider/support bundle may embed core implementation. Public re-export routes
preserve canonical runtime value identity. Runtime API markers communicate
family compatibility but do not prove module identity.

Cross-package protocol validation is nevertheless structural rather than
nominal. `ModelAdapter` inheritance is an authoring convenience, not an
`instanceof` admission gate, and foreign errors retain only a bounded validated
own-data failure envelope whose inner and outer codes agree. Invalid data becomes
`UNKNOWN`. Core does not install a process/global/Symbol duplicate detector:
official duplication is a package/pack failure, while global registration would
couple otherwise independent applications and still fail across realms.

`provider-http` owns an independently versioned `http-wire-protocol` structural
contract and a marker-stamping `defineWireProtocol()` helper. Protocol objects
remain pure and endpoint/credential-free but retain executable path, protocol
header, serialization, and stream-translation methods. Configurable HTTP
providers preserve header/dynamic auth, injected fetch, bounded discovery,
retry/transport controls, and extension diagnostics; reducing this package to a
bearer-only adapter would make the public provider plugin ecosystem nominally
open but practically official-only. Current provider-http/OpenAI/Anthropic/Codex
exports are frozen in a separate 84-symbol preservation baseline.

Wire serialization in v1 is synchronous and JSON-object-only. The HTTP adapter
validates and deep-detaches the result, encodes it once as part of the prepared
logical-call generation, and reuses identical bytes across retries. Invalid or
oversized graphs fail before any provider attempt. Supporting text, multipart,
bytes, or upload streams later requires a separately versioned body contract;
the v1 surface does not use `unknown` as an implicit `BodyInit` escape hatch.

The response side remains SSE-specific in v1. `provider-http` validates
`text/event-stream`, owns the exact-pinned parser, bounds bytes/raw chunks/event
characters/event count, and resets a single idle deadline on raw body activity so
comment heartbeats work. Protocol packages translate decoded events but do not
own transport reconnection. Exactly one final `finish` is required; truncated EOF
is a failure and automatic retry remains forbidden after visible output.

Official provider packages are the normal composition boundary. Installing core
plus one provider brings HTTP/protocol support transitively, while the preferred
provider factory retains all adapter-specific configuration and adds declarative
instance/route claims. Omitted routes infer `[id ?? family]`, making multi-account
composition possible with one ID per account. Factories are inert until runtime
setup; advanced adapters remain compatible exports. Provider-instance cache hints
such as Codex `promptCacheKey` are not session or tenant boundaries.

Additive packages do not collapse into one plugin lifecycle. Skills return lazy
borrowed providers, MCP connect functions return caller-closed tool sources, and
exporter registration states ownership. OpenTelemetry remains a caller-owned
`openSpan + processor` bridge because synchronous span parentage cannot be
reconstructed faithfully as a batch exporter. Core's high-level observability
options accept these callbacks and bounds directly, while the host retains OTel
provider flush/shutdown responsibility. Runtime tier elevation follows only the
selected capability package.

The advanced `core/observability` route preserves the current marker-free,
caller-owned bus and correlated schema-v1 event/resource/batch/ack contracts.
Those existing names are not reused for a different runtime protocol. Recommended
exporter factories instead return `ObservationExporterPlugin`; high-level runtime
delivery uses `ObservationDeliveryBatch`, `ObservationDeliveryAck`, and
`RuntimeObservationExporterRegistration` for markers, readiness, atomic run
records, acknowledgment identity, and explicit ownership. A compile contract
checks the current observability module against this target subpath.

HTTP header composition uses disjoint case-insensitive ownership layers for
transport, SDK attribution, wire protocol, endpoint static configuration, and
authentication. Cross-layer collisions fail rather than overwrite. Transport/
SDK names are reserved, endpoint static credentials are forbidden, and all
authentication-produced names are sensitive by provenance for diagnostics.
Credential headers are captured atomically with one prepared logical-call
endpoint; physical retries reuse that generation and a new logical call resolves
afresh. They are never forwarded across an origin, and redirect policy is
validated before every hop.

The high-level runtime exposes immutable provider rows and typed model-catalog
snapshots; callers do not receive the mutable registry. Catalog states distinguish
static, fresh, successful-empty, stale, and unavailable data, while explicit
model targets remain valid without discovery membership. Dynamic cache is scoped
to provider plugin instance plus route, uses per-key single-flight with isolated
caller abort, never replaces last-good data with failure, and keeps failure
backoff separate from success TTL. Different accounts compose as distinct
provider instances/routes rather than credential-derived cache keys.
Runtime discovery does not overload one provider string: it emits one row per
route with the exact model-target `route`, owning `pluginId`, and grouping
`family`. Adapter `ProviderInfo.id/name` remain route/display compatibility
metadata. Official packages freeze family; custom plugins default family to
plugin ID. Runtime catalog snapshots carry the enriched row so Web pickers can
correlate multiple accounts without mutable-registry access or credential keys.

During `0.x`, official packages supporting one core minor use a bounded peer
range such as `>=0.2.0 <0.3.0`. Runtime API markers protect bundled/deduplicated
cases that package-manager peer checks cannot see.

Provider topology setup remains synchronous and transactional. Async credential,
filesystem, discovery, or network work is explicit/lazy and cannot occur in
`setup()`.

The normal composition root accepts only composable provider plugins with inert
route claims. It validates all plugin IDs and routes before any setup method is
looked up or invoked. The named helper gives setup a claim-scoped registrar,
requires exact claim coverage, and rejects registrations or replacements outside
the snapshot. The legacy route-in-setup plugin remains an advanced-registry
compatibility surface and does not receive the stronger preflight guarantee.

Provider registry cleanup is also synchronous and removes topology before calling
the captured disposer. The recommended `defineModelProviderPlugin()` grammar uses
`undefined` return types so TypeScript rejects accidental async setup/cleanup;
the preserved direct interface remains source-compatible and runtime rejects and
contains any Promise/thenable result. Registrar handles are sealed when setup
returns. A shared close deadline may skip and mark a provider timed out before
cleanup starts, but cannot preempt synchronous JavaScript already executing.
Asynchronous owned resources use explicit capability lifecycles outside the
provider registry.

All runtime-owned asynchronous work is admitted through one typed operation-lease
registry. Agent runs, model-catalog refreshes, manual compaction, and local-team
operations combine caller cancellation with the runtime root signal and their
deadline. `close()` atomically stops admission, aborts the root, waits for leases,
seals unsettled generations so late continuations cannot publish, and only then
disposes provider topology. Its fixed per-kind report rows are authoritative;
legacy run totals are projections of the agent-run row. Immutable topology,
terminal diagnostics, and the close report remain readable afterward, while
executable entry points reject and bound loggers become closed no-op views.
The first close invocation starts one shared irreversible task. Its caller signal
may end quiescence early but never cancels cleanup or rejects that task; repeated
calls join it, and the report records settlement, timeout, or caller abort.

Skill providers and memory stores passed through agent/session slots are always
borrowed in v1. Memory bindings use either conversation scope with a canonical
versioned tuple key or explicitly shared fixed scope. Session binding/disable
overrides the agent default. Snapshots retain only a support-safe binding ID and
resume requires an exact binding match before store I/O; raw key/namespace and
store handles remain reinjected and never serialized or exported.

Skill discovery returns an opaque catalog revision with bounded candidates.
Locators are JSON-safe; core creates exact revisioned references and persists
only those references for activated skills. Resume validates reference schema,
bounds and provider identity, then requires provider validation before load or
resource I/O. Stale/unavailable references fail closed rather than silently
loading current behavior, and raw locator/resource content is never diagnostic or
snapshot data.

Live tool sources expose one synchronous revisioned snapshot operation for core
composition. Core invokes it once per source/invocation, validates bounded full
definitions, and captures schema/executable references from that single
generation. Refresh is source-owned and only affects the next invocation;
snapshot failure has no stale fallback. Terminal records contain source ID and
revision only. A direct MCP `.tools` catalog may remain for compatibility but is
not a core composition input.

Local tools remain marker-free core leaf definitions for inline ergonomics, but
are executable rather than inert. `defineTool()` creates a detached frozen view;
runtime applies the same capture to direct literals at agent/session binding.
Bounded schema and parse/execute/render/meta/timeout/concurrency references come
from one generation, retain the original receiver, and are never reread or
redirected by later caller mutation.

Approval/user-input brokers, interceptors, turn hooks, and usage estimators use
the same marker-free leaf principle. Agent/session binding captures readonly
runtime-used methods with their receivers and detached bounded configuration.
Caller objects are not frozen and interactive/stateful operational state remains
live, but post-bind method replacement cannot redirect policy or accounting.

Provider-native tools preserve the merge-extensible core schema map and typed Web
Search/Image Generation definitions. Bounded deeply detached JSON-safe configs
flow through agent input and `GenerateOptions` to protocols; model explicit
capability metadata is an allowlist. Native execution/progress stays distinct
from host tool scheduling/approval, and content payloads remain caller-stream
data rather than default observation export.

Topology schema v5 freezes the Universal Web Platform feature baseline, Browser
additions, and Node 22.12 minimum. Runtime construction preflights Universal
features before plugin access/allocation; core uses one internal platform adapter
for clocks, random IDs, and timers, adds no public host locator/polyfill layer,
and never falls back to `Math.random` for runtime identity.

### Conformance

A dev-only testkit, not a core runtime subpath, will validate third-party
providers/capabilities from a packed consumer project. Minimum provider checks:

- API marker validation happens before setup;
- setup is synchronous, side-effect bounded, and transactionally rolled back;
- routes and ids are valid and collision-safe;
- cancellation settles promptly;
- stream ordering and terminal finish are valid;
- usage coverage is honest and missing usage is not projected as zero;
- observation correlation and metadata privacy hold;
- cleanup is idempotent and support-safe.
- no-redirect behavior is equivalent in Node, workerd, browser, and Deno even
  where `redirect: 'error'` is rejected by the host;
- explicit model metadata and dynamic/empty/failed discovery are tested
  independently;
- provider-native tool events remain distinct from host tool execution events;
- a primary provider failure is not replaced by a secondary missing-usage error.

Deterministic privacy evidence uses structural field assertions or unique
sentinels outside generated ID alphabets. Short whole-report substring checks are
forbidden; a focused rerun may classify an ID collision but cannot erase the
initial suite failure or substitute for fixing the test oracle.

Each executable capability suite also rejects absent/mismatched family markers
before calling methods. The skill-provider suite covers bounded discovery, lazy
activation/resource reads, issued-candidate ownership, traversal, cancellation,
and both a strict-Worker Universal package and a visibly Node-elevated filesystem
package.

Every Universal HTTP capability suite also delegates at least one request to the
host's native fetch; injected mocks alone cannot prove `RequestInit` portability.
Provider, exporter, remote-skill, and MCP HTTP tests share the no-follow invariant:
portable manual redirect handling plus explicit rejection of every observable
redirect/origin escape before contacting the next hop. MCP additionally proves
that an unallowed redirected origin cannot receive capability headers. The
tool-source suite composes two live MCP catalogs, rejects collision/API mismatch
before dispatch, and observes reconnect/close on the next invocation without
snapshotting at agent construction. The observation-exporter suite additionally proves that
privacy processing precedes export and canonical usage fields survive it.

## Security consequences

Smaller explicit dependency closures improve reviewability but do not eliminate
supply-chain risk. Exact dependency ownership, lockfile integrity, packed-content
inspection, provenance after publication is authorized, and dependency
replaceability remain separate gates. A project generator may add recommended
packages, but the generated manifest stays explicit and auditable.

## Rejected alternatives

- A global Node/full facade: convenient initially, but hides optional packages and
  recreates the current supply-chain and runtime-boundary ambiguity.
- One generic `Plugin` interface: erases capability-specific lifecycle semantics.
- Automatic package discovery: executes ambient installation state and makes
  startup non-deterministic.
- Peer dependencies only: cannot detect every bundled or duplicated runtime.
- A thin public kernel plus agent package: makes the common installation harder
  and repeats the current product problem.

## Evidence required to accept

- the detailed v1 shape fixture and exact-target-package Edge/Node consumer
  matrix compile; the latter now covers five minimal/capability-rich consumer
  journeys, a third-party provider-author journey, and a two-account provider
  composition journey, plus typed stream/tool/usage projection, correlated safe
  errors/health, physical-attempt/model-call/run accounting, atomic per-run
  exporter reports, runtime elevation, facade inventory, rollback-safe borrowed
  resource examples, and explicit exporter ownership; a core-only author journey
  compiles skill-provider, optimistic memory-store, observation-exporter, and
  live tool-source values; the topology covers all
  eighteen retained target packages and their dependency/peer/runtime tiers;
- the 417-symbol core/agent/observability API migration baseline—415 root exports
  plus two agent `skill-validation` subpath-only exports—matches current generated
  declarations; all symbols preserve by default and the sole proposed
  removal is tied to P0-02 with explicit replacement/migration guidance;
- target parity reaches zero at the assigned specifiers; the current frozen
  inventory is ready (core root 0, agent root 0, agent skill-validation 0,
  observability root 0), while Phase 0 remains
  pending the explicit owner decisions;
- incompatible markers are rejected before provider setup in a hermetic test;
- a real provider succeeds with the same v1 marker wrapper;
- bundle/Worker and packed capability fixtures pass; current packed provider,
  Universal/Node skill, and Universal observation-exporter fixtures now pass,
  while the merged-runtime/core-only-peer rerun remains required;
- the owner approves package removals and the absence of a global Node facade.
- all applicable P0-01 through P0-14 decisions carry explicit owner approval.

Live/provider evidence is a bounded acceptance gate. Automated review of this ADR
uses static manifests/imports, compile-only contracts, and deterministic tests;
historical spike reports are retained, while their superseded executable source
has been removed.
