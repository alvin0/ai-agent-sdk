# @alvin0/ai-agent-sdk-instructions-node

Node filesystem discovery for `AGENTS.md`-style project instructions, delivered
as a core **context section**.

Runtime: **Node 22.12+**.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-instructions-node
```

The core SDK never reads a file. It exposes `ContextSection`: a callback the
turn loop re-runs before every model round, owning exactly one node on the model
surface and rewriting it only when its revision changes. This package is the
Node implementation of that callback for project instruction files.

## Usage

```ts
import { defineAgent } from '@alvin0/ai-agent-sdk-core'
import { createProjectInstructionsSection } from '@alvin0/ai-agent-sdk-instructions-node'

const agent = defineAgent({
  id: 'coder',
  instructions: 'You are a coding agent.',
  contextSections: [createProjectInstructionsSection({ cwd: process.cwd() })],
})
```

Mount it per session instead when the working directory belongs to the session
rather than the definition:

```ts
const session = runtime.agent(agent).createSession({
  contextSections: [createProjectInstructionsSection({ cwd: workspaceDir })],
})
```

## Discovery

1. The configured `globalFile`, when one is supplied. There is no default —
   a library does not guess where a host keeps a user's standing instructions.
2. Walk up from `cwd` until a `projectRootMarkers` entry is found (`.git` by
   default), then read the candidates from that root **down to `cwd`**,
   inclusive. The walk never passes the root.
3. Once a tool call touches a file below `cwd`, that subtree's directories join
   the scan and stay in scope for the rest of the session.

Within one directory, `perDirectory: 'first'` (the default) takes the first
present candidate — `AGENTS.override.md`, then `AGENTS.md` — and `'all'` takes
every present candidate. Files with identical trimmed content collapse to the
first occurrence, so a symlinked or copied twin is not rendered twice.

Rendering is broad-to-specific, each file introduced by
`Instructions from: <path relative to the project root>`. Content is admitted
whole under `maxBytes` (64 KiB by default); anything that does not fit is named
in a closing line rather than silently cut.

## Sharing one instance across agents

One section object is normally mounted on a definition that many sessions
instantiate — every member of a team, every worker cloned from a lead — and
those sessions run concurrently. Everything this section accumulates is keyed by
the conversation scope the loop passes to `resolve`, so a team member that reads
into `packages/api` does not put that directory's instructions in front of its
peers. Buckets are bounded by `maxTrackedScopes` and the least recently used one
is dropped first. A bare `runTurn` with no trace identity shares one unscoped
bucket.

Mounting the section on the session instead of the definition is still the right
call when the working directory belongs to the session — the scope keying makes
sharing *safe*, not preferable.

A skill-relative path never counts as a workspace path: arguments carrying a
`skillId` (as `read_skill_resource({ skillId, path })` does) are ignored, so a
skill resource named `references/patterns.md` cannot pull `references/AGENTS.md`
into context.

## Why a section and not a skill

Project instructions are always-on: a model that never loads them has violated
the project's conventions without knowing they existed. Skills are the opposite
contract — advertised by description and loaded only when the model picks them.

Why a section and not `additionalInstructions`: the system prompt is the cache
prefix, and these files change during a session (the cwd moves, a tool reaches
into a new subtree, someone edits the file). Rewriting the prefix each time
would discard the prompt cache, and appending has no way to retract text that no
longer applies. A section writes into the conversation surface, replaces its own
node in place, and costs nothing on the steps where nothing changed.

## Options

| Option | Default | Meaning |
|---|---|---|
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
| `intro` | see `DEFAULT_INTRO` | Paragraph placed above the files |
| `retractionText` | see `DEFAULT_RETRACTION` | Written when every file leaves scope |

A failed tool call never contributes a path: a read that errored did not enter
that directory.

Every retained directory is re-probed before every model round, so `maxNestedDirs`
bounds the per-step filesystem cost of an agent that walks a large tree. Once the
cap is reached the directories already in scope win, and `onNestedLimit` fires
once so a host can log it. `maxFileBytes` is bounded by `maxBytes`: a file larger
than the whole section is skipped without being read.
