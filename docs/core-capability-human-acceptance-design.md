# Core + Capability Human Acceptance Design

Status: **Accepted test design — target package migration pending**

Last reviewed: **2026-09-04**

Related audit: [`core-capability-audit.md`](./core-capability-audit.md)

## 1. Evidence must be separated by claim

A passing UI or CLI does not prove the proposed package architecture. Human
acceptance therefore records four independent claims:

1. **behavior** — the agent, tools, accounting, diagnostics, and lifecycle work;
2. **runtime** — the same artifact executes in its declared environment;
3. **selection** — the consuming manifest and import graph contain only the
   selected capabilities.
4. **research autonomy and quality** — a real agent derives and revises its plan,
   reads relevant evidence, audits gaps and contradictions, and supports its final
   claims. Scripted provider behavior and URL counts cannot prove this claim.

No one claim substitutes for another. In particular, bundling a Node facade into
a working CLI proves behavior but contradicts the target selection model.

## 2. Current verified behavior

On 2026-09-02 both current hermetic journeys passed:

| Journey | Evidence | Behavior result | Package-topology result |
| --- | --- | --- | --- |
| Edge Chat | `test-human/results/edge-chat/run-2026-09-02_03-56-30-129/summary.json` | 16/16 invariants, 8 concurrent chats, 6 research tool calls, 2 audits | pending: imports split `core + agent` |
| Node Codex | `test-human/results/node-codex/run-2026-09-02_03-56-39-960/summary.json` | 7/7 invariants, 9 model calls, 8 tools, 692 tokens, 92 journal records | failing target: imports global Node facade |

The Edge test proves the SDK/UI can carry a scripted research-shaped tool loop:
plan/progress, calls/results, insufficient/sufficient audit output, citations and
a Markdown report. `deepSearchResponse()` is deterministic provider emulation
whose branches choose the next operation; `researchTopics()` recognizes two
fixture topics. The fixture `audit_research` checks supplied corpus URLs against
topic predicates, not evidence quality or proof that those pages were read.
The offline corpus and this scripted oracle prove neither Internet research nor
instruction-following, autonomous planning, source sufficiency or contradiction
resolution by a real agent. The intended target remains instruction-driven;
do not move this fixture scheduler into application orchestration.

The Node test already proves filesystem skills, stdio MCP, file creation and
syntax checking, authoritative usage, durable observation recovery, and session
resume. It intentionally remains hermetic. Historical authenticated reports are
retained as context, but AI automation must not rerun them; future credentialed
acceptance is an explicit manual release activity.

The authenticated Node deep-research control now also passes at
`test-human/results/human/core-capability-node-deep-research/summary.json`: seven
native searches, 28 URLs, five domains, 22,071 report characters, accepted deep
completion, and 76,856 authoritative tokens across two HTTP-200 attempts.

## 3. Target package selections

### 3.1 Edge website

The default deployment is two separate artifacts. The browser is a static
HTML/CSS/JS SSE client and needs no SDK package. The Edge Worker is the trusted
execution owner and installs:

Hermetic CI fixture:

```text
@ai-agent-sdk/core
inline deterministic provider fixture
```

Authenticated Internet fixture:

```text
@ai-agent-sdk/core
@ai-agent-sdk/provider-openai
```

Optional delivery capabilities are added only when exercised:

```text
@ai-agent-sdk/observability-fetch
@ai-agent-sdk/mcp
```

The target imports neither `@ai-agent-sdk/agent` nor a Node/facade package.
Provider credentials are injected only into the Worker (for example through a
secret binding or a Web-safe `CredentialSource`). They never originate in
browser JSON/local storage and never appear in SSE, diagnostics, or errors. A
direct-browser BYOK product is a separate opt-in deployment and is not evidence
for this default website architecture.

### 3.2 Full Node coding harness

Hermetic CI fixture:

```text
@ai-agent-sdk/core
@ai-agent-sdk/skill-filesystem
@ai-agent-sdk/mcp-node
@ai-agent-sdk/observability-node
inline deterministic provider fixture
```

Authenticated companion:

```text
@ai-agent-sdk/core
@ai-agent-sdk/provider-codex
@ai-agent-sdk/auth-node
```

