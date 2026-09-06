# Structured Output

Agent có thể yêu cầu văn bản thông thường hoặc JSON bị ràng buộc bởi JSON Schema
thông qua trường trung lập nhà cung cấp `outputFormat`.

## Output theo JSON Schema

```ts
const reviewer = runtime.agent({
  id: 'reviewer',
  model: { provider: 'openai', id: 'gpt-5.6-sol' },
  instructions: 'Review the change and return the verdict.',
  outputFormat: {
    type: 'json_schema',
    name: 'review_result',
    schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['ship', 'block'] },
        summary: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'summary', 'blockers'],
      additionalProperties: false,
    },
  },
})

const response = await reviewer.generate('Review the pending diff.')
const result = JSON.parse(response.text) as {
  verdict: 'ship' | 'block'
  summary: string
  blockers: string[]
}
```

Khi định nghĩa agent, schema được kiểm tra là JSON không mất dữ liệu và có giới
hạn kích thước, sau đó được tách khỏi object của caller và đóng băng. Từng nhà
cung cấp vẫn có tập con JSON Schema riêng; schema object thường nên khai báo đầy
đủ các thuộc tính bắt buộc và đặt `additionalProperties: false`.

SDK giữ `response.text` làm kết quả chuẩn. Ép kiểu TypeScript không phải là kiểm
tra dữ liệu không đáng tin; hãy parse hoặc validate bằng zod, valibot, ajv hay bộ
kiểm tra của ứng dụng tại ranh giới tin cậy.

## Hành vi trong tool loop

`outputFormat` mô tả câu trả lời cuối mà người dùng nhìn thấy, không áp lên mọi
bước model nội bộ. Khi agent có thể gọi tool và được yêu cầu JSON Schema, SDK sử
dụng một quy ước ổn định trong toàn bộ loop:

1. Các vòng xử lý dùng `{ type: 'text' }` và vẫn có thể gọi tool bình thường.
2. Kết quả văn bản không gọi tool chỉ được giữ làm commentary, chưa được nhận là
   câu trả lời cuối.
3. SDK tạo thêm một request kết thúc đã khóa tool và chỉ request này dùng JSON
   Schema đã yêu cầu. Vòng kết thúc do cạn budget cũng dùng schema trực tiếp.

Nhờ vậy tool loop dài không phụ thuộc vào schema cuối, trong khi `response.text`
và terminal outcome luôn đến từ vòng bị ràng buộc bởi schema. Bước kết thúc riêng
có thể dùng thêm một model request ngoài giới hạn bước xử lý thông thường. SDK
cũng từ chối final response thành công nếu nội dung không phải JSON hợp lệ về cú
pháp; việc tuân thủ schema do structured-output implementation của provider đã
chọn đảm bảo.

## Văn bản thông thường

Text vẫn là mặc định và cũng có thể được chọn rõ ràng:

```ts
const writer = runtime.agent({
  id: 'writer',
  instructions: 'Write a concise answer.',
  outputFormat: { type: 'text' },
})
```

## Ánh xạ theo nhà cung cấp

| Giao thức | Trường trên wire | Hỗ trợ |
| --- | --- | --- |
| OpenAI Responses | `text.format` với `type: 'json_schema'` và `strict: true` | Có |
| Anthropic Messages | `output_config.format` với `type: 'json_schema'` | Có |
| Codex ChatGPT endpoint | `text.format` với `type: 'json_schema'` và `strict: true` | Có |

Tên schema được chứa chữ cái, chữ số, `_`, `-` và dài tối đa 64 ký tự. Tên này
được gửi tới nhà cung cấp cần định danh schema ổn định và được bỏ qua bởi giao
thức không sử dụng nó.

## Khi nào tool nộp kết quả vẫn tốt hơn

Hãy dùng final-answer tool nếu nhà cung cấp không hỗ trợ structured output, hoặc
khi lỗi validation cần được trả lại cho model để model tự sửa và thử lại. Hook
`parse` của tool vẫn là ranh giới validation và phục hồi độc lập nhà cung cấp.

## Đọc tiếp

- [Tạo Agent](/vi/02-agents/creating-an-agent)
- [Tham số Tool](/vi/03-tools/tool-parameters)
- [Nhà cung cấp](/vi/09-providers/)
