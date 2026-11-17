# Codex

Endpoint Codex chạy nền ChatGPT. Runtime: **Universal**, với một
`CodexAuthStore` được **tiêm vào**; một package Node cấp bản dựa trên hệ tệp.

```bash
# Universal — bạn tự tiêm kho vào
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex

# Node — kèm kho OAuth cục bộ theo dự án
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex @alvin0/ai-agent-sdk-auth-node
```

`openai` và `codex` dùng chung **một** hiện thực Responses và chỉ khác nhau ở một
bản ghi phương ngữ nhỏ: base URL, cách xác thực, và endpoint chấp nhận những
trường tuỳ chọn nào.

## Trên Node — đăng nhập cục bộ theo dự án

```bash
pnpm exec ai-agent-sdk-codex-login             # đăng nhập
pnpm exec ai-agent-sdk-codex-login --status    # chi tiết tài khoản/trạng thái cục bộ
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'

const runtime = await createAgentRuntime({ providers: [codexNodeProviderPlugin()] })

const agent = runtime.agent({
  id: 'coding-cli',
  instructions: 'Work in the current project.',
  model: { provider: 'codex' },     // danh mục khám phá từ tài khoản
})
```

`codexNodeProviderPlugin()` mặc định dùng `fileCodexCredentialStore()` có
revision. Kho này **được mượn và vẫn thuộc sở hữu của caller** — runtime đóng
phần đăng ký provider, không đóng kho.

### Việc cô lập token là có chủ ý

Token nằm ở `.providers/.codex/auth.json` bên dưới `process.cwd()`, **không** nằm
ở `~/.codex/auth.json` của Codex CLI.

Refresh token OAuth **chỉ dùng một lần và xoay vòng sau mỗi lần làm mới**, nên hai
chương trình dùng chung một tệp xác thực rồi sẽ tranh chấp — chương trình làm mới
thứ hai phát lại một token đã tiêu và bạn bị đăng xuất âm thầm khỏi Codex CLI
thật. Việc cô lập ngăn điều đó.

Việc ghi dùng compare-and-swap dưới một **khoá ghi liên tiến trình**, một tệp tạm
riêng tư cùng thư mục, đồng bộ tệp, đổi tên nguyên tử, chế độ `0600`, và đồng bộ
thư mục. **Symlink tới tệp thông tin xác thực bị từ chối.**

## Ở mọi nơi khác — tiêm một kho vào

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { codexPlugin } from '@alvin0/ai-agent-sdk-provider-codex'

const registry = new ModelRegistry()
registry.install(codexPlugin({ authStore: mySecretManagerStore }))
```

Hợp đồng `CodexAuthStore` là Universal — trình duyệt, Worker, secret manager, hay
một package Node sở hữu phần lưu trữ. Cho test và các host phù du:

```ts
import { memoryCodexCredentialStore } from '@alvin0/ai-agent-sdk-provider-codex'

codexPlugin({ authStore: memoryCodexCredentialStore(tokens) })
```

## Tạo ảnh qua endpoint riêng (thử nghiệm)

Tạo ảnh dùng transport riêng, tách khỏi Codex Responses. Hàm
`generateCodexNodeImage()` gọi một lần tới `<baseUrl>/images/generations`, dùng
lại kho OAuth của dự án và cơ chế làm mới token có revision.
`account` chọn cùng tài khoản đã đăng nhập như
`codexNodeProviderPlugin({ account })`; nếu truyền `authStore`, kho đó được ưu tiên.

```ts
import { generateCodexNodeImage } from '@alvin0/ai-agent-sdk-auth-node/codex'

// Truyền model ảnh được kết nối này cho phép dùng, cấu hình riêng với model text.
async function draw(prompt: string, imageModel: string) {
  const { images } = await generateCodexNodeImage({ model: imageModel, prompt })
  return images // ImageBlock[] chứa base64 và mediaType nhận diện từ dữ liệu
}
```

Để agent có thể yêu cầu tạo ảnh, đăng ký host tool một cách tường minh:

```ts
import { codexNodeImageTool } from '@alvin0/ai-agent-sdk-auth-node/codex'

