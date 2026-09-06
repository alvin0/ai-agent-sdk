# `Agent`

Mọi thứ tạo, gắn, hoặc chạy một agent. Import từ `@ai-agent-sdk/core` (hoặc
`@ai-agent-sdk/core/agent` cho tuyến dành cho tác giả).

## Các factory

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

| Tuỳ chọn | Kiểu | Ghi chú |
| --- | --- | --- |
| `providers` | `readonly ComposableModelProviderPlugin[]` | **Bắt buộc** |
| `defaultProvider` | `string` | Tuyến dùng khi agent bỏ trống `model.provider` |
| `signal` | `AbortSignal` | Huỷ quá trình khởi động |
| `resource` | `RuntimeObservationResourceInput` | `serviceName`, nhãn runtime |
| `observability` | `RuntimeOwnerObservabilityOptions` | Xem [Observability](/vi/13-api-reference/observability) |
| `closeTimeoutMs` | `number` | Deadline làm lắng cho `close()` |
| `startupTimeoutMs` | `number` | Deadline cho ranh giới `ready()` của provider |
| `diagnosticMaxEvents` / `diagnosticMaxBytes` | `number` | Chặn trên vòng đệm chẩn đoán |

### `RuntimeCloseReport`

```ts
{
  state: 'closed'
  quiescenceEnd: 'settled' | 'timeout' | 'caller-abort'
  deadlineReached: boolean
  activeRunsAtClose: number
  abortedRuns: number
  unsettledRuns: number                                  // > 0 là khiếm khuyết
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
  memory?: MemoryBinding
  compaction?: AgentCompactionOptions | false
  maxTurns?: number
  maxToolCalls?: number
  commentary?: 'auto' | 'concise' | 'off'
}
```

`ModelOutputFormat` là `{ type: 'text' }` hoặc
`{ type: 'json_schema'; name: string; schema: JsonObject }`. Xem
[Structured Output](/vi/02-agents/structured-output) để biết hành vi kết thúc
trong tool loop.

`RuntimeAgentBindingInput` cùng hình dạng nhưng `model` là tuỳ chọn
(`{ provider: string; id?: string }`), nên một binding có thể kế thừa provider
mặc định của runtime.

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
  tools?: readonly ToolDefinition[]        // GỘP với tool do định nghĩa sở hữu
  toolSources?: readonly ToolSource[]
  skills?: readonly RuntimeSkillSource[]
  memory?: MemoryBinding | false
  skillCwd?: string
  userInput?: UserInputBroker              // bắt buộc với 'deep-human-in-loop'
  approvals?: ApprovalBroker
  interceptors?: readonly ToolInterceptor[]
  hooks?: TurnHooks
  usagePolicy?: UsagePolicy
  runtimeLimits?: RuntimeAgentLimits
  compaction?: AgentCompactionOptions | false
}
```

### `RuntimeAgentLimits`

```ts
{
  maxSteps?: number
  maxToolCalls?: number
  maxConsecutiveToolErrors?: number
  maxTotalTokens?: number
  observerTimeoutMs?: number
}
```

## Lời gọi và kết quả

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

Mọi sự kiện đều mang `runId`, `traceId`, và `sequence` tăng đơn điệu.

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

## Hook vòng đời

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

createUserInputBroker(options?: InteractiveUserInputBrokerOptions): InteractiveUserInputBroker
fixedUserInputBroker(decision: UserInputDecision): UserInputBroker
```

## Vòng lặp tầng thấp

Từ `@ai-agent-sdk/core/agent`:

```ts
runAgent(options): AsyncIterable<AgentRunEvent>     // bạn sở hữu lịch sử
runTurn(options): AsyncIterable<AgentEvent>         // bạn sở hữu mọi ranh giới; MỘT lượt
buildTraceTree(events): TraceNode                   // cây tiến trình bất biến
class History { entries(); messages(); append(); static fromSnapshot() }
class ToolRegistry { register(); }
class AgentTeam { sendMessage(); followup(); whenIdle(); messages(); }
```

## Đọc tiếp

- [Tool](/vi/13-api-reference/tool) · [Workflow](/vi/13-api-reference/workflow) · [Memory](/vi/13-api-reference/memory) · [Types](/vi/13-api-reference/types)
- [Creating an Agent](/vi/02-agents/creating-an-agent) — bản kể chuyện
