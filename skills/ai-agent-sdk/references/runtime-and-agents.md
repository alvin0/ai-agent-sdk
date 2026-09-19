# Runtime, agents, sessions

## Four lifetimes

```text
createAgentRuntime()  ── providers ready ── runs ── close() ── RuntimeCloseReport
   └─ runtime.agent()  ── frozen binding, no I/O ───────────── (nothing to close)
        └─ createSession()  ── history + memory + skills ── reset() / drop
             └─ run() / stream()  ── turn hooks ── terminal event ── RuntimeRunReport
```

## `createAgentRuntime`

```ts
createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime>
```

| Option | Notes |
| --- | --- |
| `providers` | **Required.** `readonly ComposableModelProviderPlugin[]` |
| `defaultProvider` | Route used when an agent omits `model.provider` |
| `defaults` | SDK fallbacks for `contextWindow`, `maxTokens`, and `inputModalities`; used only when agent/model/route is silent |
| `signal` | Aborts startup |
| `resource` | `{ serviceName?, serviceVersion?, environment?, attributes? }` — the runtime label is detected, not passed |
| `observability` | See references/observability.md |
| `closeTimeoutMs` | Quiescence deadline for `close()` |
| `startupTimeoutMs` | Deadline for provider `ready()` |
| `diagnosticMaxEvents` / `diagnosticMaxBytes` | Bound the diagnostic ring |

Async because plugins have a `ready()` boundary — that is where a capability
acquires resources. Registration is **transactional**: route claims are declared
up front, a conflict fails before setup completes, and a failed startup rolls
back every partial registration.

The last-resort context default is 200,000 tokens and the last-resort input
modalities are text, image, and document. No vendor model table is compiled into
core. Set `defaults` for your host, route/model catalog values for endpoint facts,
or agent values when the agent owns the override. No output-token field is sent
unless one of those layers supplies a value (except protocols such as Anthropic
Messages that require their own protocol fallback).

```ts
interface AgentRuntime {
  providers(): readonly RuntimeProviderInfo[]
  modelCatalog(route: string, options?: ModelCatalogOptions): Promise<RuntimeModelCatalogSnapshot>
  agent(definition: RuntimeAgentBindingInput): RuntimeAgent
  team(options: RuntimeAgentTeamOptions): RuntimeAgentTeam
  logger(context?: { scope?: string; fields?: Readonly<JsonObject> }): SdkLogger
  diagnostics(): RuntimeDiagnosticSnapshot
  close(options?: { signal?: AbortSignal }): Promise<RuntimeCloseReport>
}
```

## `runtime.agent()` — every field

```ts
const agent = runtime.agent({
  // Identity
  id: 'reviewer',                 // REQUIRED, stable, emitted on trace spans
  name: 'Release Reviewer',       // GUI label and A2A Agent Cards
  description: 'Reviews release candidates.',  // agent cards, team rosters

  // Model route
  model: { provider: 'openai', id: 'gpt-5.4' },
  effort: 'medium',               // opaque provider value; sent only when set
  maxTokens: 16_384,              // checked against the hard limit before I/O
  contextWindow: 200_000,         // optional agent-owned override
  inputModalities: ['text', 'image', 'document'],
  outputFormat: { type: 'text' },

  // Behaviour
  instructions: 'Review carefully and cite evidence.',
  mode: 'basic',                  // 'basic' | 'deep' | 'deep-human-in-loop'
  commentary: 'concise',          // 'auto' | 'concise' | 'off'
  maxTurns: 16,                   // model steps, default 16
  maxToolCalls: 64,               // dispatched tools, default 64

  // Capabilities
  tools: [readFile],              // host functions the scheduler executes
  nativeTools: [{ type: 'native', name: 'web-search' }],  // provider-executed
  toolChoice: 'auto',
  toolSources: [mcpConnection],   // whole catalogs
  skills: [skillProvider],
  allowedSkillIds: ['release-review'],   // authorization boundary

  // Continuity
  memory: memoryBinding,          // a full MemoryBinding; `false` is session-only
  compaction: { thresholdRatio: 0.8, retainRatio: 0.2 },
  contextSections: [projectFacts],

  // Provider escape hatch; agent values win over route/model values.
  providerOptions: {
    headers: { 'x-agent-purpose': 'release-review' },
    body: { metadata: { workflow: 'release-review' } },
  },
})
```

