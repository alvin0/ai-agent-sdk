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
interface MemoryStoreDefinition {
  readonly id: string
  readonly apiVersion: typeof MEMORY_STORE_API_VERSION

  load(input: { scope: MemoryScope; signal?: AbortSignal }): Promise<MemoryLoadResult>
  commit(input: MemoryCommitInput): Promise<MemoryCommitResult>
}
```

```ts
interface MemoryLoadResult {
  readonly revision: number
  readonly items: readonly MemoryItem[]
}

interface MemoryCommitInput {
  readonly scope: MemoryScope
  readonly revision: number          // the revision load() returned
  readonly items: readonly MemoryItem[]
  readonly signal?: AbortSignal
}

type MemoryCommitResult =
  | { readonly status: 'committed'; readonly revision: number }
  | { readonly status: 'conflict' }
```

The store is **revisioned**, not last-write-wins. `commit()` must reject the
write if the row moved underneath it and return `conflict`; the SDK then reloads
and retries with fresh state.

## `MemoryScope`

```ts
type MemoryScope =
  | { readonly kind: 'conversation' }               // keyed by the session's conversationId
  | { readonly kind: 'fixed'; readonly key: string } // shared across sessions
```

**Snapshot binding identity** is recorded, so a snapshot taken under one scope
cannot silently resume under another — that is the cross-tenant isolation
guarantee.

## `MemoryBinding`

```ts
interface MemoryBinding {
  readonly store?: MemoryStore
  readonly scope?: MemoryScope
  readonly seed?: readonly MemoryItemInput[]
  readonly autoCaptureObjective?: boolean            // default true
}
```

```ts
// On an agent
runtime.agent({ /* … */, memory: { store, scope: { kind: 'conversation' } } })

// Per session, or disabled
agent.createSession({ memory: { store, scope: { kind: 'fixed', key } } })
agent.createSession({ memory: false })
```

## Memory items

```ts
type MemoryItemKind =
  | 'objective' | 'constraint' | 'decision' | 'fact' | 'progress' | 'next-step'

interface MemoryItemInput {
  readonly id?: string        // reusing an id UPDATES that item
  readonly kind: MemoryItemKind
  readonly content: string
}
```

```ts
session.memory.remember({ kind: 'decision', content: 'Use a transactional outbox.' })
session.memory.forget('release-constraint')
session.memory.items()
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
