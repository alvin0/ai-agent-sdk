# Creating Skills

## In-memory: `defineSkill()`

For a browser, edge worker, database-backed application, or any host without a
skill directory:

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

const agent = defineAgent({
  id: 'web-operator',
  instructions: 'Help the operator resolve incidents.',
  skills: [incidentTriage],
})
```

### The fields that matter for selection

| Field | Reaches the model | Purpose |
| --- | --- | --- |
| `id` | Discovery | Stable identity; used by `allowedSkillIds` |
| `name` | Discovery | Human label |
| `description` | Discovery | What the skill covers |
| `whenToUse` | Discovery | **The selection boundary.** Make it decisive. |
| `instructions` | Only after `load_skill` | The actual guidance |
| `resources` | Only after `read_skill_resource` | Addressable files |

`whenToUse` is the field that decides whether the model picks your skill. "Use
for outages, elevated error rates, and degraded latency" beats "for incidents".

> `defineSkill()` **eagerly materializes** its instructions and resources in the
> host's JavaScript heap, although only its metadata enters initial model
> context. For a web application that also needs lazy network/I-O and heap
> behaviour, use a provider instead.

## Custom store: `defineSkillProvider()`

Implement the same environment-neutral contract against any backing store:

```ts
import { defineSkillProvider } from '@alvin0/ai-agent-sdk-core/agent'

const scopedSkills = defineSkillProvider({
  kind: 'skill-provider',
  id: 'scoped-skills',

  async list({ allowedSkillIds }) {
    // The hint can narrow a database/API query. The SDK catalog enforces the
    // allowlist again even when a provider returns additional candidates.
    return await skillStore.listMetadata({ ids: allowedSkillIds })
  },

  async load(candidate) {
    return await skillStore.loadInstructions(candidate.locator)
  },

  async readResource(candidate, path) {
    return await skillStore.readResource(candidate.locator, path)
  },
})
```

| Method | Returns | Called |
| --- | --- | --- |
| `list(options)` | `readonly SkillCandidate[]` — metadata plus an **opaque locator** | At the start of each turn |
| `load(candidate, options)` | `SkillDefinitionInput \| undefined` — the same shape `defineSkill()` takes | After `load_skill` |
| `readResource(candidate, path, options)` | `string \| undefined` — the resource **text** | After `read_skill_resource` |

A candidate is a discovery row, and three of its fields are easy to forget
because they are required:

```ts
interface SkillCandidate {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy      // { modelInvocable, userInvocable }
  readonly source: string                          // origin label
  readonly provider: string                        // this provider's id
  readonly resourceBase?: SkillResourceBase
  readonly locator?: unknown
  readonly path?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

`load()` returns a definition **input**, so `id`, `description`, and
`instructions` are all required on it; `invocation` there is a
`Partial<SkillInvocationPolicy>` whose flags default to `true`.

### The revisioned variant

`defineSkillProviderPlugin()` from `@alvin0/ai-agent-sdk-core/skills` implements
the same three phases against a **revisioned catalog** instead. Its `list()`
returns `{ revision, candidates }`, its `load()` and `readResource()` receive a
`SkillReference` carrying `catalogRevision` rather than a candidate, and its
options give `signal` and `logger` as required fields. It does **not** take
`kind` or `apiVersion` — those are added for you, unlike
`defineSkillProvider()` above, where `kind: 'skill-provider'` is part of the
interface you pass in.

`skills: [...]` accepts either form: `RuntimeSkillSource` is
`SkillDefinition | SkillProvider | SkillProviderPlugin`.

The locator is opaque to the SDK — it is your primary key, URL, or path. Two
guarantees are worth relying on:

**The allowlist is enforced twice.** `allowedSkillIds` is a *hint* that can narrow
your query, but the SDK catalog filters again. A buggy provider that returns
extra candidates cannot widen the agent's authorization.

**Nothing is loaded speculatively.** `load()` is called only for a skill the
model selected, and `readResource()` only for a path it asked for.

### Request-scoped sources

Keep the source at session scope and declare only the ids one reusable agent may
use:

```ts
const releaseReviewer = defineAgent({
  id: 'release-reviewer',
  instructions: 'Review releases and explain the evidence.',
  skillIds: ['release-review', 'incident-triage'],
})

const session = releaseReviewer.createSession({
  registry,
  skills: [scopedSkills],   // request- or workflow-scoped source
})
```

The same pattern works with no remote provider at all: a web bundle can pass a
shared array of `defineSkill()` values through `createSession({ skills })`, and
each agent definition selects its own ids from that array.

## Filesystem: the `SKILL.md` layout

For a Node CLI, each immediate child of a skills root is one skill:

```text
.agents/skills/release-review/
├── SKILL.md                  # YAML front matter + instructions
├── agents/openai.yaml        # invocation policy
├── references/checklist.md   # addressable resource
└── scripts/verify.ts         # addressable resource
```

`SKILL.md` starts with YAML front matter containing at least `name` (the
kebab-case id) and `description`:

```markdown
---
name: release-review
description: Review a release candidate and report concrete blockers.
---

Establish what changed, verify the tests that cover it, then report blockers
with file and line references.
```

Other text files are exposed as **addressable resources**, not inserted into the
initial prompt.

### Hiding a skill from model selection

`agents/openai.yaml` with `allow_implicit_invocation: false` keeps a skill
available to an explicit host UI surface while hiding it from model selection:

```yaml
allow_implicit_invocation: false
```

Use it for skills a human triggers deliberately — a destructive runbook, a
compliance checklist — that the model should not pick on its own.

## Read next

- [Loading Skills](/en/04-skills/loading-skills) — discovery and activation
- [Skill Lifecycle](/en/04-skills/skill-lifecycle) — revisions and resume
