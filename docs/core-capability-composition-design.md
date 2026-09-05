# Core Composition and Capability Lifecycle Design

Status: **Approved for staged implementation — includes owner-requested per-agent model defaults**

Last reviewed: **2026-09-04**

Parent proposal: [`core-capability-package-plan.md`](./core-capability-package-plan.md)

This document closes the implementation-level gaps found while auditing the
`core + provider + capabilities` package proposal against the current source.

## 1. Audit verdict

The package direction is sound, but the parent proposal alone is not deep enough
to implement safely. Moving files without this companion design would preserve
four current usability problems:

1. `defineAgent()` and the higher-level `runAgent()` path currently default
   silently to Codex, `gpt-5.6-luna`, and medium reasoning effort, even though
   the proposed core must be provider-neutral.
2. `AgentSession` currently requires callers to supply `ModelRegistry` and may
   receive a different observation port from the registry. Merely merging npm
   packages would not create one easy composition path.
3. provider cleanup is synchronous, while observation exporters, MCP connections,
   teams, and process adapters have asynchronous shutdown semantics. Ownership
   and shutdown ordering are not interchangeable.
4. merging `core`, `agent`, and base `observability` changes exports, bundle size,
   package peer relationships, and runtime identity. Those contracts need explicit
   gates rather than relying on tree shaking or workspace deduplication.

The required additional design areas are therefore:

- one core composition root;
- per-agent model overrides with explicit provider-configured defaults, never core-owned model defaults;
- capability-specific composition plus explicit lifecycle ownership;
- one canonical base-observability instance per runtime;
- package/API compatibility metadata and version policy;
- core subpath and bundle budgets;
- a staged source/package migration map;
- conformance tests for external capabilities.

## 2. Fixed design principles

1. `@ai-agent-sdk/core` is the only required framework package.
2. Core remains Universal and has zero third-party runtime dependencies.
3. A model provider is required before an agent can run.
4. Core never reads environment variables, local credential files, or global
   provider configuration.
5. Capabilities implement typed contracts; there is no universal service-locator
   plugin interface.
6. Runtime ownership and capability functionality are separate concepts.
7. Runtime-specific behavior enters only through explicit imports and values.
8. One application runtime owns one model registry and one observation bus unless
   the caller explicitly supplies borrowed instances.
9. Core shutdown is bounded and idempotent.
10. Package installation never performs registration or executes application code.

## 3. Core composition root

### 3.1 Why a composition root is necessary

The current low-level pieces are strong but require manual assembly:

```text
ModelProviderPlugin -> ModelRegistry
AgentDefinition + ModelRegistry -> AgentSession
Observability -> ModelRegistry and AgentSession separately
```

The public API needs one owner that assembles those canonical instances and
prevents accidental split tracing/accounting.

The proposed public concept is `AgentRuntime`:

```ts
export interface AgentRuntimeOptions {
  readonly providers: readonly ComposableModelProviderPlugin[]
  readonly signal?: AbortSignal
  readonly resource?: ObservationResourceInput
  readonly observability?: {
    readonly mode?: DeliveryMode
    readonly content?: 'none' | 'metadata'
    readonly exporters?: readonly RuntimeObservationExporterRegistration[]
  }
  readonly closeTimeoutMs?: number
  readonly startupTimeoutMs?: number
}

export interface AgentRuntime {
  agent(definition: RuntimeAgentDefinitionInput): RuntimeAgent
  team(options: RuntimeAgentTeamOptions): RuntimeAgentTeam
  diagnostics(): DiagnosticSnapshot
  close(options?: { readonly signal?: AbortSignal }): Promise<RuntimeCloseReport>
}

export function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime>
```

The exact exported names can change during API freeze, but these semantics are
normative:

- callers await construction so rollback may await owned observation shutdown;
- a caller signal aborted before construction fails during preflight without
  setup, method access, or ownership transfer; later abort uses the same
  transactional rollback path as timeout/failure;
- provider topology setup itself stays synchronous and transactional using the
  current `ModelRegistry.install()` behavior;
- async network/file work stays lazy or belongs to explicit capability factories;
- the runtime injects the same registry and observation instance into every
  session it creates;
- runtime construction fails atomically if any provider cannot install;
- already-installed providers are disposed in reverse order when construction
  fails;
- registry and observation instances remain internal canonical identities rather
  than public mutable escape hatches;
- `close()` is async, idempotent, bounded, and produces a structured report.

### 3.2 Runtime-bound agents

`defineAgent()` remains useful for immutable, reusable definitions. A definition
does not own providers, secrets, open connections, or observation exporters.

```ts
const definition = defineAgent({
  id: 'assistant',
  model: { provider: 'openai', id: 'gpt-5.4' },
  instructions: 'Help the user.',
})

const agent = runtime.agent(definition)
const result = await agent.generate('Hello')
```

`RuntimeAgent` is the ergonomic execution surface:

```ts
export interface RuntimeAgent {
  createSession(options?: RuntimeAgentSessionOptions): RuntimeAgentSession
  generate(input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  stream(input: string, options?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle
}
```

`observability.mode` is the explicit delivery contract. Omission means
`operational`; `reliable` and `audit` require at least one non-`none` required
exporter. Exporter order and requirement flags never implicitly select a mode.

`generate()` and `stream()` create an isolated ephemeral session. Multi-turn
applications use `createSession()` explicitly.

Every run created through a runtime-bound agent, including a run on a persistent
multi-turn session, is registered with the runtime while active. Closing the
runtime aborts/waits those active runs within its deadline. Persistent session
objects become unusable for new runs after their runtime closes; their snapshots
remain valid data that another compatible runtime may resume.

The existing low-level constructors may remain exported from advanced subpaths,
but normal documentation must not ask users to construct a registry or pass the
observation bus twice.

## 4. Provider and model binding

### 4.1 Remove provider-specific defaults from core

The normal composition path must not inherit the following current defaults from
`AgentDefinitionInput` and `DEFAULT_AGENT_CALL_CONFIG`/the high-level run path:

```text
provider = codex
model = gpt-5.6-luna
effort = medium
```

Provider-neutral core cannot select a provider package that the application may
not have installed. Every bound agent must resolve to a complete model target;
the owner-approved amendment permits omission at runtime binding when the
application has explicitly configured a provider default:

```ts
export interface ModelTarget {
  readonly provider: string
  readonly id: string
}

export interface RuntimeAgentDefinitionInput {
  readonly model: ModelTarget
  // ...agent behavior
}
```

The current advanced `AgentDefinitionInput` name remains source-compatible during
the package move and is not the normal composition contract. The object-model
overload of `defineAgent()` produces `RuntimeAgentDefinition`; the legacy
provider/model-string overload produces `DefinedAgent`. Normal documentation uses
only the first form. `DEFAULT_AGENT_CALL_CONFIG` remains the one proposed removal
because retaining that value would advertise a core-owned Codex default.

The runtime discriminant is deliberately structural and unambiguous: an own
`model` value that is a non-null `{ provider, id }` object selects the runtime
definition path; a string or omission selects the preserved advanced path; every
other value is rejected synchronously before capability access. Both overloads
are side-effect free and return detached frozen definitions. `cloneAgent()` uses
the same rule. Most users bypass this distinction entirely because
`runtime.agent({ model: { provider, id }, ... })` accepts the runtime input
directly; the overload exists for reusable definitions and compatibility, not as
an extra required setup step. `runtime.agent()` additionally accepts
`RuntimeAgentBindingInput` with an omitted model or a route-only `{ provider }`.
Do not make `defineAgent({ model: undefined })` select the runtime overload:
omitted-model reusable definitions remain the legacy compatibility path.

### 4.1.1 Per-agent selection and configured defaults (owner amendment)

Each agent independently selects its model; a runtime/provider default does not
lock all agents to one model. Official provider factories accept
`defaultModel: 'model-id'` when the plugin claims exactly one route, or a complete
`{ provider, id }` target naming one of its claimed routes. Generic composable
providers expose only the canonical complete `defaultModel?: ModelTarget`.
There is no hard-coded model choice in core or a provider factory.

Resolution at `runtime.agent()` binding is deterministic:

1. A complete agent `model: { provider, id }` always wins.
2. An agent's route-only `model: { provider }` uses the default configured for
   that exact route. It never falls back to a different account or provider.
3. An omitted agent model uses `runtime.defaultProvider` when configured, otherwise
   the unique explicitly configured provider default across the runtime. Zero
   defaults is missing configuration; multiple defaults without a selected route
   are ambiguous. Registration order, catalog order and family names never decide.

Defaults are optional; multiple providers without defaults are valid when agents
select full targets. Configured defaults must have nonblank bounded IDs and claim
their route. A runtime default route must exist and own a configured default.
Validate/capture these locally before setup; do not perform network discovery
during construction or synchronous agent binding. A factory string with multiple
claimed routes is rejected; use the complete target form instead.
An explicit invalid model/route is never silently replaced by the default.
Unknown remote model availability follows the existing catalog/dispatch contract;
a failure does not trigger another model choice.

Resolve and freeze the target at agent binding, expose it through `agent.model`,
and expose configured route defaults through `runtime.providers()`. Changes to
caller-owned options or later catalog refresh cannot redirect a bound agent.
Sessions/snapshots retain the resolved target and existing identity checks;
resuming does not silently reapply a new default. Different team members retain
their own bound model. Attempt/usage records always identify the actual target.

This is an omission default, not error failover. Retries keep the resolved model;
automatic model switching on rate limits, network errors, cost or capability
mismatch requires its own explicit policy and is not introduced here.

```ts
const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey, defaultModel: 'general-model' })],
})
const assistant = runtime.agent({ id: 'assistant', instructions: 'Help the user.' })
const researcher = runtime.agent({
  id: 'researcher', instructions: 'Research the request.',
  model: { provider: 'openai', id: 'research-model' },
})
```

The IDs above are illustrative, not claims about available provider models.
The compile-only minimal Edge and multi-account fixtures exercise omission,
explicit per-agent overrides, route-only defaults and explicit runtime route
selection. Real resolution/error/accounting tests remain I3/I4 implementation work.

A `provider/model` string shorthand may be added only if model identifiers with
slashes are unambiguous. The object form remains canonical in serialized
definitions and snapshots.

Reasoning effort remains an optional agent override, but omission must reach
`ModelRegistry.prepareCall()` as omission. The adapter may then apply the exact
model generation's declared default and report that it supplied the value.
Core must not materialize `medium` before model resolution; some providers or
models do not support that effort at all.

### 4.2 Provider package API

Official provider packages continue returning the existing transactional plugin
behavior through the declarative composition shape:

```ts
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
})
```

Provider construction must remain side-effect free. Network requests, OAuth
refresh, catalog discovery, and credential resolution occur only when explicitly
called or when a model operation starts.

`createAgentRuntime()` accepts `ComposableModelProviderPlugin`, not an arbitrary
legacy `ModelProviderPlugin`. The composable shape adds inert `routes` claims.
Runtime snapshots and validates all plugin IDs and all route claims across the
whole input before looking up or invoking any `setup()` method. The existing
direct plugin interface remains available to the advanced `ModelRegistry`, where
staged setup preserves compatibility but cannot promise conflict detection before
plugin execution.

`defineModelProviderPlugin()` is the normal author grammar. Its scoped registrar
lets the common one-adapter case call `registerAdapter(adapter)` without repeating
routes; a multi-adapter author may pass a subset of the declared claims. Setup
must register every claim exactly once by return, cannot register outside the
claims, and replacement handles may move only within those claims during setup or
runtime-owned rollback/close. A mismatch rejects and rolls back construction.

### 4.3 Multiple accounts and route ownership

The provider design must support two installations of the same provider family
without route collision. Each plugin factory therefore needs explicit optional
identity and route configuration:

```ts
openAiPlugin({
  id: 'openai-team-a',
  apiKey: teamAKey,
})
```

With no `id`, the family name is both instance ID and route (`openai`,
`anthropic`, or `codex`). With `id` but no `routes`, that custom ID becomes the
sole route. A second installation therefore selects one distinct ID; explicit
route arrays are needed only for aliases. Registry transaction and replacement
behavior remains the canonical conflict mechanism.

These identities remain distinct in discovery instead of collapsing into one
ambiguous `id`. `providers()` returns one row per route with `route` (the exact
`ModelTarget.provider` key), `pluginId` (the installed account/instance), and
`family` (the implementation family such as `openai`). The existing adapter
`ProviderInfo.id/name` remain compatibility aliases for route and adapter display
name. Official packages freeze family; a custom plugin may declare it, otherwise
runtime falls back to its plugin id. Family never routes calls, plugin id never
selects a model route, and neither may be derived from credentials.

The normal `AgentRuntime` provider topology is immutable after awaited
construction. There is no public hot-install/remove method: credentials rotate
through credential sources/stores, MCP catalogs refresh through live tool
sources, and a materially different provider set gets a new runtime. This keeps
route conflict validation atomic and makes session/model identity stable. The
low-level registry may retain transactional replacement for advanced internal
use, but it is not the plugin composition grammar.

### 4.4 Family-scoped executable capability markers

