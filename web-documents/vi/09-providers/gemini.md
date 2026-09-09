# Gemini

Runtime: **Universal** — Edge/Worker, trình duyệt, Deno, Bun, và Node.
Slot ghép nối: `runtime.providers`.
Vòng đời: `inert-runtime-owned-registration`.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/provider-gemini
```

**Chỉ** nhắm tới endpoint Gemini **Interactions** của Google tại
`/v1beta/interactions`, thông qua
[`@ai-agent-sdk/protocol-gemini-interactions`](/vi/09-providers/protocols).

> Nó **không** dùng `generateContent`, và **không** dùng endpoint Chat
> Completions tương thích OpenAI. Đó là những giao thức wire khác.

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
  model: { provider: 'gemini', id: 'gemini-3-pro' },
})
```

Trên Node, đọc khoá từ môi trường qua package auth của Node:

```ts
import { envCredential } from '@ai-agent-sdk/auth-node'

geminiPlugin({ apiKey: envCredential('GEMINI_API_KEY') })
```

Thông tin xác thực luôn được **tiêm vào**. Package này không bao giờ đọc `.env`,
biến môi trường, hay tệp — việc đó thuộc về một lớp bọc Node.

Khoá được gửi trong header `x-goog-api-key`, không phải tham số query.

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
// Re-export cho tiện:
export { geminiInteractionsProtocol, type GeminiInteractionsDialect }
```

| Export | Dùng để |
| --- | --- |
| `geminiPlugin(options)` | **Khuyến nghị.** Đăng ký có giao dịch cho `createAgentRuntime()`. |
| `geminiAdapter(options)` | Tự đăng ký tuyến trên một `ModelRegistry`. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` |

```ts
import { ModelRegistry } from '@ai-agent-sdk/core'
import { geminiAdapter } from '@ai-agent-sdk/provider-gemini'

const registry = new ModelRegistry()
registry.registerAdapter(['gemini'], geminiAdapter({ apiKey }))
```

## Tuỳ chọn

```ts
interface GeminiAdapterOptions {
  apiKey: GeminiCredential          // bắt buộc; tiêm vào
  baseUrl?: string                  // mặc định GEMINI_BASE_URL
  models?: readonly ProviderCatalogModel[]
  store?: boolean                   // Google có được giữ lại interaction? mặc định false
  defaultMaxTokens?: number         // 8.192
  defaultContextWindow?: number     // 1.000.000
  streamIdleTimeoutMs?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxResponseChunks?: number
  maxSseEvents?: number
  maxSseEventChars?: number
  maxErrorBodyBytes?: number
  requestLoggerTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
  requestLogger?: ProviderRequestLogger
  fetch?: typeof globalThis.fetch
}
```

`GeminiProviderOptions` thêm `id`, `routes`, và `defaultModel` cho việc ghép nối
ở tầng runtime:

```ts
geminiPlugin({
  id: 'gemini-eu',
  routes: ['gemini-eu'],
  defaultModel: 'gemini-3-pro',
  apiKey: euKey,
})
```

### `store` — việc giữ dữ liệu phải bật tường minh

```ts
geminiPlugin({ apiKey, store: true })   // mặc định là false
```

`store: false` là mặc định, nên Google được yêu cầu **không** giữ lại yêu cầu và
interaction trừ khi bạn bật. Nó ánh xạ vào phương ngữ của giao thức, không phải
một cờ theo từng yêu cầu.

### Không có model id dựng sẵn

`models` là danh mục **tham khảo**, và không có model id nào được biên dịch cứng
vào package — nên danh sách không thể trở nên lỗi thời khi Google thay đổi dòng
sản phẩm.

```ts
const catalog = await runtime.modelCatalog('gemini')
```

`model.id` là bắt buộc trừ khi tuyến đã có `defaultModel`.

## Năng lực

