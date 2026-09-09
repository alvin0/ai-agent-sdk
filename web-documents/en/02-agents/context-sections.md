# Context Sections

A context section is a **callback the turn loop re-runs before every model
round**. It owns exactly one node on the model surface and rewrites that node
only when its content actually changed.

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

## Why not the system prompt

The system prompt is the **cache prefix**. Rewriting it mid-session discards the
prompt cache, and `additionalInstructions` can only append — it has no way to
retract text that no longer applies.

| Mechanism | Changes mid-session? | Can retract? | Cost when unchanged |
| --- | --- | --- | --- |
| `instructions` | Rewrites the cache prefix | No | Cache miss |
| `additionalInstructions` | Per run only | No | Re-sent each run |
| `session.inject()` | Yes, appends | No | Stays in history until compacted |
| **Context section** | Yes, replaces in place | Yes | **Zero** |

A section is the right tool for context that is **always-on and moving**: the
working directory, the current branch, a live incident status, project
instruction files. Skills are the opposite contract — advertised by description
and loaded only when the model picks them.

## The contract

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
```

Three possible returns:

| Return | Effect |
| --- | --- |
| Same `revision` as the live node | Nothing written. No token cost. |
| A different `revision` | The section's node is **replaced** in place |
| `undefined` | Retraction: the node becomes `retractionText` |

A changed section replaces its own node rather than appending beside it, so the
model never reads two versions of the same context at once.

The loop cannot delete a surface node, so a retraction becomes a short message
saying the earlier text no longer applies. Default:
`The previously provided '<id>' context no longer applies.`

`revision` is usually a content digest; a monotonic counter works when the
producer already tracks versions.

## What `resolve` receives

```ts
interface ContextSectionResolveInput {
  readonly signal: AbortSignal
  readonly step: number                              // 0 before the first round
  readonly touches: readonly ContextToolTouch[]       // calls committed since last resolve
  readonly current: ContextSectionState | undefined   // what is on the surface now
  readonly scope: ContextSectionScope                 // { agentId, conversationId }
}

interface ContextToolTouch {
  readonly toolName: string
  readonly rawArguments: string      // verbatim provider arguments
  readonly failed: boolean
}
```

`touches` is how a section reacts to what the model just did — a read that
entered a new directory, a command that changed the branch. A **failed** call
did not enter anywhere; treat it accordingly.

## Scope keying is not optional

One section object is routinely mounted on a definition that many sessions
instantiate — every member of a team, every worker cloned from a lead — and
those sessions run **concurrently**.

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

A section that accumulates anything across steps must key that state by
`scope`, or one agent's discoveries leak into another's context. Both fields are
absent for a bare `runTurn` given no trace identity.

## Mounting

Definition-level for a section that belongs to the agent wherever it runs:

```ts
const agent = defineAgent({
  id: 'coder',
  instructions: 'You are a coding agent.',
  contextSections: [clock],
})
```

Session-level when the content depends on the environment — a working
directory, a working tree, a tenant:

```ts
const session = runtime.agent(agent).createSession({
  contextSections: [createProjectInstructionsSection({ cwd: workspaceDir })],
})
```

Duplicate ids are rejected once, at assembly, rather than per step.

## Failure is never fatal

Assembled context is **advisory**. A section that throws, exceeds its budget, or
never settles is skipped for that step with its previous node intact — losing it
must never cost the turn.

`MAX_CONTEXT_SECTION_TEXT_BYTES` (256 KiB) is the ceiling for one section's
rendered text. A section budgets its own content below that.

```ts
CONTEXT_SECTION_ID_PATTERN        // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
CONTEXT_SECTION_INVALID           // AgentSdkError code
MAX_CONTEXT_SECTION_TEXT_BYTES    // 262_144
```

`defineContextSection` throws `CONTEXT_SECTION_INVALID` for a non-kebab-case id
or a missing `resolve`.

## Compaction-safe by construction

A section re-reads the live surface and adopts whatever node it still owns
before deciding anything — on the first step of a new turn, and on any step
after a compaction shadowed part of the surface.

Without that, a second turn would append a duplicate copy of context the model
can already read, and a compacted-away node would never be rewritten because its
revision still matched.

## Project instructions

`@alvin0/ai-agent-sdk-instructions-node` is the Node implementation of this callback
for `AGENTS.md`-style files. The core SDK never reads a file.

```ts
import { createProjectInstructionsSection } from '@alvin0/ai-agent-sdk-instructions-node'

const agent = defineAgent({
  id: 'coder',
  instructions: 'You are a coding agent.',
  contextSections: [createProjectInstructionsSection({ cwd: process.cwd() })],
})
```

It walks up from `cwd` to the nearest `projectRootMarkers` entry (`.git` by
default), reads candidates from that root **down to `cwd`**, and adds any
subtree a tool call reaches into for the rest of the session.

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | `project-instructions` | Section id on the model surface |
| `cwd` | `process.cwd()` | Session working directory |
| `globalFile` | — | Absolute path read before any project file |
| `projectRootMarkers` | `['.git']` | Entries that stop the upward walk |
| `fileNames` | `['AGENTS.override.md', 'AGENTS.md']` | Same-directory candidates, in precedence order |
| `perDirectory` | `'first'` | `first` or `all` present candidates per directory |
| `maxBytes` | `65536` | Total UTF-8 ceiling for the rendered section |
| `maxFileBytes` | `maxBytes` | Per-file UTF-8 ceiling |
| `nested` | `true` | Scan subtrees a tool call reaches into |
| `maxNestedDirs` | `256` | Most subtree directories kept in scope at once |
| `onNestedLimit` | — | Called once per conversation when that cap is reached |
| `maxTrackedScopes` | `64` | Conversations whose subtrees this instance remembers |
| `filePathFromTouch` | reads `file_path`/`path`/`filePath` | Which committed call touched which path |
| `intro` | `DEFAULT_INTRO` | Paragraph placed above the files |
| `retractionText` | `DEFAULT_RETRACTION` | Written when every file leaves scope |

Rendering is broad-to-specific, each file introduced by
`Instructions from: <path relative to the project root>`. Files with identical
trimmed content collapse to the first occurrence. Anything that does not fit
under `maxBytes` is **named** in a closing line rather than silently cut.

There is no default `globalFile`: a library does not guess where a host keeps a
user's standing instructions.

A skill-relative path never counts as a workspace path — arguments carrying a
`skillId` are ignored, so a skill resource named `references/patterns.md` cannot
pull `references/AGENTS.md` into context.

## Read next

- [Agent Context](/en/02-agents/agent-context) — everything else that reaches the model
- [Agent Instructions](/en/02-agents/agent-instructions) — the system-prompt route
- [Skills](/en/04-skills/) — the model-selected alternative