Peer dependency ranges are necessary but not sufficient when lockfiles or bundled
plugins hide version skew. Recommended composable provider plugins add a runtime
contract marker while the existing advanced registry interface remains
marker-free:

```ts
export const PROVIDER_PLUGIN_API_VERSION = 1 as const

export interface ModelProviderPlugin {
  readonly id: string
  readonly displayName: string
  setup(registrar: ModelProviderRegistrar): void | (() => void)
}

export interface ComposableModelProviderPlugin extends ModelProviderPlugin {
  readonly kind: 'model-provider-plugin'
  readonly apiVersion: 1
  readonly routes: readonly string[]
}
```

`AgentRuntime` rejects an absent/wrong `kind` or unsupported `apiVersion` before
invoking composable plugin code. The advanced `ModelRegistry.install()` path
continues to accept the current marker-free `ModelProviderPlugin`; it cannot claim
the stronger whole-runtime preflight guarantee. The discriminator is required on
independently packaged composable values because distinct executable families can
all be at numeric version `1`; version alone is not a runtime family identity.

The same protection is required for every package-supplied executable protocol,
not only values with a `setup()` method. A skill provider, observation exporter,
memory store, or connected tool source can execute code and cross a versioned
method boundary even though it is passed as a plain object. Manifest metadata is
not a substitute because core cannot inspect an installed `package.json` inside
a bundled Worker.

Versions are therefore scoped by family:

```ts
export const PROVIDER_PLUGIN_API_VERSION = 1 as const
export const CREDENTIAL_CAPABILITY_API_VERSION = 1 as const
export const SKILL_PROVIDER_API_VERSION = 1 as const
export const MEMORY_STORE_API_VERSION = 1 as const
export const OBSERVATION_EXPORTER_API_VERSION = 1 as const
export const TOOL_SOURCE_API_VERSION = 1 as const
// Exported by provider-http, not by core:
export const HTTP_PROTOCOL_API_VERSION = 1 as const
```

Every executable family carries both a literal family `kind` and its independent
numeric `apiVersion`. Core validates a value when it enters that family's
composition point: providers
before runtime allocation/setup, exporters before observation-bus construction,
credential sources/stores before resolution or I/O, memory stores before
binding/load, and skill providers before an agent/catalog is created. A breaking
skill contract
can then advance without invalidating an otherwise compatible provider package.
Plain data such as an inline `SkillDefinition`, message, or schema receives no
decorative marker. `ToolDefinition` is executable, but remains a marker-free
core-owned leaf contract rather than an independently versioned capability
family. `defineSkillProvider()` and equivalent
author helpers stamp the family marker so normal third-party authors do not
write it manually.

The complete author-helper set is family-specific:
`defineModelProviderPlugin`, `defineCredentialSource`, `defineCredentialStore`,
`defineSkillProvider`, `defineMemoryStore`, `defineObservationExporter`, and
`defineToolSource`. Each accepts behavior/configuration fields without
`kind/apiVersion`, returns a marker-bearing capability, and performs only
synchronous shape validation—no I/O, registration, or ownership transfer.
`defineAgent`, `defineTool`, and `defineSkill` remain marker-free helpers.
`defineTool` returns a detached frozen execution view that captures schema and
function references without freezing/mutating the caller's object; direct object
literals remain accepted and receive the same capture at runtime binding.

`provider-http` additionally exports `defineWireProtocol()`. A wire protocol is
pure and owns no endpoint or credential, but it still executes package code to
select a path, serialize a request, and translate an SSE stream. It therefore
carries `kind: 'http-wire-protocol'` plus its provider-http-scoped API version;
`createHttpProvider()` validates and snapshots that method table before creating
an adapter. Protocol packages remain independent of provider-http at runtime by
implementing the same structural literal contract against core stream/request
types; official provider packages own compatible versions of both dependencies.

The configurable HTTP extension kit must not collapse to bearer-only metadata.
Its recommended v1 surface preserves header and dynamic authentication, injected
fetch, static/advisory models, bounded discovery, dialect/model decoration,
retry and transport limits, error classification, and the deprecated high-risk
wire logger until separately approved for removal. Credential values use core's
versioned `CredentialInput`; dynamic auth is inline adapter configuration and
receives a required operation signal. A compile-only custom-provider journey
proves protocol serialization/translation, rotating header credentials, dynamic
headers, discovery, retry, registration, and cleanup using only core plus
provider-http.

The minimum target declarations are not a removal list. A separate frozen
baseline currently records 84 public exports across provider-http, OpenAI,
Anthropic, and Codex; all remain preserved unless an owner-approved migration
record says otherwise. Normal user docs lead with each package's plugin factory,
while adapter/protocol/error utilities stay available to extension authors.

An official provider is installed by importing only core and that provider
package; its HTTP/protocol support packages are transitive implementation detail.
The recommended plugin factory preserves the provider's adapter options and adds
only declarative `id`, `routes`, and injected `fetch`. Calling the factory is
synchronous and side-effect-free: it performs no credential resolution,
discovery, login, environment access, or network I/O. Those operations remain
lazy and receive operation cancellation after runtime construction.

For the common single-account case, omitted identity claims produce
`id = family` and `routes = [family]`. If a caller supplies only `id`, the default
route is that same ID; therefore two accounts need only two IDs and two credential
inputs, not duplicated `id/routes` strings. Explicit `routes` are non-empty,
unique aliases and are still useful for compatible gateway names. `family` is
fixed by the official package and cannot be configured from credentials or
display labels. Advanced adapter factories remain exported, but normal
composition never requires importing `provider-http`, a protocol package, or the
mutable registry.

Provider-specific controls remain available through that same preferred factory:
OpenAI organization/project/store/model metadata, Anthropic version/beta/thinking
budgets, Codex catalog/OAuth/cache settings, and shared retry/transport/SSE bounds.
Codex `promptCacheKey` is explicitly provider-plugin-instance scoped. All sessions
using that route share it; it is not a conversation or tenant boundary. Separate
account/cache isolation uses separate plugin IDs/routes unless a future
conversation-scoped provider contract is designed explicitly.

Executable capability objects also need a time-of-check/time-of-use rule. A
TypeScript `readonly` field does not stop JavaScript from replacing `id`,
`setup`, `export`, `list`, or `resolve` after preflight. Therefore every
family-specific `define…` helper returns a **new frozen wrapper**; it does not
freeze or otherwise mutate the caller's definition object. The wrapper stamps
and snapshots identity/configuration and exposes readonly function properties.
Behavior-owned state behind those functions may still change—for example an MCP
catalog revision or an exporter connection state—because immutability of the
method table is not immutability of the capability's operational state.

Core accepts structurally valid third-party/class implementations that did not
use a helper, but immediately builds one private frozen handle during preflight.
It reads `kind`, `apiVersion`, `id`, immutable configuration, and each public
method reference once; later calls use the captured reference with the original
receiver and never reread the public property. Optional lifecycle functions and
any disposer returned by `setup()` are captured when first observed, so replacing
or deleting `shutdown`/cleanup later cannot redirect teardown. Nested executable
tables such as `ToolSource.tools` follow the same rule when an invocation
snapshot is created. Dynamic catalog/data changes enter only through the
family's methods and become visible at the next documented snapshot boundary.

This is deterministic composition hardening, not a JavaScript sandbox. A hostile
`Proxy` can run traps while any property is inspected and a captured method can
execute arbitrary package code. Property access/shape failures are contained as
support-safe validation/construction failures, but trust in installed code still
comes from dependency review and package integrity. The machine-readable policy
is frozen in `design-contracts/core-capability-v1/topology.json`; deterministic
tests must mutate identity/method properties after preflight and prove routing,
cleanup, ownership, and the last valid dynamic snapshot remain unchanged.

Provider packages that do not use the optional HTTP/protocol support layer may
extend `ModelAdapter` directly through `@ai-agent-sdk/core/provider`. The target
preserves the current adapter stream, model metadata/resolution, retry-policy,
generation-binding, physical-attempt accounting, registration handle, and stream
middleware surfaces; reducing the adapter to an opaque marker would make the
plugin ecosystem official-package-only.

The registrar and its handles are activation-scoped. Registration, route
replacement, and middleware insertion are valid only while plugin `setup()` is
running; their returned disposers are valid again during runtime rollback/close.
Calling a retained registrar or mutation handle while the runtime is active fails
with a stable lifecycle error. This preserves source compatibility without
creating a public hot-install/remove API or allowing a plugin to change route
identity between model resolution and dispatch.

MCP connections and other executable live catalogs enter through a distinct
tool-source contract:

```ts
export interface ToolSource {
  readonly kind: 'tool-source'
  readonly apiVersion: 1
  readonly id: string
  snapshot(options: { readonly signal: AbortSignal }): ToolCatalogSnapshot
}
```

Official MCP connection factories return a value satisfying this contract, so a
consumer does not need an adapter wrapper. Inline `ToolDefinition` values remain
marker-free because they are core-owned leaf contracts with no independent
lifecycle—not because `execute()` is inert.
MCP may retain its stable live `.tools` catalog for direct-caller compatibility,
but core composition never reads that view.

### 4.5 Universal HTTP capability transport contract

Every HTTP-using package classified Universal—provider, remote observation
exporter, remote skill source, MCP HTTP transport, or future capability—must
accept an injected Web-compatible `fetch` implementation or an SDK transport
wrapper. Merely referencing the global `fetch` type is insufficient: supported
`RequestInit` values and redirect semantics differ in real Edge runtimes.

The no-redirect security invariant is normative:

- authorization is never forwarded by silently following a redirect;
- a runtime that rejects `redirect: 'error'` uses `redirect: 'manual'` and treats
  every observable 3xx/opaque redirect as a terminal transport failure;
- native fetch is never allowed to follow first and validate the final URL
  afterward; the policy must decide before contacting the next hop;
- if a capability explicitly opts into redirects, every hop is manually bounded
  and validated before follow, and sensitive headers never cross an origin;
- redirect policy has contract tests in workerd, a browser, Deno, and Node;
- support diagnostics record only stage, origin, status, stable code, and
  provider request id—never headers, token, request body, or error body by default.

Headers are merged by ownership, not by JavaScript spread precedence. Names are
validated and canonicalized case-insensitively into five disjoint layers:
transport (`accept`, `content-type`), SDK attribution (`user-agent` and reserved
SDK prefixes), wire protocol, endpoint static configuration, and authentication.
Any cross-layer duplicate fails with `HTTP_HEADER_COLLISION`; reserved or invalid
names fail before dispatch. Static endpoint headers cannot carry credentials and
must use an auth scheme instead. The compatibility `baseHeaders` option defines
the transport layer explicitly—it does not grant later layers overwrite rights.

Every header produced by bearer, named-header, or dynamic authentication is
marked sensitive by provenance, regardless of whether its name contains
`authorization`, `token`, or `key`. Wire diagnostics redact that entire set plus
the conservative sensitive-name policy, preventing a custom signature header
from escaping merely because its name was unfamiliar. One prepared logical call
resolves one atomic endpoint/credential/header snapshot; its physical retries
reuse that prepared generation so model capabilities, endpoint, and credential
cannot drift independently. A new logical call resolves a new snapshot. AUTH and
invalid-credential failures remain outside the default retry set. Redirect
handling validates before every hop and forwards no sensitive header across
origins.

The v1 wire body is equally explicit: `WireProtocol.serialize()` is a
synchronous, pure mapping that returns one JSON object. It does not return a
Promise, primitive, `BodyInit`, stream, `FormData`, class instance, or other host
object. `createHttpProvider()` walks the returned graph before dispatch, rejects
circular references, accessors, functions, symbols, bigint, non-finite numbers,
unsupported prototypes, and values outside configured depth/member/byte bounds,
then deep-detaches and encodes the accepted object exactly once. Serialization
or validation failure uses `HTTP_WIRE_BODY_INVALID`; encoded-size overflow uses
`HTTP_WIRE_BODY_TOO_LARGE`. Both are pre-dispatch, start no physical provider
attempt, and are never classified as retryable network failures.

The detached object, encoded bytes, endpoint, and authentication/header snapshot
together form one prepared logical call generation. Every physical retry sends
the identical bytes; provider-owned mutable state cannot silently change the
request between attempts. `application/json` remains owned by the transport
header layer. A future protocol needing text, bytes, multipart data, or streaming
upload requires a separately versioned body contract and runtime matrix rather
than widening v1 back to `unknown`. Default observations never contain the body.
The retained compatibility request logger receives the bounded detached exact
JSON body and provenance-redacted headers. Body content is not automatically
redacted because doing so would stop it being an exact-wire compatibility view;
this is why the logger remains an explicit high-risk opt-in and never a default
support path.

Successful streaming responses must declare `text/event-stream`; matching is
ASCII case-insensitive and media-type parameters are allowed. A missing or
different media type fails before the SSE parser with
`HTTP_STREAM_MEDIA_TYPE_INVALID`, rather than letting a 200 HTML/JSON error body
look like an empty successful stream. Decoding follows WHATWG streaming UTF-8
replacement semantics so behavior matches EventSource across supported hosts.
The parser's `retry` field never reconnects or changes SDK retry policy: only the
model-call retry owner may schedule a new physical attempt.

