# Skills — Overview

A skill is a **capability bundle** — instructions plus addressable resources —
that stays **out of model context until the model selects it**.

Skills solve one specific problem: having fifty capabilities available while
paying context for none of them.

## Three disclosure phases

```text
1. Discovery          bounded YAML front matter + invocation policy
                      → system prompt gets id, name, description, selection boundary
                      → capped by maxCatalogChars (8,000 default)

2. load_skill         reads the complete SKILL.md for the SELECTED skill only
                      → enters model context, advertises a bounded path/size manifest
                      → resource contents still unread

3. read_skill_resource   reads ONE selected resource
   search_skill_resources requires an already-loaded skill, searches only that skill
                      → returned text is hard-bounded; large resources exposed as chunks
                      → search stops at 32 resources / 200,000 inspected characters
```

> Disk reads and JavaScript heap do not themselves consume model tokens. Text
> starts consuming context only when placed in the system prompt, a message, or a
> tool result.

Generated skill tools are **scheduler barriers**. This preserves model order for
a batch such as `load_skill` followed by `read_skill_resource`, and does not
assume a remote provider is safe for concurrent access.

## Two ways to supply skills

| Approach | Use when | Entry point |
| --- | --- | --- |
| **In-memory definition** | Browser, edge worker, bundled content | `defineSkill()` |
| **Provider contract** | Database, API, lazy I/O, remote store | `defineSkillProvider()` |
| **Filesystem discovery** | Node CLI with `SKILL.md` folders | `@ai-agent-sdk/skill-filesystem` |

All three satisfy the same environment-neutral contract. Neither the main SDK
entry nor the provider contract imports Node filesystem modules.

## Declaring them on an agent

```ts
const agent = runtime.agent({
  id: 'operator',
  model,
  instructions: 'Help the operator resolve incidents.',
  skills: [incidentTriage],           // sources
  allowedSkillIds: ['incident-triage'], // authorization boundary
})
```

`allowedSkillIds` is an **authorization and routing boundary, not an activation
list**. The catalog exposes metadata only for those ids; a body is still fetched
only after `load_skill`. An unrelated turn performs **no** skill activation.

| Value | Behaviour |
| --- | --- |
| `['a', 'b']` | Only these ids are visible to the catalog |
| `[]` | Session-injected skills are disabled |
| omitted | Open discovery — useful for a CLI whose configured folder is the boundary |

If a declared id is not available, the session fails **before** its model request
instead of silently running with a different capability.

## Skills versus tools

| | Tool | Skill |
| --- | --- | --- |
| What it is | A function the model calls | Instructions + resources the model reads |
| Context cost when idle | Its schema, every request | Only id, name, description |
| Selected by | The model calling it | The model calling `load_skill` |
| Executes | Your code | Nothing — it is knowledge, not behaviour |

Use a tool to *do* something. Use a skill to *know* something.

## In this chapter

| Page | Answers |
| --- | --- |
| [Creating Skills](/en/04-skills/creating-skills) | `defineSkill()`, `defineSkillProvider()`, and the `SKILL.md` layout |
| [Loading Skills](/en/04-skills/loading-skills) | Filesystem discovery, host-driven activation, search bounds |
| [Skill Lifecycle](/en/04-skills/skill-lifecycle) | Rediscovery, revisions, snapshots, and resume rules |
