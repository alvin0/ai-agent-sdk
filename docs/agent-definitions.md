# Agent definitions

`defineAgent()` is the recommended application-facing layer. It keeps stable
agent identity and policy in one readable declaration, while `AgentSession`
owns the mutable state of one conversation.

```ts
import { cloneAgent, defineAgent } from '@ai-agent-sdk/core'

export const ada = defineAgent({
  id: 'ada',
  name: 'Ada',
  description: 'Explains and reviews TypeScript code.',
  instructions: 'Be precise, inspect evidence before concluding, and keep answers concise.',
  // Optional defaults:
  // provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium',
  // mode: 'basic', maxTurns: 16, maxToolCalls: 64, commentary: 'concise',
})

const session = ada.createSession({ registry })
const result = await session.run('Review this API shape.')
console.log(result.text)
```

## Definition and session have different lifetimes

An agent definition is validated, normalized, and frozen. It is safe to export
from a module and reuse across requests. It contains stable configuration:

- identity: `id`, `name`, `description`;
- model route: `provider`, `model`, `effort`;
- behaviour: `instructions`, `mode`, `maxTurns`, `maxToolCalls`, `commentary`;
- capabilities: host `tools`, provider `nativeTools`, reusable `skills`, scoped
  `skillIds`, and `toolChoice`;
- continuity: durable `memory` and context `compaction` policy.

A session is intentionally stateful. Create one per chat, user thread, or job. It
owns `history`, prevents overlapping runs on the same conversation, and accepts
run-specific cancellation through `{ signal }`.

Sessions also inherit deployment-neutral resource guards. Defaults bound model
request/response bytes, stream events, tool result bytes, model/tool/hook time,
exact repeated calls, short multi-step tool cycles, and aggregate reported tokens.
Tune them without introducing product concepts such as tenants or billing plans:

```ts
const session = ada.createSession({
  registry,
  historyLimits: { maxEntries: 20_000, maxBytes: 128 * 1024 * 1024 },
  runtimeLimits: {
    maxTotalTokens: 250_000,
    repeatToolWarningAt: 3,
    repeatToolLimit: 6,
    toolCycleWarningAt: 2,
    toolCycleLimit: 3,
    maxToolCycleLength: 4,
    maxToolDurationMs: 120_000,
    toolTeardownTimeoutMs: 10_000,
  },
})
```

Manual `session.compact()` owns the same per-session exclusion lock as a model
turn, so compaction and normal execution cannot rewrite one history concurrently.

```ts
const chat = ada.createSession({ registry })

await chat.run('My project uses SQLite.')
await chat.run('Which database did I mention?') // sees the previous turn

chat.reset() // same agent/provider/tools, fresh conversation
```

Persist and reopen a conversation through the session-level snapshot API. The
caller does not need to import or hydrate `History` and `AgentMemory` separately:

```ts
const chat = ada.createSession({ registry })
await chat.run('Review this API shape.')

await conversationStore.save(chat.conversationId, chat.snapshot())

const snapshot = await conversationStore.load(conversationId)
const resumed = ada.resumeSession({ registry, snapshot })
await resumed.run('Now suggest a migration path.')
```

The snapshot is JSON-safe and includes its schema version, `conversationId`,
agent identity, append-only history, durable memory, and the identities of any
activated skills. Skill bodies and resources are never persisted in the
snapshot. Resume rediscovers and rehydrates them from current providers, failing
before the model request if provider, source, or resource location drifted.
Restored activation count and identity/location string sizes are bounded by the
definition's skill policy, and unknown snapshot fields are discarded.
Legacy v1 snapshots without skill state remain valid. Resuming with a different
agent id fails early. The resumed session uses the current code-owned agent
definition and freshly supplied runtime dependencies such as registry, tools,
approvals, and UI brokers.

`createSession({ conversationId })` accepts an application-owned id; otherwise
one is generated. The id is preserved across snapshots and emitted as
`gen_ai.conversation.id` on root trace spans. `session.reset()` intentionally
starts a fresh conversation id and clears conversation-scoped skill activation.

Advanced callers may still supply an existing `History` or memory object to
`createSession()`. Application-level tools supplied at session creation are
combined with tools owned by the definition.

## Long-task memory and compaction

The first user request is automatically pinned as task memory, outside the
compactable transcript. Older conversation is checkpointed at context pressure,
while recent messages remain verbatim:

```ts
const worker = defineAgent({
  id: 'worker',
  instructions: 'Finish the task and verify the result.',
  memory: {
    seed: [{ kind: 'constraint', content: 'Preserve backwards compatibility.' }],
  },
  compaction: { thresholdRatio: 0.8, retainRatio: 0.2 },
})

const session = worker.createSession({ registry })
session.memory.remember({ kind: 'decision', content: 'Use the incremental migration path.' })
await session.compact() // optional manual checkpoint while idle
```

See [`memory-and-compaction.md`](memory-and-compaction.md) for persistence,
overflow recovery, lifecycle events, and policy details.

## Tools and provider-native capabilities

