# `Agent`

Everything that creates, binds, or runs an agent. Import from
`@alvin0/ai-agent-sdk-core` (or `@alvin0/ai-agent-sdk-core/agent` for the authoring route).

## Factories

```ts
createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime>
defineAgent(input: AgentDefinitionInput): DefinedAgent
cloneAgent(agent: DefinedAgent, overrides: CloneAgentOverrides): DefinedAgent
```

## `AgentRuntime`

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

### `AgentRuntimeOptions`

| Option | Type | Notes |
| --- | --- | --- |
| `providers` | `readonly ComposableModelProviderPlugin[]` | **Required** |
| `defaultProvider` | `string` | Route used when an agent omits `model.provider` |
| `signal` | `AbortSignal` | Aborts startup |
| `resource` | `RuntimeObservationResourceInput` | `serviceName`, runtime label |
| `observability` | `RuntimeOwnerObservabilityOptions` | See [Observability](/en/13-api-reference/observability) |
| `closeTimeoutMs` | `number` | Quiescence deadline for `close()` |
| `startupTimeoutMs` | `number` | Deadline for provider `ready()` boundaries |
| `diagnosticMaxEvents` / `diagnosticMaxBytes` | `number` | Bound the diagnostic ring |

### `RuntimeCloseReport`

```ts
{
  state: 'closed'
  quiescenceEnd: 'settled' | 'timeout' | 'caller-abort'
  deadlineReached: boolean
  activeRunsAtClose: number
  abortedRuns: number
  unsettledRuns: number                                  // > 0 is a defect
  operations: readonly RuntimeOperationCloseSummary[]
  components: readonly RuntimeComponentCloseReport[]
  observationHealth: RuntimeObservationHealthSnapshot
}
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

### `RuntimeAgentDefinitionInput`

```ts
{
  id: string
  name?: string
  description?: string
  model: ModelTarget                 // { provider, id? }
  instructions: string
  effort?: string
  maxTokens?: number
  outputFormat?: ModelOutputFormat
  mode?: 'basic' | 'deep' | 'deep-human-in-loop'
  tools?: readonly ToolDefinition[]
  nativeTools?: readonly NativeToolSchema[]
  toolChoice?: ToolChoice
  toolSources?: readonly ToolSource[]
  skills?: readonly RuntimeSkillSource[]
  allowedSkillIds?: readonly string[]
  contextSections?: readonly ContextSection[]
  memory?: MemoryBinding
  compaction?: AgentCompactionOptions | false
  maxTurns?: number | 'auto'
  maxToolCalls?: number
  commentary?: 'auto' | 'concise' | 'off'
}
```

`ModelOutputFormat` is `{ type: 'text' }` or
`{ type: 'json_schema'; name: string; schema: JsonObject }`. See
[Structured Output](/en/02-agents/structured-output) for finalization behavior
in tool loops.

`RuntimeAgentBindingInput` is the same shape with `model` optional
(`{ provider: string; id?: string }`), so a binding can inherit the runtime's
default provider.

## `RuntimeAgentSession`

```ts
interface RuntimeAgentSession {
  readonly conversationId: string
  readonly isRunning: boolean
  run(input: string, options?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse>
  stream(input: string, options?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle
  inject(input: string): number
  snapshot(): RuntimeAgentSessionSnapshot
  compact(options?: RuntimeAgentInvocationOptions): Promise<CompactionResult | null>
  reset(): void
  whenIdle(signal?: AbortSignal): Promise<void>
}
```

### `RuntimeAgentSessionOptions`

```ts
{
  conversationId?: string
  tools?: readonly ToolDefinition[]        // COMBINED with definition-owned tools
  toolSources?: readonly ToolSource[]
  skills?: readonly RuntimeSkillSource[]
  memory?: MemoryBinding | false
  skillCwd?: string
  userInput?: UserInputBroker              // required for 'deep-human-in-loop'
  approvals?: ApprovalBroker
  interceptors?: readonly ToolInterceptor[]
  contextSections?: readonly ContextSection[]
  hooks?: TurnHooks
  usagePolicy?: UsagePolicy
  runtimeLimits?: RuntimeAgentLimits
  compaction?: AgentCompactionOptions | false
}
```

### `RuntimeAgentLimits`

```ts
{
  maxSteps?: number | 'auto'
  maxToolCalls?: number
  maxConsecutiveToolErrors?: number
  maxTotalTokens?: number | 'auto'
  finalReportReserveTokens?: number
  observerTimeoutMs?: number
}
```

### `'auto'` limits

`maxTurns`, `maxSteps`, and `maxTotalTokens` accept `'auto'`, which removes
**that one ceiling** — nothing else.

| Limit | Default | `'auto'` means |
| --- | --- | --- |
| `maxTurns` / `maxSteps` | `16` | Completion-driven: no fixed model-step ceiling |
| `maxTotalTokens` | `'auto'` | No aggregate token ceiling; reminders and report reserves are inactive |

Resource guards, cancellation, compaction, the run-level ledger, loop guards,
and completion checks all still apply. A serialized session preserves `'auto'`
rather than resolving it to a number.

`finalReportReserveTokens` stops tool work with token headroom left for one
tools-disabled final report. It must be a non-negative safe integer **below**
`maxTotalTokens`, and it is ignored when `maxTotalTokens` is `'auto'` (there is
no ceiling to reserve against).

## Invocation and results

```ts
interface RuntimeAgentInvocationOptions {
  signal?: AbortSignal
  additionalInstructions?: string
  onEvent?: (event: RuntimeAgentRunEvent) => void | Promise<void>
}

interface RuntimeAgentResponse {
  runId: string
  traceId: string
  text: string
  usage: RuntimeRunReport['usage']
  report: RuntimeRunReport
}

interface RuntimeAgentRunHandle extends AsyncIterable<RuntimeAgentRunEvent> {
  readonly runId: string
  readonly result: Promise<RuntimeAgentResponse>
  readonly report: Promise<RuntimeRunReport>
  abort(reason?: unknown): void
}
```

### `RuntimeAgentRunEvent`

Every event carries `runId`, `traceId`, and a monotonic `sequence`.

```ts
| { type: 'commentary-delta';      text: string }
| { type: 'assistant-delta';       text: string }
| { type: 'tool-call';             callId: string; name: string; input: unknown }
| { type: 'tool-result';           callId: string; name: string
                                   status: 'completed' | 'failed' | 'aborted' | 'rejected'
                                   output: unknown }
| { type: 'assistant-native-tool'; callId: string; provider: string; name: string
                                   status: 'started' | 'completed' | 'failed' | 'unknown'
                                   input?: JsonValue; output?: JsonValue }
| { type: 'approval-request';      request: ApprovalRequest }
| { type: 'user-input-request';    request: UserInputRequest }
| { type: 'user-input-response';   requestId: string; response: UserInputDecision }
| { type: 'usage';                 usage: RuntimeRunReport['usage']; report: RuntimeRunReport }
| { type: 'error';                 error: RuntimeRunReport['errors'][number]; report: RuntimeRunReport }
```

## Lifecycle hooks

```ts
interface TurnHooks {
  beforeStep?:     (ctx: BeforeStepContext) => Promise<StepDecision> | StepDecision
  onRequestError?: (ctx: RequestErrorContext) => Promise<'retry' | 'fail'> | 'retry' | 'fail'
  checkpoint?:     (ctx: CheckpointContext) => Promise<void> | void
  onTurnEnd?:      (ctx: TurnEndContext) => Promise<void> | void
}

type StepDecision =
  | { kind: 'proceed'; prepend?: readonly Message[] }
  | { kind: 'reject'; reason: string }
```

## Brokers

```ts
createApprovalBroker(options?: InteractiveApprovalBrokerOptions): InteractiveApprovalBroker
fixedApprovalBroker(decision: ApprovalDecision): ApprovalBroker
createApprovalRequest(input: Omit<ApprovalRequest, 'approvalRequestId' | 'providerCallId'>): ApprovalRequest
withApprovalPersistence(broker: ApprovalBroker, store: ApprovalStateStore): ApprovalBroker

createUserInputBroker(options?: InteractiveUserInputBrokerOptions): InteractiveUserInputBroker
fixedUserInputBroker(decision: UserInputDecision): UserInputBroker
```

`ApprovalDecision` is `'allow' | 'deny' | 'abort'`. `createApprovalRequest`
mints the SDK-issued `approvalRequestId`; a broker only ever answers an id it
was given, never a provider call id. See
[Permissions](/en/03-tools/permissions) and
[Durable Execution](/en/03-tools/durable-execution).

## Low-level loop

From `@alvin0/ai-agent-sdk-core/agent`:

```ts
runAgent(options): AsyncIterable<AgentRunEvent>     // you own history
runTurn(options): AsyncIterable<AgentEvent>         // you own every boundary; ONE turn
buildTraceTree(events): TraceNode                   // immutable process tree
class History { entries(); messages(); append(); static fromSnapshot() }
class ToolRegistry { register(); }
class AgentTeam { sendMessage(); followup(); whenIdle(); messages(); }
```

## Read next

- [Tool](/en/13-api-reference/tool) · [Workflow](/en/13-api-reference/workflow) · [Memory](/en/13-api-reference/memory) · [Types](/en/13-api-reference/types)
- [Creating an Agent](/en/02-agents/creating-an-agent) — the narrative version
