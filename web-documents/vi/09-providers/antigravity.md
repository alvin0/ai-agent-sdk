# Antigravity

Runtime: **Universal**, nhận `AntigravityCredentialStore` do ứng dụng cung cấp.
Package Node tùy chọn phụ trách đăng nhập Google và lưu credential theo dự án.

## Cài đặt và đăng nhập

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-antigravity @alvin0/ai-agent-sdk-auth-node
export AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID='your-client-id'
# Chỉ đặt nếu OAuth client yêu cầu secret:
export AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET='your-client-secret'
pnpm exec ai-agent-sdk-antigravity-login
pnpm exec ai-agent-sdk-antigravity-login --models
```

CLI mở trình duyệt đăng nhập Google bằng OAuth authorization-code + S256 PKCE,
nhận callback tại `http://localhost:51121/oauth-callback`. Credential được lưu
riêng ở `.providers/.antigravity/auth.json`; thêm `.providers/` vào `.gitignore`
của ứng dụng. Provider tự làm mới access token trước khi hết hạn.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { antigravityNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/antigravity'

const runtime = await createAgentRuntime({ providers: [antigravityNodeProviderPlugin()] })
try {
  const catalog = await runtime.modelCatalog('antigravity')
  const model = catalog.models.find(model => model.id.startsWith('gemini-'))
  if (!model) throw new Error('No Gemini model available to this Antigravity account')
  const response = await runtime.agent({
    id: 'assistant', instructions: 'Be concise.',
    model: { provider: 'antigravity', id: model.id },
  }).generate('Hello')
  console.log(response.text)
} finally { await runtime.close() }
```

Chọn ID model chính xác từ `--models`. Ví dụ trên chọn một model Gemini có trong
tài khoản; provider không đặt model mặc định và không tự chuyển sang provider khác.

## Tài khoản và CLI

```bash
pnpm exec ai-agent-sdk-antigravity-login --status
pnpm exec ai-agent-sdk-antigravity-login --force
pnpm exec ai-agent-sdk-antigravity-login --account backup
pnpm exec ai-agent-sdk-antigravity-login --account backup --models
```

Dùng `antigravityNodeProviderPlugin({ account: 'backup' })` cho tài khoản có tên.
`--path FILE` hoặc `AI_AGENT_SDK_ANTIGRAVITY_AUTH` thay đường dẫn mặc định.
`--status` chỉ đọc file cục bộ; `--models` gọi danh sách model của tài khoản.
Khi dùng SSH, forward cổng localhost 51121 và thêm `--no-open` để tự mở URL.
Luồng này dùng trình duyệt, không dùng mã thiết bị như GitHub Copilot.

## Runtime khác

Truyền store có revision vào `antigravityPlugin({ authStore })` từ
`@alvin0/ai-agent-sdk-provider-antigravity`. Package Universal không đọc file hoặc
biến môi trường. `memoryAntigravityCredentialStore()` phục vụ kiểm thử; ứng dụng
chịu trách nhiệm lưu trữ credential khi triển khai.

`createAntigravityAuthorization()` và `completeAntigravityLogin()` cung cấp hai
bước OAuth không phụ thuộc Node. Giữ đối tượng authorization ở phía server vì nó
chứa PKCE verifier; chỉ dùng mỗi đối tượng một lần. Host phụ trách nhận callback.
Trước khi hiển thị URL, lấy revision bằng `readAntigravityCredentialRevision(store, signal)`.
Truyền giá trị này qua `expectedRevision` khi xử lý callback. Hàm đăng nhập trình duyệt trên Node tự thực hiện hai bước này.

## Phạm vi hỗ trợ

- Văn bản, reasoning, gọi hàm và kết quả hàm, giữ chữ ký cho lượt tiếp theo.
- Ảnh và PDF dạng base64 nội tuyến; từ chối URL và ID file đã tải lên.
- Chọn công cụ, đầu ra JSON Schema và giới hạn sinh nội dung.
- Danh sách model theo tài khoản, hủy request, giới hạn HTTP/SSE và thống kê token.

Chưa hỗ trợ công cụ chạy phía provider; model tạo ảnh trả trực tiếp các block ảnh. Các tham số sinh nội dung
còn phụ thuộc khả năng thực tế của từng model ở upstream.

Đây là tích hợp gói Antigravity **thử nghiệm, không chính thức**, tách biệt với
[Gemini API dùng API key](/vi/09-providers/gemini) và
[Antigravity Agent API của Google](https://aistudio.google.com/docs/antigravity-agent).
Tham chiếu giao thức từ [plugin OAuth cộng đồng](https://github.com/NoeFabris/opencode-antigravity-auth).
Google có thể đổi quyền truy cập, quota hoặc yêu cầu client. Có thể cấu hình
`baseUrl`, `userAgent`, `clientId`, `clientSecret`, giới hạn HTTP và `fetch`.

Cấu hình OAuth client được cung cấp từ bên ngoài; package không nhúng Client ID
hay Client Secret. Node đọc hai biến môi trường ở trên; tham số `clientId` và
`clientSecret` tường minh được ưu tiên. Host Universal truyền trực tiếp các tham số
này. Client cần được cấp quyền dùng dịch vụ và URL callback tương ứng.
File token hiện có vẫn giữ Client ID; refresh cần secret bên ngoài của đúng client
nếu client đó yêu cầu. Secret không được lưu vào file token. Đổi client cần đăng
nhập lại. Các lệnh phát triển của repository còn nạp file riêng tư
`.providers/.antigravity/client.env` nếu có; file này bị Git bỏ qua.

Kiểm thử offline xác nhận hành vi SDK; đăng nhập Google và gọi model bằng tài
khoản thật cần được xác minh riêng.

## Nhận ảnh được tạo

Chọn model ảnh như `gemini-3.1-flash-image` trong catalog tài khoản. Ảnh nằm ở
`response.message.content` với `type: 'image'`; `response.text` có thể rỗng nhưng
lượt sinh ảnh vẫn hoàn tất. Stream công khai phát `image-delta`; lịch sử session
giữ ảnh cuối cùng và chữ ký để dùng ở lượt tiếp theo.

```ts
const response = await runtime.agent({
  id: 'artist', instructions: 'Create the requested image.',
  model: { provider: 'antigravity', id: 'gemini-3.1-flash-image' },
  maxTokens: 4096,
}).generate('Draw a red circle on a white background.')

// Nhận cả ảnh trực tiếp của Antigravity và ảnh trong native tool của Codex.
const images = response.message?.content.flatMap(block =>
  block.type === 'image' ? [block]
    : block.type === 'native-tool-call' ? block.content.filter(item => item.type === 'image') : [],
) ?? []
for (const image of images) {
  if (image.source.kind !== 'base64') continue
  const dataUrl = `data:${image.source.mediaType};base64,${image.source.data}`
  // Hiển thị dataUrl hoặc giải mã base64 và lưu file theo MIME thực tế.
}
```

Giữ đúng `source.mediaType`: upstream có thể trả JPEG dù prompt yêu cầu PNG.
Antigravity chỉ cần chọn model ảnh. Codex dùng
`nativeTools: [{ type: 'native', name: 'image-generation' }]`, nhưng quyền gọi công
cụ còn phụ thuộc model và tài khoản ở upstream. SDK giữ kết quả ảnh nếu endpoint
trả về; khai báo công cụ không tự cấp thêm quyền truy cập.

Model ảnh dùng giới hạn SSE mặc định 12 MiB mỗi event, vẫn cho phép ghi đè bằng
`maxSseEventChars`. Khi cấu hình lưu lịch sử loại bỏ ảnh hoặc ảnh vượt giới hạn
entry, ứng dụng nên lưu byte ảnh từ kết quả công khai vào kho artifact riêng.
