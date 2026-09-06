# Streaming

Streaming là con đường duy nhất đi qua SDK. `generate()` rút cạn đúng luồng mà
`stream()` phơi ra — không có lời gọi không-streaming riêng để có thể trôi lệch.

## Run handle

```ts
const handle = agent.stream('Điều tra sự cố rồi tóm tắt lại.')

for await (const event of handle) {
  switch (event.type) {
    case 'commentary-delta': process.stdout.write(event.text); break
    case 'assistant-delta':  process.stdout.write(event.text); break
    case 'tool-call':        console.log('\n→', event.name, event.input); break
    case 'tool-result':      console.log('←', event.name, event.status); break
    case 'usage':            console.log(event.usage); break
    case 'error':            console.error(event.error); break
  }
}

const response = await handle.result
```

```ts
interface RuntimeAgentRunHandle extends AsyncIterable<RuntimeAgentRunEvent> {
  readonly runId: string
  readonly result: Promise<RuntimeAgentResponse>
  readonly report: Promise<RuntimeRunReport>
  abort(reason?: unknown): void
}
```

`result` hoàn tất sau khi cleanup lượt chạy kết thúc. Sau khi chờ nó, bạn có thể
chạy tiếp, reset hoặc compact session (trừ khi session hoặc runtime đã đóng).
`result` và `report` dùng được dù bạn có lặp qua luồng hay không. `abort(reason)`
huỷ lượt chạy và tổ hợp với bất kỳ `signal` bạn đã truyền.

## Toàn bộ sự kiện

Mọi sự kiện đều mang `runId`, `traceId`, và `sequence` tăng đơn điệu.

| Sự kiện | Dữ liệu | Dùng để |
| --- | --- | --- |
| `commentary-delta` | `text` | Tường thuật tiến độ quanh việc dùng tool |
| `assistant-delta` | `text` | Câu trả lời, từng token |
| `tool-call` | `callId`, `name`, `input` | Vẽ một nút tool |
| `tool-result` | `callId`, `name`, `status`, `output` | Hoàn tất nút đó |
| `assistant-native-tool` | `callId`, `provider`, `name`, `status`, `input?`, `output?` | Tiến độ tool do nhà cung cấp thực thi |
| `approval-request` | `request` | Hỏi người dùng cho phép một lời gọi |
| `user-input-request` | `request` | Dừng ở một quyết định quan trọng |
| `user-input-response` | `requestId`, `response` | Hiển thị lại câu trả lời trên giao diện |
| `usage` | `usage`, `report` | Hạch toán token |
| `error` | `error`, `report` | Thất bại có tương quan, đã làm sạch |

`tool-result.status` là một trong `completed`, `failed`, `aborted`, `rejected`.

## Vẽ giao diện trực tiếp

```ts
const handle = session.stream(input)

for await (const event of handle) {
  if (event.type === 'commentary-delta') appendProgress(event.text)
  if (event.type === 'assistant-delta') appendAnswer(event.text)
  if (event.type === 'tool-call') openToolNode(event.callId, event.name, event.input)
  if (event.type === 'tool-result') closeToolNode(event.callId, event.status, event.output)
  if (event.type === 'approval-request') showApprovalDialog(event.request)
  if (event.type === 'error') showBanner(event.error)
}
```

Hai điều làm cho việc này đáng tin thay vì phải đoán:

**Commentary được phân loại, không phải đoán.** `assistant-delta` là câu trả lời;
`commentary-delta` là tường thuật tiến độ. Commentary còn mang `timing` —
`before-tools`, `after-tools`, `between-tools`, `standalone` — và các id lời gọi
tool mà nó nhắc tới, nên một dòng tường thuật liên kết đúng với các lời gọi mà nó
mô tả.

**Suy luận tách bạch với cả hai.** Tóm tắt hoặc nội dung suy luận mà nhà cung cấp
thực sự phát ra đến dưới dạng sự kiện suy luận riêng, không bao giờ trộn vào văn
bản công khai.

## Một phát

```ts
const response = await agent.generate(input)

response.runId
response.traceId
response.text        // câu trả lời cuối
response.usage
response.report      // RuntimeRunReport: độ phủ, lỗi, bản ghi kết thúc
```

Bên dưới, nó rút cạn luồng và trả về kết quả kết thúc. Dùng khi không có giao
diện nào đang theo dõi.

## Huỷ

```ts
const controller = new AbortController()

const handle = session.stream(input, { signal: controller.signal })

// Cả hai cách sau đều huỷ lượt chạy:
controller.abort()
handle.abort('user navigated away')
```

Việc huỷ được **tổ hợp**: một lượt chạy dừng khi signal của chính nó, signal của
runtime, hoặc `handle.abort()` phát tín hiệu. Một tool khai báo `timeoutMs` là
đang cam kết rằng nó chuyển tiếp `ctx.signal` — đường ống abort tín hiệu rồi
**chờ**, nó không bỏ rơi promise, vì một tool mồ côi sẽ tiếp tục sửa trạng thái
sau lưng vòng lặp.

Nếu có thứ gì phớt lờ tín hiệu huỷ, bạn sẽ thấy: `MODEL_TEARDOWN_TIMEOUT` trên
lời gọi đó, và `unsettledRuns > 0` trong báo cáo đóng của runtime.

## Quan sát mà không tiêu thụ luồng

Có lúc bên tiêu thụ luồng không phải đoạn mã cần các sự kiện:

```ts
await agent.generate(input, {
  onEvent: event => metrics.record(event),
})
```

`onEvent` nhận cùng các sự kiện đó, trong khi `generate()` vẫn trả về phản hồi
kết thúc. Lỗi của bộ quan sát bị chặn bởi `observerTimeoutMs` và được kiềm chế —
chúng không bao giờ làm đổi hành vi của lượt chạy.

## Streaming model thô

Để tiêu thụ giao thức chunk trung lập **mà không có vòng lặp agent bao quanh**,
hãy dùng thẳng `ModelRegistry.stream()` và `BlockAssembler`. Đó là tầng thấp hơn
chương này — xem [Tham chiếu API `Types`](/vi/13-api-reference/types) cho
`StreamChunk`, `TokenUsage`, `FinishReason`, và `ReplayEnvelope`.

## Đọc tiếp

- [Lifecycle](/vi/02-agents/lifecycle) — hook, huỷ, bằng chứng đóng
- [Tool Execution](/vi/03-tools/tool-execution) — sự kiện tool được lập lịch thế nào
- [Tham chiếu API `Types`](/vi/13-api-reference/types) — giao thức chunk thô
