# I3 progress — Provider preflight, model selection and activation

Status: **Partial I3 implementation, not a completed composition runtime.**

## Implemented source

Seven internal modules under `packages/core/src/composition` provide:

- Domain-local metadata bounds and model-selection error codes.
- Own-data-property validation for inert metadata, bounded UTF-8 strings and
  dense arrays, plus one-time method capture preserving the original receiver.
- A support-safe construction error envelope with conflict indices and cleanup
  records, excluding raw thrown objects and abort reasons.
- Separate provider identity and method-capture phases. The second phase must be
  called only after every runtime namespace, including exporters, is validated.
  A successful capture is cached; a failed partial capture cannot be retried.
- Detached per-route defaults and per-agent model resolution: full target wins,
  route-only uses only that route's default, omission selects an explicit runtime
  route or the unique configured default. Missing/ambiguous/invalid configuration
  fails; no catalog lookup, registration-order choice or error-time failover exists.
- Claim-scoped activation against the real `ModelRegistry`, with setup-only
  registration/replacement, exact claim coverage, required setup logger injection,
  sealed post-setup mutation handles and synchronous idempotent cleanup.
- Reverse-order rollback, asynchronous-result rejection/containment and cleanup
  evidence that cannot replace the primary failure with a cleanup-triggered abort.

Metadata limits currently live in `common/config.ts`: 128 providers, 128 routes
per provider, 256 UTF-8 bytes per identity, and 1,024 bytes per display/model ID.
These are bounded implementation policies, not provider/model defaults. Slashes
in explicit model IDs remain supported. Conflict keys are redacted; component
cleanup IDs currently use input indices (`provider-0`, etc.) rather than echoing
arbitrary caller strings into support reports.

All seven implementation files are below 200 lines. Existing public entrypoints
and the I2 emitted API snapshot are intentionally unchanged: these modules are
not yet the public runtime constructor or final package API.

## Evidence collected

- Core source `typecheck`: passed, including all new composition modules.
- Focused composition tests: three suites, 68 tests passed.
- Whole-workspace `tsc --noEmit`: passed after the corrections below.
- Whole-workspace `pnpm build`: all 20 packages passed; no public API snapshot
  update was needed because the new internal modules are not public entries yet.
- Core package tests after the build: 25 suites, 410 tests passed.
- Final root typecheck and unit run after that build: 60 suites, 707 tests passed
  at 23:45 local on 2026-09-04. Builds and dependent tests were sequential.
- Package graph: 20 packages/61 edges, zero findings; emitted dependency check
  68 modules/136 dependencies, zero violations.
- Core source ownership graph: acyclic, 14 groups/53 edges.
- Agent boundary: 12 groups/32 edges, passed.
- Runtime boundary scan: 13 Universal/Browser packages, 215 source/emitted files,
  zero findings. This is a boundary scan, not actual Edge-host execution.
- Contract/API gate: passed with the unchanged I2 declaration snapshot. The two
  tracked upstream MCP full-Web declaration errors remain unresolved, not a
  full-Web pass. Documentation gate: 47 Markdown files/20 package READMEs passed.
- `git diff --check`: passed.

The tests cover same-family account routing, separate identity namespaces,
duplicate/empty/oversized metadata, exact multibyte limits, accessor rejection,
descriptor read counts, identity/default/method mutation, class receivers,
partial-capture failure, abort-before-access, setup/cleanup failure and async
returns, late registrar access, invalid route replacement, exact coverage, reverse
rollback and preservation of the primary failure. One case dispatches through the
real registry and verifies the explicit model/account in its canonical call report.
The adapter is deterministic and performs no provider network request.

## Retained failures and corrections

- The initial activation-module typecheck found two implicitly typed parameters
  on a frozen registrar object. Added explicit route/adapter types and passed.
- The expanded root typecheck found an intentionally invalid async-setup fixture
  needing an explicit `unknown` bridge for its negative test, plus a possibly
  absent declaration route in the contract checker. Fixed both without relaxing
  compiler options.
- Root typecheck also found two I2 private-source test files mixing source types
  with emitted package types. This produced distinct branded IDs and private
  registry declarations. Both tests now import their collaborators from the same
  source owner; no nominal/brand casts or compiler waivers were introduced.
  I2's earlier package typechecks and runtime tests had not covered this root
  test-source typecheck. The new full-root check passes.

## Remaining integration work

