# Agent Instructions

## Where instructions live

`instructions` is the agent's stable developer-authored guidance. It is part of
the frozen definition, not per-request data.

```ts
const agent = runtime.agent({
  id: 'reviewer',
  model,
  instructions: [
    'Review the release candidate.',
    'Inspect evidence before concluding.',
    'Report concrete risks, not general advice.',
  ].join(' '),
})
```

## The authority model

The SDK distinguishes **who authored** a piece of context, and never promotes one
authority to another.

| Source | Authority | Reaches the model as |
| --- | --- | --- |
| `instructions` | Developer | System prompt |
| Task memory | User | App-authored user context under `<task-memory>` |
| `session.inject(text)` | User-attributed | A user-role history message |
| `ctx.addContext()` from a tool | App | A user message on the next request |
| `additionalInstructions` per run | Developer | Appended developer guidance for that run |

**Task memory is deliberately not concatenated into the system prompt.** A
user-authored objective retains user authority instead of being silently
promoted to developer/system instructions. That distinction matters when the
model must weigh a user constraint against a developer rule.

## Per-run additions

```ts
await agent.generate('Review abc123.', {
  additionalInstructions: 'The customer is on the legacy plan; avoid v2-only advice.',
})
```

Use this for request-scoped guidance that does not belong in the agent's stable
identity. It does not mutate the definition — the definition is frozen.

## Mode changes how the model is prompted

`mode` is not just a loop policy; it changes the structural contract the model is
held to.

| Mode | Additional prompting |
| --- | --- |
| `basic` | Use tools within the turn budget and answer. |
| `deep` | A structural `submit_result` self-check must be accepted before the turn can end. |
| `deep-human-in-loop` | Adds the blocking `request_user_input` boundary for material user decisions. |

```ts
const planner = runtime.agent({ id: 'planner', model, instructions: '…', mode: 'deep' })
```

`deep-human-in-loop` requires a `userInput` broker at session creation, so a
missing UI integration fails early rather than deadlocking mid-run.

## Commentary is separate from reasoning

```ts
runtime.agent({ /* … */, commentary: 'concise' })
```

| Value | Behaviour |
| --- | --- |
| `concise` | Ask for short, user-visible progress narration before tools and after results. |
| `auto` | Leave narration to the model. |
| `off` | Request only the final answer. |

This is deliberately **not** reasoning. `assistant-reasoning` events contain only
reasoning summary or content the provider actually emitted;
`assistant-text` is public text classified as `commentary` or `final-answer`.

Commentary events also carry `timing` — `before-tools`, `after-tools`,
`between-tools`, `standalone` — plus tool-call id arrays, so a GUI links a
narration line to the tool calls it describes without heuristics.

## Instructions the SDK injects for you

Two injections happen automatically and are worth knowing about, because they
will appear in your transcripts:

**Budget warning.** At 75% of `maxToolCalls`, the loop injects one app-authored
warning before the next model step. This gives a long coding agent a chance to
stop broad exploration and reserve calls for edits and verification, instead of
discovering the limit only after the last dispatch.

**Compaction checkpoint.** Near the context limit, older conversation is replaced
by a structured handoff checkpoint as a user-role message. See
[Memory](/en/05-memory/).

Both are recorded in history as lifecycle entries, so `history.entries()` shows
exactly what the model was told and when.

## Read next

- [Agent Context](/en/02-agents/agent-context) — everything else that reaches the model
- [Workflows](/en/06-workflows/) — what `mode` implies for orchestration