Host tools are ordinary typed `defineTool()` values and are declared directly,
without a second string-id registry:

```ts
const researcher = defineAgent({
  id: 'researcher',
  instructions: 'Gather evidence before answering.',
  // Omit to use the adapter/model default; explicit values are checked against
  // the model's hard output ceiling before provider I/O.
  maxTokens: 16_384,
  tools: [readProjectFile],
  nativeTools: [
    { type: 'native', name: 'web-search', allowedDomains: ['openai.com'] },
  ],
})
```

Host tools execute through the SDK scheduler. Native tools execute at the
provider and still produce correlated events for a GUI. User messages may carry
image blocks; generated images are available through `image-delta` events and in
the final assistant message returned as `response.message`.

`ModelRegistry.prepareCall()` returns a generation-bound `model` capability
snapshot: combined context window, default and hard output limits, reasoning
efforts, input/output modalities, and explicit native-tool support. The registry
materializes model defaults, rejects unsupported effort/native-tool selections,
projects images only when the model explicitly lacks vision, and prevents an
output reservation from consuming the whole combined context window. These are
SDK execution invariants, not UI-only catalog fields.

## Skills: web definitions and CLI discovery

Skills use three explicit disclosure phases:

1. Discovery reads only bounded YAML front matter plus the small invocation
   policy file. The system prompt receives `id`, name, description, and selection
   boundary, capped by `maxCatalogChars` (8,000 characters by default).
2. `load_skill` reads the complete `SKILL.md` only for the selected skill. Its
   tool result enters model context and advertises a bounded path/size manifest;
   resource contents are still unread.
3. `read_skill_resource` reads one selected resource. `search_skill_resources`
   requires an already loaded skill and searches only that skill. Both tools
   hard-bound their returned text, and large resources are exposed as chunks.
   Search also stops after 32 resources or 200,000 inspected characters by
   default; configure `maxSearchResources` and `maxSearchInputChars` when needed.

Generated skill tools are scheduler barriers. This preserves model order for a
batch such as `load_skill` followed by `read_skill_resource` and does not assume
that a remote provider is safe for concurrent access.

Disk reads and JavaScript heap do not themselves consume model tokens. Text
starts consuming context only when placed in the system prompt, a message, or a
tool result. Selected instructions and returned resource chunks remain in
history until compaction; unrelated skill bodies never enter that history.

For a browser, edge worker, database-backed application, or any host without a
skill directory, declare a skill as ordinary application data:

```ts
import { defineAgent, defineSkill } from '@ai-agent-sdk/core/agent'

const incidentTriage = defineSkill({
  id: 'incident-triage',
  name: 'Incident triage',
  description: 'Diagnose a production incident and produce a safe response plan.',
  whenToUse: 'Use for outages, elevated error rates, and degraded latency.',
  instructions: 'Establish impact, gather evidence, then propose reversible mitigations.',
  resources: {
    'references/severity.md': '# Severity\n\nSEV-1 affects most users...',
  },
})

const agent = defineAgent({
  id: 'web-operator',
  instructions: 'Help the operator resolve incidents.',
  skills: [incidentTriage],
})
```

For a shared web or workflow skill store, keep the source at session/runtime
scope and declare only the ids one reusable agent is allowed to use:

```ts
import { defineAgent, defineSkillProvider } from '@ai-agent-sdk/core/agent'

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

const releaseReviewer = defineAgent({
  id: 'release-reviewer',
  instructions: 'Review releases and explain the evidence.',
  skillIds: ['release-review', 'incident-triage'],
})

const session = releaseReviewer.createSession({
  registry,
  skills: [scopedSkills], // request- or workflow-scoped source
})
```

`skillIds` is an authorization and routing boundary, not an activation list.
The catalog exposes metadata only for those ids. A body is still fetched only
after `load_skill`, and a resource only after its dedicated tool call. An
unrelated turn therefore performs no skill activation. If a declared id is not
available, the session fails before its model request instead of silently
running with a different capability. `skillIds: []` disables session-injected
skills; omitting `skillIds` keeps the open discovery behavior useful to a CLI
harness whose configured folder is the capability boundary.

The same pattern works without a remote provider. A web bundle can pass a
shared array of `defineSkill()` values through `createSession({ skills })`, and
each agent definition can select its own ids from that array.

`defineSkill()` eagerly materializes its instructions and resources in the
host's JavaScript heap, although only its metadata enters initial model context.
For a web application that also needs lazy network/I/O and heap behavior, use a
provider instead.

Remote or deployment-specific stores implement the same environment-neutral contract
with `defineSkillProvider({ list, load, readResource })`. `list()` returns
metadata and an opaque locator, `load()` fetches the selected body plus a resource
manifest, and `readResource()` fetches one path. Neither the main SDK entry nor
this contract imports Node filesystem modules.

For a Node CLI, use the isolated filesystem entry point:

