# Durable Execution

Hai adapter tuỳ chọn đưa công việc tool ra khỏi tiến trình cục bộ và làm một lời
gọi tool **sống sót qua lần khởi động lại**. Cả hai đều là interceptor thường —
không có gì ở đây bật theo mặc định.

```ts
import { createToolExecutionInterceptor, localToolExecutionBackend } from '@alvin0/ai-agent-sdk-core'
```

## Vị trí trong đường ống

```text
phân loại → phê duyệt → intercept ──┬── interceptor chính sách (của bạn)
                                    └── interceptor thực thi   ← ở đây
                                             │
                                             ├─ claim(operation)   nếu có store
                                             ├─ backend.execute()  cục bộ hay từ xa
                                             └─ complete(result)   nếu có store
   → phân tích → render/meta → chốt
```

Chính sách và phê duyệt chạy **trước** adapter này, và chính sách hậu kỳ vẫn làm
sạch kết quả — cả kết quả mới lẫn kết quả phục hồi từ store.

## Backend

```ts
interface ToolExecutionBackend {
  readonly id: string
  readonly capabilities: ToolExecutionCapabilities
  execute(request: ToolExecutionRequest, local: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
}

interface ToolExecutionCapabilities {
  readonly cancellation: 'cooperative' | 'forced'
  readonly filesystem: 'host' | 'restricted' | 'none'
  readonly network:    'host' | 'restricted' | 'none'
  readonly cleanup:    'best-effort' | 'guaranteed'
}
```

Capabilities mô tả những gì backend **thực sự cưỡng chế** — không phải quyền do
chính sách cấp. Backend khai `filesystem: 'restricted'` là đang khẳng định nó
giữ được lằn ranh đó.

`localToolExecutionBackend` là backend đồng nhất: nó gọi `local()` và chỉ khai
đúng những gì một tool trong tiến trình có thể bảo đảm — huỷ theo kiểu hợp tác,
hệ tệp và mạng của host, dọn dẹp nỗ lực-tối-đa.

```ts
interface ToolExecutionRequest {
  readonly operationId: string
  readonly toolName: string
  readonly args: unknown
  readonly identity: JsonObject      // danh tính host đáng tin, KHÔNG BAO GIỜ lấy từ đối số model
  readonly signal: AbortSignal
}
```

`identity` đến từ host đã xác thực. Lấy nó từ đối số model sẽ cho một prompt tự
chọn tenant của chính nó.

## Thao tác bền

Cấp một `store` và mỗi lời gọi sẽ được giành trước khi chạy:

```ts
interface ToolExecutionStore {
  claim(operation: ToolOperation, signal: AbortSignal): Promise<ToolOperationClaim>
  complete(operation: ToolOperation, result: ToolExecutionResult, signal: AbortSignal): Promise<void>
}

type ToolOperationClaim =
  | { status: 'claimed' }                                        // mới: cứ chạy
  | { status: 'completed'; operation: ToolOperation; result: ToolExecutionResult }
  | { status: 'unknown';   operation: ToolOperation }             // đang chạy lúc sập
```

Store **tách khỏi bộ nhớ hội thoại**. Adapter của host phải giành một id một cách
bền và nguyên tử, còn `complete` phải ghi bền xong mới được kết thúc.

```ts
const session = agent.createSession({
  interceptors: [createToolExecutionInterceptor({
    identity: { tenantId: user.tenantId },
    operationId: call => `${conversationId}:${call.turn}:${call.step}:${call.callId}`,
    store: myStore,
  })],
})
```

`operationId` phải **ổn định xuyên qua phục hồi** và được host đã xác thực gán
phạm vi theo tenant và session. Nó bị từ chối khi rỗng hoặc dài hơn 512 ký tự.

## Mỗi kết cục làm gì

| Trạng thái claim | Hành vi |
| --- | --- |
| `claimed` | Chạy, rồi `complete` ghi bền kết quả |
| `completed` | Trả về kết quả đã lưu. **Không chạy lại.** |
| `unknown` | Thất bại với `OPERATION_OUTCOME_UNKNOWN` — phải đối soát trước |

**Không có thử lại tự động.** Một claim đang chạy sẽ là `unknown` sau khi khởi
động lại, không bao giờ tự động được coi là thử lại được: SDK không thể biết một
khoản đã bị trừ hay một email đã được gửi hay chưa. Đối soát thuộc về host.

Một lần quăng lỗi, một lần huỷ, hoặc một lần ghi `complete` thất bại đều để lại
claim chưa giải quyết, nên lần sau sẽ đối soát thay vì chạy lại.

| Mã lỗi | Nguyên nhân |
| --- | --- |
| `INVALID_OPERATION_ID` | Rỗng, không phải chuỗi, hoặc dài hơn 512 ký tự |
| `INVALID_OPERATION_INPUT` | Args hoặc identity không phải JSON không mất mát |
| `OPERATION_ID_CONFLICT` | Cùng id nhưng đầu vào đã lưu khác |
| `OPERATION_OUTCOME_UNKNOWN` | Claim đang chạy, hoặc bị huỷ sau khi giành |
| `TOOL_ABORTED` | Bị huỷ trước khi giành |

`OPERATION_ID_CONFLICT` là chốt chặn một id mang hai nghĩa khác nhau — so sánh
chuẩn hoá cả args lẫn identity, không phải so hash.

Thao tác bền yêu cầu `args` và `identity` là JSON không mất mát, vì một thao tác
được phục hồi phải so bằng với thao tác đã lưu.

## Phê duyệt bền

Cùng ý tưởng cho lằn ranh con người:

```ts
import { createApprovalBroker, withApprovalPersistence } from '@alvin0/ai-agent-sdk-core'

const approvals = withApprovalPersistence(createApprovalBroker(), {
  async savePending(request)            { await db.insertPending(request) },
  async saveDecision(request, decision) { await db.recordDecision(request.approvalRequestId, decision) },
})
```

Lớp bọc đăng ký bộ chờ tương tác **trước** lần ghi lưu trữ đầu tiên, nên một
quyết định tới trong lúc đang ghi không bao giờ bị rơi.

Quyết định đã lưu **không bao giờ** tự áp cho một yêu cầu mới. Khi phục hồi,
host nạp các bản ghi đang chờ và phát lại một yêu cầu phê duyệt mới — đó là lý do
`createApprovalRequest` sinh ra `approvalRequestId` phía SDK.

## Đọc tiếp

- [Tool Execution](/vi/03-tools/tool-execution) — đường ống điều phối
- [Permissions](/vi/03-tools/permissions) — lằn ranh phê duyệt
- [`Tool` API](/vi/13-api-reference/tool) — mọi chữ ký
