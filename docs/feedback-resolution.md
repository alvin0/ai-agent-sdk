# Feedback resolution and migration

## CI and supply chain (A)

CI runs boundary/build, functional tests (including packed runtimes), and supply-chain checks independently. The existing `deterministic` check requires all three, including when a dependency job fails or is cancelled. No advisory gate is skipped.

The reproduced supply-chain failure was missing review evidence for Drizzle's esbuild versions and two sample dependency licenses. Exact version/package exceptions are documented in `dependency-policy.md`; the general license allowlist is unchanged. The live production audit had no high/critical findings.

## Approval identity and tool validation (B, D)

Policy and approval run only after tool lookup, JSON parsing and the optional tool validator succeed. Invalid calls still produce the existing tool-error result and tool events, but no longer invoke authorization interceptors. Use tool-call/tool-result events to audit invalid attempts.

`ApprovalRequest.approvalRequestId` is SDK-issued and single-use. `providerCallId` and the legacy `callId` identify the provider call only. Requests also carry `runId`, `conversationId`, tool name and a frozen snapshot of parsed/validated arguments on session execution paths. Standalone dispatchers can supply run/session identity in `position`.

Interactive hosts must migrate `broker.resolve(request.callId, decision)` to `broker.resolve(request.approvalRequestId, decision)`. Direct broker users construct requests with `createApprovalRequest(...)`. Reusing a settled request is rejected. `abortRun(runId)` and `abortSession(conversationId)` leave unrelated waiters intact. Identity is correlation, not authentication: hosts still authorize the reviewer and tenant.

The sample's existing wire field `callId` now carries the approval identity. `providerCallId` correlates the prompt to a tool row. `/api/approve` rejects provider IDs, stale IDs and duplicate decisions. Standing grants are still a host policy.

`defineToolFromSchema(schema, definition)` accepts a `RuntimeSchema<T>` adapter with `jsonSchema` and synchronous `parse`. Convert a schema library once into this adapter; it then supplies inferred tool argument types, the model schema and runtime validation. The original `defineTool` remains available, including tools that validate in their bodies.

## Public input, output and events (C)

`generate`, `run`, `stream`, and `inject` accept `AgentInput` (`string | UserMessage`). Responses retain `.text` and expose `.message`. Adapter-private `source.replayState`, block `providerState`, and annotation `providerState` are excluded from public message projections; public content is retained.

Runtime events carry `schemaVersion: 1`, run/trace identity and monotonic sequence. Text deltas retain provider block indexes and a block ID scoped by model-round span. Text endings retain authoritative phase and incomplete flags. The explicit event allowlist includes images, full assistant messages, reasoning summaries, text placement, turn/step lifecycle and compaction lifecycle. Raw trace events are not forwarded. Consumers should switch on event type and tolerate additive event types instead of assuming the first event is text.

For parsed and validated structured output, pass a schema adapter per invocation:

```ts
const response = await agent.generate('Extract the invoice amount', {
  structuredOutput: { name: 'invoice', schema: invoiceSchema },
})
// invoiceSchema: RuntimeSchema<JsonValue>, derived from your schema library.
// Validation runs before the engine finalizes its report.
console.log(response.output)
```

The SDK sends that adapter's JSON Schema only for final output, parses final JSON, invokes `parse` once, and returns its frozen JSON result. Invalid JSON or a thrown validator fails the run and its canonical report. The parser must be synchronous and return lossless JSON. Existing `outputFormat` remains supported; without a runtime schema adapter it does not claim schema validation.

## Required image input (E)

Use `{ imagePolicy: 'strict' }` when images are required. The session preflights image-bearing history before automatic compaction; the registry also checks requests (including tool-result images) before generation dispatch. A model whose metadata explicitly excludes images produces `UNSUPPORTED_IMAGE_INPUT` without a generation request. Unknown metadata is not treated as proof that images are unsupported.

The default and explicit `project` policy retain the previous lossy projection behavior for text-only models. Strict conservatively treats all images in the invocation history as required. The SDK never switches provider or model automatically.

## Execution and crash recovery (F, G)

