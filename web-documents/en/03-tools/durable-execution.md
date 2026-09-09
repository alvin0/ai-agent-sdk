# Durable Execution

Two opt-in adapters move tool work off the local process and make one tool call
**survive a restart**. Both are ordinary interceptors — nothing here is on by
default.

```ts
import { createToolExecutionInterceptor, localToolExecutionBackend } from '@ai-agent-sdk/core'
```

## Where it sits in the pipeline

```text
classify → approve → intercept ──┬── policy interceptors (yours)
                                 └── execution interceptor  ← here
                                          │
                                          ├─ claim(operation)      store, if any
                                          ├─ backend.execute()     local or remote
                                          └─ complete(result)      store, if any
   → parse → render/meta → commit
```

Policy and approval run **before** this adapter, and post-policy still sanitizes
the result — both a fresh one and one recovered from the store.

## Backends

```ts
interface ToolExecutionBackend {
  readonly id: string
  readonly capabilities: ToolExecutionCapabilities
  execute(request: ToolExecutionRequest, local: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
}

interface ToolExecutionCapabilities {
  readonly cancellation: 'cooperative' | 'forced'
  readonly filesystem: 'host' | 'restricted' | 'none'
  readonly network:    'host' | 'restricted' | 'none'
  readonly cleanup:    'best-effort' | 'guaranteed'
}
```

Capabilities describe what a backend **actually enforces** — not permissions
granted by policy. A backend claiming `filesystem: 'restricted'` is asserting
that it can hold that line.

`localToolExecutionBackend` is the identity backend: it calls `local()` and
claims exactly what an in-process tool can honour — cooperative cancellation,
host filesystem and network, best-effort cleanup.

```ts
interface ToolExecutionRequest {
  readonly operationId: string
  readonly toolName: string
  readonly args: unknown
  readonly identity: JsonObject      // trusted host identity, NEVER from model arguments
  readonly signal: AbortSignal
}
```

`identity` comes from the authenticated host. Sourcing it from model arguments
would let a prompt choose its own tenant.

## Durable operations

Supply a `store` and each call is claimed before it runs:

```ts
interface ToolExecutionStore {
  claim(operation: ToolOperation, signal: AbortSignal): Promise<ToolOperationClaim>
  complete(operation: ToolOperation, result: ToolExecutionResult, signal: AbortSignal): Promise<void>
}

type ToolOperationClaim =
  | { status: 'claimed' }                                        // fresh: run it
  | { status: 'completed'; operation: ToolOperation; result: ToolExecutionResult }
  | { status: 'unknown';   operation: ToolOperation }             // in-progress at crash time
```

The store is **separate from conversation memory**. The host adapter must claim
an id durably and atomically, and `complete` must persist before it resolves.

```ts
const session = agent.createSession({
  interceptors: [createToolExecutionInterceptor({
    identity: { tenantId: user.tenantId },
    operationId: call => `${conversationId}:${call.turn}:${call.step}:${call.callId}`,
    store: myStore,
  })],
})
```

`operationId` must be **stable across recovery** and scoped to tenant and
session by the authenticated host. It is rejected when empty or over 512
characters.

## What each outcome does

| Claim status | Behaviour |
| --- | --- |
| `claimed` | Executes, then `complete` persists the result |
| `completed` | Returns the saved result. **No re-execution.** |
| `unknown` | Fails with `OPERATION_OUTCOME_UNKNOWN` — reconcile first |

There is **no automatic retry**. An in-progress claim is `unknown` after a
restart, never implicitly retryable: the SDK cannot know whether a charge was
posted or an email sent. Reconciliation is host-owned.

A throw, a cancellation, or a failed `complete` write leaves the claim
unresolved, so the next attempt reconciles rather than executing again.

| Error code | Cause |
| --- | --- |
| `INVALID_OPERATION_ID` | Empty, non-string, or over 512 characters |
| `INVALID_OPERATION_INPUT` | Args or identity are not lossless JSON |
| `OPERATION_ID_CONFLICT` | Same id, different saved input |
| `OPERATION_OUTCOME_UNKNOWN` | Claim was in progress, or cancelled after claiming |
| `TOOL_ABORTED` | Cancelled before the claim |

`OPERATION_ID_CONFLICT` is the guard against an id that means two different
things — a canonical comparison of both args and identity, not a hash.

Durable operations require lossless JSON for `args` and `identity`, because a
recovered operation must compare equal to the one that was saved.

## Durable approvals

The same idea for the human boundary:

```ts
import { createApprovalBroker, withApprovalPersistence } from '@ai-agent-sdk/core'

const approvals = withApprovalPersistence(createApprovalBroker(), {
  async savePending(request)            { await db.insertPending(request) },
  async saveDecision(request, decision) { await db.recordDecision(request.approvalRequestId, decision) },
})
```

The wrapper installs the interactive waiter **before** the first storage write,
so a decision arriving during the write is never dropped.

A saved decision is **never** auto-applied to a new request. On recovery the
host loads pending records and reissues a fresh approval — that is what
`createApprovalRequest` mints an SDK-side `approvalRequestId` for.

## Read next

- [Tool Execution](/en/03-tools/tool-execution) — the dispatch pipeline
- [Permissions](/en/03-tools/permissions) — the approval boundary
- [`Tool` API](/en/13-api-reference/tool) — every signature
