# Loading Skills

## Node filesystem discovery

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-skill-filesystem
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { fileSystemSkillProviderPlugin } from '@alvin0/ai-agent-sdk-skill-filesystem'

const skills = fileSystemSkillProviderPlugin({ roots: ['./skills'] })
const runtime = await createAgentRuntime({ providers: [modelProvider] })

const agent = runtime.agent({
  id: 'coding-agent',
  model,
  instructions: 'Use the available skills when relevant.',
  skills: [skills],
})
```

Creating the provider performs **no filesystem I/O**. Metadata is discovered at
the start of a run; bodies and resources are loaded lazily with bounded reads.
Lifecycle is `borrowed-caller-owned` — close the runtime; the provider itself has
no owned resource to close.

## Where it searches

By default, discovery searches `.agents/skills` from `cwd` **upwards through the
Git root**.

| Option | Default | Effect |
| --- | --- | --- |
| `cwd` | — | Start of the upward search |
| `roots` | — | Explicit, hermetic, ordered search. Earlier roots win duplicate ids. |
| `includeProjectAgents` | `true` | Discover `.agents/skills` |
| `includeProjectDsh` | `false` | Also discover `.dsh/skills` |
| `includeUserAgents` | `false` | Opt into user-level discovery |
| `onIo` | — | Observe bounded filesystem work |

Also pass `skillCwd` when creating the session so discovery resolves against the
right directory:

```ts
const session = agent.createSession({ skillCwd: process.cwd() })
```

### Hermetic roots

For a reviewed harness or a test, pin the exact roots and turn off ambient
discovery:

```ts
fileSystemSkills({
  roots: [{ path: './fixtures/skills', source: 'reviewed-harness-corpus' }],
  includeProjectAgents: false,
  includeProjectDsh: false,
  includeUserAgents: false,
})
```

A root may be a plain path string or a `FileSystemSkillRoot` with a `source`
label that appears in observation records.

## Lazy versus eager

```ts
fileSystemSkills(options)            // lazy — the recommended provider
discoverFileSystemSkills(options)    // eager — loads every discovered SKILL.md body
```

`discoverFileSystemSkills()` is deliberately eager: it loads every discovered
`SKILL.md` body (still **not** resource contents). Do not use it for a large
agent startup catalog — it exists for tooling that genuinely wants all
definitions.

## What the model can call

Once a catalog is present, three tools appear:

| Tool | Effect | Bound |
| --- | --- | --- |
| `load_skill` | Reads the complete `SKILL.md` for one skill | Advertises a bounded path/size manifest |
| `read_skill_resource` | Reads one resource | Hard-bounded text; large resources exposed as chunks |
| `search_skill_resources` | Searches **only** an already-loaded skill | 32 resources / 200,000 inspected characters |

```ts
runtime.agent({
  /* … */
  skills: [skills],
  // Tune when a skill has many large resources:
  // maxSearchResources, maxSearchInputChars, maxCatalogChars
})
```

All three are **scheduler barriers**, so `load_skill` followed by
`read_skill_resource` executes in model order rather than in parallel.

## Host-driven activation

A host UI can inspect the catalog and activate a skill itself, without the model
choosing:

> **Which session.** `.skills` is on the `defineAgent()` layer's
> `AgentSession`; `RuntimeAgentSession` does not expose it.

```ts
const summaries = session.skills?.summaries()
const invocable = summaries?.filter(s => s.userInvocable)

const definition = await session.skills?.activate('release-review')
```

Activation returns the definition and **permits its resource tools**, but the host
must deliberately place the returned instructions into a message if it wants them
in model context. Nothing is injected behind your back.

This is the surface that pairs with `allow_implicit_invocation: false` — a skill
a person triggers, hidden from model selection.

## Observing filesystem work

```ts
const io: FileSystemSkillIoEvent[] = []

const skills = fileSystemSkills({
  roots: ['./reviewed-skills'],
  onIo: event => io.push(event),   // phase: discovery | activation | resource
})
```

Each event reports the phase, operation, path, and bytes read (or entries
scanned) — **without** re-reading file contents. Observer failures are contained
and never change skill-loading behaviour.

Skill operations are also on the observation bus as `sdk.skill.operation`, with
discovery/activation/resource-read counts and **never** path or content.

## Context cost, precisely

```text
always:                 id + name + description + selection boundary
                        (all skills, capped by maxCatalogChars = 8,000)

after load_skill:       that skill's instructions + a path/size manifest
after read_resource:    that one resource's text (or one chunk of it)
never:                  unrelated skill bodies, unread resources
```

Selected instructions and returned resource chunks remain in history **until
compaction**. After a compaction the model can call `load_skill` again.

## Read next

- [Skill Lifecycle](/en/04-skills/skill-lifecycle)
- [Agent Context](/en/02-agents/agent-context) — how skills fit the whole request
