# Skills — progressive disclosure

A skill is a capability bundle — instructions plus addressable resources — that
stays **out of model context until the model selects it**. It solves one
problem: having fifty capabilities available while paying context for none.

## Three disclosure phases

```text
1. Discovery            bounded front matter + invocation policy
                        → system prompt gets id, name, description, selection boundary
                        → capped by maxCatalogChars (8,000 default)

2. load_skill           reads the complete SKILL.md for the SELECTED skill only
                        → enters model context with a bounded path/size manifest
                        → resource contents still unread

3. read_skill_resource     reads ONE selected resource
   search_skill_resources  requires an already-loaded skill, searches only that one
                        → returned text hard-bounded; large resources exposed as chunks
                        → search stops at 32 resources / 200,000 inspected characters
```

Disk reads and JS heap do not consume model tokens. Text costs context only when
placed in the system prompt, a message, or a tool result.

All three generated tools are **scheduler barriers**, so `load_skill` then
`read_skill_resource` runs in model order rather than in parallel.

## Context cost, precisely

```text
always:              id + name + description + selection boundary (all skills)
after load_skill:    that skill's instructions + a path/size manifest
after read_resource: that one resource's text, or one chunk of it
never:               unrelated skill bodies, unread resources
```

Selected instructions stay in history until compaction; afterwards the model can
call `load_skill` again.

## Three ways to supply skills

| Approach | Use when | Entry point |
| --- | --- | --- |
| In-memory definition | Browser, edge worker, bundled content | `defineSkill()` |
| Provider contract | Database, API, lazy I/O, remote store | `defineSkillProvider()` or `defineSkillProviderPlugin()` |
| Filesystem discovery | Node CLI with `SKILL.md` folders | `@alvin0/ai-agent-sdk-skill-filesystem` |

All three satisfy the same environment-neutral contract. Neither the main entry
nor the provider contract imports Node filesystem modules.

## `defineSkill()`

```ts
import { defineAgent, defineSkill } from '@alvin0/ai-agent-sdk-core/agent'

const incidentTriage = defineSkill({
  id: 'incident-triage',
  name: 'Incident triage',
  description: 'Diagnose a production incident and produce a safe response plan.',
  whenToUse: 'Use for outages, elevated error rates, and degraded latency.',
  instructions: 'Establish impact, gather evidence, then propose reversible mitigations.',
  resources: {
    'references/severity.md': '# Severity\n\nSEV-1 affects most users…',
    'references/runbook.md': '# Runbook\n\n1. Check the error budget…',
  },
})
```

| Field | Reaches the model | Purpose |
| --- | --- | --- |
| `id` | Discovery | Stable identity; used by `allowedSkillIds` |
| `name` | Discovery | Human label |
| `description` | Discovery | What the skill covers |
| `whenToUse` | Discovery | **The selection boundary. Make it decisive.** |
| `instructions` | After `load_skill` | The actual guidance |
| `resources` | After `read_skill_resource` | Addressable files |

`whenToUse` decides whether the model picks your skill. "Use for outages,
elevated error rates, and degraded latency" beats "for incidents".

`defineSkill()` **eagerly materializes** instructions and resources in the host
heap, though only metadata enters initial context. For lazy network/IO, use a
provider.

## Two custom-provider contracts — pick the right one

They are **not** interchangeable, and the difference is what tsc will tell you
about first.

| | `defineSkillProvider` | `defineSkillProviderPlugin` |
| --- | --- | --- |
| Import | `@alvin0/ai-agent-sdk-core/agent` | `@alvin0/ai-agent-sdk-core/skills` |
| Type | `SkillProvider` — typed pass-through | `SkillProviderPlugin` |
| You pass `kind: 'skill-provider'` | **yes**, it is part of the interface | no — added for you |
| You pass `apiVersion` | no such field | no — added for you |
| `list()` returns | `readonly SkillCandidate[]` | `SkillCatalogSnapshot` (`revision` + `candidates`) |
| `load()` / `readResource()` take | a `SkillCandidate` | a `SkillReference` |
| Use when | ordinary lazy store — DB, API, browser | you need a revisioned catalog the runtime can diff |

### `defineSkillProvider()` — the common case

```ts
import { defineSkillProvider } from '@alvin0/ai-agent-sdk-core/agent'

const scopedSkills = defineSkillProvider({
  kind: 'skill-provider',      // required here
  id: 'scoped-skills',

  // Called at the start of each turn. allowedSkillIds is a query hint; the SDK
  // catalog enforces it again even if you return extra candidates.
  list: async ({ allowedSkillIds, signal }) => [
    {
      id: 'release-review',
      name: 'Release review',
      description: 'Review a release candidate.',
      whenToUse: 'Use before tagging a release.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'scoped-store',
      provider: 'scoped-skills',
      locator: { row: 42 },     // opaque; handed back to load() unchanged
    },
  ],

  // Called after load_skill, with a candidate list() returned.
  load: async (candidate, { signal }) => await skillStore.loadDefinition(candidate.locator, { signal }),

  // Optional. Called after read_skill_resource; returns the resource TEXT.
  readResource: async (candidate, path, { signal }) =>
    await skillStore.readResource(candidate.locator, path, { signal }),
})
```

```ts
interface SkillProvider {
  readonly kind: 'skill-provider'
  readonly id: string
  list(options: SkillProviderListOptions): Promise<readonly SkillCandidate[]>
  load(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinitionInput | undefined>
  readResource?(candidate: SkillCandidate, path: string, options: SkillLookupOptions): Promise<string | undefined>
}

interface SkillProviderListOptions { readonly cwd?: string; readonly signal?: AbortSignal
                                     readonly allowedSkillIds?: readonly string[] }
interface SkillLookupOptions       { readonly cwd?: string; readonly signal?: AbortSignal }
```

