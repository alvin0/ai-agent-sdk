# Core + Capability Phase 0 Approval Record

Status: **Approved — staged product source migration authorized**

Machine precondition: **API name parity is ready; all fourteen owner decisions are approved with the per-agent model-default amendment**.
Core, agent, base observability, providers, and all 19 retained capability
entrypoints now have zero preserved names missing. The retained ledger covers
344 export occurrences, and focused same-source compiles cover the restored
protocol, exporter, MCP, Auth/Codex, and A2A routes. Every P0 decision below
has owner/time attribution in the machine record; migration proceeds through the gated I1–I8 slices.
The machine record binds approval to 18 packages, 32 public specifiers and
the exact 264-name core root facade.

Approval is permission to enter I1–I7 in dependency order, not a declaration that
the target passes I8. In particular, the two upstream MCP full-Web type errors
remain open, and scripted Edge research is not real-agent research-quality
evidence. These require the existing implementation/acceptance work; they do not
require another broad architecture document before the initial ownership move.
Approval does not authorize npm publishing or automated spike/live-provider runs.

Last reviewed: **2026-09-04**

Machine-readable source:
[`../design-contracts/core-capability-v1/phase0-decisions.json`](../design-contracts/core-capability-v1/phase0-decisions.json)

This is a small approval record, not another architecture design. It consolidates
the product choices that were previously scattered through the package plan,
composition design, audit, ADR, and implementation ledger. Static evidence may
support a recommendation, but only the owner can change a decision from
`pending-owner-approval` to `approved`.

## Approved decisions

