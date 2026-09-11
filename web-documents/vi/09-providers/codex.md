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
  models: [{ id: 'gpt-5.6-luna', inputModalities: ['text', 'image', 'document'] }],
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
