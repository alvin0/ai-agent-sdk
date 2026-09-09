# `Tool`

Import từ `@ai-agent-sdk/core`; phần viết tool source nằm ở
`@ai-agent-sdk/core/tools`.

## `defineTool`

```ts
defineTool<Args>(definition: ToolDefinition<Args>): ToolDefinition<Args>
```

```ts
interface ToolDefinition<Args = unknown> extends ToolSchema {
  name: string
  description: string
  parameters: JsonSchema

  parse?:             (raw: unknown) => Args
  execute:            (args: Args, ctx: ToolRunContext) => Promise<JsonValue | void> | JsonValue | void
  render?:            (value: JsonValue | undefined, args: Args) => readonly ContentBlock[]
  meta?:              (value: JsonValue | undefined, args: Args) => JsonObject | undefined
  timeoutMs?:         number
  isConcurrencySafe?: (args: Args) => boolean
  maxOutputTokens?:   number
  budgetExempt?:      true
}
```

| Trường | Bắt buộc | Ghi chú |
| --- | --- | --- |
| `name` | ✓ | Ổn định; xuất hiện trong lịch sử, vết, hộp thoại phê duyệt |
| `description` | ✓ | Prompt engineering — cho model biết *khi nào* nên gọi |
| `parameters` | ✓ | JSON Schema thuần, gửi tới nhà cung cấp nguyên văn |
| `parse` | — | Ranh giới tin cậy. Ném lỗi → `INVALID_ARGUMENTS` mà model sửa được |
| `execute` | ✓ | Trả về JSON không mất mát, hoặc không trả gì |
| `render` | — | Mặc định: chuỗi nguyên văn, còn lại in JSON định dạng đẹp |
| `meta` | — | Metadata giao diện; model **không bao giờ** thấy |
| `timeoutMs` | — | Không bao giờ gửi cho model. Cam kết rằng `execute` chuyển tiếp `ctx.signal` |
| `isConcurrencySafe` | — | **Fail-closed**: chỉ đúng `true` mới cho chạy song song |
| `maxOutputTokens` | — | Số token text ước lượng mà kết quả của tool này được đưa cho model. Không gửi cho model; bên nào chặt hơn giữa nó và ngân sách turn thì thắng |
| `budgetExempt` | — | Miễn ngân sách tool-call của turn và các guard vòng lặp. Dành cho call KẾT THÚC việc — submit, hỏi người dùng, giao việc. Chỉ đúng `true`; giới hạn mức run của ledger vẫn áp dụng |

## `defineToolFromSchema`

```ts
interface RuntimeSchema<T> {
  readonly jsonSchema: JsonObject
  readonly parse: (value: unknown) => T
}

defineToolFromSchema<T>(
  schema: RuntimeSchema<T>,
  definition: Omit<ToolDefinition<T>, 'parameters' | 'parse'>,
): ToolDefinition<T>
```

Bắc cầu sang một thư viện schema **một lần duy nhất**: `parameters` và `parse`
lấy từ cùng một nguồn, nên JSON Schema mà nhà cung cấp thấy không bao giờ lệch
khỏi bộ kiểm tra đứng canh `execute`.

```ts
import { defineToolFromSchema } from '@ai-agent-sdk/core'
import { z } from 'zod'

const shape = z.object({ path: z.string() })
const schema = { jsonSchema: z.toJSONSchema(shape), parse: value => shape.parse(value) }

const readFile = defineToolFromSchema(schema, {
  name: 'read_file',
  description: 'Read one UTF-8 file.',
  execute: async args => readUtf8(args.path),   // args đã có kiểu
})
```

SDK không phụ thuộc thư viện schema nào. `RuntimeSchema` là bề mặt hai phương
thức mà thư viện nào cũng thoả được trong ba dòng.

## `ToolRunContext`

```ts
interface ToolRunContext {
  readonly callId: ToolCallId     // provider-issued id for this call
  readonly toolName: string
  readonly turn: number           // 1-based turn in the conversation
  readonly step: number           // 1-based step within the turn
  readonly signal: AbortSignal
  readonly logger?: SdkLogger     // always present on AgentRuntime paths

  concludeTurn(): void
  addContext(content: string | readonly ContentBlock[]): void
}
```