function imageAgent(imageModel: string) {
  return runtime.agent({
    id: 'image-assistant',
    instructions: 'Dùng codex_generate_image khi người dùng yêu cầu tạo ảnh mới.',
    model: { provider: 'codex', id: 'gpt-6-luna' },
    tools: [codexNodeImageTool({ model: imageModel })],
  })
}
```

Model chỉ điều khiển tham số `prompt` của tool. Thông tin xác thực, endpoint,
model ảnh và thiết lập đầu ra do ứng dụng cấu hình. Ảnh xuất hiện ở sự kiện
`tool-result` (`event.output.content`) và lịch sử kết quả tool; tin nhắn assistant
cuối cùng có thể chỉ chứa text. Ứng dụng lấy các image block ở đó để hiển thị hoặc
lưu. Đường này không bật native tool `image-generation` của Responses và không
thêm model ảnh vào danh mục chat.

**Kết nối được Codex không đảm bảo endpoint này chấp nhận yêu cầu tạo ảnh.**
Thử trực tiếp OAuth của dự án ngày 2026-11-17 vẫn nhận HTTP 403 khi dùng model ảnh
chuyên dụng. Các test offline đã kiểm tra việc trả ảnh qua transport và vòng lặp
agent; chưa xác minh được một lần tạo ảnh thật thành công qua kết nối này.
Kết quả đó không xác định giới hạn tạo ảnh của ứng dụng Codex, vì xác thực runtime
của ứng dụng có thể khác.

`CodexImageError.code` phân biệt `CODEX_IMAGE_FORBIDDEN` (403),
`CODEX_IMAGE_UNAUTHORIZED` (401), `CODEX_IMAGE_HTTP`, `CODEX_IMAGE_REDIRECT`,
`CODEX_IMAGE_TIMEOUT`, `CODEX_IMAGE_NETWORK`, `CODEX_IMAGE_TOO_LARGE` và
`CODEX_IMAGE_MALFORMED`. Lỗi thiếu thông tin xác thực và lỗi làm mới token giữ
nguyên loại; hủy yêu cầu giữ nguyên lý do từ caller. Không tự retry, đổi model hay
chuyển sang tính phí bằng API key. Mặc định deadline 180 giây và giới hạn JSON
response 32 MiB; có thể cấu hình `timeoutMs`, `maxBytes`, `quality`, `size`,
`background`. Chỉ đặt `baseUrl` tới endpoint HTTPS đáng tin vì endpoint sẽ nhận
thông tin xác thực của tài khoản đã chọn.

Host tool mặc định giới hạn JSON response **2.000.000 byte** để giá trị JSON và
ảnh đã render cùng nằm trong giới hạn kết quả tool 4 MiB của core. Muốn nhận ảnh
lớn hơn, cần cấu hình đồng thời `maxBytes`, `maxToolResultBytes` và giới hạn entry
lịch sử, hoặc dùng hàm gọi trực tiếp rồi lưu ảnh vào kho artifact của ứng dụng.

Host Universal dùng `generateCodexImage({ authStore, model, prompt })` hoặc
`codexImageTool({ authStore, model })` từ
`@alvin0/ai-agent-sdk-provider-codex`. Route này dựa trên
[Images client của Codex](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs)
và
[backend extension tạo ảnh](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/backend.rs).

## Export

```ts
// Adapter + plugin
export {
  CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR,
  codexAdapter, codexPlugin,
  type CodexAdapterOptions, type CodexPluginOptions,
  type CodexProviderOptions, type CodexRevisionedAdapterOptions,
}