One provider-owned compatibility rule is intentionally narrower than the generic
transport contract. The fixed ChatGPT Codex `/backend-api/codex/responses`
endpoint has been observed returning a successful SSE body with the
`Content-Type` header absent. `provider-codex` may supply `text/event-stream` only
for that exact configured official endpoint, HTTP 200, a non-null body, no
redirect evidence, and a completely absent header. An explicit wrong media type,
a changed final URL, a custom Codex base URL, or any other provider remains
subject to the strict generic check. This exception is isolated in the official
provider and does not weaken `provider-http` or authorize content sniffing.

The existing response-byte and raw-chunk bounds are necessary but insufficient.
One raw network chunk can contain many terminated events, so v1 additionally
defaults to at most 100,000 decoded SSE events and 1,048,576 buffered characters
per event, both configurable downward/upward through bounded positive integer
options. Exceeding either emits `HTTP_SSE_LIMIT_EXCEEDED`. Callback events are
drained with a cursor/linear queue, never repeated `Array.shift()`, preventing a
single legal-sized chunk from creating quadratic work.

Each physical attempt owns one resettable idle deadline. Every non-empty body
read resets it, including comment-only heartbeat frames; a heartbeat is activity
but never a protocol event. The overall request deadline still caps a slow-loris
stream. A protocol translation must yield exactly one terminal `finish` chunk as
its last chunk. EOF before it becomes `STREAM_CLOSED`; output after it is rejected
and the body is cancelled. No failure after the first downstream chunk may be
automatically retried, because replay would duplicate visible output. Teardown is
bounded, but a secondary cancellation timeout is recorded separately and must
not replace the primary parse/protocol failure.

An injected mock fetch proves request construction but not host semantics. Every
Universal HTTP capability therefore has at least one packed test that delegates
to the runtime's native fetch in workerd/browser/Node/Deno for the relevant
`RequestInit` policy. Shared policy helpers are allowed only if their own packed
matrix passes and they do not add a third-party dependency to core.

Dynamic catalog discovery is a separate optional provider operation. Providers
may accept explicit model metadata for deployments where discovery is blocked or
undesirable. Empty discovery must remain distinguishable from a configured empty
catalog and from an authentication/transport failure. Explicit metadata continues
to drive reasoning/native-tool validation; core never guesses capabilities.

The composition root exposes `providers()` and `modelCatalog(route, options)`
so a normal Web UI can build a model picker without obtaining the mutable
registry. The runtime catalog snapshot carries the same route/plugin/family row,
so multi-account UIs can correlate a picker result without guessing identity.
An adapter-level catalog retains only adapter route metadata; the composition
root enriches it from the immutable installation topology. A catalog snapshot
contains a support-safe provider identity, opaque
revision, timestamps, models, and one explicit state: `static`, `fresh`, `empty`,
`stale`, or `unavailable`. An unavailable catalog never invalidates an explicit
`{ provider, id }` target; it only removes unverified picker/capability detail.

Dynamic cache keys are scoped to provider plugin instance plus route. Different
accounts require distinct plugin instances/routes, matching the multi-account
composition grammar; credential values never become cache keys or diagnostics.
Static models bypass discovery. A successful empty result is cached as `empty`,
while failure is a separate support-safe state and never overwrites the last good
snapshot. Fresh TTL defaults to the current five minutes. Stale serving is opt-in
(`catalogStaleTtlMs` defaults to zero); failure retry backoff defaults to five
seconds and is capped at one minute, independently of success TTL. `force`
refresh bypasses cached freshness/backoff but still joins an in-flight refresh.

Concurrent refresh is single-flight per cache key. Each caller races its own
signal and detaches without aborting other waiters; the shared operation is
aborted only after all waiters detach. Revision changes only when the published
snapshot changes. Bounds apply before publication, and an oversized/malformed
result becomes `unavailable`/`stale` rather than a successful empty catalog.

## 5. Typed capability composition

“Plugin package” does not mean every package installs through
`runtime.install(plugin)`.

| Capability | How it composes | Lifecycle owner |
| --- | --- | --- |
| Model provider | `AgentRuntimeOptions.providers` | runtime owns registration handle |
| Inline tool | agent `tools` | immutable/borrowed |
| Skill provider | agent `skills` | always borrowed; caller owns any connected backing client |
| Memory store | agent/session `memory` | shared/borrowed; caller owns store lifecycle |
| MCP/tool source | connection enters agent/session `toolSources` | caller owns connection by default |
| Observation exporter plugin | `AgentRuntimeOptions.observability.exporters` | `RuntimeObservationExporterRegistration` explicitly selects borrowed or owned |
| Credential source/store | provider factory input | shared/borrowed; caller owns lifecycle |
| Local team/control plane | `runtime.team({ members })` | runtime-owned; explicit early close allowed |
| Remote A2A transport | linked through explicit `a2a` capability | caller-owned transport |

This table prevents an attractive but unsafe abstraction where unrelated
capabilities receive the same registrar, can inspect one another, and share one
unbounded cleanup contract.

### 5.1 Borrowed versus owned values

Ownership must be documented at every composition point:

- values constructed internally by a runtime are owned by that runtime;
- an instance passed by the caller is borrowed by default;
- ownership transfer requires an explicit `ownership: 'owned'` field;
- a borrowed instance is never closed implicitly;
- owned cleanup is idempotent and happens exactly once;
- ownership is not inferred from package name, runtime, or object shape.

`RuntimeObservationExporterRegistration.ownership` is required rather than defaulted.
For an `owned` registration, transfer occurs only after the exporter family
marker validates and before activation; any later construction failure is rolled
back by the runtime. Marker rejection never transfers ownership or invokes an
untrusted exporter method. Exporter factories are cold/side-effect-free, and a
caller that passes a pre-opened custom exporter remains responsible for it until
that validation boundary. A `borrowed` exporter is never shut down by runtime.

The first implementation does not need a general `runtime.manage()` API. MCP and
other independently opened connections remain caller-owned until a concrete
ergonomic problem justifies a lifecycle-only resource owner. This avoids turning
the composition root into a service locator.

Capabilities with asynchronous readiness remain explicit, but the owner of the
activation boundary must await them. The caller awaits an independently owned MCP
connection's `connect()`. In contrast, `createAgentRuntime()` validates every
exporter marker and requested durability boundary, transfers only registrations
marked `owned`, then awaits each exporter's optional `ready(signal)` within
`startupTimeoutMs` before publishing a usable runtime.

Readiness failure, timeout, or abort rolls back all already-transferred owned
components in reverse order and never shuts down a borrowed exporter. No exporter
method is invoked before marker/boundary validation. The factory rejects with a
support-safe `AgentRuntimeConstructionError` whose stage identifies preflight,
provider setup, exporter readiness, or activation; its reason distinguishes
invalid, failed, timed-out and aborted starts, and its optional component identifies
the provider/exporter without exposing secrets. Its cleanup report retains
failed/timed-out rollback evidence without replacing the primary cause. Exporter
factories remain cold and provider setup remains synchronous; this boundary does
not authorize hidden network, credential, or filesystem I/O during provider setup.

Skill providers and memory stores have no ownership-transfer registration in v1;
objects passed into agent/session definitions are always borrowed. A remote skill
package that needs a connection returns an independently connected caller-owned
client implementing `SkillProvider`, and the host closes it after runtime
quiescence. This corrects the earlier “unless transferred” wording, for which no
typed transfer boundary existed.

Memory composition makes cross-session sharing explicit. A binding carries a
support-safe `bindingId` and one scope: `conversation` derives a versioned,
collision-free store key from the tuple `(namespace, agentId, conversationId)`,
while `fixed` requires `sharedAcrossSessions: true` alongside its caller key.
Runtime never concatenates these fields with an ambiguous delimiter and never
places the key/namespace in diagnostics or snapshots. A session-level binding (or
`false`) overrides the agent default, then agent binding, then no persistence.
Stores remain borrowed in every case.

Snapshots persist only `memoryBindingId`. `resumeSession()` must receive the same
effective binding ID through the bound agent or session options; missing or
different bindings fail with `MEMORY_BINDING_REQUIRED` or
`MEMORY_BINDING_MISMATCH` before store I/O. This prevents a valid conversation
snapshot from silently resuming against another tenant's memory while keeping
store handles, keys, namespaces, and credentials reinjected rather than serialized.

Every runtime delivery batch and diagnostic snapshot carries one immutable
`ObservationResource`: runtime-generated `runtimeId`, SDK name/version, and
optional caller-supplied service name/version/environment plus JSON-safe
attributes. The field remains optional in the public interface solely so the
existing advanced observation bus stays source-assignable; `AgentRuntime`
guarantees it on runtime-owned output. Callers cannot spoof SDK/runtime identity
through the high-level constructor. This gives shared
exporters enough identity to separate concurrent runtimes without placing content
or credentials in resource metadata. Export-visible event and resource attributes
are normalized to `JsonValue` after privacy processing; circular objects, class
instances, raw errors, functions, symbols, and other host values never cross the
exporter boundary.

### 5.2 Identity namespaces and atomic collision handling

Executable capability IDs are support/lifecycle identities, not decoration. Each
composition point owns an explicit namespace: provider plugin IDs and routes per
runtime; exporter IDs per runtime; tool-source IDs, tool names, skill-provider
IDs and resolved skill IDs per agent/session snapshot; team member names per
team. Import order never selects a winner and no later registration shadows an
earlier one.

Runtime preflight first reads marker/id fields through safe own-data-property
validation, then rejects duplicate provider/exporter IDs and routes before setup,
method access, ownership transfer, bus allocation, or readiness. Agent/session
catalog creation applies the same all-or-nothing rule before a model request or
tool/skill execution. Team validation finishes before any member session is
created. Dynamic skill/tool-source refresh is snapshot-scoped: a collision fails
the next snapshot without mutating the last valid one.

Support-safe failures use stable codes plus `CapabilityIdentityConflict` with
namespace, bounded/redacted key, and first/second input indices. Runtime
construction additionally exposes `failureCode` and the conflict on
`AgentRuntimeConstructionError`; cleanup remains empty for pure preflight
conflicts. Provider routes and plugin IDs are separate namespaces, so two routes
may share a plugin only when one plugin registered them atomically, while two
plugins cannot claim the same route.

### 5.3 Live tool-source composition

`tools` and `toolSources` are intentionally separate. `tools` contains local,
marker-free core-contract definitions. `toolSources` contains borrowed executable catalogs such
as MCP connections. This is more explicit than a catch-all union while keeping
the common call site short:

```ts
const github = await connectMcpHttp({
  serverName: 'github',
  url,
  headers,
  logger: runtime.logger({ fields: { integration: 'mcp-github' } }),
})
const database = await connectMcpStdio({
  serverName: 'db',
  command,
  args,
  logger: runtime.logger({ fields: { integration: 'mcp-database' } }),
})

const agent = runtime.agent({
  model,
  instructions,
  tools: [localClock],
  toolSources: [github, database],
})
```

Core retains the sources rather than copying their current definitions. At the
start of every invocation it calls each captured `snapshot(signal)` method
exactly once. The synchronous result contains a bounded non-empty revision and
bounded `ToolDefinition` values. Core validates every family marker, schema and
name collision, then captures identity/schema/executable method references into
one private immutable table before a model request or tool execution. That table stays
stable for the invocation; a later MCP refresh/reconnect becomes visible on the
next invocation. Snapshot failure rejects the invocation—core never silently
falls back to a stale catalog. A source that advertises an invalid definition
also fails closed.

`RunTerminalRecord.toolSourceSnapshots` records only source ID and revision for
every source used by the run. Tool schemas, arguments, results and live catalog
content are not copied into reports or diagnostics. This makes support evidence
correlatable without turning observability into a second tool registry.

Local/package tools are captured too. When binding a runtime agent or session,
core validates bounded detached schema data and captures `parse`, `execute`,
`render`, `meta`, timeout, and concurrency-classifier references once, preserving
the original receiver. It never freezes the caller object and never rereads it
after capture. Later mutation cannot change the schema/execute pair already bound
to that agent. Local and source tools then enter one collision-checked invocation
namespace before model dispatch.

Core does not call `connect()` or `close()` for a borrowed source. This preserves
sharing across agents and makes partial-startup rollback unambiguous. Convenience
recipes may use `try/finally`; hidden lifecycle ownership is not introduced.

MCP connections retain their reconnect policy, support-safe state, bounded
catalog/result/operation limits, and monotonically increasing catalog revision.
Core records the source ID/revision used by each invocation. Reconnect or refresh
never mutates the invocation snapshot already selected. Existing caller-owned
`close(): Promise<void>` remains source-compatible. The additive
`closeWithReport()` operation is bounded and idempotent and returns an
`McpCloseReport`; it does not silently turn a teardown timeout into success. The
host closes the runtime first, then the borrowed connection, and retains both
reports independently.

`connectMcpHttp()` and `connectMcpStdio()` are transactional convenience
factories. If transport/authentication/handshake/catalog startup fails before a
connection can be returned, they run bounded `closeWithReport()` rollback and
reject with `McpConnectionError`. Its stable stage and `failure` preserve the
support-safe primary cause; `cleanup` retains the close report even when rollback
also failed or timed out. A cleanup failure never replaces the connect failure.
The HTTP `/client` and Node stdio entrypoints both re-export this error so the
normal consumer does not need a hidden support-package import. Advanced
`createMcp*Client()` plus manual `connect()` remains available for callers that
need the original low-level error behavior.

