# `Memory`

Import from `@alvin0/ai-agent-sdk-core/memory`.

```ts
export { defineMemoryStore, MEMORY_STORE_API_VERSION, MEMORY_ERROR_CODES }
export type {
  MemoryBinding, MemoryCommitInput, MemoryCommitResult, MemoryLoadResult,
  MemoryScope, MemoryStore, MemoryStoreDefinition, MemoryStoreOptions,
}
```

## `defineMemoryStore`

```ts
defineMemoryStore(definition: MemoryStoreDefinition): MemoryStore
```

```ts
interface MemoryStore {
  readonly kind: 'memory-store'
  readonly apiVersion: 1
  readonly id: string
  readonly load: (key: string, options: MemoryStoreOptions) => Promise<MemoryLoadResult | undefined>
  readonly commit: (input: MemoryCommitInput, options: MemoryStoreOptions) => Promise<MemoryCommitResult>
}

/** What you pass to defineMemoryStore(); kind and apiVersion are added for you. */
type MemoryStoreDefinition = Omit<MemoryStore, 'kind' | 'apiVersion'>

interface MemoryStoreOptions {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}
```

`load()` is addressed by a **key**, not by a scope — the scope on the binding is
what the runtime turns into that key. Returning `undefined` means "nothing
stored yet", which is different from an empty snapshot.

```ts
interface MemoryLoadResult {
  readonly snapshot: AgentMemorySnapshot
  readonly revision: string
}

interface MemoryCommitInput {
  readonly key: string
  readonly snapshot: AgentMemorySnapshot
  readonly expectedRevision: string | null   // null on a first write
}

interface MemoryCommitResult {
  readonly revision: string
}
```

A revision is a **string** the store owns; the SDK only ever hands back one it
was given. The store carries a whole `AgentMemorySnapshot`, not a bare item
list.

The store is **revisioned**, not last-write-wins: `commit()` must honour
`expectedRevision` and fail the write when the row moved underneath it, so a
concurrent writer cannot be silently overwritten.

```ts
const pgMemory = defineMemoryStore({
  id: 'pg-memory',
  load: async (key, { signal }) => {
    const row = await db.selectMemory(key, { signal })
    return row === undefined ? undefined : { snapshot: row.snapshot, revision: row.revision }
  },
  commit: async ({ key, snapshot, expectedRevision }, { signal }) => {
    const revision = await db.compareAndSetMemory(key, snapshot, expectedRevision, { signal })
    return { revision }
  },
})
```

## `MemoryScope`

```ts
type MemoryScope =
  | { readonly kind: 'conversation'; readonly namespace: string }
  | { readonly kind: 'fixed'; readonly key: string; readonly sharedAcrossSessions: true }
```

A conversation scope is keyed by the session's `conversationId` **within**
`namespace`, so two tenants cannot collide. A fixed scope must say
`sharedAcrossSessions: true` out loud — sharing state between conversations is
never something you get by accident.

**Snapshot binding identity** is recorded, so a snapshot taken under one scope
cannot silently resume under another — that is the cross-tenant isolation
guarantee.

## `MemoryBinding`

```ts
interface MemoryBinding {
  readonly store: MemoryStore
  readonly bindingId: string                          // recorded in the snapshot
  readonly scope: MemoryScope
  readonly requirement: 'required' | 'best-effort'
}
```

Every field is required — there is no partial binding, because each one changes
what a resumed snapshot is allowed to do.

```ts
// On an agent
runtime.agent({
  /* … */
  memory: {
    store: pgMemory,
    bindingId: 'billing-memory',
    requirement: 'required',
    scope: { kind: 'conversation', namespace: 'tenant-42' },
  },
})

// Per session, or disabled for this conversation
agent.createSession({
  memory: {
    store: pgMemory,
    bindingId: 'team-memory',
    requirement: 'best-effort',
    scope: { kind: 'fixed', key: 'release-team', sharedAcrossSessions: true },
  },
})
agent.createSession({ memory: false })
```

`memory: false` is a **session** option; a definition takes a `MemoryBinding` or
nothing at all.

Seeds and objective capture are **not** part of the binding — they belong to the
agent's memory config:

```ts
interface AgentMemoryConfigInput {
  readonly autoCaptureObjective?: boolean   // default true
  readonly maxInjectedChars?: number        // default 12,000
  readonly maxItems?: number                // default 1,024
  readonly maxItemChars?: number            // default 65,536
  readonly maxStoredChars?: number          // default 1 MiB
  readonly seed?: readonly AgentMemorySeed[]
}
```

## Memory items

```ts
type AgentMemoryKind =
  | 'objective' | 'constraint' | 'decision' | 'fact' | 'progress' | 'next-step'

interface AgentMemorySeed {
  readonly id?: string        // reusing an id UPDATES that item
  readonly kind: AgentMemoryKind
  readonly content: string
}

interface AgentMemoryItem extends AgentMemorySeed {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
}
```

The `.memory` accessor is on the **`defineAgent()` layer's `AgentSession`**.
`RuntimeAgentSession` — what `runtime.agent().createSession()` returns — exposes
only `conversationId`, `isRunning`, `run`, `stream`, `inject`, `snapshot`,
`compact`, `reset`, and `whenIdle`.

```ts
const session = ada.createSession({ registry })

session.memory.remember({ kind: 'decision', content: 'Use a transactional outbox.' })
session.memory.forget('release-constraint')
session.memory.items()
session.memory.render(12_000)
```

Rendering is bounded and prioritizes objectives, constraints, and decisions.
Memory arrives as app-authored **user** context under `<task-memory>`, never as
system instructions.

## Compaction

```ts
interface AgentCompactionOptions {
  readonly thresholdRatio?: number        // 0.8
  readonly retainRatio?: number           // 0.2
  readonly maxSummaryTokens?: number
  readonly maxOverflowRetries?: number    // 1
  readonly maxToolResultChars?: number
}
```

```ts
const result: CompactionResult | null = await session.compact({ signal })
result?.shadowedSeqs
result?.estimatedTokensAfter
```

`compaction: false` disables checkpointing. `session.compact()` takes the same
per-session exclusion lock as a model turn.

## Session snapshots

```ts
interface RuntimeAgentSessionSnapshot extends AgentSessionSnapshot {
  readonly memoryBindingId?: string
}
```

JSON-safe, versioned. Contains `conversationId`, agent identity, append-only
history, durable memory, and the **identities** of activated skills. Skill bodies
and resources are **never** persisted.

Low-level alternatives, for applications that deliberately manage the two stores
independently:

```ts
History.fromSnapshot(snapshot)
AgentMemory.fromSnapshot(snapshot)
```

## Bounds

| Limit | Default |
| --- | --- |
| Items retained | 1,024 |
| Characters per item | 65,536 |
| Total content | 1 MiB |
| Characters injected per request | 12,000 |
| History entries | 100,000 |
| Bytes per history entry | 16 MiB |
| Total history bytes | 128 MiB |

Restore paths validate limits **before publication** and canonicalize only the
documented fields.

## Ownership

A memory store is `borrowed-caller-owned`: the runtime reads and writes, and
**never closes it**. Memory operations appear on the observation bus as
`sdk.memory.operation` with load/append/save **counts** and never message bodies.

## Read next

- [Memory](/en/05-memory/) — the narrative version
- [Custom Memory Provider](/en/05-memory/custom-memory-provider)
