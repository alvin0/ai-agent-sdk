# OpenAI

Để khai báo context window và ngân sách output theo model, xem phần
[cấu hình giới hạn model](/vi/09-providers/).

Runtime: **Universal** — Edge/Worker, trình duyệt, Deno, Bun, và Node.
Slot ghép nối: `runtime.providers`.
Vòng đời: `inert-runtime-owned-registration`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai
```

Nhắm tới cả hai wire generation của OpenAI: **Responses** (mặc định) và **Chat
Completions**. Một route có thể chọn wire mặc định bằng `api`, hoặc định tuyến
từng model trong catalog bằng `models[].api`.

## Ghép nối

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const apiKey = defineCredentialSource({
  id: 'openai',
  resolve: () => secretStore.get('openai'),
})

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'gpt-5.4' },
})
```

Trên Node, đọc khoá từ môi trường qua package auth của Node:

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'

openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })
```

Package provider là Universal và **không bao giờ tự đọc biến môi trường hay
tệp** — việc tra cứu môi trường thuộc về một lớp bọc Node.

## Export

```ts
export {
  OPENAI_BASE_URL,
  openAiAdapter,
  openAiPlugin,
  type OpenAiAdapterOptions,
  type OpenAiApi,
  type OpenAiCatalogModel,
  type OpenAiChatCompletionsCompat,
  type OpenAiCredential,
  type OpenAiPluginOptions,
  type OpenAiProviderOptions,
}
// Re-export cho tiện:
export {
  openAiResponsesProtocol,
  openAiChatCompletionsProtocol,
  type ResponsesDialect,
  type ChatCompletionsDialect,
}
```

| Export | Dùng để |
| --- | --- |
| `openAiPlugin(options)` | **Khuyến nghị.** Một đăng ký có giao dịch cho `createAgentRuntime()`. |
| `openAiAdapter(options)` | Tự đăng ký tuyến trên một `ModelRegistry`. |
| `OPENAI_BASE_URL` | Endpoint mặc định, khi bạn cần tham chiếu hoặc ghi đè. |

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const registry = new ModelRegistry()
registry.registerAdapter(['openai'], openAiAdapter({ apiKey }))
```

## Năng lực

| Năng lực | Hỗ trợ |
| --- | --- |
| Web search native | ✓ |
| Sinh ảnh native | ✓ |
| Ảnh đầu vào qua URL / base64 | ✓ |
| Ảnh đầu vào qua `fileId` | ✓ |
| Tài liệu (PDF) qua URL / base64 / `fileId` | ✓ |
| `detail: 'original'` | ✓ |
| Mức nỗ lực suy luận | ✓ — đối chiếu với các mức model khai báo |
| Trạng thái phát lại | ✓ |

```ts
runtime.agent({
  id: 'researcher',
  model: { provider: 'openai', id: 'gpt-5.6' },
  instructions: 'Gather evidence before answering.',
  effort: 'medium',
  nativeTools: [
    { type: 'native', name: 'web-search', allowedDomains: ['openai.com'] },
    { type: 'native', name: 'image-generation', format: 'webp', partialImages: 2 },
  ],
})
```

Xem [Native Tools](/vi/03-tools/native-tools) cho bề mặt sự kiện.

## Khám phá model

```ts
const catalog = await runtime.modelCatalog('openai')
```

`model.id` là **bắt buộc** trừ khi tuyến đã có giá trị mặc định được cấu hình.
Không có model mặc định dựng sẵn: danh mục model của nhà cung cấp thay đổi nhanh
hơn nhịp phát hành của package này, nên bất kỳ mặc định dựng sẵn nào rồi cũng trỏ
vào một model đã ngừng phục vụ.

## Thử lại

```ts
import { withRetry } from '@alvin0/ai-agent-sdk-core'

registry.registerAdapter(['openai'], withRetry(openAiAdapter({ apiKey }), {
  policy: { mode: 'normal', maxRetries: 3 },
  onRetry: attempt => console.warn(`retry ${attempt.attempt}: ${attempt.failure.code}`),
}))
```

Thử lại chỉ bao phủ những thất bại **trước khi chunk đầu tiên tới tay bên tiêu
thụ** — phát lại token đã giao sẽ nhân đôi output. `AUTH`, `INVALID_REQUEST`,
`QUOTA`, và `CONTEXT_WINDOW_EXCEEDED` bị loại trừ mặc định vì chúng thất bại y hệt
ở mọi lần thử.

## Nhiều tài khoản

```ts
const runtime = await createAgentRuntime({
  providers: [
    openAiPlugin({ id: 'openai-eu', apiKey: euKey }),
    openAiPlugin({ id: 'openai-us', apiKey: usKey }),
  ],
})

runtime.agent({ id: 'eu-agent', model: { provider: 'openai-eu', id: 'gpt-5.4' }, instructions: '…' })
```

ID và tuyến thực thể tường minh làm cho hai tài khoản trong cùng một họ provider
trở nên không nhập nhằng. Kết quả khám phá báo một dòng cho mỗi tuyến, với danh
tính tuyến, danh tính thực thể plugin, và danh tính họ provider tách bạch.

Xung đột tuyến thất bại **trước khi hoàn tất thiết lập** với `DUPLICATE_ADAPTER`,
không phải tới lúc dùng lần đầu.

## Prompt caching cho session dài

Caching là opt-in. Để SDK sinh một key ổn định cho instance adapter/plugin này:

```ts
openAiPlugin({
  apiKey,
  promptCaching: true,
})
```

Hoặc truyền key do ứng dụng sở hữu khi provider instance phục vụ một session đã
biết:

```ts
openAiPlugin({
  apiKey,
  promptCacheKey: `conversation:${conversationId}`,
})
```

Key đã resolve được serialize thành `prompt_cache_key` trên cả Responses và Chat
Completions. Route hỗn hợp dùng chung một key cho cả hai wire. Hãy giới hạn một
provider instance dùng auto-key cho đúng một cache identity; dùng chung instance
đó giữa các tenant hoặc hội thoại không liên quan sẽ gom traffic vào cùng key.

Nếu gateway tương thích trả HTTP 400 và nêu rõ `prompt_cache_key`, adapter thử
lại call đó một lần không có field rồi ghi nhớ việc hạ cấp trong suốt vòng đời.
Cơ chế này không nuốt các lỗi không liên quan.

Xem [Prompt caching](/vi/09-providers/prompt-caching) để biết khác biệt giữa các
provider, vòng đời session, độ ổn định prefix và accounting usage.

## Một endpoint tương thích OpenAI

Chọn đúng wire mà endpoint thực sự hiện thực. Phần lớn gateway tương thích
OpenAI hiện thực Chat Completions:

```ts
openAiPlugin({
  id: 'openrouter',
  displayName: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  api: 'chat-completions',
  apiKey: envCredential('OPENROUTER_API_KEY'),
  compat: { reasoningFormat: 'openai' },
})
```

Đặt `api: 'responses'` cho endpoint tương thích Responses. `compat` điều khiển
các field riêng của Chat Completions như định dạng reasoning, field giới hạn
token, system role, tools, streaming usage, stop và seed. `path`, `query`, `body`
và `transformRequest` bao phủ cách định tuyến và payload riêng của gateway.

## Đọc tiếp

- [Anthropic](/vi/09-providers/anthropic) · [Codex](/vi/09-providers/codex)
- [Protocols](/vi/09-providers/protocols)
- [Prompt caching](/vi/09-providers/prompt-caching)
- [Custom Provider](/vi/09-providers/custom-provider)