### 5.4 Package authoring and consumer ergonomics

Every capability package should have the same predictable public shape without
pretending that every capability has the same lifecycle:

1. a side-effect-free named factory whose options contain all credentials,
   endpoints, roots, and injected host functions;
2. a typed returned value for one documented composition slot;
3. an explicit `connect()`/`ready()` only when real asynchronous preparation is
   required;
4. an explicit `close()` on independently owned connected clients;
5. family API marker plus non-executable manifest runtime metadata;
6. no import-time registration, package scanning, environment lookup, or hidden
   singleton.

```ts
const skills = remoteSkillProvider({ endpoint, fetch })
const telemetry = fetchObservationExporter({ endpoint, fetch })
const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
  observability: {
    exporters: [{
      exporter: telemetry,
      ownership: 'owned',
      requirement: 'required',
      boundary: 'remote-acknowledged',
    }],
  },
})

let mcp: McpClientConnection | undefined
try {
  mcp = await connectMcpHttp({
    serverName: 'tools',
    url,
    fetch,
    logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
  })
  const agent = runtime.agent({ model, skills: [skills], toolSources: [mcp] })
  await agent.generate(input)
} finally {
  try {
    const runtimeCloseReport = await runtime.close()
    void runtimeCloseReport
  } finally {
    if (mcp !== undefined) {
      const mcpCloseReport = await mcp.closeWithReport()
      void mcpCloseReport
    }
  }
}
```

These shapes have distinct ownership. The recommended target runtime path uses
`fileSystemSkillProviderPlugin()`, a versioned lazy borrowed Node capability.
The existing `fileSystemSkills()` remains a marker-free advanced compatibility
provider; both perform no filesystem I/O until a bounded list/load/resource
operation. `connectMcpHttp()`/`connectMcpStdio()` return an
already connected borrowed tool source which the caller closes after runtime
quiescence. Observation exporter factories are inert until runtime readiness and
their registration says `owned` or `borrowed` explicitly. Selecting one Node
factory elevates only that install recipe; core and unrelated capabilities remain
Universal.

OpenTelemetry is not a batch `ObservationExporterPlugin`. Real span parentage must be
opened synchronously and its processor projects events into metrics/logs before
export queues. `createOpenTelemetryBridge({ tracer, meter, logger? })` therefore
returns `openSpan`, `processor`, and bounded diagnostics. The high-level runtime
accepts those typed callbacks under `observability.openSpan/processors`; it
captures their method table before runs. The host owns tracer/meter/logger
providers and their flush/shutdown—runtime close never assumes ownership of an
external OTel SDK. The optional logs peer is needed only when a logger is supplied.

Recommended factories retain their operational controls rather than presenting
toy option bags: filesystem roots/project/user discovery and scan bounds; MCP
transport/reconnect/catalog/result bounds; IndexedDB quota/open bounds; fetch
retry/batch/ack bounds and injected timing/fetch; JSONL durability/retention/sync
bounds; and OTel content/diagnostic policy. Explicit test hooks such as clocks or
random sources stay advanced options and are never read from environment/global
state during package import.

This is the documented composition grammar. Recipes and a future generator may
write these explicit imports and manifest entries for the user, but must not emit
an opaque `plugins: [...]` array or a replacement full/Node facade.

### 5.4.1 Skill catalogs and resumable references

`SkillProviderPlugin.list()` returns an opaque catalog revision plus bounded candidates,
not a bare array. Candidate locators are bounded `JsonValue`; functions, class
instances, filesystem handles, circular objects, and raw errors cannot enter a
session snapshot. Core validates candidate provider IDs against the owning
provider and stamps the chosen candidate with the catalog revision to create one
`SkillReference`.

`load()` and `readResource()` receive that exact reference. Providers must treat
references restored from snapshots as untrusted input, validate their revision
and locator before I/O, and return unavailable rather than guessing a current
candidate. Core turns invalid/unavailable references into stable fail-closed
errors before model/resource use. Resource paths are bounded provider-relative
paths and cannot traverse the provider root.

Activated-skill snapshots persist the reference only: provider, source, ID,
catalog revision, and JSON-safe locator. Loaded instructions and resource content
are neither serialized nor logged. Resume validates schema/bounds/provider
identity, then asks the provider to validate and load the exact reference. This
makes a session portable without silently upgrading its skill behavior when a
remote or filesystem catalog changes.

### 5.4.2 Local executable policy objects

Approval/user-input brokers, tool interceptors, turn hooks, and usage estimators
are marker-free core leaf contracts, not generic plugins. At agent/session
binding, core validates and detaches bounded configuration, then captures every
runtime-used function reference exactly once with its original receiver. Public
function properties are readonly; later replacement cannot redirect a bound
session.

Capture does not freeze the caller object or its operational state. An interactive
broker can still add waiters and the host can call `pending()`, `resolve()`, or
`abortAll()` on the original value. Runtime simply keeps the captured `request`
function. Likewise, stateful interceptors/estimators may update their own internal
state, but cannot swap policy methods mid-run. The runtime always supplies an
operation cancellation signal to broker requests and hooks so capture does not
weaken close/abort. Legacy broker method signatures retain an optional signal for
source compatibility; that optionality does not permit runtime calls without one.

### 5.5 Memory persistence is a separate executable family

Core owns the bounded in-run `AgentMemory` model, snapshot schema, injection, and
compaction interaction. External packages persist that snapshot through a
`MemoryStore`; they do not replace session accounting or inspect other runtime
capabilities. A binding's explicit scope derives an isolated conversation key or
acknowledges a fixed cross-session key, and selects `required | best-effort`
behavior.
Stores are shared/borrowed and core never closes them.

Every load/commit receives an `AbortSignal`. `load()` distinguishes not-found
(`undefined`) from failure (rejection). `commit()` uses an expected revision:
`null` means create only and a string means compare-and-swap. Core must never
treat a failed load as not-found and then overwrite existing memory. Under
`required`, load fails before the first model request and commit failure rejects
the run while preserving its usage report. Under `best-effort`, load failure
disables persistence for that run, commit is skipped, and diagnostics report the
degraded state without losing provider usage.

This deliberately avoids a generic key/value/storage API in core. A future SQL,
KV, or browser package can implement `MemoryStore` while keeping connection
pooling and its close lifecycle caller-owned.

### 5.6 Credential capabilities are lazy, abortable, and revisioned

A literal API key remains valid `CredentialInput` for the simplest server-side
case. Executable resolution uses a `CredentialSource` object with the credential
family marker and required `AbortSignal`; direct callback functions are rejected
so an official auth package cannot silently cross an unversioned protocol.
`envCredential()` returns this object and therefore keeps environment access in
the explicit Node package while preserving the same provider factory call site.

Refreshable material uses borrowed `CredentialStore<Value>`. Reads return a
value plus opaque revision; commits require `null` for create-only or the exact
revision for compare-and-swap replacement. A failed read is never treated as an
empty store. Codex refresh must pass the model-operation signal through store
read, refresh request, and commit; on a revision conflict it reloads the winning
record instead of writing a now-consumed refresh token. File-backed stores use
atomic replacement internally, but filesystem policy remains outside core.

Credential IDs/labels may appear in support diagnostics; secret values, store
contents, environment-variable values, and filesystem locations do not. The
source/store remains caller-owned and is never closed by provider or runtime.

The retained advanced provider surface still accepts its historical unmarked
credential callbacks for source compatibility. That overload returns the
advanced `ModelProviderPlugin` and does not satisfy the normal composition slot.
Normal provider options consume `CredentialInput`; custom HTTP composition uses
the separately named `createRuntimeHttpProvider()` and `Runtime…` protocol/auth
contracts. This preserves old extension authors without weakening the marker,
cancellation, snapshot, and preflight guarantees claimed by `createAgentRuntime()`.

### 5.7 Interactive policy is part of the portable agent surface

Approval and user-input brokers remain Web-standards interfaces in core. A broker
parks one call by stable ID, receives a runtime-supplied run signal, registers its waiter
before publishing to listeners, and distinguishes deny from abort. Interactive
brokers are bounded and expose `abortAll()` so cancellation/runtime close cannot
strand pending promises. Fixed brokers support deterministic/headless policy.

Tool interceptors remain ordered, named, and signal-aware. They may allow, deny,
or request approval before dispatch and inspect/replace/block a result afterward.
Turn hooks receive bounded snapshots and required cancellation; they do not
bypass the canonical ledger or provider-attempt reporting. The event stream
projects approval request and user-input request/response by call/request ID so a
web or CLI host never parses assistant prose to discover a pause.

### 5.8 Local teams stay Universal; remote transports stay optional

`runtime.team()` composes already-bound `RuntimeAgent` values into named local
sessions. A runtime-created team is owned by that runtime, may be closed early,
and appears as an `agent-team` component in the runtime close report. Team member
and mailbox/observer limits are explicit; member errors use support-safe values.
The runtime rejects duplicate names and more than one lead before creating any
session, and rolls back partial attachment.

Remote A2A codecs/transports do not enter core. The Node `a2a` capability can link
a caller-owned remote transport into either the preserved `AgentTeam` or the new
`RuntimeAgentTeam` through one structural `linkAgent()` contract.
`RuntimeAgentTeam.sendMessage()` is the remote operation; `session()`/`run()`
remain local-member APIs. Link admission uses the team's existing identity and
message bounds plus the `team-operation` lease. The returned unlink function is
synchronous and idempotent. Team/runtime close removes the link but never closes
the borrowed transport; transport resources remain the caller's responsibility.
The recommended cleanup calls `runtime.close()` first and invokes the additive
idempotent `unlinkWithReport()` in `finally`; this quiesces sends before link
teardown, still attempts caller cleanup if close reporting fails unexpectedly,
and retains support-safe evidence without relying on a closed logger. The
preserved `unlink()` remains the advanced compatibility handle.
This keeps local multi-agent web use possible without adding the A2A SDK or Node
boundary to the base package.

## 6. Shutdown and failure ordering

`AgentRuntime.close()` uses this order:

1. atomically reject admission of every new runtime-owned asynchronous operation;
2. abort the runtime root signal shared by active agent runs, model-catalog
   refreshes, manual compaction, and local-team operations;
3. wait for all operation leases to quiesce within the shared deadline;
4. seal every unsettled operation generation so a late result cannot publish to
   a cache, ledger, caller result, or observation stream;
5. close runtime-created local teams after their sessions quiesce;
6. dispose provider registrations in reverse installation order;
7. flush canonical terminal observations;
8. shut down an owned observation bus/exporters last;
9. return every contained failure in a structured close report.

Admission and the transition to `closing` use one atomic state decision. An
operation obtains its lease before executable capability method access and uses
one signal composed from caller cancellation, the runtime root, and its operation
deadline. It either wins admission before close and is tracked, or fails with
`RUNTIME_CLOSING`/`RUNTIME_CLOSED` without starting work. A deadline cannot
preempt arbitrary JavaScript, so close invalidates the generation token of an
unsettled lease and records it rather than allowing its later continuation to
repopulate a catalog or emit a terminal success after provider disposal.

The close report always contains one row, including zero counts, for each fixed
operation kind. `activeRunsAtClose`, `abortedRuns`, and `unsettledRuns` remain
compatibility projections of the `agent-run` row; for every row,
`activeAtClose = settled + unsettled`. Provider cleanup starts only after the
operation-quiescence/sealing boundary.

The first `close()` call synchronously starts one irreversible shared close task;
concurrent and repeated calls await that same task, and later options cannot
replace its budget. `close({ signal })` never cancels cleanup and never rejects
merely because that signal aborts. Instead, caller abort ends the quiescence wait,
seals unresolved generations, and cleanup continues to the terminal report. The
report distinguishes `quiescenceEnd: settled | timeout | caller-abort`;
`deadlineReached` is retained only as the compatibility projection of `timeout`.
An already-aborted first-call signal still transitions the runtime to closing
before immediately taking this accelerated path.

The normal composition API owns one internal observation bus. Exporter
registrations retain their explicit borrowed/owned semantics: runtime flushes
terminal events through both, shuts down only owned exporters, and reports every
failure. Borrowed MCP connections, remote team transports, credential stores,
skill providers, and exporters are never shut down.

Provider plugin cleanup remains synchronous because it only removes topology and
synchronous middleware. A provider that owns an asynchronous resource must keep
operation resources request-scoped or expose an explicit capability object owned
outside the registry. Do not widen `ModelProviderPlugin.setup()` to arbitrary
async initialization; that would destroy the current atomic install guarantee.

There are two enforcement layers. The preserved direct `ModelProviderPlugin`
surface keeps its existing `void | (() => void)` signature for source
compatibility, so runtime must reject and contain a returned Promise/thenable.
The new `defineModelProviderPlugin()` input uses `undefined` and a cleanup
returning `undefined`, rather than TypeScript's special `void`, so an accidental
`async setup()` or async disposer fails during compile-only author checks. On a
runtime async-setup violation, the registrar is sealed immediately, staged
routes/middleware are discarded, any late rejection is contained, and
construction fails with `PROVIDER_SETUP_ASYNC_UNSUPPORTED`. A late continuation
cannot reuse the captured registrar.