A `SkillCandidate` is a discovery row — metadata only, never instructions:

```ts
interface SkillCandidate {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy    // required on a candidate
  readonly source: string
  readonly provider: string
  readonly resourceBase?: SkillResourceBase
  readonly locator?: unknown                    // your addressing scheme
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

interface SkillInvocationPolicy {
  readonly modelInvocable: boolean   // may the model discover and load it
  readonly userInvocable: boolean    // may a host UI offer it explicitly
}
```

`load()` returns a `SkillDefinitionInput` — the same shape `defineSkill()` takes,
so `id`, `description`, and `instructions` are required; `invocation` there is a
`Partial<SkillInvocationPolicy>`, both flags defaulting to `true`.

### `defineSkillProviderPlugin()` — revisioned catalog

```ts
import { defineSkillProviderPlugin, SKILL_PROVIDER_API_VERSION } from '@alvin0/ai-agent-sdk-core/skills'

const plugin = defineSkillProviderPlugin({
  id: 'scoped-skills',
  list: async ({ allowedSkillIds, signal, logger }) => ({
    revision: await skillStore.revision({ signal }),
    candidates: await skillStore.listCandidates({ ids: allowedSkillIds, signal }),
  }),
  load: async (reference, { signal }) => await skillStore.loadDefinition(reference.locator, { signal }),
  readResource: async (reference, path, { signal }) =>
    await skillStore.readResource(reference.locator, path, { signal }),
})
```

Its `list`/`load`/`readResource` receive `RuntimeSkillLookupOptions`, where
`signal` and `logger` are **required** rather than optional, and address skills
through a `SkillReference` carrying `catalogRevision`.

```ts
interface SkillCatalogSnapshot { readonly revision: string
                                 readonly candidates: readonly RuntimeSkillCandidate[] }

interface SkillReference { readonly id: string; readonly source: string
                           readonly provider: string; readonly catalogRevision: string
                           readonly locator?: JsonValue }
```

`skills: [...]` accepts `RuntimeSkillSource`, which is
`SkillDefinition | SkillProvider | SkillProviderPlugin` — all three forms.

## Node filesystem discovery

```ts
import { fileSystemSkillProviderPlugin } from '@alvin0/ai-agent-sdk-skill-filesystem'

const skills = fileSystemSkillProviderPlugin({ roots: ['./skills'] })

const agent = runtime.agent({
  id: 'coding-agent', model,
  instructions: 'Use the available skills when relevant.',
  skills: [skills],
})

const session = agent.createSession({ skillCwd: process.cwd() })
```

Creating the provider performs **no** filesystem I/O. Metadata is discovered at
the start of a run; bodies and resources load lazily with bounded reads.
Lifecycle is `borrowed-caller-owned` — close the runtime, the provider owns
nothing.

Default search: `.agents/skills` from `cwd` upwards through the Git root.

| Option | Default | Effect |
| --- | --- | --- |
| `cwd` | — | Start of the upward search |
| `roots` | — | Explicit, hermetic, ordered. Earlier roots win duplicate ids |
| `includeProjectAgents` | `true` | Discover `.agents/skills` |
| `includeProjectDsh` | `false` | Also discover `.dsh/skills` |
| `includeUserAgents` | `false` | Opt into user-level discovery |
| `onIo` | — | Observe bounded filesystem work |

```ts
// Hermetic: pin roots, no ambient discovery.
fileSystemSkills({ roots: [{ path: './fixtures/skills', source: 'reviewed-harness-corpus' }] })
```

`onIo` events report phase (`discovery` | `activation` | `resource`), operation,
path, and bytes read — without re-reading contents. Observer failures are
contained. The bus also carries `sdk.skill.operation` with counts and **never**
path or content.

## Declaring them on an agent

```ts
runtime.agent({
  id: 'operator', model,
  instructions: 'Help the operator resolve incidents.',
  skills: [incidentTriage],               // sources
  allowedSkillIds: ['incident-triage'],   // authorization boundary
  // maxSearchResources, maxSearchInputChars, maxCatalogChars when resources are large
})
```

`allowedSkillIds` is an **authorization and routing boundary, not an activation
list**. The catalog exposes metadata only for those ids; a body is fetched only
after `load_skill`. An unrelated turn performs no activation.

| Value | Behaviour |
| --- | --- |
| `['a', 'b']` | Only these ids are visible to the catalog |
| `[]` | Session-injected skills are disabled |
| omitted | Open discovery — fine for a CLI whose configured folder is the boundary |

A declared id that is not available fails the session **before** its model
request, rather than silently running a different capability.

## Host-driven activation

The `.skills` accessor is on the **`defineAgent()` layer's `AgentSession`**, not
on `RuntimeAgentSession` from `runtime.agent()`.

```ts
const session = ada.createSession({ registry })

const summaries = session.skills?.summaries()
const invocable = summaries?.filter(s => s.userInvocable)

const definition = await session.skills?.activate('release-review')
session.skills?.activatedResources('release-review')
session.skills?.activatedSummaries()
```

Activation returns the definition and permits its resource tools, but the host
must deliberately place the instructions into a message. Nothing is injected
behind your back. Pairs with `allow_implicit_invocation: false` — a skill a
person triggers, hidden from model selection.

## Skills versus tools

| | Tool | Skill |
| --- | --- | --- |
| What it is | A function the model calls | Instructions + resources the model reads |
| Idle context cost | Its schema, every request | Only id, name, description |