I3 stays open. Subsequent [platform/lifecycle work](./I3-platform-lifecycle.md)
implements internal feature preflight, managed resources and operation quiescence,
and fixes the distinct async-cleanup report code. The 68-test results above remain
the historical provider-foundation checkpoint, not the latest total.

The public async constructor, cross-family exporter readiness and ownership
rollback, author helper, public operation-lease integration and deadline-aware
close, bound agents/sessions, logging/diagnostic delivery, memory,
skills, tools and the rest of the approved contracts still require implementation
or wiring. Provider activation currently receives a registry and logger from its
internal caller; it is not an alternate user-facing runtime or a replacement for
the approved `createAgentRuntime()` architecture.

Browser/workerd, autonomous deep-search and persistent human-built application
acceptance remain tracked separately in the full ledger. A later section records
the completed live Codex provider usage/correlation acceptance.

## Follow-up: focused provider author route and logger contexts

The public core/provider and core/tools focused routes are now emitted beside
the existing agent, memory, skills and observability routes. A side-effect-free
defineModelProviderPlugin helper captures inert claims and the author setup
method once, then supplies a logger-bearing claim-scoped registrar: a one-adapter
author can omit routes, while explicit multi-adapter subsets remain constrained
by the preflighted claims and exact-coverage rollback.

Credential source/store contracts and author helpers now require operation
options with both AbortSignal and canonical SdkLogger. Together with provider
setup, tool-source snapshot, skill-provider operations and memory-store
operations, all five versioned contexts require the same logger type. The
focused provider/tools/skills/memory routes re-export that canonical type.

Verification:

- 413 tests / 34 composition suites pass, including provider helper exact
  coverage/rollback and credential method-capture/receiver tests.
- Strict workspace typechecking and the core build pass.
- The core packed-package gate installs the generated tarball into isolated
  consumers and NodeNext-compiles a third-party-style consumer of all five
  logger contexts without workspace path aliases; the standards, Node,
  Chromium and workerd runtime fixtures also pass.
- The first installed compile correctly failed because its fixture confused a
  credential-store label with the marker-free memory-store shape. The fixture
  was corrected; no product contract was relaxed.

## Follow-up: structural adapter and foreign failure boundary

The four cross-package nominal error checks were removed from
`provider-http/src/base/http-adapter.ts`. Provider-attempt admission failures are
now propagated by the identity of the exact callback failure, without reading a
foreign `code`. Other provider errors cross a bounded own-data envelope: matching
outer/inner codes plus validated message, HTTP status, retry delay and request ID.
A lone code, mismatch, oversized/malformed field or accessor-backed property is
downgraded to `UNKNOWN`; an ordinary network error without an envelope remains
`TRANSPORT`.

Core's shared `normalizeModelFailure()` was hardened at the same time so its
documented own-data rule applies to inner fields as well: getters and Proxy
descriptor failures are contained without executing a getter. No global or
`Symbol.for` duplicate-core detector was introduced.

Evidence:

- A structurally complete adapter object with no `ModelAdapter` inheritance is
  activated and dispatched through the real claim-scoped registry.
- An independent fixture module supplies a compatible foreign error and preserves
  `RATE_LIMIT`, HTTP 429, retry delay and request ID.
- Outer accessor, inner accessor, mismatched codes and a lone retry code all
  produce `UNKNOWN`; accessor spies remain at zero calls.
- Core build plus 61 suites/793 tests pass. Provider-http build plus 3 suites/78
  tests pass. Its installed tarball passes Node, Chromium, workerd and the strict
  Worker negative matrix.
- The contract gate accepts zero nominal checks and reaches only the already
  tracked atomic documentation-migration mismatch.

## Follow-up: Codex prompt-cache scope

The public option documentation now states the implemented ownership precisely:
the default `promptCacheKey` is captured once per adapter/provider-plugin instance,
not once per conversation or tenant. A public `createAgentRuntime()` test installs
two Codex plugins over the same revisioned credential store under distinct plugin
IDs/routes. Two separate runs through the first route reuse one `session-id`; the
second plugin receives a different key. Provider-codex typecheck/build and 15 tests
pass, and its installed Node/Chromium/workerd runtime matrix passes.

## Follow-up: packed third-party provider testkit

`@ai-agent-sdk/testkit` is now a private, dev-only Universal package with no
test-runner runtime dependency and no registry publication configuration. Its
framework-independent `runProviderConformanceSuite()` returns one frozen,
support-safe report and drives a new provider instance through 19 checks:
inertness, kind/version preflight, route conflict, transactional rollback,
stream ordering, complete/missing/malformed usage, retry success/exhaustion,
cancellation, empty/failed catalogs, bounded-stream failure, failure redaction,
cleanup-failure containment, observation correlation/privacy and idempotent
cleanup.