## Results

```ts
type ToolExecutionResult = ToolSuccess | ToolFailure

interface ToolSuccess {
  readonly isError: false
  readonly value: JsonValue | undefined
  readonly content: readonly ContentBlock[]
  readonly meta?: JsonObject
  readonly additionalContext?: readonly ContentBlock[]
  readonly concludesTurn?: true
}

interface ToolFailure {
  readonly isError: true
  readonly error: { readonly message: string; readonly code: string }
  readonly content: readonly ContentBlock[]
  readonly meta?: JsonObject
  readonly additionalContext?: readonly ContentBlock[]
  readonly concludesTurn?: never          // thất bại KHÔNG BAO GIỜ kết thúc được lượt
}
```

## Lập lịch

```ts
type ToolExecutionMode = 'parallel' | 'exclusive'
```

Mặc định là `exclusive`. Bộ phân loại `isConcurrencySafe` ném lỗi hoặc không khai
báo cũng bị coi là exclusive, vì kiểu thất bại khi đoán sai là hỏng dữ liệu âm
thầm, không phải một lỗi nhìn thấy được.

## Approvals

```ts
createApprovalBroker(options?: InteractiveApprovalBrokerOptions): InteractiveApprovalBroker
fixedApprovalBroker(decision: ApprovalDecision): ApprovalBroker
createApprovalRequest(input: Omit<ApprovalRequest, 'approvalRequestId' | 'providerCallId'>): ApprovalRequest
withApprovalPersistence(broker: ApprovalBroker, store: ApprovalStateStore): ApprovalBroker
```

```ts
type ApprovalDecision = 'allow' | 'deny' | 'abort'

interface ApprovalRequest {
  readonly approvalRequestId: string      // do SDK cấp, dùng một lần
  readonly providerCallId: ToolCallId
  readonly callId: ToolCallId
  readonly toolName: string
  readonly args: unknown
  readonly reason?: string
  readonly runId?: string
  readonly conversationId?: string
  readonly turn: number
  readonly step: number
}

interface ApprovalStateStore {
  savePending(request: ApprovalRequest, signal?: AbortSignal): Promise<void>
  saveDecision(request: ApprovalRequest, decision: ApprovalDecision, signal?: AbortSignal): Promise<void>
}
```

Hãy trả lời theo `approvalRequestId`, không bao giờ theo `providerCallId` — id
của SDK dùng một lần, nên một id lời gọi được phát lại không thể tái dùng quyết
định cũ.

`withApprovalPersistence` ghi sổ mọi yêu cầu đang chờ và mọi quyết định, bọc
quanh một broker có sẵn. Nó đăng ký bộ chờ tương tác **trước** lần ghi lưu trữ
đầu tiên, nên không có quyết định nào tới lúc chẳng ai đang nghe. Quyết định đã
lưu không bao giờ tự áp cho một yêu cầu mới: khi phục hồi, host nạp các bản ghi
đang chờ và phát lại một yêu cầu phê duyệt mới.

Các kiểu: `ApprovalBroker`, `ApprovalDecision`, `ApprovalRequest`,
`ApprovalStateStore`, `InteractiveApprovalBroker`,
`InteractiveApprovalBrokerOptions`.

Lời gọi bị từ chối trở thành `ToolFailure` với `status: 'rejected'` trên sự kiện
của lượt chạy.

## Tool source — `@ai-agent-sdk/core/tools`

```ts
export { defineToolSource, TOOL_SOURCE_API_VERSION }
export type {
  ToolCatalogSnapshot, ToolSource, ToolSourceDefinition,
  ToolSourceRunReference, ToolSourceSnapshotOptions, ToolSchema,
}
```

Một `ToolSource` công bố cả một danh mục. Ảnh chụp là **đồng bộ và nguyên tử** —
một revision gắn cả schema lẫn việc thực thi — và bằng chứng kết thúc chỉ mang
nguồn và revision.