It must not install `@ai-agent-sdk/node`, `@ai-agent-sdk/agent`, the standalone
base observability package, or the unscoped facade.

## 4. Required Edge journeys

### 4.1 Hermetic PR gate

- real workerd with `Buffer` and `process` deliberately unset;
- ChatGPT-like streamed website, responsive desktop/mobile layout;
- multi-turn isolated conversations and cancellation;
- interactive user-input request/response is correlated by request ID and every
  pending waiter settles on cancellation;
- visible commentary/progress separated from tool calls;
- explicit deep-search mode and instruction-based automatic activation;
- scripted search/read/audit event replay, including an insufficient and a
  sufficient audit, to verify SDK/UI ordering and projection; this is not an
  autonomy or research-quality pass;
- authoritative usage and observation health shown in support-safe artifacts;
- packed direct dependency closure matches the topology manifest.

### 4.2 Authenticated Internet gate

This is a separate, non-PR acceptance because it needs credentials and live web
state. It uses the target run-scoped instruction policy and UI event renderer,
replacing the deterministic provider/corpus and fixture-only audit oracle. Do
not reuse the fixture's two-topic URL matcher as a real sufficiency decision.

- execute at least three meaningful searches;
- read at least six relevant pages across three independent domains;
- record source URL, title, search query, and tool duration without page bodies;
- audit coverage, source independence, contradictions, stale claims, and missing
  topics after each research round;
- continue autonomously when an audit fails;
- produce a final Markdown report with citations only after a sufficient audit;
- display every provider-native or host search/read operation to the user;
- retain complete authoritative token usage and correlated lifecycle events;
- use SSRF-safe URL policy for host-side page reading.

The existing Node `human:deep-research` run is useful provider evidence, but D7
is not complete until the same live boundary is exercised through the Edge
website/workerd entry.

The first direct workerd attempt is recorded at
`.temp/core-capability-edge-live/report.json`. It proves the full provider closure
bundles with no external/Node imports and exposes progress over SSE, but it is a
negative result: workerd rejects the current HTTP adapter's `redirect: 'error'`;
after a fixture-only no-follow shim, the Codex consumer endpoint returns a
Cloudflare HTML HTTP 403 while the same credential succeeds in Node. The provider
maps it to `AUTH`, but the artifact does not mislabel the intermediary page as a
proven API auth error. D7 therefore remains open. A passing
Edge gate needs a provider/upstream combination that supports the deployment; a
Node relay is not accepted as proof that the provider itself is Edge-safe.

### 4.2.1 Research evidence, independent assessment and stopping

The test harness verifies evidence, not a prescribed research workflow. The
agent derives criteria from the user's request, chooses queries/pages, revises
its plan and decides when to audit. The host enforces resource bounds and records
actual tool outcomes; it must not choose the next search/read/audit action or
fabricate an audit to make the test pass. An audit tool may validate provenance
or return an assessment, but a model-supplied `sufficient: true` is not itself
independent proof of adequacy.

Required acceptance evidence:

- Successful reads create host-owned receipts scoped to the authorized research
  task, with stable read/call IDs, requested/final URL, retrieved time, content
  revision/digest, extraction outcome and complete/partial status. Search results
  and snippets do not create read receipts. Failed reads do not count; a partial
  read supports only content actually obtained, never unseen parts of a page.
- Audit source references resolve to existing successful receipts, not arbitrary
  URLs supplied by the agent. Deduplicate repeated reads by canonical source and
  content revision; track redirects and mirrored sources so repeated URLs or
  domains are not mistaken for independent corroboration. Reuse across runs is
  explicit and scoped, with freshness reviewed rather than silently assumed.
- Each audit identifies request-derived criteria, supported claims, missing
  evidence, contradictions, uncertainty and its source/read references. The
  reviewer can trace final claims/citations to content actually read. A URL-topic
  matcher, minimum count, text length, or model self-rating cannot replace this
  semantic assessment. Numeric search/read/domain thresholds in 4.2 are coverage
  floors for this acceptance scenario, not universal definitions of sufficiency.
- Manual acceptance uses multiple requests beyond the two offline fixture topics,
  including a complex report needing broad reading, conflicting/outdated sources,
  and a case that remains incomplete. For the multi-round case, verify a real gap
  audit precedes further investigation and a later reassessment, without fixing
  call order, query text, a mandatory first-round failure or a fixed round count.
