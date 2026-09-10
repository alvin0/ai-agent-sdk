# Instructions, context sections, injected text

## The authority model — never promoted

The SDK tracks **who authored** each piece of context and never upgrades one
authority into another.

| Source | Authority | Reaches the model as |
| --- | --- | --- |
| `instructions` | Developer | System prompt |
| Task memory | User | App-authored user context under `<task-memory>` |
| `session.inject(text)` | User-attributed | A user-role history message |
| `ctx.addContext()` from a tool | App | A user message on the next request |
| `additionalInstructions` per run | Developer | Appended developer guidance for that run |

Task memory is deliberately **not** concatenated into the system prompt: a
user-authored objective keeps user authority instead of being silently promoted
to a developer rule. That distinction is what lets the model weigh a user
constraint against a developer one.

```ts
await agent.generate('Review abc123.', {
  additionalInstructions: 'The customer is on the legacy plan; avoid v2-only advice.',
})
```

Per-run additions do not mutate the definition — a definition is frozen.

## Two injections the SDK makes for you

Both appear in transcripts, and both are recorded as lifecycle entries, so
`history.entries()` shows exactly what the model was told and when.

- **Budget warning.** At 75% of `maxToolCalls`, one app-authored warning is
  injected before the next model step, so a long agent can reserve calls for
  edits and verification instead of discovering the ceiling after its last
  dispatch.
- **Compaction checkpoint.** Near the context limit, older conversation is
  replaced by a structured handoff checkpoint as a user-role message.

## Context sections — always-on, moving context

A section is a callback the turn loop re-runs **before every model round**. It
owns exactly one node on the model surface and rewrites that node only when its
content actually changed.

```ts
import { defineContextSection } from '@alvin0/ai-agent-sdk-core'

const clock = defineContextSection({
  id: 'wall-clock',
  resolve() {
    const text = `Current time: ${new Date().toISOString()}`
    return { revision: text, text }
  },
})
```

### Why not the system prompt

| Mechanism | Changes mid-session? | Can retract? | Cost when unchanged |
| --- | --- | --- | --- |
| `instructions` | Rewrites the cache prefix | No | Cache miss |
| `additionalInstructions` | Per run only | No | Re-sent each run |
| `session.inject()` | Yes, appends | No | Stays in history until compacted |
| **Context section** | Yes, replaces in place | Yes | **Zero** |

The system prompt is the cache prefix — rewriting it mid-session discards the
prompt cache, and `additionalInstructions` can only append.

Use a section for context that is always-on and moving: working directory,
current branch, live incident status, project instruction files. Skills are the
opposite contract — advertised by description, loaded only when picked.

### The contract

```ts
interface ContextSection {
  readonly id: string                    // kebab-case, unique within one turn
  resolve(input: ContextSectionResolveInput):
    | ContextSectionState | undefined | Promise<ContextSectionState | undefined>
  readonly retractionText?: string
}

interface ContextSectionState {
  readonly revision: string              // change key
  readonly text: string                  // exact model-facing text
}

interface ContextSectionResolveInput {
  readonly signal: AbortSignal
  readonly step: number                              // 0 before the first round
  readonly touches: readonly ContextToolTouch[]      // calls committed since last resolve
  readonly current: ContextSectionState | undefined  // what is on the surface now
  readonly scope: ContextSectionScope                // { agentId, conversationId }
}

interface ContextToolTouch {
  readonly toolName: string
  readonly rawArguments: string          // verbatim provider arguments
  readonly failed: boolean
}
```

| Return | Effect |
| --- | --- |
| Same `revision` as the live node | Nothing written. No token cost. |
| A different `revision` | The node is **replaced** in place |
| `undefined` | Retraction: the node becomes `retractionText` |

A changed section replaces its own node rather than appending beside it, so the
model never reads two versions of the same context. The loop cannot delete a
surface node, so a retraction becomes a short message; the default is
`The previously provided '<id>' context no longer applies.`

`revision` is usually a content digest; a counter works when the producer
already tracks versions.

`touches` is how a section reacts to what the model just did — a read that
entered a new directory, a command that changed the branch. A **failed** call
did not enter anywhere; treat it accordingly.

### Scope keying is not optional

One section object is routinely mounted on a definition that many sessions
instantiate — every team member, every worker cloned from a lead — and those
sessions run **concurrently**.

```ts
// WRONG: one shared accumulator across every session
const dirs = new Set<string>()

// RIGHT: keyed by the conversation asking
const dirs = new Map<string, Set<string>>()
resolve({ scope, touches }) {
  const key = scope.conversationId ?? '<unscoped>'
  // …
}
```

State accumulated across steps must be keyed by `scope`, or one agent's
discoveries leak into another's context. Both fields are absent for a bare
`runTurn` with no trace identity.

### Mounting

Definition-level, for a section that belongs to the agent wherever it runs:

```ts
const agent = defineAgent({
  id: 'coder',
  instructions: 'You are a coding agent.',
  contextSections: [clock],
})
```

Session-level, when content depends on the environment:

```ts
// runtime.agent() takes a binding INPUT, not a DefinedAgent — their `model`
// shapes differ, so `runtime.agent(definedAgent)` does not type-check.
const session = agent.createSession({
  registry,
  contextSections: [createProjectInstructionsSection({ cwd: workspaceDir })],
})
```

Duplicate ids are rejected once, at assembly, rather than per step.

Bounds: id pattern `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, text at most
`MAX_CONTEXT_SECTION_TEXT_BYTES` (262,144); an invalid shape raises
`CONTEXT_SECTION_INVALID`.

Assembled context is **advisory**: a section that throws or exceeds its budget
does not fail the run.

## `AGENTS.md`-style files on Node

```ts
import { createProjectInstructionsSection } from '@alvin0/ai-agent-sdk-instructions-node'
```

The core SDK never touches a filesystem, clock, or network on a section's
behalf — a filesystem-backed section is built by a platform package and mounted
through the session option above.
