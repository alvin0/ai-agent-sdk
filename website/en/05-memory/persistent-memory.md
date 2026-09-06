# Persistent Memory

A session is intentionally stateful. Create one per chat, user thread, or job.

## Conversation identity

```ts
const session = agent.createSession({ conversationId: 'thread-42' })
```

`createSession({ conversationId })` accepts an application-owned id; otherwise one
is generated. The id is preserved across snapshots and emitted as
`gen_ai.conversation.id` on root trace spans.

`session.reset()` intentionally starts a **fresh** conversation id and clears
conversation-scoped skill activation, while keeping the same agent, provider, and
tools.

```ts
const chat = agent.createSession()

await chat.run('My project uses SQLite.')
await chat.run('Which database did I mention?')   // sees the previous turn

chat.reset()   // same agent/provider/tools, fresh conversation
```

## Save and reopen

Persist and reopen a conversation through the session-level snapshot API. You do
not need to import or hydrate `History` and `AgentMemory` separately.

```ts
const chat = agent.createSession()
await chat.run('Review this API shape.')

await conversationStore.save(chat.conversationId, chat.snapshot())

// Later, possibly in a different process:
const snapshot = await conversationStore.load(conversationId)
const resumed = agent.resumeSession(snapshot)
await resumed.run('Now suggest a migration path.')
```

With the `defineAgent()` style it is the same shape:

```ts
const resumed = ada.resumeSession({ registry, snapshot })
```

## What a snapshot contains

The snapshot is **JSON-safe** and includes:

- its schema version;
- `conversationId`;
- agent identity;
- append-only history;
- durable memory;
- the **identities** of any activated skills.

## What a snapshot deliberately excludes

**Skill bodies and resources are never persisted.** Resume rediscovers and
rehydrates them from current providers, failing **before** the model request if
provider, source, or resource location drifted.

Restored activation count and identity/location string sizes are bounded by the
definition's skill policy, and unknown snapshot fields are discarded.

## Resume rules

| Situation | Behaviour |
| --- | --- |
| Legacy v1 snapshot without skill state | Valid — accepted. |
| Different agent id | Fails early. |
| Skill provider/source/location drifted | Fails before the model request. |
| Unknown fields present | Discarded. |

The resumed session uses the **current code-owned agent definition** and freshly
supplied runtime dependencies — registry, tools, approvals, UI brokers. A
snapshot restores conversation state, not code.

## History and memory as low-level APIs

Advanced callers may supply an existing `History` or memory object to
`createSession()`. Application-level tools supplied at session creation are
**combined** with tools owned by the definition.

Applications that deliberately manage the two stores independently can use
`History.fromSnapshot()` and `AgentMemory.fromSnapshot()`. Most applications
should not — the session-level snapshot exists so you do not have to keep two
stores in sync.

## Concurrency

A session prevents overlapping runs on the same conversation. `session.compact()`
takes the same per-session exclusion lock as a model turn, so compaction and
normal execution cannot rewrite one history concurrently.

```ts
session.isRunning              // boolean
await session.whenIdle(signal) // wait for the current run to settle
```

Run-specific cancellation goes through `{ signal }`:

```ts
await session.run('Long task…', { signal: abortController.signal })
```

## Read next

- [Custom Memory Provider](/en/05-memory/custom-memory-provider) — `defineMemoryStore()`
- [Skill Lifecycle](/en/04-skills/skill-lifecycle) — why skill bodies are not persisted