- Record a reviewer decision separately from the agent's audit decision. It
  assesses whether major claims are supported, conflicting findings explained,
  missing topics disclosed, and follow-up work actually addresses the earlier gap.
  A reviewer rejection leaves the research-quality claim unverified even when
  transport, runtime, selection and token-accounting checks pass.
- If time/turn/token/read limits or missing evidence stop research, the outcome
  is partial/incomplete with gaps and reason, not an artificial sufficient audit.
  An assessment change after the latest audit invalidates the old sufficiency
  claim until reassessed. The UI keeps distinct tool failure, successful partial
  reading, audit insufficiency, cancellation and final report states.

Hermetic future tests should reject a known-corpus URL that was never read,
duplicate references, failed reads counted as evidence, another task's receipt,
and unsupported complete-page claims from truncated content. They may use
scripted providers to test these conditions, but must label their evidence as
scripted; real-agent autonomy remains a separately authorized manual activity.
Keep read receipts and bounded review metadata in the human-test artifacts.
Do not add whole page bodies to ordinary SSE/log/support records; if content
snapshots are needed for manual review, use a separately approved bounded artifact
policy. Without the required reviewable evidence, do not claim report quality.

### 4.3 Browser/Worker session and stream contract

The Worker obtains `principalId` from trusted host authentication, never from
the chat request body. A session is authorized and keyed by the collision-free
tuple `(principalId, conversationId)` or by an equivalent server-issued opaque
handle. The fixed hermetic test principal is explicit test scaffolding, not a
production authorization scheme.

One visible conversation has one canonical session/history. `mode` is not part
of the storage key. Selecting deep search maps a small host-owned enum to bounded
run-scoped `additionalInstructions`; the request cannot forward arbitrary system
instructions. The agent interprets those instructions, derives its own plan,
audits evidence adaptively, and continues until sufficient. The host does not
encode a search/read/audit workflow. Run-scoped instructions are not persisted
in history or snapshots and do not change the conversation identity.
They are host-owned fixed text, validated before admission as non-whitespace and
at most 65,536 UTF-8 bytes. The accepted value applies to all requests in that
run, including retries and post-compaction turns, is usage-accounted, and is
discarded before any later run. It grants no tool, approval, credential, model,
or resource authority.

The HTTP/SSE adapter must additionally guarantee:

- one active run per authorized conversation; a second admission receives a
  stable `409` and starts no provider/tool work;
- an owned abort controller combines request abort, response-stream `cancel()`,
  and runtime close; disconnect aborts the run and waits for session idle with a
  bounded deadline, then observes the handle's independent terminal `report`;
- every envelope contains `schemaVersion`, SDK `runId`, a monotonically
  increasing per-run `sequence`, and `type`;
- exactly one `complete`, `failed`, or `aborted` terminal envelope carries a
  support-safe run report; EOF before terminal is visibly **incomplete**, never
  success, and is not automatically replayed without a designed resume protocol;
- failures expose stable code/stage/message fields, never raw thrown messages,
  stacks, provider bodies, headers, or credentials;
- tool input/result is emitted only through an explicit JSON-safe public
  projector with byte/depth/cardinality limits;
- same-origin is the default request boundary and JSON byte limits are enforced
  before agent admission.

The compile-only `edge-worker-chat` journey freezes the package selection and
API shape for this boundary. The current `test-human/edge-chat` implementation
does not yet meet the whole contract: it keys sessions by mode, trusts a client
conversation ID without principal binding, forwards raw error messages, lacks a
response `cancel()` settlement hook, and cannot detect sequence gaps/EOF before
a terminal event. These are I6 implementation items, not reasons to run a live
spike during design review.

## 5. Required Node journeys

- explicit capability imports shown in section 3.2;
- filesystem skill discovery and lazy resource activation;
- confined read/write tools and shell-free process invocation;
- separately supervised MCP stdio child and bridged tool call;
- client-only MCP closure contains neither Universal nor Node server-hosting
  packages/dependencies;
- metadata-only base diagnostics plus durable Node journal;
- missing usage configured as a terminal failure for an otherwise successful
  call; an existing primary provider failure remains primary;
