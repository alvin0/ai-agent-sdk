# Gemini

Runtime: **Universal** — Edge/Worker, trình duyệt, Deno, Bun, và Node.
Slot ghép nối: `runtime.providers`.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-gemini
```

Provider này **chỉ** nhắm tới Gemini Interactions API của Google:

```text
POST https://generativelanguage.googleapis.com/v1beta/interactions
```

Nó không gọi `generateContent` và không dùng endpoint Chat Completions tương
thích OpenAI của Gemini.

## Ghép nối

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { geminiPlugin } from '@ai-agent-sdk/provider-gemini'

const runtime = await createAgentRuntime({
  providers: [geminiPlugin({ apiKey: () => secretStore.get('gemini') })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'gemini', id: 'gemini-3-flash-preview' },
})
```

Provider Universal không bao giờ tự đọc `.env`, tệp, hay `process.env`. Trên
Node, đọc biến môi trường chỉ là tiện ích tuỳ chọn do host cung cấp:

```ts
import { envCredential } from '@ai-agent-sdk/auth-node'

geminiPlugin({ apiKey: envCredential('GEMINI_KEY') })
```

Bạn có thể tiêm Worker secret, vault lookup, hoặc resolver async luân chuyển.

## Structured output và tool loop

`outputFormat: { type: 'json_schema' }` được ánh xạ sang `response_format` của
Interactions với `mime_type: 'application/json'`. Các vòng xử lý bình thường
vẫn dùng dạng native của provider; vòng cuối riêng biệt của SDK áp schema sau
khi tools đã bị tắt.

Adapter mặc định dùng lịch sử stateless (`store: false`). Nó phát lại các step
`user_input`, `model_output`, chữ ký `thought`, `function_call`, và
`function_result`, nên tool loop ngắn hoặc dài dùng cùng hợp đồng agent như các
provider khác.

## Phạm vi hỗ trợ

| Năng lực | Hỗ trợ |
| --- | --- |
| Streaming text | ✓ |
| Host function call và result | ✓ |
| Phát lại nhiều lượt stateless | ✓, gồm chữ ký thought |
| JSON Schema output | ✓ |
| Ảnh đầu vào | ✓, URL/URI và base64 |
| Google Search native không kèm bộ lọc | ✓ |
| Bộ lọc domain/vị trí/kích thước tìm kiếm của SDK | ✗ lỗi `INVALID_REQUEST` có kiểu |
| Tool sinh ảnh native | ✗ lỗi `INVALID_REQUEST` có kiểu |

Không có model ID dựng sẵn. Hãy truyền `model.id` tường minh và có thể cung cấp
metadata `models` nếu cần khai báo chính xác ngữ cảnh, output, reasoning, hay
modality.

## Test thực tế trong repository

Human test của repository có thể đọc `.env` chỉ để tiện kiểm thử cục bộ:

```dotenv
GEMINI_KEY=...
GEMINI_MODEL=...
```

```bash
pnpm human:structured-output -- --provider gemini --scenario short
pnpm human:structured-output -- --provider gemini --scenario long
```

Quy ước `.env` này thuộc test harness, không thuộc API của provider.

## Export

```ts
export {
  GEMINI_BASE_URL,
  geminiAdapter,
  geminiPlugin,
  type GeminiAdapterOptions,
  type GeminiCredential,
  type GeminiPluginOptions,
  type GeminiProviderOptions,
}
export { geminiInteractionsProtocol, type GeminiInteractionsDialect }
```

## Tài liệu chính thức

- [Bắt đầu với Gemini API](https://ai.google.dev/gemini-api/docs/get-started)
- [Tham chiếu Interactions API](https://ai.google.dev/api/interactions-api)
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