// Hợp đồng auth và kho trong bộ nhớ
export {
  ACCESS_TOKEN_REFRESH_WINDOW_MS, LAST_REFRESH_MAX_AGE_MS,
  isFedrampAccount, memoryCodexAuthStore, memoryCodexCredentialStore,
  readJwtClaims, requireTokens, resolveAccountId, shouldRefresh,
  type CodexAuthFile, type CodexAuthStore, type CodexCredentialStore,
  type CodexJwtClaims, type CodexTokens,
}

// Luồng OAuth device-code
export {
  CODEX_CLIENT_ID, CodexRefreshError, DEFAULT_CODEX_ISSUER,
  refreshCodexTokens, requestDeviceCode, runDeviceCodeLogin,
  type CodexDeviceCode, type CodexLoginProgress, type CodexLoginResult,
  type CodexOAuthOptions, type RefreshFailureKind,
}
```

`shouldRefresh()`, `ACCESS_TOKEN_REFRESH_WINDOW_MS`, và
`LAST_REFRESH_MAX_AGE_MS` là những thứ một kho tuỳ biến dùng để quyết định khi nào
làm mới, thay vì đoán chỉ dựa vào thời điểm hết hạn.

## Danh mục đến từ tài khoản

```ts
const models = await runtime.modelCatalog('codex')
```

Codex **khám phá danh mục từ chính endpoint**, vì model khả dụng phụ thuộc gói
dịch vụ của tài khoản. Đó là lý do `model: { provider: 'codex' }` không kèm `id`
lại có ý nghĩa ở đây, theo cách mà nó không có với một danh mục tĩnh.

### Discovery báo thiếu khả năng đọc tài liệu

Discovery chỉ báo `input_modalities` gồm `text` và `image`, kể cả với model thật
sự nhận được PDF. Vì một modality bị bỏ trống được hiểu là khai báo phủ định, tài
liệu đầu vào sẽ bị chiếu thành text trừ khi bạn tự override entry đó:

```ts
codexNodeAdapter({
  authStore,
  models: [{ id: 'gpt-6-luna', inputModalities: ['text', 'image', 'document'] }],
})
```

Một entry `models` tường minh sẽ thay thế discovery cho id đó. Xem
[TÃ i liá»u Äáº§u vÃ o](/vi/03-tools/native-tools#tai-lieu-pdf-đau-vao).

## Hai điều cần biết trước khi dùng

> **Endpoint này phục vụ Codex CLI.** Nó nhận diện client bằng header
> `originator`, và adapter mặc định dùng `CODEX_ORIGINATOR` — giá trị của CLI —
> để yêu cầu được chấp nhận.
>
> Hãy dùng **tài khoản của chính bạn**, và ưu tiên
> [`openai`](/vi/09-providers/openai) cho production.

## Đây chính là ca `auth: dynamic` dựng sẵn

Codex cần một thông tin xác thực OAuth tự làm mới, và nó **không cần kế thừa lớp
adapter** nào: nó chỉ là cấu hình đặt trên giao thức Responses với
`auth: { kind: 'dynamic' }`.

Nếu provider của bạn cũng làm mới thông tin xác thực, bạn cũng không cần kế thừa
lớp — xem [Custom Provider](/vi/09-providers/custom-provider).

## Quan sát thông tin xác thực bị che

Việc quan sát thông tin xác thực và danh mục **loại trừ** token OAuth, thông tin
tài khoản, vị trí kho, và lỗi xác thực thô. `sdk.credential.operation` ghi
**phân loại** làm mới/đăng nhập và không bao giờ ghi giá trị thông tin xác thực.

`CodexRefreshError` mang một `RefreshFailureKind` có kiểu, nên bạn phân biệt được
"cần đăng nhập lại" với "lỗi mạng thoáng qua" mà không phải phân tích chuỗi thông
điệp.

## Đọc tiếp

- [auth-node](/vi/09-providers/auth-node) — chi tiết về kho thông tin xác thực
- [OpenAI](/vi/09-providers/openai) — cùng giao thức, danh mục tĩnh
- [Agent lập trình trên Node](/vi/10-advanced/deploy-node-cli) — Codex trong một CLI đầy đủ
