# Task memory, compaction, snapshots

Long-running work has **two** continuity problems, kept separate:

| Concern | Mechanism | Lossy? |
| --- | --- | --- |
| Facts that must never disappear — objective, constraints, decisions | **Task memory** | No — pinned outside the compactable span |
| Older conversation that no longer fits the window | **Context compaction** | Yes, by design |

Conflating them is how long agents lose their objective halfway through.

## Four layers of state

```text
┌─ Task memory ───────── pinned, bounded, host-controlled
│    objective · constraint · decision · fact · progress · next-step
│    → injected as app-authored USER context under <task-memory>
├─ History (entries) ─── append-only durable transcript, never deleted
│    every message + every lifecycle record, including failed compactions
├─ History (messages) ── the current model-visible projection
│    recent turns verbatim + checkpoints replacing older spans
└─ Snapshot ─────────── JSON-safe, versioned, portable across processes
     conversationId · agent identity · history · memory · skill identities
```

## Defaults on every `defineAgent()`

| Behaviour | Default |
| --- | --- |
| First real user message becomes `original-objective` memory | on |
| Memory prepended under `<task-memory>` each request | on |
| Automatic compaction checks pressure before each model step | on |
| Pressure threshold | 80% of the **usable** window |
| Retained verbatim tail | most recent 20% |
| Oversized tool-result text | pruned to a durable head/tail projection |
| Pressure backoff | 4 model steps on `unreachable-threshold` or `low-savings` |
| Provider-confirmed `CONTEXT_WINDOW_EXCEEDED` | may compact and retry once |
| Checkpoint call | inherits conversation provider, model, effort |

```text
usable input window = model.contextWindow − effective output reservation
```

A 128k combined window with a 32k output budget is never treated as 128k of
input. If an adapter reports no context window, automatic pressure compaction is
a **no-op** unless `maxInputTokens` is configured; manual `session.compact()` and
overflow recovery still work.

## Memory API — the real types

These differ from the narrative docs; the typings below are what compiles.

```ts
import { defineMemoryStore, MEMORY_STORE_API_VERSION } from '@alvin0/ai-agent-sdk-core/memory'

interface MemoryStore {
  readonly kind: 'memory-store'
  readonly apiVersion: 1
  readonly id: string
  readonly load: (key: string, options: MemoryStoreOptions) => Promise<MemoryLoadResult | undefined>
  readonly commit: (input: MemoryCommitInput, options: MemoryStoreOptions) => Promise<MemoryCommitResult>
}

type MemoryStoreDefinition = Omit<MemoryStore, 'kind' | 'apiVersion'>   // what you pass in

interface MemoryStoreOptions { readonly signal: AbortSignal; readonly logger: SdkLogger }
interface MemoryLoadResult  { readonly snapshot: AgentMemorySnapshot; readonly revision: string }
interface MemoryCommitInput { readonly key: string; readonly snapshot: AgentMemorySnapshot
                              readonly expectedRevision: string | null }
interface MemoryCommitResult { readonly revision: string }
```

Note: `revision` is a **string**, `load()` takes a **key** (not a scope) and may
return `undefined`, and it carries a whole `snapshot` rather than a bare item
list.

```ts
const store = defineMemoryStore({
  id: 'sql-memory',
  load: async (key, { signal }) => {
    const row = await db.get(key, { signal })
    return row === undefined ? undefined : { snapshot: row.snapshot, revision: row.revision }
  },
  commit: async ({ key, snapshot, expectedRevision }, { signal }) => {
    const revision = await db.compareAndSet(key, snapshot, expectedRevision, { signal })
    return { revision }
  },
})
```

The store is **revisioned, not last-write-wins**: `commit()` must honour
`expectedRevision` and fail the write when the row moved underneath it.
`expectedRevision: null` means "no prior revision" — a first write.

A store is `borrowed-caller-owned`: the runtime reads and writes and **never
closes it**. Bus events are `sdk.memory.operation` with counts only, never
bodies.

## Binding a store to an agent

