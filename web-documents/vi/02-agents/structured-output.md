# Structured Output

`outputFormat` ràng buộc phần văn bản hiển thị của model. Nó trung lập với nhà
cung cấp: cùng một khai báo chạy được trên OpenAI Responses, Anthropic Messages,
và Gemini Interactions.

```ts
const agent = runtime.agent({
  id: 'extractor',
  model,
  instructions: 'Extract the invoice fields from the attached document.',
  outputFormat: {
    type: 'json_schema',
    name: 'invoice',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        total: { type: 'number' },
        currency: { type: 'string' },
      },
      required: ['id', 'total', 'currency'],
    },
  },
})

const response = await agent.generate(document)
const invoice = JSON.parse(response.text)   // chắc chắn là JSON, nếu không lượt chạy đã thất bại
```

## Hợp đồng

```ts
type ModelOutputFormat = TextOutputFormat | JsonSchemaOutputFormat

interface TextOutputFormat {
  readonly type: 'text'
}

interface JsonSchemaOutputFormat {
  readonly type: 'json_schema'
  /** Định danh schema ổn định. Bắt buộc với các nhà cung cấp như OpenAI Responses. */
  readonly name: string
  /** JSON Schema mà nhà cung cấp hỗ trợ. Tập con riêng của từng nhà cung cấp vẫn áp dụng. */
  readonly schema: Readonly<JsonObject>
}
```

`outputFormat` được chấp nhận ở:

| Tầng | Trường |
| --- | --- |
| `runtime.agent({ … })` | `outputFormat` |
| `defineAgent({ … })` | `outputFormat` |
| `runAgent({ … })` | `outputFormat` |
| `ModelRegistry.stream(call)` | `outputFormat` trên `GenerateOptions` |

Bỏ trống nghĩa là văn bản thông thường, không ràng buộc.

## Kiểm tra diễn ra lúc định nghĩa

Schema được kiểm tra, **tách rời, chặn trên, và đóng băng** ngay khi định nghĩa
agent — không phải ở yêu cầu đầu tiên.

```ts
name: /^[A-Za-z0-9_-]{1,64}$/
```

| Chặn trên | Giới hạn |
| --- | --- |
| Byte của schema | 256 KiB |
| Độ sâu schema | 32 |
| Số nút schema | 16.384 |
| Số trường của object | 512 |
| Số phần tử mảng | 1.024 |
| Byte của khoá | 256 |

Hình dạng không hợp lệ ném lỗi ngay:

```
TypeError: agent outputFormat must be text or a bounded JSON Schema with a valid name
```

Chỉ `type`, `name`, và `schema` được chấp nhận — khoá dư bị từ chối chứ không bị
âm thầm bỏ qua. Schema được chụp lại, nên sửa đối tượng của bạn sau đó không đổi
được thứ agent gửi đi.

## Tool và JSON schema đi cùng nhau

Đây là phần đáng hiểu nhất. Khi bạn kết hợp `outputFormat` dạng `json_schema`
**với các tool gọi được**, vòng lặp tách lượt thành hai pha:

```text
┌─ pha xử lý ────────────────────────────────────────────────┐
│  outputFormat bị ép về { type: 'text' }                    │
│  tool khả dụng, toolChoice được tôn trọng                  │
│  model điều tra, gọi tool, đọc kết quả                     │
└────────────────────────────────────────────────────────────┘
                            ↓
┌─ pha output cuối ──────────────────────────────────────────┐
│  outputFormat = json_schema của bạn                        │
│  toolChoice bị ép về 'none'                                │
│  model phát ra câu trả lời có cấu trúc và không gì khác    │
└────────────────────────────────────────────────────────────┘
```

Lý do: một model không thể vừa phát lời gọi tool vừa thoả một output schema
nghiêm ngặt trong cùng một phản hồi. Thay vì bắt bạn phải chọn, SDK chạy vòng lặp
tool không ràng buộc rồi thêm một **bước cuối chuyên dụng** dưới schema.

