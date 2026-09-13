# Gateway tương thích và credential trong database

Có từ SDK **0.1.2**.

## Cấu hình endpoint tương thích

Adapter/plugin generation của OpenAI, Anthropic và Gemini nhận `baseUrl`,
`models`, `fetch` và `headers`. Adapter/plugin embedding của OpenAI và Gemini
cũng nhận header tùy biến.

```ts
import { openAiEmbeddingPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const provider = openAiEmbeddingPlugin({
  id: 'gateway-embeddings',
  apiKey: 'gateway-key', // hoặc CredentialSource
  baseUrl: 'https://gateway.example/v1',
  headers: { 'x-tenant': 'tenant-a' },
  models: [{
    id: 'custom-embedding',
    compatibilityIdentity: 'gateway:custom-embedding',
  }],
})
```

Có thể truyền hàm đồng bộ: `headers: () => ({ 'x-tenant': tenantId })`.
Record tĩnh được sao chép khi tạo adapter. Hàm được gọi theo operation; mọi batch
trong một embedding call đã prepare dùng chung snapshot header.
Mỗi provider instance nên gắn với đúng tenant/account; tránh đổi biến tenant toàn
cục trong lúc nhiều request đang chạy đồng thời.

Tên header không phân biệt hoa/thường. Tên trùng hoặc xung đột quyền sở hữu sẽ
báo lỗi. Dùng `apiKey` cho credential, `organization`/`project` của OpenAI cho
account header, và `version`/`beta` của Anthropic cho protocol header.
Các header transport/SDK như `content-type`, `accept`, `user-agent` được giữ riêng.
Nếu cần cách xác thực khác, dùng [HTTP provider tùy biến](/vi/09-providers/custom-provider).

| Năng lực | Giao thức/path yêu cầu |
| --- | --- |
| OpenAI generation | Responses, `/responses` |
| Anthropic generation | Messages, `/v1/messages` |
| Gemini generation | Interactions, `/interactions` |
| OpenAI embedding | `/embeddings` |
| Gemini embedding | `models/{model}:batchEmbedContents` |

Tên model không chứng minh tính tương thích. Gateway chỉ có Chat Completions hoặc
Gemini `generateContent` không khớp các plugin generation trên. Khai báo năng lực
model trong `models` theo endpoint thực tế. Gateway HTTP local đáng tin cậy cần
bật tường minh `allowInsecureHttp: true`.

## Lưu credential Codex và Copilot trong database

Provider Universal nhận `authStore` do ứng dụng cung cấp. Chỉ wrapper Node mới
mặc định dùng file; wrapper cũng cho phép truyền store khác. `CodexAuthFile` và
`CopilotAuthFile` là tên kiểu dữ liệu JSON, không bắt buộc tạo file.

Dùng `defineCredentialStore<Value>` từ `@alvin0/ai-agent-sdk-core/provider`:

| Hook | Hợp đồng |
| --- | --- |
| `read(operation)` | Trả `{ value, revision }` hoặc `undefined`. |
| `commit(input, operation)` | Ghi `input.value` nguyên tử khi `input.expectedRevision` khớp; trả revision mới. `null` nghĩa là chỉ insert nếu chưa có. |

Mọi thao tác phải gắn với một tenant/account và provider. Báo xung đột bằng
`CODEX_CREDENTIAL_REVISION_CONFLICT` hoặc `COPILOT_CREDENTIAL_REVISION_CONFLICT`.
Cả hai luồng device login đều lưu credential qua các hook này.

Repo có [ví dụ SQLite đã được test](https://github.com/alvin0/ai-agent-sdk/tree/main/samples/credential-database).
Với database khác, dùng client tương ứng để hiện thực cùng hợp đồng.

## Lấy và refresh token

```ts
import { getCodexTokens, refreshCodexTokens } from '@alvin0/ai-agent-sdk-provider-codex'
import { getCopilotToken, createCopilotTokenCache } from '@alvin0/ai-agent-sdk-provider-copilot'

// codexStore và copilotStore là store của ứng dụng.
const current = await getCodexTokens(codexStore)
const storedOnly = await getCodexTokens(codexStore, { refreshIfNeeded: false })
const refreshed = await refreshCodexTokens(codexStore)

const tokenCache = createCopilotTokenCache()
const apiToken = await getCopilotToken(copilotStore, { tokenCache })
const renewed = await getCopilotToken(copilotStore, { tokenCache, forceRefresh: true })
```

Dùng chung cache với `copilotPlugin({ authStore: copilotStore, tokenCache })`.
Nếu không truyền cache, mỗi lần gọi `getCopilotToken` sẽ exchange lại. Cache được
tiêm vào sở hữu cấu hình exchange. `forceRefresh` vô hiệu hóa entry đang cache,
nhưng có thể dùng lại một exchange đang chạy.

Để cache API token trong database hoặc gọi auth service riêng, hiện thực
`CopilotTokenCache.acquire(source, operation, context?)` và `invalidate()`.
`acquire` trả `{ token, expiresAtMs }` và tự quản lý hạn dùng/exchange.
`invalidate` là đồng bộ: đánh dấu hết hiệu lực ở local rồi await thao tác database
trong lần `acquire` tiếp theo. SDK cũng export `exchangeCopilotToken` để gọi riêng.
Cache key phải bao gồm account và revision của credential nguồn.

Codex refresh sẽ xoay vòng và lưu refresh token. Copilot đổi GitHub token dài hạn
lấy API token ngắn hạn, không xoay vòng GitHub token. Cache ngắn hạn tách biệt với
`CopilotAuthFile`.

Các helper hỗ trợ hủy khi chờ hook database/cache. Hủy chỉ kết thúc phần chờ của
caller, không thể dừng tùy ý code của host. Client database/auth nên nhận và tuân
theo `operation.signal`.

Kiểm tra revision tránh ghi đè dữ liệu, nhưng không ngăn hai worker gửi cùng một
refresh token Codex tới OAuth. Cần điều phối toàn bộ read/refresh/commit theo account,
kể cả refresh do inference kích hoạt. Host quản lý mã hóa, quyền database và chọn
tenant; không đưa token vào log hay response chỉ dùng để xem trạng thái.
