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
```

Các kiểu: `ApprovalBroker`, `ApprovalDecision`, `ApprovalRequest`,
`InteractiveApprovalBroker`, `InteractiveApprovalBrokerOptions`.

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
const session = agent.createSession({ interceptors: [async (call, next) => next(call)] })
```

`ToolInterceptor` bọc quanh việc điều phối. Interceptor được nắm bắt kèm receiver
gốc, nên một phương thức lấy ra khỏi đối tượng vẫn giữ `this`.

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