```ts
import { defineAgent } from '@ai-agent-sdk/core/agent'
import { fileSystemSkills } from '@ai-agent-sdk/skill-filesystem'

const agent = defineAgent({
  id: 'coding-cli',
  instructions: 'Work in the current project and use relevant skills.',
  skills: [fileSystemSkills({ cwd: process.cwd() })],
})

const session = agent.createSession({ registry, skillCwd: process.cwd() })
```

For a hermetic model harness, point the provider at the exact reviewed root and
leave `skillIds` unset so folders can be added between rounds:

```ts
const harness = defineAgent({
  id: 'coding-harness',
  instructions: 'Use a relevant skill only after loading it.',
  skills: [fileSystemSkills({
    roots: [{ path: './fixtures/skills', source: 'reviewed-harness-corpus' }],
    includeProjectAgents: false,
    includeProjectDsh: false,
    includeUserAgents: false,
  })],
})
```

The root is rediscovered before every user turn. A newly added folder therefore
appears as metadata in the next round without rebuilding the agent. Previously
selected instructions remain in conversation history until compaction; after a
compaction the model can call `load_skill` again. The provider does not preload
every `SKILL.md` body into model context.

Acceptance harnesses can observe bounded filesystem work without reading file
contents a second time:

```ts
const io = []
const skills = fileSystemSkills({
  roots: ['./reviewed-skills'],
  onIo: event => io.push(event), // discovery | activation | resource
})
```

Each event reports the phase, operation, path, and bytes read (or entries
scanned). Observer failures are contained and never change skill-loading
behavior.

By default, discovery searches `.agents/skills` from `skillCwd` upwards through
the Git root. Each immediate child is one skill:

```text
.agents/skills/release-review/
├── SKILL.md
├── agents/openai.yaml
├── references/checklist.md
└── scripts/verify.ts
```

`SKILL.md` starts with YAML front matter containing at least `name` (the
kebab-case id) and `description`. Other text files are exposed as addressable
resources, not inserted into the initial prompt. Set `includeProjectDsh: true`
to additionally discover `.dsh/skills`, or pass ordered `roots` for an explicit,
hermetic search. Earlier roots win duplicate ids. User-level skill discovery is
opt-in with `includeUserAgents: true`.

`fileSystemSkills()` is the recommended lazy provider. The convenience function
`discoverFileSystemSkills()` is deliberately eager for tooling that wants all
definitions: it loads every discovered `SKILL.md` body (but still not resource
contents), so do not use it for a large agent startup catalog.

The catalog is rediscovered at the start of each session turn, so a CLI can add
or update a folder without rebuilding its agent definition. Same-path
`SKILL.md` edits change the shallow file revision and invalidate an old resource
manifest, requiring the skill to be loaded again. A host UI can inspect
`session.skills?.summaries()`, filter `userInvocable`, and call
`session.skills?.activate(id)`. Activation returns the definition and permits its
resource tools, but the host must deliberately place the returned instructions
into a message if it wants them in model context. `agents/openai.yaml` with
`allow_implicit_invocation: false` keeps a skill available to that explicit UI
surface while hiding it from model selection.

## Execution modes and human input

`mode` selects an existing execution policy:

- `basic` uses tools within a bounded turn and returns an answer;
- `deep` requires the structural completion self-check;
- `deep-human-in-loop` also lets the model park on a material user decision.

The human-in-loop mode requires a broker when the session is created, so a
missing UI integration fails early:

```ts
const broker = createUserInputBroker()
const session = planner.createSession({ registry, userInput: broker })

broker.onRequest(async request => {
  broker.resolve(request.requestId, await askInGui(request))
})
```

When a turn reaches 75% of `maxToolCalls`, the loop injects one app-authored
budget warning before the next model step. This gives long coding agents a chance
to stop broad exploration and reserve calls for edits and verification instead of
discovering the limit only after the last tool dispatch.

## One-shot result or live events

`run()` drains the same stream used by the live API and returns the terminal
outcome, final-answer text, and latest assistant message:

```ts
const { text, outcome, message } = await session.run('Create a diagram.')
```

`stream()` exposes the complete `AgentRunEvent` surface for terminals and GUIs:

```ts
for await (const event of session.stream('Investigate the failure.')) {
  if (event.type === 'assistant-text') renderTextNode(event)
  if (event.type === 'tool-call') renderToolNode(event.call)
  if (event.type === 'image-delta') renderImagePreview(event)
  if (event.type === 'agent-end') renderOutcome(event.outcome)
}
```

Every event retains the Foundry-style trace identity generated by the low-level
loop. `defineAgent()` supplies `agentId` and `agentName`; callers may supply a
parent trace when creating a session.

## Deriving agents

Definitions never mutate. Use `.with()` for a local variant or `cloneAgent()`
when the derived agent needs a new stable identity:

```ts
const deepAda = ada.with({ mode: 'deep', maxTurns: 24 })

const reviewer = cloneAgent(ada, {
  id: 'reviewer',
  name: 'Reviewer',
  instructions: 'Find correctness risks and cite the relevant evidence.',
})
```

`runAgent()` and `runTurn()` remain public as lower-level building blocks for
applications that deliberately own execution policy or history persistence.