`createToolExecutionInterceptor` is the optional execution adapter point. Policy/approval precede it; post-policy sanitizes fresh and recovered results. `localToolExecutionBackend` calls the existing in-process tool body and declares cooperative cancellation, host filesystem/network access, and best-effort cleanup. A host can supply a process/container/remote implementation of `ToolExecutionBackend`; core does not ship or claim a sandbox for those environments. Capability declarations describe the host backend's guarantees, not additional enforcement by core.

The host supplies frozen authenticated `identity` and an `operationId(call)` function. Model arguments never replace this identity. IDs must remain stable across recovery and be scoped to the authenticated tenant and operation. Using a new ID on each retry cannot prevent duplicate external work.

`ToolExecutionStore` is separate from conversation memory. Its adapter must atomically and durably claim an operation ID before dispatch and persist the result before acknowledging completion. Durable operation arguments must be lossless JSON. A saved completed result is reused only for matching identity, tool and arguments. An existing unfinished claim returns `unknown`; the SDK raises `OPERATION_OUTCOME_UNKNOWN` instead of retrying. If execution succeeds but result persistence fails, the unfinished claim remains for host reconciliation. Even concurrent callers require the adapter's atomic claim guarantee.

`withApprovalPersistence(broker, store)` journals pending requests and decisions before execution is released. Storage failure prevents execution. Hosts restore pending records by reissuing a fresh SDK request and asking again, rather than applying an old decision to a new request.

No general exactly-once guarantee is made. The destination service's idempotency and reconciliation API determine whether an unknown external operation can be safely retried. No workflow store or execution adapter is required for a simple chatbot.

## Reproducing the real sample check

Build packages, then run the sample with a disposable database/workspace and a separate build directory so the developer server can remain running:

```sh
pnpm workspace:build
CHAT_AGENTS_DIST_DIR=.next-feedback \
CHAT_AGENTS_DB=/tmp/chat-feedback/app.db \
CHAT_AGENTS_WORKSPACE=/tmp/chat-feedback/workspace \
pnpm --filter @chat-agents/web dev --port 3108 --hostname 127.0.0.1
```

The sample loads its normal repository-local credentials. In a second terminal:

```sh
CHAT_AGENTS_FEEDBACK_URL=http://127.0.0.1:3108 \
CHAT_AGENTS_FEEDBACK_WORKSPACE=/tmp/chat-feedback/workspace \
CHAT_AGENTS_LIVE_MODEL=gpt-5.6-sol \
CHAT_AGENTS_FEEDBACK_REPORT=/tmp/chat-feedback/live-report.json \
node scripts/test-chat-agents-feedback-live.mts
```

This check uses real HTTP/SSE and provider calls. It verifies approval identity separation, no writes before permission, exact approved file content, denied and cancelled writes, stale/duplicate decision rejection, persisted transcripts, and conversation reuse after cancellation. Run it only against the disposable sample workspace. Restart the sample after rebuilding core.

## Verification recorded on 2026-09-08

- Full local baseline: 152 test files, 1,817 tests passed.
- Workspace build/typechecks, sample backend/web typechecks, root TypeScript, graph/runtime boundaries and negative boundary fixtures passed.
- Package-owned suites and the full packed-package/runtime matrix passed; the changed core was repacked and checked again after the final build.
- Supply-chain gate passed with 599 integrity records, seven production license expressions, and zero findings, including the live production advisory check.
- A real Chromium session against the isolated Next.js sample used Codex `gpt-5.6-sol`: the permission card blocked the write, Allow once released it, exact file content was read back, the final answer rendered, and the conversation survived reload.
- The HTTP/SSE regression script passed allow, deny and abort against the rebuilt sample, including duplicate/provider-ID rejection and another successful prompt after abort. These runs used real provider calls, not the sample mock.

Hosted GitHub Actions has not been dispatched. Live image/structured-output provider compatibility beyond the existing sample UI is not claimed by the chat check; those new engine paths have focused scripted-adapter regression coverage. Process/container isolation and durable storage guarantees remain responsibilities of the optional host adapters.
