# Agent Context

"Context" here means **exactly what reaches the model on one request**. The SDK
assembles it from five sources, and each one is measured before dispatch.

## What one request contains

```text
┌─ system prompt ──────────────────────────────────────────┐
│  instructions              (developer authority)         │
│  + mode contract           (deep / HIL structural rules) │
│  + skill catalog metadata  (id, name, description only)  │
└──────────────────────────────────────────────────────────┘
┌─ messages ───────────────────────────────────────────────┐
│  <task-memory> block       (app-authored user context)    │
│  history projection        (history.messages())           │
│    · verbatim recent turns                                │
│    · compaction checkpoints replacing older spans         │
│  additionalInstructions    (this run only)                │
└──────────────────────────────────────────────────────────┘
┌─ tools ──────────────────────────────────────────────────┐
│  host tool schemas + generated skill tools                │
│  native tool schemas       (provider-executed)            │
└──────────────────────────────────────────────────────────┘
```

Everything else — skill bodies, resource files, tool result values kept for your
UI — stays out of context until something deliberately places it there.

## History has two views

```ts
history.entries()    // the durable human transcript: every message + lifecycle record
history.messages()   // the current model-visible projection
```

`entries()` is append-only and **never deleted**, including failed compaction
attempts. `messages()` is what the model sees now — older spans may be shadowed
by a checkpoint.

That split is why you can audit exactly what the model was told while still
compacting aggressively.

## Adding context without a model turn

```ts
const seq = session.inject('The candidate commit is abc123.')
```

`inject()` appends an attributed user-role message and returns its sequence
number. No model request happens. Use it when your application learns something
the model will need on its next turn.

In a team, `team.sendMessage({ delivery: 'quiet' })` does the same thing across
sessions — durable local context without waking an idle agent.

## Adding context from inside a tool

```ts
execute: async (args, ctx) => {
  if (fileChangedUnderneath) {
    ctx.addContext('The file changed since you last read it; re-read before editing.')
  }
  return result
}
```

The blocks become a user message the model sees on the **following** request. Use
it for information the model needs but did not ask for — a reminder that it has
repeated itself, a warning that state moved.

It arrives on the result as `additionalContext`, so it is auditable rather than
invisible.

## Recomputed context: sections

A **context section** is a callback the loop re-runs before every model round.
It owns one node on the model surface and replaces that node only when its
`revision` changes — so unchanged context costs nothing.

```ts
const branch = defineContextSection({
  id: 'git-branch',
  resolve: () => ({ revision: head.sha, text: `Branch: ${head.ref}` }),
})
```

Use it for context that is always-on and **moving** — the working directory, a
live branch, `AGENTS.md` files that change under the agent. Unlike
`inject()` it can be retracted, and unlike `instructions` it does not rewrite
the prompt cache prefix.

See [Context Sections](/en/02-agents/context-sections).

## Task memory is the pinned part

The first real user message automatically becomes `original-objective` memory,
outside the compactable transcript.

> **Which session.** `.memory` is on the `defineAgent()` layer's
> `AgentSession`. The runtime layer's `RuntimeAgentSession` — what
> `runtime.agent().createSession()` returns — has no `.memory` accessor; bind a
> store there and read it back through a `defineAgent()` session, or keep task
> facts in your own state.

```ts
session.memory.remember({ kind: 'decision', content: 'Use the incremental migration path.' })
session.memory.forget('release-constraint')
console.log(session.memory.items())
```

Memory rendering is bounded — at most 12,000 characters injected per request —
and prioritizes objectives, constraints, and decisions. See
[Memory](/en/05-memory/) for the full model.

## Skills add metadata, not bodies

A skill catalog contributes only `id`, name, description, and selection boundary
to the system prompt, capped by `maxCatalogChars` (8,000 by default).

A body enters context only after the model calls `load_skill`; a resource only
after `read_skill_resource`. Disk reads and JavaScript heap do not themselves
consume model tokens — text starts consuming context only when placed in the
system prompt, a message, or a tool result.

## Context is measured, not guessed

Before each normal model step, the SDK measures the **full next request** —
system memory, messages, and tool schemas — against the model's usable window:

```text
usable input window = model.contextWindow − effective output reservation
```

A model with a 128k combined window and a 32k output budget is therefore never
treated as having 128k available for input.

If the measurement crosses `compaction.thresholdRatio` (80% by default), older
context is checkpointed before the request goes out. If an adapter reports no
context window, automatic pressure compaction is a **no-op** unless
`maxInputTokens` is configured.

The default meter is a conservative deterministic estimator over text, tool
schemas, replay state, and fixed image costs — the neutral SDK cannot bundle
every provider tokenizer.

## Read next

- [Context Sections](/en/02-agents/context-sections) — recomputed, retractable context
- [Memory](/en/05-memory/) — pinned facts and context compaction
- [Skills](/en/04-skills/) — progressive disclosure in three phases
- [Performance](/en/10-advanced/performance) — every bound and budget
