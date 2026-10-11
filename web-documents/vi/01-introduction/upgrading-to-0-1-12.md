# Nâng cấp lên 0.1.12

Nâng các SDK package cùng nhau lên **0.1.12**. Workspace có 28 package, trong đó
27 package có thể publish; `testkit` vẫn private. Push vào `main` kích hoạt
publish sau các gate. Release chạy thủ công mặc định là dry run. Local checks
không chứng minh CI hosted hoặc npm publish đã thành công.

## Trường event bắt buộc

Event `reasoning-delta` và `assistant-reasoning` ở cả tầng thấp và runtime bắt
buộc có `reasoningKind: 'summary' | 'content' | 'unknown'`. Cập nhật wrapper,
code tự tạo event và test double. Chunk stream và `ReasoningBlock` trong history
sử dụng trường `kind` không bắt buộc. History cũ vẫn restore được; thiếu nhãn
hoặc nhãn trộn nghĩa là unknown, không được đoán thành summary.

## Web search ảnh và câu trả lời chỉ có ảnh

Bật tìm ảnh trên Responses bằng:

```ts
nativeTools: [{
  type: 'native', name: 'web-search', searchContentTypes: ['text', 'image'],
}]
```

Bỏ trống nghĩa là tìm văn bản. Codex chấp nhận trường Responses này; Anthropic
và Gemini báo `INVALID_REQUEST` khi yêu cầu ảnh.

Basic mode chấp nhận ảnh thực tế làm câu trả lời dù không có text, kể cả khi hết
budget phải ép final answer. Deep mode vẫn cần văn bản. Tool có status completed
nhưng không có ảnh không được tính là câu trả lời ảnh.

Lưu bytes ảnh cuối từ event tầng thấp `assistant-message`. Nếu ảnh base64 vượt
giới hạn history, loop lưu entry không có bytes ảnh và thêm số lượng vào trường
`omittedImages` không bắt buộc của assistant history event. Ảnh trực tiếp được
thay bằng ghi chú commentary. Snapshot giữ số lượng, không giữ ảnh bị bỏ. Entry
đã giảm mà vẫn quá lớn tiếp tục báo lỗi.

Request image generation mặc định giới hạn mỗi SSE event ở 12 × 1.048.576 ký tự.
`maxSseEventChars` do host cấu hình được ưu tiên; `maxResponseBytes` vẫn giới hạn
response tổng. Responses không còn nhân đôi ảnh trong `providerState.result`;
replay đọc `content`, với fallback cho state cũ.

## Retry và recovery từ 0.1.11

`RequestErrorContext` bắt buộc có `consecutiveFailures` và `retries`. Trường đầu
đếm request thất bại liên tiếp trong đợt lỗi và reset sau request thành công;
trường sau đếm retry đã được cấp trong cả turn. Cập nhật context tự tạo và test double.

`requestRetryHook` từ `@alvin0/ai-agent-sdk-core/agent` tạo hook
`onRequestError` với giới hạn theo đợt lỗi/cả turn, backoff, wait có thể abort và
deadline tùy chọn. Retry transport trước chunk đầu và retry request ở loop là
hai ranh giới riêng. Lỗi admission/checkpoint của loop không được retry.

`TurnHooks.onTerminalRecovery` và `createTerminalRecoveryMessage` cho phép host
đưa lại text/tool result đã commit khi không thể gọi model nữa. Recovery giữ
outcome không thành công và tuân thủ cancellation; không suy ra hoàn thành mục
tiêu chỉ từ message recovery hay promise resolve. Report reserve thích ứng với
chi phí request đã quan sát nên forced answer có thể bắt đầu sớm hơn. Finalize
window chỉ mở nếu còn budget cho một request nữa.

## Effort và model

Effort bỏ trống vẫn giữ bỏ trống; giá trị đặt tường minh được gửi cho provider,
không validate theo catalog effort cục bộ. `defineAgent()` tầng thấp vẫn giữ
model Codex mặc định cũ. Ví dụ và live call của project phải chọn tường minh
`gpt-6-luna` hoặc model mới hơn được chọn. SDK vẫn cho consumer cấu hình model.

## Đọc tiếp

- [Streaming](/vi/02-agents/streaming)
- [Native tools](/vi/03-tools/native-tools)
- [Kiểm thử và nghiệm thu](/vi/14-project/testing)
