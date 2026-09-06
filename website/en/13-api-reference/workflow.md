# `Workflow`

> **There is no `Workflow` type.** The SDK exports no `defineWorkflow()`, no
> `Workflow` interface, and no step-graph types. Orchestration is expressed with
> the types on this page.
>
> See [Workflows](/en/06-workflows/) for the narrative version.

## What to reach for instead

| You want | Type / function | Entry point |
| --- | --- | --- |
| Ordered steps | `RuntimeAgentSession.run()` | `@ai-agent-sdk/core` |
| Parallel tool calls | `ToolDefinition.isConcurrencySafe` | `@ai-agent-sdk/core` |
| Parallel agents | `RuntimeAgentTeam`, `spawn_agent` | `@ai-agent-sdk/core` |
| A conditional gate | `TurnHooks.beforeStep` → `StepDecision` | `@ai-agent-sdk/core/agent` |
| A human gate | `ApprovalBroker`, `UserInputBroker` | `@ai-agent-sdk/core` |
| A completion contract | `mode: 'deep'` | `@ai-agent-sdk/core` |

## Teams

```ts
createManagedAgentTeam(options): RuntimeAgentTeam & { run(); spawn(); workers(); removeWorker() }
createDefinedAgentTeam(options): { run(name, input); team: AgentTeam }
```

```ts
interface RuntimeAgentTeamOptions {
  readonly registry?: unknown
  readonly team?: { readonly id: string }
  readonly members?: readonly AgentTeamMemberInput[]
  readonly lead?: DefinedAgent
  readonly maxWorkers?: number
  readonly workerTemplate?: DefinedAgent
  readonly workerFactory?: (request: { name: string; task: string; specialty?: string }) => DefinedAgent
  readonly workerSessionOptionsFactory?: (request: unknown) => RuntimeAgentSessionOptions
}

interface AgentTeamMemberInput {
  readonly agent: DefinedAgent
  readonly role?: 'lead'
}
```

Types: `RuntimeAgentTeam`, `RuntimeAgentTeamEvent`, `RuntimeAgentTeamOptions`,
`AgentTeamMemberInput`.

### `AgentTeam` — the low-level primitive

From `@ai-agent-sdk/core/agent`:

```ts
class AgentTeam {
  constructor(options: { id: string; maxMembers?: number })

  sendMessage(input: {
    from: string
    target: string
    message: string
    delivery: 'quiet' | 'wake-up'
  }): Promise<unknown>

  followup(from: string, target: string, message: string): Promise<Receipt>
  whenIdle(target: string, signal?: AbortSignal): Promise<void>
  messages(): readonly TeamMessage[]        // immutable audit view
}
```

### Bound model tools

| Tool | Target | Effect |
| --- | --- | --- |
| `list_agents` | — | Roster: kind, protocol, delivery modes, status |
| `send_message` | local only | Quiet context injection |
| `followup_task` | local or remote | Serialized work, returns the result |
| `wait_agents` | local | Blocks until scheduled work is idle |
| `spawn_agent` | managed lead only | Creates a worker clone and session |

Set `team: { team, tools: false }` when only the host may communicate. Sender
identity is bound at session creation — a model cannot forge `from`.

## Conditional execution

```ts
type StepDecision =
  | { readonly kind: 'proceed'; readonly prepend?: readonly Message[] }
  | { readonly kind: 'reject'; readonly reason: string }

interface TurnHooks {
  beforeStep?:     (ctx: BeforeStepContext) => Promise<StepDecision> | StepDecision
  onRequestError?: (ctx: RequestErrorContext) => Promise<'retry' | 'fail'> | 'retry' | 'fail'
  checkpoint?:     (ctx: CheckpointContext) => Promise<void> | void
  onTurnEnd?:      (ctx: TurnEndContext) => Promise<void> | void
}
```

Context types: `BeforeStepContext`, `RequestErrorContext`, `CheckpointContext`,
`TurnEndContext`, `TurnEndReason`, `TurnOutcome`, `ExhaustedBudget`.

## Execution bounds

```ts
interface TurnBounds {
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly onExhausted: 'force-final-answer' | 'stop'
  readonly maxConsecutiveToolErrors: number
  readonly repeatToolWarningAt: number
  readonly repeatToolLimit: number
  readonly toolCycleWarningAt: number
  readonly toolCycleLimit: number
  readonly maxToolCycleLength: number
  readonly maxTotalTokens: number
  readonly maxParallel: number
  readonly maxToolResultBytes: number
  readonly maxToolDurationMs: number
  readonly toolTeardownTimeoutMs: number
}
```

## Low-level loop entry points

```ts
// You own history; the SDK owns execution policy.
runAgent(options: {
  mode: 'basic' | 'deep' | 'deep-human-in-loop'
  registry: ModelRegistry
  history: History
  tools?: ToolRegistry
  config?: CallConfig
  nativeTools?: readonly NativeToolSchema[]
  userInput?: UserInputBroker
  maxTurns?: number
}): AsyncIterable<AgentRunEvent>

// You own every boundary — ONE turn.
runTurn(options: {
  registry: ModelRegistry
  config: CallConfig
  history: History
  tools?: ToolRegistry
  commentary?: 'auto' | 'concise' | 'off'
  trace?: { agentId: string; agentName?: string }
}): AsyncIterable<AgentEvent>
```

## Tracing a flow

```ts
buildTraceTree(events): TraceNode
```

Projects `span-start` / `span-end` events into an immutable Foundry-style process
tree. Every model and tool event carries `traceId`, `spanId`, and
`parentSpanId`; parallel calls to the same tool always receive **distinct span
ids**, while the tool call id remains the correlation id.

## Read next

- [Workflows](/en/06-workflows/) — the narrative version
- [Agent](/en/13-api-reference/agent) · [Tool](/en/13-api-reference/tool)