`effort` is pure pass-through. The SDK neither fills a default nor rejects a
value absent from `model.reasoning.efforts`; the provider is authoritative and
its own rejection reaches the caller. `contextWindow` and `inputModalities`
belong to the agent configuration and therefore survive a per-call model switch.

`maxTurns` also accepts `'auto'`, which removes the step ceiling without
removing resource limits. Brokers do **not** belong here: `approvals`,
`userInput`, `interceptors`, and `spillStore` are session options.

`runtime.agent()` performs no I/O and holds no resource. It is a frozen binding
with nothing to close and no `ready()` step.

## Route resolution

```text
model: { provider: 'openai', id: 'gpt-5.4' }  → exact route + exact model
model: { provider: 'openai' }                  → route's configured default model
model omitted                                  → runtime's selected or unique-default provider
defineAgent() with provider/model omitted      → Codex gpt-5.6-luna; effort remains omitted
```

## `defineAgent()` — the reusable definition

Flatter model fields than `runtime.agent()`. Validated, normalized, frozen at
module scope; safe to export and reuse across requests.

```ts
export const ada = defineAgent({
  id: 'ada',
  name: 'Ada',
  description: 'Explains and reviews TypeScript code.',
  instructions: 'Be precise, inspect evidence before concluding, keep answers concise.',
  provider: 'codex',
  model: 'gpt-5.6-luna',
  effort: 'medium',
  mode: 'basic',
  maxTurns: 16,
  maxToolCalls: 64,
  commentary: 'concise',
})

const session = ada.createSession({ registry })   // options are REQUIRED here
const response = await session.run('Explain this stack trace.')
```

`instructions` is **required** on a definition.

Definitions never mutate — derive instead:

```ts
const deepAda = ada.with({ mode: 'deep', maxTurns: 24 })   // local variant, same identity
const reviewer = cloneAgent(ada, {                          // NEW stable identity
  id: 'reviewer',
  name: 'Reviewer',
  instructions: 'Find correctness risks and cite the relevant evidence.',
})
```

## `RuntimeAgent`

```ts
interface RuntimeAgent {
  readonly model: ModelTarget
  generate(input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  stream(input: string, options?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle
  createSession(options?: RuntimeAgentSessionOptions): RuntimeAgentSession
  resumeSession(snapshot: RuntimeAgentSessionSnapshot, options?: RuntimeAgentSessionOptions): RuntimeAgentSession
}
```

`generate()` is stateless. For a conversation, use a session.

## `RuntimeAgentSession`

```ts
interface RuntimeAgentSession {
  readonly conversationId: string
  readonly isRunning: boolean
  run(input: string, options?): Promise<RuntimeAgentResponse>
  stream(input: string, options?): RuntimeAgentRunHandle
  inject(input: string): number
  snapshot(): RuntimeAgentSessionSnapshot
  compact(options?): Promise<CompactionResult | null>
  reset(): void
  whenIdle(signal?: AbortSignal): Promise<void>
}
```

A session owns mutable state — history, memory, activated skills, an exclusion
lock — and **prevents overlapping runs** on one conversation. `compact()` takes
the same lock as a model turn, so compaction cannot race execution.

`reset()` starts a fresh conversation id, clears conversation-scoped skill
activation, and restores definition-level memory seeds.

A session has no `close()`. Persist it with `snapshot()`; discard it by dropping
the reference.

### Per-call model and output ceiling

`run()`, `stream()`, and `compact()` accept `model` and `maxTokens` for that call
alone. Effort is definition-level; changing it requires deriving/binding another
agent rather than mutating one invocation:

```ts
await session.run('draft it')                                  // the bound model
await session.run('summarize', { model: { provider: 'codex', id: 'gpt-reserve' } })
await session.run('continue')                                  // back to the bound model
```