## Native tools

Khai báo trên `nativeTools`, **không phải** `tools`, để bộ lập lịch không bao giờ
cố chạy chúng:

```ts
type NativeToolSchema = NativeWebSearchTool | NativeImageGenerationTool
type NativeToolName = 'web-search' | 'image-generation'

{ type: 'native', name: 'web-search', allowedDomains?: string[] }
{ type: 'native', name: 'image-generation', format?: string, partialImages?: number }
```

`ModelRegistry` từ chối native tool không hỗ trợ bằng `UNSUPPORTED_NATIVE_TOOL`
**trước** khi có I/O tới nhà cung cấp.

## Interceptors

```ts
interface ToolInterceptor {
  readonly name: string
  readonly before?: (call: ToolCallContext, next: () => Promise<PreToolDecision>)  => Promise<PreToolDecision>
  readonly around?: (call: ToolCallContext, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>
  readonly after?:  (call: ToolCallContext, result: ToolExecutionResult,
                     next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
}

interface ToolCallContext {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly tool: ToolDefinition | undefined
  readonly rawArguments: string       // nguyên văn từ nhà cung cấp
  readonly args: unknown              // đã phân tích, ở đây vẫn chưa có kiểu
  readonly signal: AbortSignal
  readonly turn: number
  readonly step: number
  readonly logger?: SdkLogger
}

type PreToolDecision  = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
type PostToolDecision = { kind: 'accept' }
                      | { kind: 'replace'; content: readonly ContentBlock[]; meta?: JsonObject }
                      | { kind: 'block'; feedback: readonly ContentBlock[]; code?: string }
```

Interceptor là một **đối tượng có tên**, không phải hàm trần, và mỗi pha đều
tuỳ chọn:

```ts
const audit: ToolInterceptor = {
  name: 'audit',
  around: async (call, next) => {
    const started = performance.now()
    try {
      return await next()
    } finally {
      metrics.record(call.toolName, performance.now() - started)
    }
  },
}

const session = agent.createSession({ interceptors: [audit] })
```

`before` trả `{ kind: 'ask' }` sẽ đưa lời gọi sang approval broker;
`{ kind: 'deny' }` không bao giờ tới `execute`. `after` có thể thay thế hoặc chặn
một kết quả mà model lẽ ra sẽ đọc. Interceptor được nắm bắt kèm receiver gốc,
nên một phương thức lấy ra khỏi đối tượng vẫn giữ `this`.

## Thực thi bền

```ts
createToolExecutionInterceptor(options: {
  readonly backend?: ToolExecutionBackend        // mặc định localToolExecutionBackend
  readonly identity: JsonObject                  // danh tính host đáng tin
  readonly operationId: (call: ToolCallContext) => string
  readonly store?: ToolExecutionStore
}): ToolInterceptor

localToolExecutionBackend: ToolExecutionBackend
```

Các kiểu: `ToolExecutionBackend`, `ToolExecutionCapabilities`,
`ToolExecutionRequest`, `ToolExecutionStore`, `ToolOperation`,
`ToolOperationClaim`.

Xem [Durable Execution](/vi/03-tools/durable-execution) để biết hợp đồng đầy đủ.

## Các chặn trên

| Chặn trên | Mặc định |
| --- | --- |
| `maxToolCalls` | 64 mỗi lượt chạy |
| `maxToolResultBytes` | Kết quả đã tuần tự hoá được giữ, có chặn trên |
| `maxToolDurationMs` | Thời gian thực cho mỗi lời gọi |
| `toolTeardownTimeoutMs` | Thời gian chờ sau khi huỷ một tool bất hợp tác |
| `maxConsecutiveToolErrors` | Ngưỡng cắt |
| `maxParallel` | Số lời gọi an toàn chạy đồng thời |

## Đọc tiếp

- [Agent](/vi/13-api-reference/agent) · [Types](/vi/13-api-reference/types)
- [Creating a Tool](/vi/03-tools/creating-a-tool) — bản kể chuyện