```ts
interface MemoryBinding {
  readonly store: MemoryStore
  readonly bindingId: string                        // recorded in the snapshot
  readonly scope: MemoryScope
  readonly requirement: 'required' | 'best-effort'
}

type MemoryScope =
  | { readonly kind: 'conversation'; readonly namespace: string }
  | { readonly kind: 'fixed'; readonly key: string; readonly sharedAcrossSessions: true }
```

Every field is required — there is no partial binding.

```ts
runtime.agent({
  /* … */
  memory: { store, bindingId: 'billing-memory', requirement: 'required',
            scope: { kind: 'conversation', namespace: 'tenant-42' } },
})

// Per session, or disabled for this conversation:
agent.createSession({ memory: { store, bindingId, requirement: 'best-effort',
                                scope: { kind: 'fixed', key: 'team-wide', sharedAcrossSessions: true } } })
agent.createSession({ memory: false })
```

`memory: false` is a **session** option. A definition takes a `MemoryBinding`
or nothing.

`bindingId` is why a snapshot taken under one scope cannot silently resume under
another — that is the cross-tenant isolation guarantee.

## Items, seeds, and per-agent memory config

```ts
type AgentMemoryKind =
  | 'objective' | 'constraint' | 'decision' | 'fact' | 'progress' | 'next-step'

interface AgentMemorySeed { readonly id?: string        // reusing an id UPDATES that item
                            readonly kind: AgentMemoryKind
                            readonly content: string }

interface AgentMemoryConfigInput {
  readonly autoCaptureObjective?: boolean   // default true
  readonly maxInjectedChars?: number        // default 12,000
  readonly maxItems?: number                // default 1,024
  readonly maxItemChars?: number            // default 65,536
  readonly maxStoredChars?: number          // default 1 MiB
  readonly seed?: readonly AgentMemorySeed[]
}
```

Seeds and `autoCaptureObjective` live on this config — **not** on
`MemoryBinding`.

## Reading and writing items at runtime

`RuntimeAgentSession` (from `runtime.agent()`) exposes only `conversationId`,
`isRunning`, `run`, `stream`, `inject`, `snapshot`, `compact`, `reset`,
`whenIdle`. It has **no** `.memory` accessor.

The `defineAgent()` layer's `AgentSession` does:

```ts
const session = ada.createSession({ registry })

session.memory.remember({ kind: 'decision', content: 'Use a transactional outbox.' })
session.memory.forget('release-constraint')
session.memory.items()      // readonly AgentMemoryItem[] with createdAt/updatedAt
session.memory.render(12_000)
session.history             // append-only History
session.skills              // SkillCatalog | undefined
```

Rendering is bounded and prioritizes objectives, constraints, and decisions.
Memory is app-authored **user** context under `<task-memory>`, never system
instructions.

## Compaction

```ts
interface AgentCompactionOptions {
  readonly thresholdRatio?: number        // 0.8
  readonly retainRatio?: number           // 0.2
  readonly maxSummaryTokens?: number
  readonly maxOverflowRetries?: number    // 1
  readonly maxToolResultChars?: number
}

const result: CompactionResult | null = await session.compact({ signal })
result?.shadowedSeqs
result?.estimatedTokensAfter
```

`compaction: false` disables checkpointing. An explicit `maxInputTokens` replaces
the ratio threshold but is still bounded by the available input window. Token
counts are estimates, not an exact per-model tokenizer — overflow can still
occur.

## Snapshots and resume

```ts
const snapshot = session.snapshot()          // JSON-safe, versioned
const resumed = agent.resumeSession(snapshot)
```

Contains `conversationId`, agent identity, append-only history, durable memory,
and the **identities** of activated skills. Skill bodies and resources are never
persisted. `RuntimeAgentSessionSnapshot` adds `memoryBindingId`.

Low-level alternatives when managing the two stores independently:

```ts
History.fromSnapshot(snapshot)
AgentMemory.fromSnapshot(snapshot)
```

## Bounds

| Limit | Default |
| --- | --- |
| Items retained | 1,024 |
| Characters per item | 65,536 |
| Total memory content | 1 MiB |
| Characters injected per request | 12,000 |
| History entries | 100,000 |
| Bytes per history entry | 16 MiB |
| Total history bytes | 128 MiB |

Restore paths validate limits **before publication** and canonicalize only the
documented fields.