The bound and cleanup fixtures place a long private sentinel only in raw causes;
the suite checks exact absence from run events/reports, diagnostics and the
runtime close report. Failed internal assertions retain only testkit-authored
messages; arbitrary provider exceptions are never copied into the conformance
report.

Verification:

- package typecheck and ESM build pass;
- the deterministic suite passes 19/19 checks;
- a separately packed provider fixture with only the published core peer range
  is installed beside packed core/testkit tarballs using install scripts disabled
  and passes the same 19 checks;
- the machine-readable result is generated locally at
  `packages/testkit/artifacts/provider-conformance-report.json`; the reproducible
  artifact directory is ignored rather than committed;
- no npm registry publish was performed or configured, per the project constraint.

## Follow-up: official provider conformance

The same 19-check suite now executes through the public `openAiAdapter()`,
`anthropicAdapter()` and `codexAdapter()` implementations. A shared test-only
fixture injects each adapter's real SSE wire protocol and HTTP transport. It
uses provider-specific complete, missing and malformed usage frames; HTTP 500
retry sequences; a fetch that waits for the propagated abort signal; and a
two-event response with `maxSseEvents: 1` for the actual HTTP parser bound.
Only catalog- and cleanup-failure injection use thin generic wrappers because
the official static-catalog factories do not expose a failing discovery hook
and their normal cleanup is intentionally infallible.

Verification:

- OpenAI: 1 suite / 4 tests passed, including conformance 19/19;
- Anthropic: 1 suite / 4 tests passed, including conformance 19/19;
- Codex: 2 suites / 17 tests passed, including conformance 19/19;
- all three packages built during the full workspace build;
- the shared fixture root-types cleanly; the remaining root TypeScript findings
  are pre-existing MCP human-test and observability fixture ownership issues,
  not provider-conformance findings.

## Follow-up: authenticated Codex usage and correlation acceptance

The authenticated integration matrix was rerun through the real ChatGPT Codex
endpoint and the installed local credential store. Catalog discovery, streamed
text assembly, a provider-native tool call with parseable arguments, and unknown
model classification all passed (4/4 tests). The successful call reported 31
input, 5 output and 36 total tokens with `complete`, authoritative coverage. Its
single physical attempt was `sent`, returned HTTP 200, retained a provider request
ID, and observation delivery ended healthy with no pending or rejected critical
events.

The first live run exposed that the fixed official endpoint returned a valid SSE
body without `Content-Type`. A diagnostic run that changed only the received
header proved the protocol stream and usage were otherwise valid. The resulting
provider-owned compatibility wrapper applies only to the exact official
`/responses` endpoint, HTTP 200, a non-null body, no redirect evidence and a
completely absent header. Custom bases and explicit wrong media types still fail
with `HTTP_STREAM_MEDIA_TYPE_INVALID`. Provider-codex's 17 unit tests cover those
three branches, and its rebuilt tarball passes standards, Chromium and workerd
consumers.

The support-safe artifact is retained at
`.temp/live-acceptance/codex-luna-safe-report.json` with mode `0600`. A separate
exact comparison against the credential store checked access, refresh and ID
tokens and found none in the artifact. The file contains correlation IDs, usage,
attempt state, HTTP status, provider request ID, delivery summary, observation
health and observed event names, but no prompt or response content.

## Follow-up: support-safe provider failure envelope

Run terminal errors now correlate sanitized model-call and physical-attempt
failures with their already validated ledger facts. Provider errors carry a
stable stage, provider family, selected route, origin, HTTP status, provider
request ID, retryability, dispatch state, full run usage coverage and the count
of possibly billed attempts without usage. Non-provider failures retain the
smaller `agent-run` envelope. Both paths replace arbitrary messages and never
copy headers, request/response bodies, prompts, completions or raw causes.

Provider family and plugin installation identity are captured with the adapter
registration generation; logical model-call reports retain them independently
from the selected route. Physical attempts retain only the URL origin, never a
path or query. A legacy/direct registry route falls back to its route identity,
while normal composition preserves distinct same-family plugin installations.

Verification:

- a failed physical attempt projects `provider-attempt`, route, origin, HTTP 503,
  request ID and `sent` while the private provider body sentinel remains absent;