Cleanup first removes committed topology and seals all mutation handles, then
invokes the captured synchronous disposer exactly once. A returned
Promise/thenable is contained and reported as
`PROVIDER_CLEANUP_ASYNC_UNSUPPORTED`; it is never treated as successful cleanup
or awaited as an undocumented resource lifecycle. `closeTimeoutMs` can mark a
provider component `timed-out` only when the shared deadline is exhausted before
its disposer begins. JavaScript cannot preempt a synchronous disposer after it
starts, so untrusted blocking package code is outside the deadline guarantee and
must not be described as sandboxed or cancellable.

`RuntimeCloseReport` must include:

- whether the deadline was reached;
- whether operation quiescence ended by settlement, timeout, or caller abort;
- active, aborted, settled, and unsettled operation counts by fixed kind;
- compatibility run totals derived from, never counted separately from, the
  `agent-run` operation row;
- provider cleanup failures;
- observation flush/shutdown status;
- final observation health;
- no prompt, completion, key, token, filesystem path, or wire body by default.

Owned cleanup failures are values in the report rather than thrown replacements
for the primary run/provider failure. `close()` is idempotent and resolves the
same terminal report on repeated calls; caller argument/programming errors may
still throw before shutdown begins. Independently owned MCP/host cleanup remains
outside this report and must be handled by the host after runtime quiescence.

After close, immutable provider topology, final bounded diagnostics, and the
terminal close report remain readable. Agent/team/catalog/run/compaction entry
points reject new work with a stable runtime code. A logger acquired before or
after close is a closed no-op view: it neither throws from application cleanup
nor reopens or mutates the observation bus.

## 7. Base observability in core

### 7.1 One canonical instance

`createAgentRuntime()` always owns one internal `Observability` instance and
injects its port into the model registry, agent sessions, run ledger, tools, and
capability hooks. Split registry/session observation is not permitted through the
normal API. The mutable bus is not exposed; the runtime publishes only bounded
diagnostics, structured close/run reports, and a runtime-bound logger view.

### 7.2 Default behavior

The default is operational, metadata-only, bounded base logging:

- content policy `none`;
- no console output;
- a small bounded in-memory diagnostics buffer;
- canonical per-run ledger and usage coverage always enabled;
- no durable-delivery claim;
- errors and missing usage appear in terminal run reports even if the diagnostics
  buffer evicts older operational events.

The default diagnostics buffer is a new bounded ring, not the current unbounded
`MemoryObservationExporter` intended for tests. The exact limits must be
benchmarked and frozen before implementation. They must be low enough for Edge
isolates and visible through a diagnostic snapshot API. A user may disable the
cross-run buffer, but cannot disable canonical per-run accounting.

### 7.3 Runtime-bound application and plugin logging

`runtime.logger({ scope, fields })` returns the existing synchronous `SdkLogger`
bound to the runtime's generated resource identity. `RuntimeLoggerContext` cannot
override resource, runtime, trace, or span IDs. A call outside a run receives a
fresh correlated operation scope; tools, turn hooks, and model invocation
contexts receive a logger already bound to the active run/span. Authors can add
JSON-safe child fields but cannot fabricate correlation.

The `logger` property remains optional on the preserved low-level tool/hook/model
context types so existing mocks and direct pipeline callers remain assignable.
Every path entered through `AgentRuntime` guarantees it is populated; new plugin
code should tolerate absence only when it intentionally supports legacy low-level
invocation outside the composition root.

The independently versioned capability protocols do not need that compatibility
escape hatch. `ComposableModelProviderRegistrar`, `CredentialOperationOptions`,
`ToolSourceSnapshotOptions`, `RuntimeSkillLookupOptions`, and
`MemoryStoreOptions` therefore receive one required runtime-bound `SdkLogger`.
Core records each capability start, terminal status, and support-safe failure
whether or not plugin code logs anything; the injected logger exists only for
additional internal operational detail. It cannot replace the terminal ledger,
override correlation, or carry credential values, content, or raw errors.
`ObservationExporterPlugin` intentionally receives no logger because sending a
log through the exporter currently exporting logs would create a recursion path;
its failures are recorded by the owning observation bus instead.

Logger calls enter the same privacy, priority, queue, health and exporter path as
SDK events. Invalid/non-JSON fields fail synchronously at the caller boundary;
exporter failures are contained and become observation-health evidence rather
than exceptions from `logger.info()` or a replacement for the primary operation
error. No console sink is enabled implicitly. Low-level `Observability`,
`createObservability()` and `LoggerContext` remain preserved on the advanced
`core/observability` compatibility surface, but the normal runtime does not
accept a second mutable bus.

Caller-owned integrations need an explicit bootstrap rule to keep their own
connect, authentication, reconnect, serving, and teardown evidence on that same
path. Recommended runtime journeys create `AgentRuntime` first, then pass a
child `runtime.logger({ fields: { integration: ... } })` into MCP HTTP/stdio
clients or an A2A link before attaching it to `toolSources`/the runtime team.
They quiesce and close runtime work before closing or unlinking the borrowed
integration. Nested cleanup guards ensure an attempted runtime close cannot skip
integration cleanup. The post-runtime path uses capability-specific support-safe
reports instead of pretending the now-closed runtime logger can record teardown
or allowing cleanup to replace the primary run/connect failure.

The logger option remains optional on preserved direct-use MCP client, MCP Web
server, MCP stdio server, A2A client, and A2A server APIs. A standalone host may
provide its own `SdkLogger` or omit it; omission is supported and installs no
implicit console sink. When one of those capabilities is composed with
`AgentRuntime`, however, the recommended fixture and documentation must pass the
runtime-bound logger. Integrations may create child fields but cannot accept or
fabricate runtime/trace/span correlation identifiers. Observation exporters are
still excluded from logger injection because their recursion boundary differs
from these caller-owned integrations.

The first-party integration conformance matrix requires exactly one start and
one terminal log for each runtime-active logical operation below; a failure
terminal carries only a stable support-safe classification. Every network/process
retry attempt is linked to that logical operation rather than collapsed or
counted as a second logical call. Entries that intentionally happen after runtime
close use the structured report channel described below, not a logger.

| Integration | Required operation evidence |
| --- | --- |
| MCP HTTP client | connect, authenticate, catalog refresh, reconnect, tool call, close |
| MCP stdio client | connect, catalog refresh, reconnect, tool call, close |
| MCP Web server | request, tool call, agent call |
| MCP stdio server | request, tool call, agent call, close |
| A2A client link | agent-card resolve, link, send, stream, unlink |
| A2A server | request, execute, cancel, dispose |

Correlation uses two channels rather than incorrectly reusing the logger captured
at connection time for later runs. MCP lifecycle operations use the connection
logger, while each MCP tool execution uses the logger supplied through the
runtime-owned snapshot/tool-run context. A2A link/card lifecycle uses its option
logger, while `RuntimeAgentTeam` supplies the active operation logger on the
additive-optional `LinkedAgentSendInput.logger`; direct legacy transports remain
assignable. Server options supply a request child logger, and an embedded agent
run continues with its own run/span context. No integration accepts raw
runtime/trace/span IDs.

First-party packages type every emitted field object with
`IntegrationOperationEvidenceFields` from `core/observability`. Its discriminant
is one of `logical-start`, `attempt-start`, `attempt-terminal`, or
`logical-terminal`; attempt rows require stable attempt ID/number, and terminal
rows require status plus finite non-negative duration. Family and operation names
are at most 64 characters, operation/attempt IDs and support-safe error codes at
most 128, attempt numbering starts at one, and the logger message is a static SDK
string rather than user data. This common schema makes retries queryable across
MCP/A2A packages without moving their implementations into core or adding the
type to the curated core root.

Runtime close shuts down the observation bus and turns its logger into a no-op,
so it cannot be the evidence source for later caller-owned teardown. MCP HTTP and
stdio clients return `McpCloseReport`; Node MCP hosting returns
`McpNodeServerCloseReport`; A2A adds `A2AUnlinkReport` and `A2ADisposeReport`
without removing its existing `unlink()`/`dispose()` compatibility methods. The
recommended A2A path uses `unlinkWithReport()`/`disposeWithReport()` after runtime
close. These reports are bounded, idempotent and support-safe, retained beside
`RuntimeCloseReport`; the Universal Web MCP server remains inert and has no
fabricated teardown report.

These records are metadata-only: no credential, header, request/response body,
prompt, tool result, or agent-card content. They are operational evidence, never
token/billing authority. Provider token use remains exclusively in the core run
ledger even when an MCP/A2A operation caused the provider call.

`SdkLogger` is an operational event API, not an accounting writer or durability
receipt. Token/call/error truth remains in `RunTerminalRecord`/`RunReport`, and
required delivery remains in checkpoint/export acknowledgment. A successful
`logger.info()` means only that a valid event entered the bounded local path; no
consumer may infer token completeness, remote acknowledgment, or durable storage
from its synchronous return.

### 7.3.1 Integration trace completeness is an evidence claim

Required integration starts and successful terminals use `info`, and failure
terminals use `error`; `debug` is reserved for optional detail. The current logger
filters debug by default and normal-priority info events can still be evicted
from a full queue. Configuring `minimumLogLevel: 'warn'` intentionally suppresses
info evidence and therefore cannot produce a complete integration trace.

Keep the preserved `ObservationHealthSnapshot` unchanged. Runtime diagnostics and
close reports instead expose `RuntimeObservationHealthSnapshot`, an additive
projection with cumulative `integrationEvidence` counters:

- `accepted`: valid evidence records admitted to the local queue, not exported;
- `filtered`: recognizable evidence suppressed by minimum log level;
- `dropped`: previously admitted evidence later discarded by the queue;
- `rejected`: evidence refused at validation/admission.

Recognize and account for the integration envelope before level filtering. These
are runtime-lifetime, monotonic counters, not per-run receipts. A later drop does
not subtract from accepted; the counters are not mutually exclusive totals.
Counter overflow must never wrap to zero or permit a completeness claim. A
third-party plugin that emits nothing cannot be certified by zero counters.

No-loss counters are necessary but insufficient. A complete trace claim requires
conformance evidence for expected logical operations and physical attempts,
balanced start/terminal pairs, acknowledgment of their exact event IDs at the
selected delivery boundary, and separate post-runtime teardown reports. Missing
or unavailable evidence means incomplete or unknown, never success.
`ObservationDeliverySummary.complete` tracks critical checkpoints and does not
prove delivery of all normal-priority integration logs. It cannot be reused as
that stronger claim. Likewise, the default evictable diagnostic ring is a support
view, not a complete audit log; ring eviction does not itself imply an exporter
lost the same event. Core's authoritative token/call ledger remains independent.

### 7.4 Canonical accounting and terminal records

The ledger is the single accounting writer. Every provider-backed invocation—
normal generation, retry, overflow recovery, and compaction summarization—must
produce exactly one logical `ModelCallReport`; each physical transport attempt
appears exactly once beneath it. Stream/history `TokenUsage` is a projection,
not an independently summable source. Reported and estimated counters are never
merged into an apparently authoritative total, and input, cache-read,
cache-write, output, and reasoning buckets preserve their canonical semantics.
Cancellation/failure after possible dispatch retains an attempt with
`dispatchState: sent | unknown` and missing/partial coverage instead of silently
dropping it.

The current `warn | estimate | fail` missing-usage policy remains available
during the package move; it is not renamed merely for API aesthetics. Estimator
input is process-local, abort-aware through the owning run, and never retained or
exported. Estimates fill only absent buckets and always leave the report
non-authoritative.

An exporter-plugin batch may contain events from several runs and one run may cross
batch boundaries. Therefore `ObservationDeliveryBatch` carries `runRecords[]`, not one
batch-level usage value. `RunTerminalRecord` contains canonical accounting and
lifecycle data but deliberately excludes delivery state, so it can be staged and
checkpointed without depending on its own acknowledgment. After that checkpoint,
core creates the caller-facing `RunReport` by adding the final delivery summary;
neither value is mutated. Each `runId` appears at most once per batch, acknowledgments
name accepted run IDs separately from event IDs, and exporter retries reuse the
same batch/record identity. Operational event eviction does not remove the
terminal report from the run handle.

The advanced `core/observability` surface separately preserves the current
marker-free caller-owned `ObservationExporter`, `ObservationBatch`, `ExportAck`,
`ObservationExporterRegistration`, `Observability`, and `createObservability()`
contracts. Those names are not repurposed for runtime plugins. Named capability
factories return `ObservationExporterPlugin`; runtime delivery uses
`ObservationDeliveryBatch`/`ObservationDeliveryAck` and explicit
`RuntimeObservationExporterRegistration`. This keeps normal composition concise
while allowing the package move to preserve existing extension code.

P0-09 proposes a dual provisional default of 256 events and 1 MiB retained
serialized bytes, plus retained/evicted event and byte counters. The current
64 KiB per-event hard cap makes a count-only 256-event ring too close to the
entire sampled Edge heap budget. Owner approval and packed post-migration
re-measurement are both required.

