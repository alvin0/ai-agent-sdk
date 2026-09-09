# Memory — Overview

Long-running tasks have **two different continuity problems**, and the SDK keeps
them separate:

| Concern | Mechanism | Lossy? |
| --- | --- | --- |
| Facts that must never disappear — the objective, constraints, decisions | **Task memory** | No — pinned outside the compactable span |
| Older conversation that no longer fits the context window | **Context compaction** | Yes, by design |

A checkpoint is lossy. Pinned memory is **not part of the compactable history
span**. Conflating the two is how long agents lose their objective halfway
through.

## Four layers of state

```text
┌─ Task memory ────────────────── pinned, bounded, host-controlled
│    objective · constraint · decision · fact · progress · next-step
│    → injected as <task-memory> app-authored USER context
│
├─ History (entries) ──────────── append-only durable transcript, never deleted
│    every message + every lifecycle record, including failed compactions
│
├─ History (messages) ─────────── the current model-visible projection
│    recent turns verbatim + checkpoints replacing older spans
│
└─ Snapshot ──────────────────── JSON-safe, versioned, portable across processes
     conversationId · agent identity · history · memory · skill identities
```

## Defaults

Every `defineAgent()` definition enables both mechanisms unless configured
otherwise:

| Behaviour | Default |
| --- | --- |
| First real user message becomes `original-objective` memory | on |
| Memory prepended to each request under `<task-memory>` | on |
| Automatic compaction checks pressure before each model step | on |
| Pressure threshold | 80% of the **usable** context window |
| Retained verbatim tail | most recent 20% |
| Oversized tool-result text | pruned to a durable head/tail projection |
| Pressure backoff | 4 model steps on `unreachable-threshold` or `low-savings` |
| Provider-confirmed `CONTEXT_WINDOW_EXCEEDED` | may compact and retry once |
| Checkpoint call | inherits the conversation provider, model, and effort |

```text
usable input window = model.contextWindow − effective output reservation
```

A model with a 128k combined window and a 32k output budget is therefore never
treated as having 128k available for input.

> If an adapter reports no context window, automatic pressure compaction is a
> **no-op** unless `maxInputTokens` is configured. Manual `session.compact()` and
> overflow recovery still work.

## Bounds

| Limit | Default |
| --- | --- |
| Memory items retained | 1,024 |
| Characters per memory item | 65,536 |
| Total memory content | 1 MiB |
| Characters injected per request | 12,000 |
| History entries | 100,000 |
| Bytes per history entry | 16 MiB |
| Total history bytes | 128 MiB |

Restore paths validate limits **before publication** and canonicalize only the
documented fields.

## Memory is user-authored, deliberately

Memory is **not** concatenated into the system prompt. It arrives as app-authored
**user** context, so a user-authored objective retains user authority instead of
being silently promoted to developer/system instructions.

The model also cannot rewrite it: memory is inspectable and host-controlled.

```ts
session.memory.remember({ kind: 'decision', content: 'Use the incremental path.' })
session.memory.forget('release-constraint')
session.memory.items()
```

## In this chapter

| Page | Answers |
| --- | --- |
| [Short-term Memory](/en/05-memory/short-term-memory) | History, task memory, and how compaction actually runs |
| [Persistent Memory](/en/05-memory/persistent-memory) | Snapshots, save/resume, and what is deliberately excluded |
| [Custom Memory Provider](/en/05-memory/custom-memory-provider) | `defineMemoryStore()` and scope/ownership rules |