- a scripted adapter without physical-attempt hooks projects `model-call`, the
  installed family and route, policy-derived retryability and logical
  `dispatchState: unknown`;
- hostile error message getters are not invoked by terminal projection;
- core typecheck/build and 61 suites / 794 tests pass;
- the rebuilt core tarball passes its standards, Node, Chromium and workerd
  consumer matrix;
- the declaration contract reaches only the separately tracked atomic I6
  documentation mismatch.

## Follow-up: multiple installations and Web catalog identity

Provider identity, family and route remain separate namespaces. Two installations
of family `openai` with plugin IDs/routes `a` and `b` dispatch to different
adapters, and each model-call report retains its selected route, family and exact
plugin installation. Duplicate plugin IDs, duplicate aliases within one plugin,
and route collisions across plugins fail during metadata preflight before setup
or adapter exposure; setup-time missing, repeated, undeclared, replaced and
released claims roll back transactionally.

Catalog tests install two accounts in the same family and prove each snapshot
retains its own route/plugin pair and model list. The packed Web fixture repeats
that exact two-account discovery through public `createAgentRuntime()` exports in
both headless Chromium and workerd, so this is not inferred from a Node-only
unit test or a display name.

Verification:

- provider activation: 22 tests pass, including independent same-family dispatch;
- provider preflight: 31 tests pass, including duplicate ID/route rejection before
  setup lookup;
- runtime model catalog: 11 tests pass, including two account-scoped catalogs;
- rebuilt packed core passes standards, Node, Chromium, workerd and declaration
  consumers with exact Web topology/catalog assertions.

## Follow-up: provider/protocol markers, synchronous topology and core peer closure

Normal provider composition now has two independently checked identity layers:
package manifests declare non-executable `aiAgentSdk` runtime/core API/roles
metadata, while executable provider and HTTP wire values carry literal family
`kind` markers plus their own API versions. Provider preflight validates all
inert identity/route metadata before reading setup; `createRuntimeHttpProvider()`
validates and captures the protocol marker/method table before constructing its
adapter. `defineModelProviderPlugin()` and `defineWireProtocol()` stamp and freeze
the corresponding markers without setup, credential, discovery or network work.

Provider setup/cleanup remain synchronous transactions. The author helper uses
`() => undefined` cleanup grammar so accidental async callbacks fail at compile
time. Direct foreign promises/thenables fail at runtime with stable setup/cleanup
codes; late rejection is contained, staged routes are discarded, the registrar
is sealed immediately, committed routes are removed before cleanup, and cleanup
runs at most once.

Every provider-http/protocol/official-provider runtime edge to core is a required
bounded peer plus a development peer, never a normal dependency. A shared packed
tree checker now recursively visits nested package `node_modules` directories and
requires exactly one physical `@ai-agent-sdk/core` location. Its negative tests
prove missing and nested copies fail. Provider-http plus OpenAI, Anthropic and
Codex packed standards/Chromium/workerd matrices all pass this assertion.

Verification:

- provider identity preflight: 31 tests pass;
- provider activation/rollback/sealing: 22 tests pass;
- installed-tree contract: 3 tests pass, including a nested-core negative case;
- provider-http and all three official provider packed runtime matrices pass;
- manifest/declaration checks pass through the contract gate before the known I6
  documentation mismatch.

## Follow-up: bounded JSON wire bodies and SSE terminal transport

The v1 runtime wire boundary now accepts only one synchronous finite JSON object.
It rejects primitives, promises/thenables, functions, bigint, non-finite numbers,
cycles, accessors, unsupported prototypes and structural/encoded overflow before
provider-attempt admission. The accepted graph is deeply detached and frozen,
encoded once per prepared logical call, and the same string is reused across
physical retries. Default attempt/run observations retain no request body; the
explicit compatibility request logger remains the only exact-body path and
redacts credential-derived headers.

The HTTP adapter now owns one resettable idle deadline per physical response. Raw
non-empty body reads and comment-only SSE heartbeats reset that same deadline,
while the independent overall request deadline still terminates a continuously
trickling response. A provider-neutral terminal guard withholds `finish` until the
translator ends, requires exactly one final finish, maps clean EOF before finish
to `STREAM_CLOSED`, and classifies duplicate or post-terminal output as malformed.
Parser and idle teardown preserve the primary transport/protocol failure when
reader cancellation rejects or exceeds its bound.

Verification:

- the serializer fixture matrix passes 13 focused cases, including encoded-byte
  overflow before both fetch and provider-attempt admission;
