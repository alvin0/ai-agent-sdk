# Skill Lifecycle

## Rediscovery happens every turn

The catalog is rediscovered at the **start of each session turn**. A CLI can add
or update a folder mid-session without rebuilding its agent definition, and the
new folder appears as metadata in the next round.

```text
turn N     → discover catalog → model may load_skill → instructions enter history
turn N+1   → discover catalog AGAIN (a new folder is now visible)
```

The provider does **not** preload every `SKILL.md` body into model context. Only
metadata is refreshed.

## Revisions invalidate manifests

Editing a `SKILL.md` at the same path changes its **shallow file revision**, which
invalidates the old resource manifest and requires the skill to be loaded again.

That is why an edit sometimes appears not to take effect: the model is still
holding instructions from the previous revision, already in history. It will pick
up the new body the next time it calls `load_skill`.

| Change | Effect |
| --- | --- |
| Edit `SKILL.md` in place | Revision changes; old manifest invalid; reload required |
| Add a new skill folder | Appears as metadata next turn |
| Remove a skill folder | Disappears from the catalog next turn |
| Edit a resource file | Re-read through `read_skill_resource` |

## History retention

Selected instructions and returned resource chunks **remain in conversation
history until compaction**. After a compaction the model can call `load_skill`
again.

This matters for cost: loading a large skill is not a one-request expense, it
stays in the input for every subsequent request in that span. If a skill is
large and rarely needed twice, prefer several resource reads over one enormous
body.

## Activation is conversation-scoped

```ts
session.reset()   // clears conversation-scoped skill activation
```

`reset()` starts a fresh conversation id and clears activation, while restoring
definition-level memory seeds. The agent, provider, and tools stay the same.

## Snapshots persist identity, not content

**Skill bodies and resources are never persisted** in a session snapshot. What is
persisted is the **identity** of activated skills.

```ts
const snapshot = session.snapshot()   // JSON-safe; skill identities only
await store.save(session.conversationId, snapshot)

const resumed = agent.resumeSession(await store.load(conversationId))
```

On resume the SDK **rediscovers and rehydrates** them from current providers.

## Resume fails early, on purpose

| Situation | Behaviour |
| --- | --- |
| Provider, source, or resource location drifted | Fails **before** the model request |
| A declared `allowedSkillIds` entry is unavailable | Fails before the model request |
| Legacy v1 snapshot without skill state | Valid — accepted |
| Unknown snapshot fields | Discarded |
| Different agent id | Fails early |

Failing before the request is the point: the alternative is silently running with
a **different capability set** than the snapshot recorded, which produces results
nobody can explain later.

Restored activation count and identity/location string sizes are bounded by the
definition's skill policy, so a tampered snapshot cannot expand the surface.

## Bounds across the lifecycle

| Bound | Default | Applies to |
| --- | --- | --- |
| `maxCatalogChars` | 8,000 | Discovery metadata in the system prompt |
| `maxSearchResources` | 32 | `search_skill_resources` |
| `maxSearchInputChars` | 200,000 | `search_skill_resources` |
| Returned resource text | Hard-bounded | `read_skill_resource`; large resources chunked |
| Restored activation count | Definition policy | Resume |

## Observability

`sdk.skill.operation` records start/end with discovery, activation, and
resource-read **counts** — and **never** a path or content. Filesystem-level
detail is available separately through the provider's own `onIo` observer, which
reports phase, operation, path, and bytes without re-reading contents.

That split is deliberate: telemetry stays safe to export, while local debugging
can still see paths.

## Read next

- [Sessions and persistence](/en/05-memory/persistent-memory)
- [Loading Skills](/en/04-skills/loading-skills)