`agent.model` never changes. The override resolves against the configured routes
before the run acquires anything, so `MODEL_ROUTE_UNAVAILABLE`,
`MODEL_DEFAULT_MISSING`, and `MODEL_TARGET_INVALID` cost no request; `{ provider }`
alone takes that route's default model. A model switch drops the bound output
ceiling unless the call restates it. Agent-owned `contextWindow` and
`inputModalities` remain in force.

No failover: a failure on the chosen model reaches the caller, and retries stay
on that model. `embeddingModel()` has no per-call override at all — a handle keeps
its embedding space for its lifetime.

## `createSession()` options

```ts
interface RuntimeAgentSessionOptions {
  readonly conversationId?: string
  readonly tools?: readonly ToolDefinition[]
  readonly toolSources?: readonly ToolSource[]
  readonly skills?: readonly RuntimeSkillSource[]
  readonly memory?: MemoryBinding | false
  readonly skillCwd?: string
  readonly userInput?: UserInputBroker
  readonly approvals?: ApprovalBroker
  readonly spillStore?: SpillStore        // mount one and oversized tool output spills
                                          // instead of truncating; the model gets read_tool_output
  readonly interceptors?: readonly ToolInterceptor[]
  readonly contextSections?: readonly ContextSection[]
  readonly hooks?: TurnHooks
  readonly usagePolicy?: UsagePolicy
  readonly historyLimits?: HistoryLimits
  readonly ledgerLimits?: RunLedgerLimits
}
```

Environment-dependent context sections belong here; sections that travel with
the agent wherever it runs belong on the definition.

## Turn hooks

```ts
interface TurnHooks {
  readonly beforeStep?: (ctx: BeforeStepContext) => Promise<StepDecision> | StepDecision
  readonly onRequestError?: (ctx: RequestErrorContext) => Promise<'retry' | 'fail'> | 'retry' | 'fail'
  readonly checkpoint?: (ctx: CheckpointContext) => Promise<void> | void
  readonly onTurnEnd?: (ctx: TurnEndContext) => Promise<void> | void
}

const session = agent.createSession({
  hooks: { beforeStep: () => ({ kind: 'proceed' }) },   // or { kind: 'reject', reason }
})
```

`beforeStep` returns a `StepDecision` — the branch/gate primitive. See
references/orchestration.md.

## Two session layers — do not mix them up

| | `runtime.agent().createSession()` | `defineAgent().createSession({ registry })` |
| --- | --- | --- |
| Type | `RuntimeAgentSession` | `AgentSession` |
| Options | optional | **required** (needs the registry) |
| Response | `RuntimeAgentResponse`: `completed`, `stopReason`, `runId`, `traceId`, `text`, `output?`, `message?`, `usage`, `report` | `AgentResponse`: `text`, `outcome`, `report`, `message?` |
| `.memory` / `.history` / `.skills` | **absent** | present (`AgentMemory`, `History`, `SkillCatalog \| undefined`) |

Reach for the `defineAgent()` layer when the host needs to inspect or mutate
memory, history, or the skill catalog directly.

## Closing

```ts
const report = await runtime.close()
```

```ts
{
  state: 'closed'
  quiescenceEnd: 'settled' | 'timeout' | 'caller-abort'
  deadlineReached: boolean
  activeRunsAtClose: number
  abortedRuns: number
  unsettledRuns: number          // > 0 means something ignored cancellation
  operations: readonly RuntimeOperationCloseSummary[]
  components: readonly RuntimeComponentCloseReport[]
  observationHealth: RuntimeObservationHealthSnapshot
}
```

Always close in a `finally`. When you also own a borrowed connection (MCP, A2A),
close the runtime **first** to quiesce runs, then the connection.

## Context sections

For instructions recomputed per turn from outside the SDK:

```ts
import { defineContextSection } from '@alvin0/ai-agent-sdk-core'
```

A section is a pure recompute callback — the core SDK never touches a filesystem,
clock, or network on its behalf. Id pattern `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, text
capped at 262,144 bytes, invalid shape raises `CONTEXT_SECTION_INVALID`.

`AGENTS.md`-style files on Node:

```ts
import { createProjectInstructionsSection } from '@alvin0/ai-agent-sdk-instructions-node'
```