- the direct parser plus adapter transport matrices pass 22 tests covering
  parameterized/missing/wrong media types, split and malformed UTF-8, CR/LF/BOM,
  comments, SSE `retry` isolation, one-chunk fan-out, event/character/raw-chunk/
  response-byte bounds, early EOF, duplicate/post-terminal output, slow-loris
  overall timeout, cancellation failure and retry before/after visible output;
- `eventsource-parser` is exact-pinned at `4.1.0` and is a direct dependency only
  of `@ai-agent-sdk/provider-http`; the callback queue drains by cursor;
- provider-http typecheck and all 89 package tests pass;
- the rebuilt provider-http tarball passes its packed standards, Chromium and
  workerd runtime matrix.

## Follow-up: real provider author surfaces

The advanced core provider API still exposes `ModelAdapter` stream chunks,
provider metadata, advisory and snapshot catalogs, model resolution, route-owned
retry policy, atomic `prepareCall`, invocation context/provider-attempt hooks,
registration handles and stream middleware. The normal composition helper keeps
those authoring controls activation-scoped while retaining immutable runtime
topology after startup.

`createRuntimeHttpProvider()` now proves the extension path against the built
public `@ai-agent-sdk/core/provider` and `@ai-agent-sdk/provider-http`
declarations, not only the aspirational contract stubs. That same author journey
defines an executable versioned protocol, synchronous serializer, header
credential source, dynamic auth, discovery and a transactional provider plugin.
The runtime adapter preserves injected fetch, layered headers, dialect/model
decoration, bounded catalogs and transport, error classification, retry metadata
and the explicit compatibility wire logger.

One cancellation defect surfaced during this audit: `HttpModelAdapter.listModels`
discarded its public signal, and catalog cancellation was converted into an empty
successful catalog. It now forwards the signal into the connection/discovery
generation and rethrows cancellation rather than publishing false metadata.

Verification:

- the new current-provider-extension-author TypeScript config compiles the exact
  target author source against built real package declarations;
- the core current-provider compatibility journey compiles unchanged;
- 84 focused core provider/registry/activation tests pass across direct streams,
  prepare/dispatch binding, retry, accounting, registration and middleware;
- provider-http has 92 passing tests, including rotating header credentials,
  dynamic endpoint headers, retry policy exposure, catalog cancellation and
  bounds, stream terminal enforcement, custom errors and request logging;
- the contract checker passes all strict NodeNext and Web declaration checks and
  reaches only the separately tracked atomic I6 documentation mismatch.

## Follow-up: preferred official-provider factories

OpenAI, Anthropic and Codex now expose preferred plugin factories as synchronous,
inert identity wrappers. Factory construction captures only provider ID, fixed
family, route claims and default-model metadata; adapter construction, credential
resolution, Codex store reads, catalog discovery and fetch remain deferred until
the corresponding lifecycle stage. A custom ID infers its own route, while
explicit empty or duplicate aliases fail during identity validation before setup.

Every preferred factory carries its complete advanced adapter surface into the
runtime adapter: injected fetch and shared request/response/SSE/retry/logger
bounds, OpenAI organization/project/store/catalog controls, Anthropic
version/beta/thinking budgets, and Codex catalog/OAuth/prompt-cache controls.
String credentials now remain on the preferred composition path even when routes
are explicit; legacy credential callback overloads remain available through the
advanced compatibility factory grammar.

The HTTP provider's model-decoration hook now runs against the same captured
connection generation in `resolveModel`, `prepareCall` and direct dispatch. This
fixes a discovered atomicity defect where Anthropic advertised configured
reasoning efforts during model resolution but `prepareCall` rebuilt undecorated
metadata and rejected the selected effort.

Verification:

- the official runtime matrix passes 11 cases covering default/custom identity,
  inferred and explicit aliases, six invalid claim cases, fixed families, two
  same-family accounts with isolated credentials/fetch/default models, lazy
  credentials/discovery, gateway and option forwarding, and setup rollback;
- all OpenAI, Anthropic and Codex focused suites pass 33 tests together;
- a current-official-provider-factories TypeScript config compiles the public
  consumer journey against the built declarations of core, provider-http,
  protocols and all three official providers;
- all three provider tarballs pass their independent standards, Node, Chromium
  and workerd packed-runtime matrices;
- every touched implementation file remains below the 700-line ceiling (the
  largest is the shared HTTP adapter at 661 lines).

## Follow-up: owned header composition and prepared generations