| Năng lực | Hỗ trợ | Khi không khớp |
| --- | --- | --- |
| Structured output (`outputFormat`) | ✓ `text` và `json_schema` | — |
| Mức nỗ lực suy luận | ✓ ánh xạ sang `thinking_level` | — |
| Tóm tắt suy nghĩ | ✓ `thinkingSummaries: 'auto' \| 'none'` | — |
| Web search native | ✓ ánh xạ sang `google_search` | — |
| Bộ lọc web-search (`allowedDomains`, `blockedDomains`, `searchContextSize`, `userLocation`, `maxUses`) | ✗ | `INVALID_REQUEST` có kiểu |
| Sinh ảnh native | ✗ không phơi ra dưới dạng native tool của SDK | `INVALID_REQUEST` có kiểu |
| Ảnh đầu vào — base64, URL, file id | ✓ | — |
| `toolChoice`, kể cả buộc dùng web search | ✓ | — |

### Web search là được-tất-hoặc-không

```ts
runtime.agent({
  /* … */
  nativeTools: [{ type: 'native', name: 'web-search' }],   // ✓
})

runtime.agent({
  /* … */
  nativeTools: [{ type: 'native', name: 'web-search', allowedDomains: ['example.com'] }],
})
// ✗ INVALID_REQUEST: "Gemini Interactions web search does not support SDK search
//    filters or limits"
```

Endpoint Interactions phơi ra `google_search` mà không có bộ từ vựng bộ lọc của
SDK. Thay vì âm thầm bỏ qua bộ lọc của bạn — điều sẽ mở rộng phạm vi tìm kiếm mà
bạn tưởng đã thu hẹp — adapter thất bại bằng một lỗi có kiểu.

Đó cũng là quy tắc trung thực mà Anthropic áp dụng cho việc sinh ảnh native.

### Suy luận

```ts
runtime.agent({
  id: 'analyst',
  model: { provider: 'gemini', id: 'gemini-3-pro' },
  instructions: '…',
  effort: 'medium',        // → thinking_level
})
```

Tóm tắt suy nghĩ được yêu cầu khi có chọn mức suy luận, điều khiển bởi
`thinkingSummaries` trong phương ngữ (mặc định `'auto'`, đặt `'none'` để tắt).
Tóm tắt đến dưới dạng sự kiện `reasoning` thông thường — không bao giờ trộn vào
văn bản công khai.

## Structured output

Gemini Interactions hỗ trợ thẳng hợp đồng `outputFormat` trung lập:

```ts
const agent = runtime.agent({
  id: 'extractor',
  model: { provider: 'gemini', id: 'gemini-3-pro' },
  instructions: 'Extract the invoice fields.',
  outputFormat: {
    type: 'json_schema',
    name: 'invoice',
    schema: {
      type: 'object',
      properties: { id: { type: 'string' }, total: { type: 'number' } },
      required: ['id', 'total'],
    },
  },
})
```

Xem [Structured Output](/vi/02-agents/structured-output) để biết vòng lặp hành xử
thế nào khi kết hợp tool với một JSON schema.

## Nhiều tài khoản

```ts
const runtime = await createAgentRuntime({
  providers: [
    geminiPlugin({ id: 'gemini-eu', apiKey: euKey }),
    geminiPlugin({ id: 'gemini-us', apiKey: usKey }),
  ],
})
```

ID và tuyến thực thể tường minh giữ cho hai tài khoản cùng họ provider không nhập
nhằng. Xung đột tuyến thất bại **trước khi hoàn tất thiết lập** với
`DUPLICATE_ADAPTER`.

## Chuyển được giữa các nhà cung cấp

Mọi thứ phía trên adapter nói bằng từ vựng trung lập, nên một định nghĩa chạy
được trên cả bốn provider có sẵn:

```ts
const definition = { id: 'reviewer', instructions: '…', tools: [readFile] }

runtime.agent({ ...definition, model: { provider: 'gemini', id: 'gemini-3-pro' } })
runtime.agent({ ...definition, model: { provider: 'openai', id: 'gpt-5.4' } })
runtime.agent({ ...definition, model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } })
```

Thứ khác nhau đúng là bảng năng lực phía trên — và những khác biệt đó hiện ra
thành lỗi có kiểu, không thành hành vi trôi lệch.

## Đọc tiếp

- [OpenAI](/vi/09-providers/openai) · [Anthropic](/vi/09-providers/anthropic) · [Codex](/vi/09-providers/codex)
- [Protocols](/vi/09-providers/protocols)
- [Structured Output](/vi/02-agents/structured-output)