Nếu **không có** tool gọi được thì không có việc tách pha — mọi bước đã chạy dưới
schema sẵn.

## Hai kiểu thất bại bạn có thể dựa vào

**JSON không hợp lệ ở pha cuối.**

```text
MALFORMED_RESPONSE: model returned invalid JSON for the requested structured output
```

Vòng lặp phân tích văn bản cuối. Nếu nhà cung cấp báo `stop` nhưng văn bản không
phải JSON, lượt chạy thất bại bằng lỗi có kiểu, thay vì đưa cho bạn một chuỗi mà
`JSON.parse` sẽ ném lỗi sau này.

**Một lời gọi tool ở pha cuối.**

```text
INVALID_TOOL_CALL: model emitted a host tool call during the final output phase
```

Tool bị tắt ở pha đó, nên một lời gọi ở đây là vi phạm hợp đồng. Block vi phạm bị
loại bỏ và lượt kết thúc kèm lỗi.

Cả hai đều mang cùng ý nghĩa cho mã của bạn: nếu `generate()` trả về thành công
thì văn bản thoả đúng hình dạng bạn đã yêu cầu.

## Hỗ trợ theo nhà cung cấp

| Nhà cung cấp | Ánh xạ |
| --- | --- |
| OpenAI Responses | `text.format` — phụ thuộc cờ `structuredOutputs` của phương ngữ |
| Anthropic Messages | `format: { type: 'json_schema', schema }` |
| Gemini Interactions | `response_format` |

Cả ba đều được hỗ trợ. Tập con JSON Schema riêng của từng nhà cung cấp vẫn áp
dụng — một tính năng schema mà nhà cung cấp này nhận có thể bị nhà cung cấp khác
từ chối bằng `INVALID_REQUEST`.

## Khi nào một tool là câu trả lời tốt hơn

`outputFormat` ràng buộc **văn bản cuối cùng**. Nó không giúp gì khi bạn muốn
model *đưa cho bạn một giá trị giữa lượt chạy*, hoặc nộp nhiều kết quả, hoặc kích
hoạt một tác dụng phụ cùng lúc.

Khi đó, hãy dùng một tool mà bản thân nó là câu trả lời:

```ts
const submitReview = defineTool({
  name: 'submit_review',
  description: 'Submit the final review verdict. Call this exactly once, last.',
  parameters: { /* … */ },
  parse: raw => ReviewResult.parse(raw),
  execute: (args, ctx) => {
    sink.value = args
    ctx.concludeTurn()
    return { accepted: true }
  },
})
```

| Dùng `outputFormat` khi | Dùng tool nộp kết quả khi |
| --- | --- |
| Câu trả lời *chính là* văn bản phản hồi | Bạn cần giá trị có kiểu trong mã, ngay giữa lượt chạy |
| Một kết quả cho mỗi lượt chạy | Nhiều kết quả, hoặc có tác dụng phụ khi nộp |
| Bạn muốn ràng buộc ở tầng nhà cung cấp | Bạn muốn `parse` từ chối và để model thử lại |

**`parse` cho bạn một đường thử lại mà `outputFormat` không có.** Ném lỗi bên
trong `parse` sinh ra kết quả `INVALID_ARGUMENTS` mà model đọc được và tự sửa ở
bước sau. Một output có cấu trúc sai định dạng thì kết thúc lượt.

Hai thứ ghép được với nhau: `mode: 'deep'` thêm một bài tự kiểm hoàn thành có cấu
trúc, nên lượt không thể kết thúc cho tới khi bài kiểm `submit_result` của chính
model được chấp nhận.

## Đọc tiếp

- [Tool Parameters](/vi/03-tools/tool-parameters) — `parse` như ranh giới tin cậy
- [Creating an Agent](/vi/02-agents/creating-an-agent) — `outputFormat` nằm ở đâu
- [Gemini](/vi/09-providers/gemini) · [OpenAI](/vi/09-providers/openai) · [Anthropic](/vi/09-providers/anthropic)