- cancellation and bounded close of active run, MCP, journal, and runtime;
- approval deny versus abort, ordered interceptor policy, and retained separate
  runtime/MCP close reports;
- snapshot round-trip/resume with canonical runtime identity;
- a two-member local team composes without installing the Node A2A capability;
- packed manifest/lock closure contains only selected direct capabilities;
- authenticated provider companion validates the same composition API marker,
  usage, correlation, privacy, and close semantics.

### 5.1 Integration evidence versus user-facing progress

Operational integration logs and the UI/CLI tool timeline prove different
claims and must not be substituted for one another:

- the Edge website and Node CLI render only bounded public
  `RuntimeAgentRunEvent` tool/native-tool progress with stable call IDs, sequence,
  status, and projected metadata; they never expose raw observation records,
  headers, bodies, prompts, results, credentials, or agent-card content;
- when Node selects MCP stdio, its durable journal proves start/terminal pairs
  for connect, catalog refresh, tool call, and close, plus every physical process
  attempt linked to one logical operation;
- an Edge fixture that selects remote MCP applies the equivalent HTTP connect,
  authentication, catalog, reconnect, tool-call, and close assertions;
- lifecycle operations use the runtime-bound logger passed at connect/link,
  while MCP tool execution and A2A send use the active run/team-operation logger;
  the acceptance rejects a lifecycle-only logger being reused as false per-run
  correlation;
- runtime-active records conform to `IntegrationOperationEvidenceFields`, stay
  within the 64/128-character bounds, and balance logical/attempt start-terminal
  rows with one-based attempt numbers and finite non-negative durations;
- runtime diagnostics/close expose accepted, filtered, dropped and rejected
  integration counters. The UI/support artifact distinguishes incomplete or
  unknown trace evidence from complete token accounting; neither zero counters
  nor critical-checkpoint `delivery.complete` proves all integration logs arrived.
  A complete trace assertion also reconciles expected operation/attempt pairs,
  exact acknowledged event IDs, and teardown reports. Ring eviction alone is not
  evidence that durable export lost the same events;
- logical integration events never alter or duplicate core's authoritative
  provider attempt/token totals; missing usage remains a terminal ledger defect,
  not something inferred from logs;
- cleanup fault fixtures retain the primary operation failure and independently
  assert the runtime and integration close/unlink/dispose reports; because the
  runtime logger is closed/no-op by then, a post-close log is explicitly not
  accepted as teardown evidence;
- standalone no-logger MCP/A2A construction is covered by deterministic tests
  that prove no implicit console output.

MCP/A2A server operation matrices are deterministic contract gates rather than a
reason to contact a provider. Live provider acceptance stays a separate manual
release activity. Until these assertions run through the migrated target
packages, “logger field exists” is only API-shape evidence, not an acceptance
pass.

## 6. Package selection gate

`../test-human/package-topology.json`
records both the current direct import graph and target graph. The checker must:

- derive current scoped imports from source rather than trusting documentation;
- fail if the recorded current graph drifts;
- reject target facades and environment-ambiguous packages;
- require core in every target journey;
- report migrations as pending until current imports equal target imports;
- inspect packed consumer manifests and transitive lock closure after migration.

The current graph may pass as accurately recorded while target migration remains
pending. Such a pass is audit integrity, not architecture completion.

## 7. D7 completion criteria

D7 passes only when all of the following are true:

1. both current import graphs equal their target graphs;
2. packed direct and transitive dependency assertions pass;
3. hermetic Edge and Node behavior gates pass unchanged;
4. a human-authorized manual provider acceptance is signed off without being
   invoked by AI automation;
5. live Internet deep research passes through the Edge website;
6. artifacts contain no credentials, prompts/page bodies by default, or exact
   provider wire data;
7. selected MCP/A2A integrations pass their logical-operation, physical-attempt,
   active-correlation, no-double-accounting, cleanup, and no-content evidence;
8. the coverage checker no longer contains an exception protecting a removed
   facade.

The manually produced Edge live artifact must additionally state whether catalog data was dynamic
or explicit, whether any fetch compatibility shim was used, and whether native
tool progress was observed from events rather than inferred from final text.