### 7.5 Delivery modes

- `operational`: best effort; no durable exporter required;
- `reliable`: at least one required durable or acknowledged exporter;
- `audit`: fail closed at the already-defined critical checkpoints.

Existing boundary validation, privacy-before-fan-out, exporter health, and
content opt-in rules remain unchanged when moved into core.

Delivery mode and durability boundary are different types. Mode is
`operational | reliable | audit`; the only boundary vocabulary is
`none | local-durable | remote-acknowledged`. Every exporter declares
`supportedBoundaries`, and registration fails before ownership transfer when the
selected boundary is not supported. Factories and examples use the canonical
names directly—there are no `durable`/`acknowledged` aliases whose meaning changes
by package.

The base observation envelope retains run/trace/span IDs, a per-run sequence,
wall and monotonic timestamps, priority, phase, and structured attributes. This
is required even with metadata-only logging; otherwise batching/exporter plugins
cannot reconstruct order or diagnose a missing terminal operation.

### 7.6 Host tools and provider-native tools

The public event surface keeps two typed families:

- host `tool-call` / `tool-result`, owned and executed by the SDK tool pipeline;
- `assistant-native-tool`, executed by the provider and replayed as assistant
  content (for example web search or image generation).

Core preserves the merge-extensible `NativeToolSchemaMap` rather than replacing
it with `{ [option: string]: unknown }`. Built-in Web Search and Image Generation
have typed JSON-safe options; provider packages may augment the semantic map.
Runtime still validates every augmented definition as bounded deeply detached
JSON-safe data before model resolution. Functions, class instances, circular
objects, raw errors, credentials, and mutable host handles are rejected. Later
caller mutation cannot change the bound agent request.

`GenerateOptions.nativeTools` carries those exact definitions to the adapter and
wire protocol. `ToolChoice` is a discriminated union for host versus native tool
names. Model metadata uses the same `NativeToolName` vocabulary: an absent
capability list means unknown, while an explicit list is an allowlist and rejects
unsupported native tools before dispatch. Provider-native execution does not run
through the host tool scheduler or approval broker; deployments needing host
approval must use a host tool or provider policy that supports it explicitly.

UI adapters and telemetry count/project both families, preserve their native
identity, and never infer calls by parsing assistant prose. Where a provider only
emits a completed native item, the UI may show provider commentary as progress
but must not fabricate a start timestamp.

Both families expose a stable `callId` and a terminal status. Provider-native
events normalize status while retaining optional bounded `JsonValue` input/output
for the caller application stream. Base observations retain metadata only and do
not export those payloads by default. This lets a deep-search UI pair repeated
search/read calls, distinguish failure/cancellation, and render progress without
parsing Markdown or inventing lifecycle transitions.

### 7.7 Primary error and usage-coverage precedence

Every possibly billed attempt retains a usage coverage state even on failure.
However, a missing-usage policy applies as the terminal error only when no more
specific model/provider failure already explains the run. If dispatch fails,
HTTP authentication fails, or a stream truncates, that primary failure remains
the terminal reason and missing usage is reported alongside it.

The support-safe failure envelope includes stable code, stage, provider/route,
origin, HTTP status, provider request id, retryability, dispatch state, and usage
coverage when known. It excludes credentials, request headers/body, response
body, prompt, completion, and page content by default.

### 7.8 Streaming versus durable execution

Core owns the portable `run()`/event-stream lifecycle, cancellation, budgets,
operation ids, and serializable snapshots. It does not claim that an HTTP request
or isolate is durable. Resume/event persistence, queues, actors, workflow engines,
and background scheduling compose through explicit host capabilities. This keeps
deep research instruction-driven while allowing a deployment to persist and
resume it without putting a generic workflow engine in core.

`RuntimeAgentSessionSnapshot` is an explicit JSON-safe versioned envelope, not
`unknown`: it contains conversation/agent identity, validated append-only history,
bounded task memory, and activated-skill locators without loaded secret/resource
contents. Resume validates version, agent identity, bounds, event lifecycle and
skill ownership before allocating a runnable session. Runtime dependencies,
brokers, tool sources, stores, hooks, and credentials are always reinjected and
never serialized.

### 7.9 Web Platform baseline and preflight

“Universal” means the machine baseline in `topology.json`, not merely “contains
no `node:` import”. Core requires AbortController plus `AbortSignal.any/timeout`,
DOMException, streams/text codecs/URL, `structuredClone`, timers,
`crypto.getRandomValues`, and `performance.now`. Browser capabilities add
IndexedDB and lifecycle event registration. Node capabilities target Node
22.12+ and declare their concrete builtin closure separately.

`createAgentRuntime()` preflights the Universal baseline before provider marker
access, setup, or owned allocation and returns a stable unsupported-runtime
error naming only the missing feature. One internal platform adapter supplies
wall/monotonic time, random IDs, and bounded timers across core/agent/logging;
there is no `Math.random` identity fallback and no public host service locator.
All runtime-owned timers/listeners are cancelled on close. HTTP capabilities
continue accepting injected `fetch`; core itself does not acquire network I/O.

### 7.10 Edge website trust, session, and stream boundary

The default ChatGPT-like website has a static browser client and an Edge Worker
SDK host. The browser installs no SDK package and owns no provider credential.
The Worker composes core, one provider, and only selected Universal capabilities;
credentials enter through Worker bindings or injected Web-safe credential
sources. Direct-browser BYOK is a separate opt-in architecture.

The trusted host authenticates the principal before the chat adapter. A raw
browser conversation ID is never sufficient authorization. One collision-free
`(principal, conversation)` tuple selects one session and history; display mode
is excluded from identity. Deep-search activation maps a bounded host enum to
run-scoped `AgentRunOptions.additionalInstructions`. That overlay is appended to
the immutable agent definition, is neither history nor snapshot state, and does
not change the agent/session identity. Browser input cannot populate it directly.
The agent remains responsible for planning, searching, reading, repeated
evidence audits and deciding when its report is complete.

The overlay contract is exact rather than implementation-defined. If present it
must contain non-whitespace text and encode to at most 65,536 UTF-8 bytes. The
runtime validates and captures the exact string synchronously before run
admission, history append, ledger allocation, or any capability method. Empty or
oversized values fail with `RUN_ADDITIONAL_INSTRUCTIONS_INVALID`; the runtime
does not trim or rewrite an accepted value. System composition order is agent
instructions, lazy skill catalog, team collaboration instructions, run overlay,
then core-owned mode/control instructions. This keeps the host override useful
without letting it replace core lifecycle/control policy.

The captured overlay applies to every model request in that run, including
physical retries, later tool-loop steps and requests after automatic compaction.
Manual compaction outside a run uses base instructions only. The overlay is
discarded at terminal settlement and never enters history, memory, snapshots,
resume identity, later runs, default observations, diagnostics, errors, or
artifacts. It is still provider request content, so authoritative provider usage
and any local usage estimator must account for it. It conveys no authorization,
approval, tool/resource access, model selection, or budget authority.

The SSE adapter is an application boundary above the core event stream. It
projects only bounded public JSON, preserves the SDK `runId`, adds a monotonic
per-run sequence, and terminates exactly once with complete/failed/aborted plus
the support-safe run report. Raw exceptions, provider bodies and arbitrary tool
metadata do not cross it. EOF without terminal is an incomplete run. Request
abort, response cancellation and runtime close feed one owned abort path and
settle the session under a deadline; a concurrent request for the same session
is rejected before a second run starts.

`stream()` is eager and returns a single-consumer `RuntimeAgentRunHandle` with an
immediately stable `runId`, success-oriented `result`, independently awaitable
terminal `report`, and synchronous idempotent `abort()`. Aborting after terminal
is a no-op; abandoning event iteration aborts and settles under a bound. Success
resolves `result`; error/abort rejects it with a stable `AgentRunError` carrying
the same report, while `report` still resolves. The terminal usage/error event
also references that identical report. Raw abort reasons are control input only:
they are never inspected into observations, serialized, or reused as a
support-safe message. Session idle becomes true only after event, result, and
report settlement, and internal rejection handlers prevent process-level
unhandled rejections without consuming the caller-facing promises.

For the non-stream convenience path, preserved
`RuntimeAgentInvocationOptions.onEvent` saves callers from manually draining a handle
just to render progress. `run()`/`generate()` invoke it exactly once per event,
in order, and await each callback under the session's bounded observer timeout.
Callback failure aborts and settles the run, then rejects with the stable
observer code while retaining the canonical report; raw callback content is not
support data. `stream()` does not invoke the callback because its handle is the
event surface, and manual `compact()` has no run events. `onEvent` is application
delivery convenience, never a telemetry exporter or durability acknowledgment.

## 8. Core export design

The package should be complete without becoming a single undifferentiated entry.

Recommended exports:

| Export | Purpose |
| --- | --- |
| `@ai-agent-sdk/core` | common runtime, agent definition, messages, tools, run reports |
| `@ai-agent-sdk/core/agent` | advanced sessions, modes, teams, hooks |
| `@ai-agent-sdk/core/tools` | tool catalogs, approvals, interceptors |
| `@ai-agent-sdk/core/skills` | skill definitions/providers/catalogs |
| `@ai-agent-sdk/core/memory` | history, memory, compaction contracts |
| `@ai-agent-sdk/core/observability` | bus, logger, processors, exporter contracts |
| `@ai-agent-sdk/core/provider` | adapter, registry, provider author contracts |

Do not add a core `/testing` runtime export. Provider and capability conformance
utilities live in the separate dev-only `@ai-agent-sdk/testkit` package so
Vitest/fixture concerns cannot enter the core runtime closure. The first shipped
suite is framework-independent at runtime and is verified from a locally packed
third-party consumer; registry publication remains intentionally deferred.

The root export must remain useful but curated. It does not re-export every
advanced class merely because the code lives in one package.

The compile contract makes that statement measurable. `packages/core/index.d.ts`
is the declaration-only canonical owner used by every view, but it is not mapped
to a package export. The public root is a separate re-export-only facade. It
contains all 184 current core-root names for compatibility plus exactly 80
everyday additions for runtime/agent/session, inline tool and skill definition,
base logging, diagnostics, model catalog and run reports: 264 names total.
Moved legacy agent/team/history and mutable observability construction stay on
their focused subpaths unless explicitly listed as ergonomic additions. Official
capability declarations also import focused subpaths rather than treating root
breadth as an undocumented author API.

The exact future export maps for core and auth-node live in the compile
contract's `manifest-blueprints.json`. Core emits one curated root entry and six
explicit focused entries; its canonical owner has no package export. Auth-node
emits root, `/env`, and `/codex`, with root and `/env` preserving identity and
only `/codex` associated with the optional provider peer. Every code route has
`types`, `import`, and `default` conditions; wildcard and CommonJS routes are
forbidden.

## 9. Bundle and dependency budgets

The reproducible 2026-09-02 baseline is:

```text
core             119,088 raw / 33,924 gzip bytes
agent            301,415 raw / 71,668 gzip bytes
observability     41,953 raw / 10,534 gzip bytes
current sum      462,456 raw / 116,126 gzip bytes

contract Worker   40,086 raw / 11,982 gzip bytes
basic agent      226,342 raw / 62,928 gzip bytes
```

The isolated Worker bundles use current source ownership plus the proposed
composition root, not a future packed core tarball. They establish migration
budgets but do not pre-approve the final artifact.

The initial merged package must satisfy:

1. zero third-party runtime dependencies;
2. packed Universal closure contains no Node package or built-in;
3. full merged package runtime gzip does not exceed 127,739 bytes (the clean
   three-package sum plus 10%) without an ADR;
4. the isolated tree-shaken basic Edge agent stays at or below 70,000 gzip bytes;
5. the contract-only Edge fixture stays at or below 14,000 gzip bytes and does
   not initialize agent or observation runtime state;
6. importing only core messages/provider contracts does not initialize agent or
   observation runtime state;
7. all entry points are side-effect free;
8. strict workerd fixtures explicitly unset `Buffer` and `process`, because
   modern workerd may expose them without a Node compatibility flag;
9. emitted bundles contain zero unresolved external imports and `node:*` built-ins;
10. the bounded diagnostics stress fixture retains exactly its configured limit
    and reports eviction;
11. sampled workerd used heap stays within 4 MiB for contracts, 16 MiB peak for
    basic-agent, and 8 MiB basic-agent delta; the report labels this sampling and
    does not claim an allocation-complete or post-GC retained bound;
12. peak budgets and the default diagnostics capacity are re-frozen against the
    packed post-migration artifact.

These are migration budgets, not permanent claims. Later releases establish
their own tracked baselines.

## 10. Package tiers and version policy

### 10.1 Tiers

| Tier | Audience | Examples |
| --- | --- | --- |
| Product | normal application developers | core, official providers, skills, MCP, exporters |
| Extension kit | third-party integration authors | provider HTTP helpers and protocol contracts |
| Internal | repository implementation only | generated wire helpers that are bundled, not imported by consumers |

Every workspace package must be assigned one tier before publication. An
internal package cannot be a runtime dependency of a published package unless it
is bundled into that package or promoted to a documented public/support tier.

### 10.2 Peer dependencies

