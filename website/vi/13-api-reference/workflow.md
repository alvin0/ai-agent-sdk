# `Workflow`

> **Không có kiểu `Workflow` nào.** SDK không export `defineWorkflow()`, không có
> interface `Workflow`, và không có kiểu đồ thị bước. Việc điều phối được biểu
> diễn bằng các kiểu trên trang này.
>
> Xem [Workflows](/vi/06-workflows/) cho bản kể chuyện.

## Thay vào đó hãy dùng gì

| Bạn muốn | Kiểu / hàm | Điểm vào |
| --- | --- | --- |
| Các bước theo thứ tự | `RuntimeAgentSession.run()` | `@ai-agent-sdk/core` |
| Lời gọi tool song song | `ToolDefinition.isConcurrencySafe` | `@ai-agent-sdk/core` |
| Agent song song | `RuntimeAgentTeam`, `spawn_agent` | `@ai-agent-sdk/core` |
| Một cổng có điều kiện | `TurnHooks.beforeStep` → `StepDecision` | `@ai-agent-sdk/core/agent` |
| Một cổng do người chốt | `ApprovalBroker`, `UserInputBroker` | `@ai-agent-sdk/core` |
| Một hợp đồng hoàn thành | `mode: 'deep'` | `@ai-agent-sdk/core` |

## Team

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

Các kiểu: `RuntimeAgentTeam`, `RuntimeAgentTeamEvent`, `RuntimeAgentTeamOptions`,
`AgentTeamMemberInput`.

### `AgentTeam` — nguyên thuỷ tầng thấp

Từ `@ai-agent-sdk/core/agent`:

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
  messages(): readonly TeamMessage[]        // khung nhìn kiểm toán bất biến
}
```

### Tool được gắn sẵn cho model

| Tool | Đích | Tác dụng |
| --- | --- | --- |
| `list_agents` | — | Danh bạ: loại, giao thức, chế độ giao nhận, trạng thái |
| `send_message` | chỉ cục bộ | Tiêm ngữ cảnh im lặng |
| `followup_task` | cục bộ hoặc từ xa | Công việc tuần tự, trả về kết quả |
| `wait_agents` | cục bộ | Chờ trong `timeoutMs`; hết thời gian thì trả roster |
| `spawn_agent` | chỉ agent dẫn dắt trong team quản lý | Tạo một bản sao worker và session |

Đặt `team: { team, tools: false }` khi chỉ host được phép giao tiếp. Danh tính
người gửi được gắn ngay lúc tạo session — model không thể giả mạo `from`.

## Thực thi có điều kiện

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

Các kiểu context: `BeforeStepContext`, `RequestErrorContext`, `CheckpointContext`,
`TurnEndContext`, `TurnEndReason`, `TurnOutcome`, `ExhaustedBudget`.

## Chặn trên khi thực thi

```ts
interface TurnBounds {
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly onExhausted: 'force-final-answer' | 'stop' | 'continue'
  readonly maxConsecutiveToolErrors: number
  readonly repeatToolWarningAt: number
  readonly repeatToolLimit: number
  readonly toolCycleWarningAt: number
  readonly toolCycleLimit: number
  readonly maxToolCycleLength: number
  readonly maxTotalTokens: number
  readonly maxParallel: number
  readonly maxToolResultBytes: number
  readonly maxToolResultTokens: number
  readonly toolResultOverflow: 'auto' | 'truncate' | 'spill'
  readonly maxToolDurationMs: number
  readonly toolTeardownTimeoutMs: number
}
```

`maxToolResultTokens` chặn lượng text MỘT kết quả tool được đưa cho model (mặc định 10.000,
đúng mức Codex cấp cho một lần gọi shell), áp ngay lúc kết quả sinh ra chứ không đợi dựng
request. `toolResultOverflow` chọn cách xử lý khi vượt: `truncate` cắt giữa, không cần gì
thêm; `spill` lưu toàn văn qua `SpillStore` đã mount và cho model tool `read_tool_output`
để đọc phần còn lại; `auto` (mặc định) spill khi có store, cắt khi không. Tool có thể tự hạ
phần của mình bằng `ToolDefinition.maxOutputTokens`; bên nào chặt hơn thì thắng.

`'continue'` biến ngân sách tool-call thành lời nhắc thay vì bức tường: không call nào
bị từ chối vì nó, và turn vẫn bị chặn bởi `maxSteps`, `maxTotalTokens`, cùng các giới hạn
mức run của ledger. Tool khai báo `budgetExempt: true` không bao giờ bị từ chối vì ngân sách
ở bất kỳ chế độ nào, nên submit, hỏi người dùng và giao việc luôn còn dùng được.

## Điểm vào vòng lặp tầng thấp

```ts
// Bạn sở hữu lịch sử; SDK sở hữu chính sách thực thi.
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

// Bạn sở hữu mọi ranh giới — MỘT lượt.
runTurn(options: {
  registry: ModelRegistry
  config: CallConfig
  history: History
  tools?: ToolRegistry
  commentary?: 'auto' | 'concise' | 'off'
  trace?: { agentId: string; agentName?: string }
}): AsyncIterable<AgentEvent>
```

## Gắn vết cho một luồng

```ts
buildTraceTree(events): TraceNode
```

Chiếu các sự kiện `span-start` / `span-end` thành một cây tiến trình bất biến kiểu
Foundry. Mọi sự kiện model và tool đều mang `traceId`, `spanId`, và
`parentSpanId`; các lời gọi song song tới cùng một tool luôn nhận **span id khác
nhau**, trong khi id lời gọi tool vẫn là id tương quan.

## Đọc tiếp

- [Workflows](/vi/06-workflows/) — bản kể chuyện
- [Agent](/vi/13-api-reference/agent) · [Tool](/vi/13-api-reference/tool)