| ID | Recommendation | Evidence/reason | Status |
| --- | --- | --- | --- |
| P0-01 | Export `AgentRuntime`/`createAgentRuntime`, high-level provider/catalog discovery, typed provider-native tools, exact host-owned run-scoped `additionalInstructions`, sequential `RuntimeAgentInvocationOptions.onEvent`, and eager `RuntimeAgentRunHandle` with stable ID/events/abort/result/report; preserve established advanced names and use distinct `Runtime…` composition protocols | Edge/Node consumers retain simple progress callbacks without confusing them with durable observability, avoid mutable registry/untyped config/split histories, and existing extension/harness contracts are not silently repurposed | Approved |
| P0-02 | Each agent may select its own full model target, a provider route default, or inherit the runtime's selected/unique configured provider default; keep reusable definition overloads compatible | explicit agent choice wins; no hard-coded model, registration-order choice or error-time model switching; missing/ambiguous defaults fail before dispatch; resolved target is immutable and visible on agent.model | Approved |
| P0-03 | Freeze the 18-package/32-specifier topology, runtime tiers, seven bounded core specifiers, retained compatibility subpaths, and the exact 264-name curated root facade | topology schema v5 covers every retained package; preserves auth `/env`, A2A `/client` and `/server`, MCP `/client` and optional-peer `/server`, and observability-node `/journal` and `/diagnostic`; checks exact manifest blueprints for all 18 packages with no wildcard/CommonJS/canonical-owner export; freezes dependency/peer/optional-peer/catalog encoding, packed files, auth binary, root mirrors, Node engines, all 18 non-executable package-role metadata records, and the phase-tracked 56-file I1/I2 source ownership move with route-complete temporary bridges (`observability` root; `agent` root plus `/skill-validation`); records exact workspace/external/effective-runtime closure for all 25 journeys plus independent core-adjacent probes for all 17 non-core packages; and covers runtime baselines plus all four removed-package inventories | Approved |
| P0-04 | Remove both facades; add no replacement full facade; approve the three-state documentation cutover | imports of both facades plus the agent/observability bridges are machine-inventoried; 27 Markdown files have exact rewrite/delete/history dispositions, I6 is coupled to target human journeys, and facade-owned READMEs remain until package deletion at I7 | Approved |
| P0-05 | Approve seven independent executable-family v1 markers, declarative composable-provider route claims, preflight method snapshots, distinct route/instance/family identities, synchronous JSON-object-only requests, and bounded terminal SSE response semantics | makes route conflicts reject before plugin setup, includes the provider-http wire protocol family, prevents post-validation replacement, keeps multiple-account discovery unambiguous, freezes one request body across retries, and prevents heartbeat/event-flood/truncated-stream ambiguity | Approved |
| P0-06 | Keep typed capability slots, explicit ownership, atomic revisioned tool snapshots, revisioned skill references, isolated memory scopes, immutable provider topology, and typed runtime operation leases | prevents schema/execute generation mixing, stale skill upgrade, and cross-session memory rebind; closes async shutdown races, detects collisions before dispatch, and avoids a service locator | Approved |
| P0-07 | Make `auth-node` root env-only and `/codex` an optional-peer subpath; preserve callable env and blind Codex-store APIs as compatibility views while new composition uses distinct abortable revisioned source/store contracts | minimal env consumers avoid the Codex/provider/SSE closure, current source remains valid, and new concurrent token refresh cannot blindly overwrite a newer credential record | Approved |
| P0-08 | Require bounded core peers recursively, one physical packed core, and structural plugin boundaries | prevents nested/embedded core copies while avoiding nominal `instanceof` failures and global singleton side effects | Approved |
| P0-09 | Provisional diagnostics default: 256 events **and** 1 MiB; add runtime integration accepted/filtered/dropped/rejected counters without changing advanced health | current events have a 64 KiB hard cap; count-only 256 could approach the entire 16 MiB sampled Edge peak budget; a complete integration trace additionally needs expected operation/attempt pairs, exact event-ID acknowledgments and teardown reports, not merely zero loss counters or a green critical checkpoint | Approved |
| P0-10 | Document side-effect-free named factories, preserve operational controls, keep MCP connect/close and caller-owned OTel explicit, preserve marker-free advanced observation and skill-provider contracts, use distinct marker-based runtime protocols, require correlated loggers in safe versioned capability contexts, require runtime-first/logger-bound caller-owned MCP/A2A composition with runtime-before-integration teardown, and freeze the model-object versus string/omitted agent-definition overload discriminant | keeps core-plus-provider/additive composition concise without silently repurposing existing exporter, skill, event, definition, session, or team APIs; machine-checks one named entrypoint, typed slot, audience, ownership rule, direct install journey, and compiled wiring proof for all 17 non-core packages; five plugin contexts plus a six-family/27-operation metadata-only integration matrix use one bounded focused logical/attempt evidence grammar and distinct lifecycle versus active tool/team correlation, while teardown after runtime shutdown uses independent support-safe reports instead of a no-op logger; core owns lifecycle evidence, standalone use remains optional/no-console, and exporters cannot recurse through logging | Approved |
| P0-11 | Keep exact-wire diagnostics in `observability-node` during this migration | package splitting is independent of removing the full Node facade | Approved |
| P0-12 | Freeze Web Platform/Browser/Node 22.12 feature baselines and their packed gates | separates strict Node and no-Node-types Web declaration checks; the former two-error MCP 2.0.0 `Buffer` debt is closed by SDK-owned portable declarations plus installed-tarball and packed-runtime evidence; makes “Universal” testable across Workerd, Chromium, Node and Deno/Bun standards checks while live network gates remain manual | Approved; portability debt closed 2026-09-05 |
| P0-13 | Retain A2A as explicit Node capability and preserve its root, `/client`, and `/server` surfaces by default | the baseline freezes all 76 export occurrences across the three current entrypoints; target declarations are at name parity and dual-compile representative client/server lifecycles; an additive structural bridge proves the same `linkA2AAgent()` works with legacy `AgentTeam` and the new `RuntimeAgentTeam`, the runtime team supplies active-operation logging, and the recommended fixture closes runtime routing before idempotent reported unlink without taking ownership of injected transport resources; existing unlink/dispose methods remain while reported variants provide post-runtime evidence | Approved |
| P0-14 | Split MCP client and server installation closures while retaining current `/client` and optional-peer `/server` routes | the declaration mapping preserves all 61 current MCP export occurrences and dual-compiles old/new routes; Edge/Node clients do not select server packages, connected HTTP/stdio factories expose one shared `McpConnectionError` with primary startup plus bounded rollback evidence, and moving former root server names still requires explicit owner approval | Approved |

## Diagnostics rationale for P0-09

The historical prototype defaults to 256 events, while the retained Workerd
benchmark exercised only 32 events and observed 864 evictions. Current privacy
processing enforces a 64 KiB hard maximum per serialized observation event. A
count-only 256-event ring could therefore retain up to 16 MiB before object
overhead, equal to the provisional sampled peak budget for the whole basic Edge
agent.

The recommended v1 contract consequently needs both:

- `diagnosticMaxEvents`, provisionally 256;
- `diagnosticMaxBytes`, provisionally 1 MiB;
- retained/evicted event and byte counters;
- canonical per-run usage/error reports that survive ring eviction.

These are provisional entry decisions. The packed migrated core must re-measure
representative and maximum-size events before Phase 2 can claim exit.

## Approval mechanics

Approval requires an explicit owner response naming the accepted IDs or accepting
the record as a whole. The machine record then receives `status: "approved"`,
`approvedBy`, and an ISO-8601 `approvedAt` value for each accepted decision. A
static checker rejects an approval without that attribution or a Markdown/JSON ID
drift. The owner explicitly approved all decisions in this thread on 2026-09-04, with
P0-02 amended to permit configured provider defaults and independent per-agent
model overrides. Phase 0 and ADR 0002 are Approved; this is not runtime acceptance.