Official capability packages declare a compatible peer on core and an exact
workspace development dependency. For the `0.x` line, a plugin supporting one
core minor uses a bounded range such as:

```json
{
  "peerDependencies": {
    "@ai-agent-sdk/core": ">=0.2.0 <0.3.0"
  }
}
```

Applications install core explicitly. Peer ranges plus runtime API markers make
version mismatches visible instead of silently installing a second core identity.

Official packed closures must resolve exactly one physical copy of core, not
merely one semver range. The package/conformance gate records the resolved path
for core from every runtime-emitting provider/support package, rejects nested
normal dependencies or bundled core implementation, and proves root/subpath/
bridge re-exports are the same runtime values. API family markers express
protocol compatibility; they are not a substitute for canonical core identity.

At the same time, plugin boundaries must not use nominal class identity as their
validation gate. `ModelAdapter` remains an advanced authoring convenience, but a
registrar validates its required methods/data structurally and never rejects only
because `instanceof ModelAdapter` is false. Provider/capability errors cross the
boundary as a bounded validated data envelope: own data properties only, matching
error/failure codes, valid status/retry/request-id fields, and no getter
execution. Unknown or malformed foreign errors normalize to `UNKNOWN`; they
cannot inject a trusted retry code. I4 removed the inventoried two
`instanceof AgentSdkError` and two `instanceof ModelError` boundary checks from
`provider-http`; the contract inventory now requires all four counts to remain zero.

Core does not register a `Symbol.for` singleton or otherwise mutate global state
to detect duplicates. Such a detector would make unrelated applications,
microfrontends, tests, and isolated runtimes interfere with one another and would
still not cover separate realms. Duplicate official closure is an install/pack
failure; structural boundary handling is defense in depth, not support for an
arbitrary multi-core application topology.

Supporting HTTP/protocol packages may be normal dependencies of official
providers because they own implementation. However, any supporting package that
imports a runtime value from core must itself declare core as a peer, never as a
normal dependency. For example, `provider-http` subclasses core adapters and the
wire translators construct core errors/IDs; provider packages may depend on
those helpers, while every helper's core edge remains a bounded peer. A wire-only
package may omit the peer only when emitted-code inspection proves all core
imports are type-only and erased.

The source-manifest encoding is mechanical, not left to each implementation
slice. `normalWorkspaceDependencies` become `dependencies` using `workspace:^`.
Every non-core package's core edge becomes `peerDependencies` using
`workspace:^`, with a matching development dependency so local build/type
resolution never relies on root hoisting. `optionalWorkspacePeers` use the same
peer protocol and must also appear in `peerDependenciesMeta` with
`optional: true`. External runtime dependencies resolve from the exact strict
catalog; required and optional external APIs remain peer ranges with exact
catalog-backed development resolutions, and optional ones receive the same peer
metadata. Packing may rewrite workspace/catalog protocols, but may not change
the topology role or resolved exact external version.

Every package packs `dist`, `README.md`, and `LICENSE`. `auth-node` additionally
packs `bin` and retains exactly one executable mapping:
`ai-agent-sdk-codex-login` to `./bin/ai-agent-sdk-codex-login.mjs`. Root `main`
and `types` compatibility fields mirror the root conditional export; they never
point to a second build. The Node engine floor applies only to packages whose
topology runtime is Node, so Universal/Browser packages do not falsely advertise
a Node runtime requirement.

An optional subpath must not force an unrelated capability closure. In
particular, `@ai-agent-sdk/auth-node/env` must not make an OpenAI/Anthropic
consumer install the Codex provider merely because the same package also exposes
`/codex`. In the target graph, core is a required peer and `provider-codex` is an
optional peer used only by the `/codex` subpath; the Codex recipe installs both
packages explicitly. The package root exports only the env credential source;
it must not statically re-export `/codex`, because an ESM re-export resolves the
optional peer even when the caller never uses Codex.

### 10.3 Capability metadata

Each official package adds machine-readable, non-executable manifest metadata:

```json
{
  "aiAgentSdk": {
    "roles": ["skill-provider"],
    "runtime": "node",
    "coreApi": 1
  }
}
```

Roles are an explicit bounded vocabulary because one package may expose more
than one related capability—for example MCP client plus tool source, Node
observation exporter plus diagnostics, or credential source plus store. The
18-package mapping and 16-role vocabulary live in topology. Build/docs/release
scripts validate this field. Runtime code never scans packages or auto-loads a
capability from it.

### 10.4 Target dependency closure

Normal consumers install only the packages in the **Direct selection** column.
Support packages remain transitive implementation details, while peers must be
satisfied by the application's explicit selections.

| Package/family | Direct selection | Bounded peers | Normal implementation dependencies |
| --- | --- | --- | --- |
| `core` | always | none | none |
| `provider-openai` | when selected | `core` | `provider-http`, `protocol-responses` |
| `provider-anthropic` | when selected | `core` | `provider-http`, `protocol-anthropic-messages` |
| `provider-codex` | when selected | `core` | `provider-http`, `protocol-responses` |
| `provider-http` | no; extension authors may select | `core` | exact `eventsource-parser` |
| `protocol-*` | no; extension authors may select | `core` while runtime values are imported | no third-party runtime dependency |
| `skill-filesystem` | when selected | `core` | none |
| `mcp` | when remote MCP client is selected | `core` | MCP client closure only |
| `mcp-server` | when a Universal MCP server is hosted | `core` | MCP server closure only |
| `mcp-node` | when stdio MCP client is selected | `core` | `mcp` plus stdio client closure |
| `mcp-node-server` | when Node MCP hosting is selected | `core` | `mcp-server` plus Node server adapters |
| `observability-*` | when selected | `core`; OTEL APIs where applicable | only exporter-owned closure |
| `auth-node` | when selected | `core`; optional `provider-codex` for `/codex` | none of the provider packages |
| `a2a` | when selected | `core` | A2A SDK closure |

This table is normative for migration reviews. The current manifests do not yet
match it: they use normal workspace dependencies throughout, `auth-node` normally
depends on Codex, and skill/MCP/exporter packages still point at the split agent
or observation layers. A working current bundle does not close that migration.

The staged packed auth closure validates the target manifest/root policy without
changing product source: env-only falls from six installed runtime packages and
998,762 bytes to two packages and 517,466 bytes, with no external runtime package.
The full Codex recipe restores the provider/protocol/transport closure only when
selected. `/codex` without the optional peer must fail with an error naming the
missing package; silent fallback or implicit provider installation is forbidden.

### 10.4.1 Public type closure and MCP portability decision

A package's runtime closure and TypeScript declaration closure are separate
requirements. An HTTP implementation can use only Web APIs while its declaration
imports a Node-only type. Tree-shaking a runtime bundle does not establish type
portability. `types: []` also does not prevent a dependency's explicit reference
from loading Node typings, so inspect the actual compiler file closure.

Local evidence: MCP client/server 2.0.0 root declarations export the shared-stdio
`ReadBuffer` class with `append(chunk: Buffer): void`. Their public export maps
do not provide an HTTP-only type route. The target SDK's HTTP options, advanced
connection, request-context and server types refer to those upstream roots.
Strict full-Web compilation therefore has two errors even though the consumer
did not select a Node capability. An alias or a new convenience helper in the
same declaration does not isolate it. This finding does not, by itself, prove a
Node dependency in emitted HTTP runtime code.

Recommended resolution for P0-12/I8:

1. Prefer a versioned upstream correction that keeps Node stdio declarations
   outside the HTTP declaration closure, or makes the shared declaration genuinely
   Web-compatible without altering required behavior. Verify the actual corrected
   release before changing the pinned dependency. No such correction is verified
   by this audit; no dependency update or upstream submission is authorized here.
2. If upstream cannot supply that boundary, review an SDK-owned portable public
   type boundary before implementation. Inventory every exposed upstream type,
   preserve accepted inputs, return types, overloads, class/private-member identity
   and advanced escape hatches, then prove compatibility from installed artifacts.
   An owned wrapper that still names the upstream root does not solve the problem;
   copied structural approximations do not establish class compatibility.
3. Keep the 18-package/32-specifier composition unless the owner explicitly
   approves a different migration. Do not add a blanket Node dependency, another
   Web facade/install step, or silently remove existing advanced exports. If the
   compatibility requirements cannot coexist with a portable boundary, surface
   that conflict for owner decision; do not claim full Universal support.

Do not modify installed dependency files, import private hashed declaration
chunks, add an ambient Buffer shim, or waive declaration checking as acceptance.
The two-diagnostic design baseline makes the open issue visible; it is not a
waiver for the final gate.

Resolution (2026-09-05): the reviewed fallback in item 2 is implemented. The
Universal MCP client/server declarations now expose SDK-owned structural Web
types for negotiation, HTTP/SSE options, transport, raw protocol access,
request/call context, server and handler facades. Runtime code continues to use
MCP 2.0.0 internally. `withClient` retains a typed common protocol facade plus
an explicit generic escape hatch; existing upstream transports remain
structurally assignable. No dependency file, ambient global or private hashed
route is part of the solution.

Acceptance evidence now includes strict target NodeNext and no-Node-types Web
declaration compilation, a tarball installed in an isolated project with
`skipLibCheck: false`, Node `Buffer` stdio parsing, and packed Node, Chromium and
Workerd runtime journeys. The temporary pnpm patches used during diagnosis were
removed after proving that package-manager patches do not propagate to tarball
consumers. The emitted public declarations contain no MCP upstream import or
`Buffer` reference.

Acceptance requires all supported Universal public routes, including MCP root,
`/client`, `mcp-server`, and the `/server` compatibility view, to compile strictly
from installed artifacts with `types: []`, no workspace `paths`, no Node typings
in the compiler closure, and no diagnostic baseline. Exercise Bundler resolution
with `workerd` and `browser` conditions separately. Node consumers must also pass
NodeNext resolution with explicit Node types and preserve advanced API identity.
These type checks supplement, never replace, packed host-runtime acceptance.

## 11. Revised package migration map

| Current package | Target action |
| --- | --- |
| `@ai-agent-sdk/core` | receive agent and base-observability source |
| `@ai-agent-sdk/agent` | remove after source move and import migration |
| `@ai-agent-sdk/observability` | remove after source move; exporter packages point to core |
| provider packages | peer on core; retain explicit plugin factories |
| `@ai-agent-sdk/provider-http` and protocols | classify as extension/support packages; normal dependencies of providers, but bounded core peers wherever runtime values are imported |
| skill filesystem | change contract import from agent to core skills subpath |
| MCP | change tool/core imports to canonical core subpaths |
| observation exporters | change exporter/bus type imports to core observability subpath |
| auth | retain capability package; peer on core, make provider-codex optional for `/codex`, and keep `/env` free of that closure |
| A2A | point agent/team types to core while retaining its Node classification |
| `@ai-agent-sdk/node` | remove; migrate human harness to explicit capabilities |
| `ai-agent-sdk` | remove if repository consumer audit finds no required external compatibility |

Audit correction: removing the top-level `@ai-agent-sdk/node` facade is the
important usability change. Names such as `mcp-node`, `auth-node`, and
`observability-node` already identify a feature plus its runtime and do not need
to be renamed during the core merge. Splitting them should require a separate
security or ownership reason. In particular, exact-wire diagnostics may justify
a later split from the JSONL journal, but that is not a blocker for this package
model.

## 12. Source-move constraints

Moving agent and observation code into core is a source ownership operation, not
a facade re-export operation.

- do not make core depend on the current agent or observability packages;
- use `git mv` and rewrite imports to core-relative module boundaries;
- keep the current zero-workspace-cycle rule;
- run the source ownership cycle checker after every domain move;
- preserve runtime object identity: there is one `ModelRegistry`, one underlying
  session implementation owner, one skill catalog/provider implementation owner,
  one observation event schema, and one run ledger implementation; focused
  compatibility and `Runtime…` interfaces are projections, not duplicate state;
- do not leave compatibility copies in both packages;
- treat every current public export as preserved by default; a removal requires
  a stable decision, replacement/rationale, consumer migration and owner approval;
- temporary re-export packages, if needed during migration, may depend on core but
  contain no implementation and must have a deletion milestone.

The safest order is:

1. add target core subpaths and move base observability;
2. move agent definitions/tools/skills/history in cohesive domain commits;
3. move run ledger and session/runtime binding last;
4. repoint capability packages;
5. migrate fixtures and human tests;
6. delete empty facades and update graph allowlists.

The first two ownership moves are exact atomic states, not a sequence of merged
half-packages. `source-migration.json` maps seven files from base observability to
`core/src/observability` and 49 files from agent to `core/src/agent`. The existing
`core/src/observation` directory remains the low-level contract/port layer.
Within I1/I2, dependencies may be edited in the recorded dependency-first order,
but the accepted slice moves the complete root, rewrites every public-core
self-import to a relative internal owner, and replaces the old package source
with its exact route-complete re-export-only bridge in the same change.
Observability retains only its root route; agent retains both its root and the
existing `./skill-validation` route, which forwards to `core/skills`. The machine state advances
`pending` to `moved`; partial cross-root ownership is never a valid checked state.