Provider HTTP headers now pass through five explicit, lowercase,
case-insensitive ownership layers: transport, SDK attribution, wire protocol,
endpoint static configuration and authentication. The merger snapshots data
properties without invoking accessors, rejects invalid or transport-reserved
names, reserves `user-agent` and the `x-ai-agent-sdk-` prefix for attribution,
and reports a cross-layer or case-variant duplicate as
`HTTP_HEADER_COLLISION` before applying reserved-name classification. Endpoint
configuration cannot carry conservative credential-like names.

Every authentication-produced name is retained as sensitive provenance. The
exact-wire compatibility logger redacts that provenance in addition to the
shared conservative name policy, including custom names that do not resemble a
token or API key. Non-auth layer conflicts are detected before credential
resolution. The low-level adapter no longer combines request headers with
JavaScript spread precedence: legacy subclass transport/auth layers are
captured once, while the configured path supplies its already-composed five-layer
snapshot.

The prepared-call matrix proves that one logical operation resolves endpoint
headers and credentials once, discovery receives that generation, two physical
attempts reuse the same values, and the next logical operation rotates both.
Abort remains bounded before dispatch. A credentialed 307 response is requested
with portable manual redirect mode, produces one terminal stable-code failure,
and never contacts or forwards credentials to the advertised second origin.

Verification:

- 74 focused provider HTTP tests pass, including collision ordering, SDK prefix
  reservation, malformed/case-duplicate input, static credential rejection,
  custom authentication provenance, generation reuse/rotation, discovery and
  cross-origin redirect containment;
- all 95 provider-http package tests pass;
- the rebuilt provider-http tarball passes its standards, Chromium and workerd
  installed-consumer matrix;
- all touched implementation files remain below 700 lines; the largest is the
  shared HTTP adapter at 683 lines.

## Follow-up: activation-scoped registrar and immutable runtime topology

The recommended composition path completes identity and route preflight before
capturing or running provider setup. Its registrar admits adapter registration,
route replacement and middleware insertion only during synchronous activation.
Returned handles are sealed while the runtime is active, reopen only inside
runtime-owned rollback/cleanup, and seal permanently afterward. Retaining a
registrar, adapter handle or middleware disposer therefore cannot mutate a live
runtime. Cleanup removes topology first and runs in reverse activation order
after operation quiescence.

`createAgentRuntime()` returns a frozen facade containing provider/model
snapshots, agent/team binding, logging, diagnostics and close only. It exposes no
registry, install, remove, replace or generic plugin-array method. Duplicate
provider IDs, cross-instance routes and repeated aliases fail atomically during
preflight before setup property access; incomplete or out-of-claim setup rolls
back without publishing partial routes. The retained `ModelRegistry` mutation
surface remains an explicit low-level compatibility API, not the normal runtime
composition grammar.

Verification:

- 67 provider-preflight, activation, runtime-owner and public-runtime tests pass;
- the matrix covers active-state mutation rejection, setup-time replacement,
  retained/late handles, duplicate and incomplete claims, reverse rollback,
  cleanup failures/timeouts, quiescence ordering and immutable public topology;
- core package typecheck passes.

## Follow-up: explicit model metadata versus discovery state

The configured HTTP adapter now serves a configured model catalog directly,
without opening a connection, resolving credentials or calling a discovery
hook. This includes an explicitly configured empty catalog. Exact model metadata
resolution uses the same detached static entries and continues to drive context,
output limits, input/output modalities, native-tool support and reasoning
validation independently of network availability.

Dynamic discovery no longer collapses a transport/authentication failure into a
successful empty generation at the adapter boundary. A successful empty result
publishes `empty`; a failure rejects the adapter generation so the composition
runtime publishes support-safe `unavailable` (or retains its own eligible stale
generation). The provider request path still treats catalog membership as
advisory, so an explicit `{ provider, id }` call succeeds after discovery fails.

Verification:

- 100 focused HTTP/catalog/official-factory tests pass;
- an actual Codex runtime distinguishes empty and failed discovery, then
  successfully invokes an explicit model after the failed generation;
- explicit metadata tests prove zero credential resolutions, discovery calls or
  fetches while returning context, limits, modalities, native tools and
  reasoning metadata;
- the provider-http package passes 96 tests and its rebuilt tarball passes the
  installed standards-only Node, Chromium and workerd matrix;
- implementation files remain under 700 lines (largest: base HTTP adapter 674,
  configured adapter 605, shared transport utility 261).
