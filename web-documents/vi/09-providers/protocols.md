# Protocol

Một package giao thức sở hữu **lược đồ wire, bộ tuần tự hoá yêu cầu, bộ dịch
luồng, và bản ghi phương ngữ**. Nó không sở hữu endpoint, thông tin xác thực,
hiện thực fetch, truy cập hệ tệp, hay API của Node.

Cả bốn package đều **Universal**, phụ thuộc runtime duy nhất là
`@alvin0/ai-agent-sdk-core`, slot ghép nối là `provider-author.protocol`, và vòng đời là
`inert-value` — chọn một cái trong `createRuntimeHttpProvider()` mà không có
nghĩa vụ khởi động hay dọn dẹp nào.

---

## `@alvin0/ai-agent-sdk-protocol-responses`

Giao thức wire OpenAI Responses / Codex. `openai` và `codex` dùng chung một hiện
thực này và chỉ khác nhau ở một bản ghi phương ngữ nhỏ.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-protocol-responses
```

```ts
export type {
  ProtocolDefinition, ProtocolRequest, ProtocolSseEvent, ProtocolStreamChunk,
}
export {
  OPENAI_RESPONSES_PROTOCOL_ID,
  openAiResponsesProtocol,
  type ResponsesProtocolDefinition,
}
export {
  serializeResponsesRequest,
  type ResponsesReasoningState,
}
export { translateResponsesStream }
export type * from './wire.ts'   // toàn bộ kiểu của lược đồ wire
```

```ts
import { openAiResponsesProtocol } from '@alvin0/ai-agent-sdk-protocol-responses'

createRuntimeHttpProvider({ protocol: openAiResponsesProtocol, baseUrl, auth })
```

Hỗ trợ web search native và sinh ảnh, ảnh đầu vào dạng
`{ kind: 'file', fileId }`, `detail: 'original'`, và field phương ngữ tuỳ chọn
`prompt_cache_key`.

---

## `@alvin0/ai-agent-sdk-protocol-openai-chat-completions`

Wire OpenAI Chat Completions cho endpoint tương thích không phơi ra Responses.
Phương ngữ của nó điều khiển riêng định dạng reasoning, field output token,
system role, structured output, tools, streaming usage, stop, seed và
`prompt_cache_key`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-protocol-openai-chat-completions
```

`provider-openai` chọn protocol này bằng `api: 'chat-completions'`; thông thường
caller không cần tự dựng nó.

---

## `@alvin0/ai-agent-sdk-protocol-gemini-interactions`

Giao thức wire Google Gemini Interactions. Nó tuần tự hoá lịch sử Step stateless
và dịch các sự kiện SSE `step.*` / `interaction.completed` hiện hành. Nó không
hiện thực `generateContent` hay Chat Completions.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-protocol-gemini-interactions
```

Giao thức giữ chữ ký thought qua các vòng function-call và ánh xạ JSON Schema
output sang `response_format` với `application/json`. Model được hỗ trợ thực hiện
implicit prefix caching; protocol này không có field cache key trong request và
ánh xạ `usage.total_cached_tokens` được báo về thành cache-read usage trung lập.

---

## `@alvin0/ai-agent-sdk-protocol-anthropic-messages`

Giao thức wire Anthropic Messages.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-protocol-anthropic-messages
```

```ts
export type {
  ProtocolDefinition, ProtocolRequest, ProtocolSseEvent, ProtocolStreamChunk,
}
export {
  ANTHROPIC_MESSAGES_PROTOCOL_ID,
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicMessagesProtocol,
  type AnthropicDialect,
  type AnthropicMessagesProtocolDefinition,
}
export {
  serializeAnthropicRequest,
  type AnthropicReasoningState,
  type AnthropicSerializeOptions,
  type ThinkingBudgets,
}
export { translateAnthropicStream }
export type * from './wire.ts'
```

Ánh xạ web search native và giữ trạng thái phát lại kết quả/trích dẫn đã mã hoá.
Báo phần sinh ảnh native và ảnh đầu vào theo file-id không hỗ trợ thành lỗi
`INVALID_REQUEST` có kiểu, thay vì âm thầm bỏ qua. Phương ngữ caching opt-in thêm
breakpoint `cache_control` vào prefix system, tool và history ổn định.

---

## Hợp đồng giao thức

```ts
interface ProtocolDefinition {
  // Dựng thân yêu cầu từ một prepared call trung lập.
  serialize(request: ProtocolRequest): JsonObject
  // Dịch sự kiện SSE của nhà cung cấp thành chunk trung lập.
  translate(event: ProtocolSseEvent): readonly ProtocolStreamChunk[]
  // Các đặc điểm phương ngữ riêng của endpoint.
  dialect: ProtocolDialect
}
```

Hai ràng buộc mà một hiện thực giao thức phải tuân thủ:

**Tuần tự hoá là đồng bộ và chỉ dùng đối tượng JSON**, có kiểm tra và tách rời
trước khi gửi với chặn trên, và **một thân yêu cầu đã mã hoá được dùng lại qua
các lần thử lại** — một lần thử lại không được tuần tự hoá lại một đối tượng đã
bị sửa.

**Phân tích SSE là cục bộ theo provider và ghim chính xác**, có kiểm tra
media-type, chặn trên theo byte/chunk/sự kiện, nhịp sống bằng comment-heartbeat,
rút cạn tuyến tính, và **bắt buộc** đúng một sự kiện kết thúc. Một luồng kết thúc
mà thiếu dấu hiệu kết thúc sẽ sinh `STREAM_CLOSED`, chứ không phải một message bị
cắt cụt âm thầm.

## Đọc tiếp

- [Custom Provider](/vi/09-providers/custom-provider)
- [Đường ống adapter](/vi/11-internals/adapter-pipeline)