The implementation ledger refines this into I0–I8 mergeable states in
[`core-capability-implementation-todo.md`](./core-capability-implementation-todo.md).
The temporary agent/observability packages in those states are re-export-only
bridges with mandatory deletion milestones, never alternate implementation
owners or a reversal of the target package decision.

The authoritative pre-move API inventory is
[`../design-contracts/core-capability-v1/api-migration.json`](../design-contracts/core-capability-v1/api-migration.json).
It freezes 417 current public API export occurrences and their declaration
signature hashes: 184 core-root exports remain on `core`, 207 agent-root exports
move to `core/agent`, 24 base-observability root exports move to
`core/observability`, and the two exports available only at
`agent/skill-validation` move to `core/skills`. The only proposed removal is
`DEFAULT_AGENT_CALL_CONFIG` under P0-02 because its implicit provider/model default
contradicts the new composition contract. A compile journey is representative,
not an API deletion allowlist. Before each bridge deletion, an API-report diff
must prove every non-removed baseline symbol exists at its assigned target
specifier with compatible value/type identity and signature.

The core ownership move now has complete name ownership. Its machine-resolved
target parity inventory is zero at `core`, `core/agent`, `core/skills` for the
former skill-validation subpath, and `core/observability`. Counts plus sorted-name SHA-256 are frozen so that part of
the gap cannot drift invisibly. The broader package migration is now name-parity
ready: a second ledger freezes 19 retained entrypoints and 344 export
occurrences, with zero now absent after wire protocols, observability
capabilities, split MCP routes, Auth/Codex, and A2A reached name parity and passed
focused same-source dual compiles. Owner approval and the remaining signature
fixtures are still required before I0. The core
inventory was closed through one internal canonical declaration owner and
focused re-exports, not duplicate subpath owners or undocumented removals.

Existing public subpaths are compatibility routes, not implementation details:
`a2a/client`, `a2a/server`, `mcp/client`, `mcp/server`,
`observability-node/journal`, and `observability-node/diagnostic` remain explicit
exports. MCP `/server` is an optional-peer view over `mcp-server`, preserving the
old import path without putting the server closure into normal MCP clients.

Subpaths are routing views, not new type owners. The current 417-symbol baseline
has exactly one cross-package name collision: agent re-exports core's
`AgentMessageSource`. Its canonical owner remains the core implementation; both
the curated root and `core/agent` re-export that same identity. The same rule applies prospectively to
`core/tools`, `/skills`, `/memory`, `/observability`, and `/provider`: they may
offer focused imports for ergonomics, but their declaration files contain only
re-exports from the canonical core implementation. Duplicate interfaces/classes,
wrapper constructors, or subpath-local singletons are forbidden.

Core message/content compatibility uses a same-source dual compile rather than
comparing two aliased branded modules directly. The latter would manufacture two
private `unique symbol` identities and report an incompatibility that does not
exist when the canonical `@ai-agent-sdk/core` package is upgraded in place. The
first dual compile covers 45 message/content/brand symbols. A second covers
the remaining 67 core provider/retry/error/registry/utility names plus 15
already-present signature-sensitive types. Both current and target accept the
same marker-free advanced plugin and adapter-subclass source. The sole
cross-package collision, `AgentMessageSource`, is now actually re-exported from
`core/agent`. Four further same-source fixtures cover tools (25 restored/14
signature-sensitive), skills (21/9), memory/history/compaction (28/7), and
accounting/trace (16/8), loop/definition (27/15), and team/messaging (25/2).
All four target parity inventories are now zero. Existing `AgentDefinition`,
`AgentRunEvent`, `AgentSession`, and `AgentTeam` semantics remain advanced
compatibility surfaces; composition-root protocols use distinct `Runtime…`
names so convenient new factories do not repurpose established contracts.

## 13. Conformance design

A plugin ecosystem needs reusable conformance suites before third parties are
encouraged to publish packages.

Required suites:

- provider: transactionality, route conflicts, abort, retry accounting, malformed
  usage, missing usage, streaming bounds, cleanup, redaction;
- run accounting: disjoint cache/reasoning counters, retry attempt identity,
  missing/estimated coverage, cancellation at each dispatch boundary, overflow,
  compaction calls counted once, terminal-report identity, and multi-run exporter
  batching without cross-run totals;
- skill provider: bounded discovery, stable candidate ownership, lazy load,
  resource traversal rejection, abort, duplicate ids;
- observation exporter: acknowledgment identity, retryability, staging,
  shutdown, deadline, durability-boundary honesty, privacy-before-export, and
  native-fetch redirect semantics;
- MCP/tool source: family mismatch before method access, atomic per-invocation
  snapshot, two live sources, namespace collision, advertised-missing definition,
  catalog/result bounds, reconnect visibility on the next invocation, cancellation,
  caller-owned close, endpoint policy, and native redirect/header escape;
- credential store/resolver: secret redaction, refresh race, atomic persistence
  where applicable, no implicit global credential paths.

The dev-only `@ai-agent-sdk/testkit` package contains deterministic,
framework-agnostic helpers and fixtures and has no runtime dependency on a test
runner. Its provider suite covers the required transactionality, conflict,
abort, retry/usage, stream-bound, cleanup and redaction cases; official-provider
adapters remain separate conformance work.

Privacy tests assert exact field absence or use a long sentinel containing
characters outside every generated identifier alphabet. They never search a
whole report containing random run/trace/span/attempt IDs for a short token such
as `bad`. A focused pass after a random collision diagnoses the oracle but does
not erase the initial suite failure; the oracle is fixed before claiming green.

Every suite first rejects an absent or unsupported family marker before calling
the capability's methods. Packed skill-provider coverage must include both a
Universal injected-fetch implementation and a Node filesystem implementation;
the same consumer bundle must prove the Node selection visibly introduces its
`node:*` boundary.

## 14. Migration acceptance gates

Implementation is complete only when all of the following hold:

1. a new Edge consumer installs only core and one provider and runs an agent;
2. core alone installs no `eventsource-parser` or other third-party runtime code;
3. provider installation brings only its owned transport/protocol closure;
4. a minimal Node HTTP app uses the same two-package install as Edge;
5. the coding harness declares filesystem, MCP stdio, auth, and journal packages
   explicitly and imports no Node facade;
6. each agent resolves to its own explicit or configured-default model, with no core-owned defaults or silent failure-time switching;
7. one runtime injects one canonical registry and observation instance;
8. runtime close produces bounded, complete lifecycle evidence;
9. core strict Worker, Chromium, and standards fixtures pass from tarballs;
10. every capability's packed manifest and runtime metadata match its tests;
11. package graph, source graph, dependency cruise, supply-chain, type, API,
    publint, ATTW, and human acceptance gates pass;
12. documentation contains no install example for a package that does not exist;
13. the Edge website keeps browser credentials out of scope, binds conversation
    identity to a trusted principal, preserves one history across deep-search
    activation, and visibly rejects incomplete/lost terminal streams.
14. installed public declarations pass strict NodeNext and Web/Bundler checks
    without workspace path aliases; Web conditions load no Node typings, and the
    MCP type-portability debt in 10.4.1 is resolved with no diagnostic waiver.

## 15. Owner-approved decisions

The authoritative choices and recommendations are the fourteen stable IDs in
[`core-capability-phase0-approval.md`](./core-capability-phase0-approval.md):

- P0-01 through P0-02: composition names and model target;
- P0-03 through P0-04: package map and facade removal;
- P0-05 through P0-08: executable markers, typed slots, auth, and core peers;
- P0-09: dual event/byte diagnostics budget;
- P0-10 through P0-14: factory grammar, Node wire ownership, supported runtime
  matrix, A2A scope, and MCP client/server closure.

The owner approved P0-01 through P0-14 with the model-default amendment in 4.1.1.
The JSON record is `approved`. A static gate rejects a drift
between those IDs and this review record, or an approval without owner/time
attribution.

None of these decisions requires restoring a top-level Node facade or splitting
the core agent runtime again.

## 16. Remaining design artifacts before source changes

No third broad architecture document is needed. The three review artifacts now
exist at different approval levels:

1. ADR 0002 records the approved package removals/retentions and the explicit
   provider-default amendment; implementation remains staged, not completed;
2. the original declaration fixture records the detailed shape, while
   [`../design-contracts/core-capability-v1/`](../design-contracts/core-capability-v1/)
   compiles direct imports for minimal/extended Edge, minimal Node, Node env-auth,
   and full Node journeys plus negative contracts, stream/tool/usage projection,
   correlated safe errors, observation health, runtime elevation, facade
   inventory, and a third-party Universal provider author journey; its names are
   recommended, not yet frozen. A core-only author journey separately proves the
   skill-provider, observation-exporter, and live tool-source families. The
   machine topology covers all eighteen retained target packages and their full
   dependency/peer/runtime-tier rules;
3. historical reports establish provisional current bundle, strict Worker heap,
   and bounded-diagnostics baselines; final values can only be exit evidence from
   the packed post-migration artifact.

Therefore the design is technically deep enough to implement, but source changes
remain unauthorized until the Phase 0 owner decisions are accepted. Exact package
exports, migrated dependency closure, and runtime acceptance are exit gates, not
additional design documents.

Automated continuation of this work uses static graph/import audits, compile-only
contracts, deterministic tests, and the maintained bundle benchmark. Superseded
prototype scripts were removed; provider/network/runtime acceptance uses the
bounded human harness.

The exact-wire diagnostic package question is a separate security ADR and does
not block core composition unless the implementation attempts to rename or split
that package in the same change.

## 17. Executable design evidence

The isolated prototype was audit evidence only and was never exported by a
package. Its source was removed after the maintained test suites absorbed the
coverage. On 2026-09-02 it proved:

- awaited construction rolls back prior provider registrations and awaits owned
  observation shutdown after a later provider fails;
- explicit `{ provider, id }` model targets and fixed-capacity diagnostics work;
- close is idempotent, bounded, and rejects new work;
- a live Codex call through the proposed composition shape and API-v1 marker
  discovered 9 models,
  reported 155 input and 11 output tokens with complete authoritative coverage,
  emitted 18 metadata-only correlated lifecycle events, and closed cleanly.

The spike also exposed the provider-specific medium-effort default recorded in
section 4.1. A frozen consumer declaration compiles, provider API mismatch is
rejected before setup/allocation, and isolated bundles run in strict workerd at
11,982 gzip bytes for contracts and 62,928 for a basic agent. Sampled workerd
peaks are 915,692 bytes for contracts and 6,041,364 bytes for the basic agent;
the report explicitly does not claim allocation-complete or post-GC retained
heap. Packed target tarball identity, direct authenticated Edge provider success,
and external target-runtime testkit consumption remain unproven. A locally packed
provider already passes the current public registry contract with scripts
disabled, bounded peer metadata, complete usage, cancellation, and cleanup.

A second packed consumer now installs Universal and Node skill-provider tarballs
with install scripts disabled. The Universal closure is 7,525 gzip bytes, has no
external import or Node builtin under AST-based emitted-code inspection, runs in
strict workerd, preserves discovery-before-activation, rejects traversal/foreign
candidates, observes abort, and uses portable manual no-follow semantics. The
Node provider loads a confined directory, and its attempted Edge bundle exposes
`node:fs/promises` and `node:path` exactly as the runtime-elevation rule requires.
Both executable providers carry the proposed skill-family API marker. They still
peer on the current `agent` package as well as core; the core-only target peer is
unproven until source ownership moves.

A third packed consumer installs an external Universal observation exporter. Its
32,937-byte raw/10,330-byte gzip closure contains no external import or Node
builtin, runs in strict workerd, retains authoritative usage while excluding a
prompt and access token, retries an identical body/idempotency key, rejects a
mismatched acknowledgment, preserves abort, rejects an API-v2 value before method
execution, and shuts down exactly once. A paired native-fetch negative proves the
current `observability-fetch` still sends `redirect: 'error'`; workerd rejects it
and the exporter reports a retryable transport failure. The existing mock-fetch
runtime matrix did not cover this host semantic.

A fourth packed consumer now exercises the current MCP packages and the proposed
tool-source shape. The current public `AgentSession` snapshots an empty live
catalog at construction: a tool registered afterward appears in the source but
not in the first model request and is never executed. The audit-only composer
then combines two real namespaced stdio MCP servers, dispatches both results,
tracks each caller-owned close live, rejects a duplicate name, and rejects API-v2
before calling source methods. A packed Workerd native-fetch negative proves both
MCP HTTP defects: `allowRedirects: false` emits unsupported `redirect: 'error'`,
while the default follow mode contacts an unallowed second origin and forwards a
fixture capability header before final-URL validation rejects it. The target is
therefore per-invocation live snapshot plus manual pre-hop redirect validation,
not the current `tools: connection.tools` copy.

The live Edge fixture further proved an 80,676-byte gzip Codex/provider closure
with no external/Node import and `eventsource-parser` bundled. It also exposed the
portable redirect, empty catalog, and upstream Cloudflare HTML HTTP-403 gaps
defined in sections 4.5 and 7.5. The provider currently maps that response to
`AUTH`, but the audit does not claim the intermediary HTML is an API auth error.
The Node deep-research control passed with seven native searches,
28 URLs, five domains, and complete usage for two provider attempts.
