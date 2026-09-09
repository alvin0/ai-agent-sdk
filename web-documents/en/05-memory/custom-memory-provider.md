# Custom Memory Provider

`defineMemoryStore()` lets you back task memory with your own store — Postgres,
Redis, Durable Objects, a vector index, anything.

```ts
import { defineMemoryStore, MEMORY_STORE_API_VERSION } from '@alvin0/ai-agent-sdk-core/memory'
```

## The contract

```ts
const pgMemory = defineMemoryStore({
  id: 'pg-memory',
  apiVersion: MEMORY_STORE_API_VERSION,

  async load({ scope, signal }): Promise<MemoryLoadResult> {
    const row = await db.query(
      'select revision, items from agent_memory where scope_key = $1',
      [scopeKey(scope)],
      { signal },
    )
    return row === null
      ? { revision: 0, items: [] }
      : { revision: row.revision, items: row.items }
  },

  async commit({ scope, revision, items, signal }): Promise<MemoryCommitResult> {
    // Compare-and-swap on the revision the SDK read.
    const updated = await db.query(
      `update agent_memory set items = $1, revision = revision + 1
         where scope_key = $2 and revision = $3
       returning revision`,
      [items, scopeKey(scope), revision],
      { signal },
    )

    if (updated === null) return { status: 'conflict' }
    return { status: 'committed', revision: updated.revision }
  },
})
```

| Method | Purpose |
| --- | --- |
| `load({ scope, signal })` | Return the current `revision` and `items` |
| `commit({ scope, revision, items, signal })` | Write **only if** the revision still matches |

Both receive the operation cancellation signal. Forward it — a memory write that
outlives a cancelled run is exactly the kind of orphaned work the SDK is built to
avoid.

## Revisions are the whole point

The store is **revisioned**, not last-write-wins. `commit()` receives the revision
the SDK loaded and must reject the write if the row moved underneath it.

```ts
return { status: 'conflict' }   // the SDK reloads and retries with fresh state
```

Without compare-and-swap, two sessions sharing one memory scope silently clobber
each other's decisions — and because memory is what the model treats as
authoritative, that corruption is invisible until the agent contradicts itself.

## Scopes

```ts
const agent = runtime.agent({
  id: 'migration-agent',
  model,
  instructions: '…',
  memory: { store: pgMemory, scope: { kind: 'conversation' } },
})
```

| Scope | Key | Use for |
| --- | --- | --- |
| `conversation` | The session's `conversationId` | One thread's memory |
| `fixed` | A caller-supplied key | Memory shared across sessions — a project, a user, a workspace |

```ts
// A workspace-wide memory shared by every session in it:
memory: { store: pgMemory, scope: { kind: 'fixed', key: `workspace:${workspaceId}` } }
```

Per-session override is supported:

```ts
const session = agent.createSession({
  memory: { store: pgMemory, scope: { kind: 'fixed', key: tenantKey } },
})

const noMemory = agent.createSession({ memory: false })
```

**Snapshot binding identity** is recorded, so a snapshot taken under one scope
cannot silently resume under another. That is the cross-tenant isolation
guarantee: a resumed session cannot inherit a different tenant's memory because
the binding no longer matches.

## Ownership

A memory store is **borrowed**. The runtime uses it and never closes it — you own
its connection pool, its shutdown, and its retries.

| Label | Meaning |
| --- | --- |
| `borrowed-caller-owned` | The runtime reads and writes; you close it |

```ts
try {
  await runtime.close()
} finally {
  await db.end()          // your store, your shutdown
}
```

## Bounds still apply

Your store does not bypass the SDK's limits. Restore paths validate **before
publication**:

| Limit | Default |
| --- | --- |
| Items retained | 1,024 |
| Characters per item | 65,536 |
| Total content | 1 MiB |
| Characters injected per request | 12,000 |

A store that returns 50,000 items does not get 50,000 items into context — the
load is validated and bounded first. Only the documented fields are
canonicalized; unknown fields are discarded.

## Errors

`MEMORY_ERROR_CODES` carries the closed set of memory failure codes. A store
failure is surfaced as a typed error, not as a silent empty memory — an agent
running with **no** objective because the database was down is a failure you want
to see.

Memory operations appear on the observation bus as `sdk.memory.operation` with
load/append/save **counts** and **never** message bodies.

## The optimistic path

`defineMemoryStore()` is the *optimistic* memory-store family: the SDK reads,
works, and commits with a revision check, rather than holding a lock for the
duration of a turn. That keeps a slow store from serializing your agents, and
pushes conflict resolution to the one place that can see both versions.

## Read next

- [Short-term Memory](/en/05-memory/short-term-memory) — what memory holds and how it renders
- [Persistent Memory](/en/05-memory/persistent-memory) — the built-in snapshot path
