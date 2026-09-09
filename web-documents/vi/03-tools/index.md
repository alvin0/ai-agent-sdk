# Tools — Tổng quan

Tool là một **hàm host có kiểu mà model có thể gọi**. Không có registry thứ hai
theo chuỗi id để phải giữ đồng bộ — định nghĩa *chính là* đăng ký.

```ts
import { defineTool } from '@alvin0/ai-agent-sdk-core'

const multiply = defineTool({
  name: 'multiply',
  description: 'Multiply two numbers.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  parse: raw => raw as { a: number; b: number },
  execute: ({ a, b }) => ({ product: a * b }),
})

const agent = runtime.agent({ id: 'calc', model, instructions: '…', tools: [multiply] })
```

## Ba loại tool

| Loại | Khai báo bằng | Ai thực thi | Ví dụ |
| --- | --- | --- | --- |
| **Tool của host** | `tools: [defineTool(...)]` | Bộ lập lịch của SDK | Đọc tệp, gọi API của bạn |
| **Native tool** | `nativeTools: [{ type: 'native', … }]` | Nhà cung cấp | Web search, sinh ảnh |
| **Tool source** | `toolSources: [connection]` | Bộ lập lịch của SDK, qua nguồn đó | Cả một danh mục MCP server |

Chúng được khai báo **tách riêng có chủ ý**: bộ lập lịch không bao giờ được cố
chạy một tool phía nhà cung cấp, và một danh mục từ xa phải đổi revision được mà
không chạm tới các hàm host của bạn.

## Hai quyết định hình dạng đáng biết

**Thân hàm trả về giá trị, không trả về văn bản cho model.** `execute` sinh ra
một giá trị JSON không mất mát; `render` biến nó thành các block mà model đọc.
Tách hai thứ này ra nghĩa là giá trị có thể được ghi log, phát lại, kiểm tra
trong test, và đưa cho giao diện, trong khi cách diễn đạt hướng model vẫn tự do
thay đổi mà không làm hỏng bất cứ thứ nào ở trên.

Tool đơn giản bỏ qua `render` và nhận mặc định hợp lý: chuỗi được truyền nguyên
văn, thứ khác thì in JSON định dạng đẹp.

**Kênh phụ nằm trên context, không nằm trong kiểu trả về.** Tool muốn kết thúc
lượt hoặc tiêm thêm ngữ cảnh thì gọi `ctx.concludeTurn()` hoặc `ctx.addContext()`.
Nhờ vậy kiểu trả về thông thường vẫn đơn giản — một chuỗi hoặc một đối tượng —
thay vì bắt mọi tool bọc kết quả trong một envelope.

## Hợp đồng đầy đủ

```ts
interface ToolDefinition<Args> extends ToolSchema {
  name: string
  description: string
  parameters: JsonSchema

  parse?:              (raw: unknown) => Args
  execute:             (args: Args, ctx: ToolRunContext) => Promise<JsonValue | void> | JsonValue | void
  render?:             (value: JsonValue | undefined, args: Args) => readonly ContentBlock[]
  meta?:               (value: JsonValue | undefined, args: Args) => JsonObject | undefined
  timeoutMs?:          number
  isConcurrencySafe?:  (args: Args) => boolean
}
```

## Các mặc định an toàn bạn nên biết

| Mặc định | Vì sao |
| --- | --- |
| Lập lịch là **exclusive** trừ khi `isConcurrencySafe` trả về đúng `true` | Đoán sai gây hỏng dữ liệu âm thầm, không phải một lỗi nhìn thấy được |
| `timeoutMs` abort tín hiệu rồi **chờ** | Một tool mồ côi sẽ tiếp tục sửa trạng thái sau lưng vòng lặp |
| `parse` ném lỗi thì thành `INVALID_ARGUMENTS`, không phải sập | Model thấy được lỗi và tự sửa |
| Thất bại **không bao giờ** kết thúc được lượt | `concludesTurn` có kiểu `never` trên `ToolFailure` |
| 64 tool được điều phối mỗi lượt chạy | An toàn cho vận hành không giám sát; host cấu hình được |

## Trong chương này

| Trang | Trả lời |
| --- | --- |
| [Creating a Tool](/vi/03-tools/creating-a-tool) | Mọi trường, và `execute` / `render` / `meta` chia việc thế nào |
| [Tool Parameters](/vi/03-tools/tool-parameters) | Thiết kế schema và ranh giới tin cậy `parse` |
| [Tool Execution](/vi/03-tools/tool-execution) | Lập lịch, đồng thời, timeout, interceptor, tool source |
| [Error Handling](/vi/03-tools/error-handling) | Model thấy gì khi một tool thất bại |
| [Permissions](/vi/03-tools/permissions) | Broker phê duyệt và chặn các lời gọi phá huỷ |
| [Native Tools](/vi/03-tools/native-tools) | Web search và sinh ảnh do nhà cung cấp thực thi |
