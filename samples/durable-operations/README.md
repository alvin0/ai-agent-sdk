# Durable tool operations on Node SQLite

[journal.ts](./journal.ts) is a working host-side store for
`createToolExecutionInterceptor`. It keeps a mutating tool call from running twice
when a process dies around it, and it tells completed apart from unknown. It needs
Node 22.18+ (`node:sqlite`, which Node still marks experimental). It is a sample to
copy into a host, not a package.

What it proves and what it does not:

- Several processes on **one machine** sharing one SQLite file. It is not a
  distributed store and has no multi-host lease.
- **No exactly-once promise** to anything outside the database. A call whose effect
  may have happened stays `unknown` until the host reconciles it from an independent
  receipt. A delivery retry still needs the receiver to deduplicate.
- The session checkpoint and this journal are **separate stores**. Recovery relies
  on the pending intent written before dispatch, not on one transaction across both.

## Use it

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { createToolExecutionInterceptor, withApprovalPersistence, createApprovalBroker } from '@alvin0/ai-agent-sdk-core/agent'
import { openOperationJournal } from './journal.ts'

const journal = openOperationJournal('operations.sqlite')

// 1. Before dispatch, persist the exact call the host intends to make.
//    The operation ID is the host's, scoped to tenant and session, never the provider's call ID.
journal.recordIntent('checkout-42', {
  operationId: 'tenant-a:checkout-42', toolName: 'charge_card', args: { amount: 1200 }, identity: { tenant: 'tenant-a' },
})

// 2. Resume the recorded intent (after a restart too) through the interceptor.
const intent = journal.pendingIntent('checkout-42')!
const session = agent.createSession({
  interceptors: [createToolExecutionInterceptor({
    identity: intent.identity, operationId: () => intent.operationId, store: journal.store,
  })],
  approvals: withApprovalPersistence(createApprovalBroker(), journal.approvals),
})

// 3. After the checkpoint that carries the result is written and the result delivered:
journal.markPublished(intent.operationId)
journal.finishIntent('checkout-42')
```

A resumed call whose claim never completed fails with `OPERATION_OUTCOME_UNKNOWN`.
Do not retry it. Reconcile it:

```ts
const outcome = await journal.reconcile('tenant-a:checkout-42', async operation => {
  // Ask the external service by idempotency key. Only an independent receipt counts.
  const receipt = await payments.lookup(operation.operationId)
  return receipt === undefined
    ? { status: 'unknown' }
    : { status: 'completed', result: { isError: false, value: receipt, content: [{ type: 'text', text: 'charged' }] } }
})
```

`reconcile` takes the operation over in a transaction that raises its generation.
The original writer can no longer commit if it is still alive. The recovered result
still passes through the session's current post-policy before anyone sees it.

## Schema and retention

- `PRAGMA user_version` holds the schema version (currently 3). Opening runs
  forward-only migrations, each in its own transaction. A database written by newer
  code is refused. Version 1 is the research schema, so an SP-02 research database
  migrates in place.
- `prune({ olderThanMs })` deletes only operations that are completed, marked
  published and older than the TTL. After pruning, the journal no longer remembers
  those IDs: the host must stop replaying them or keep a separate deduplication
  record for the required retention horizon.
- `claimed` and `unknown` operations are never deleted automatically. When an outcome
  can never be established, an operator can call `retire(id, { actor, reason })`.
  Retiring writes a tombstone, and that ID can never be claimed again.
- Pending approvals record the journal owner that saved them. Opening a journal never
  expires anything, because another writer may still be alive. Once the host knows the
  earlier writers are gone, it calls `expirePendingApprovals()`, which marks the pending
  approvals of other owners `stale`. A saved decision never answers a new request.

## Evidence

[Unit tests](../../tests/unit/durable-operations-sample.spec.ts) cover migration,
restart, conflict, fencing, retire, prune and stale approvals. The SP-02 process
harness (`test-human/spikes/durable-operation.ts`) runs its 45 kill/restart cases
through this journal. It uses SIGKILL at handshake failpoints, two concurrent
workers, a real `SQLITE_FULL`, stale approvals, a fenced late writer and an HTTP
delivery that disconnects before ack. See the
[decision record](../../docs/plans/ai-agent-sdk_sp-02_stable-identity_adr_2026-09-26.md).
