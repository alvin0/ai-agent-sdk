# `@alvin0/ai-agent-sdk-auth-node`

Runtime: **Node 22.12+**. Điểm vào: `.`, `./env`, `./codex`.
Ghép nối: `provider-factory.credentials`. Vòng đời: `borrowed-caller-owned` —
thông tin xác thực được provider đã chọn giải quyết một cách lười, và **core
không bao giờ đóng chúng**.

Thông tin xác thực từ môi trường do Node sở hữu, cùng kho OAuth Codex cục bộ theo
dự án. Root của package và điểm vào `/env` là **chỉ-môi-trường**: cài một trong
hai không đòi hỏi và không nạp bất kỳ model provider nào.

---

## Root và `/env` — thông tin xác thực từ môi trường

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai @alvin0/ai-agent-sdk-auth-node
```

```ts
export function envCredential(envVar: string): CredentialSource & (() => string)
export const apiKeyFromEnv = envCredential   // bí danh
```

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})
```

`envCredential()` là **lười**, nhận tín hiệu huỷ của thao tác model, và vẫn gọi
được như một hàm thường để tương thích. Nó được provider mượn và không có vòng
đời đóng.

`@alvin0/ai-agent-sdk-auth-node/env` là tuyến tương thích được giữ lại: một khung nhìn
giữ nguyên danh tính lên root chỉ-môi-trường, và **không** kéo theo tập phụ thuộc
Codex tuỳ chọn.

---

## `/codex` — xác thực Codex cục bộ theo dự án

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-codex @alvin0/ai-agent-sdk-auth-node
```

```ts
export function codexNodeProviderPlugin(
  options?: CodexNodeProviderOptions,
): ComposableModelProviderPlugin

export function codexNodeAdapter(options?: CodexNodeAdapterOptions): ModelAdapter
export function codexNodePlugin(options?: CodexNodePluginOptions): ModelProviderPlugin

// Bí danh giữ lại để công thức trên Node đọc tự nhiên
export const codexAdapter = codexNodeAdapter
export const codexPlugin = codexNodePlugin
export type CodexAdapterOptions = CodexNodeAdapterOptions
export type CodexPluginOptions = CodexNodePluginOptions

export { CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR }
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'

const runtime = await createAgentRuntime({
  providers: [codexNodeProviderPlugin()],
})
```

### Kho thông tin xác thực

```ts
fileCodexCredentialStore(options?)   // có revision — dùng cái này
fileCodexAuthStore(options?)         // hợp đồng read/write cũ, đã deprecate
```

`codexNodeProviderPlugin()` mặc định dùng `fileCodexCredentialStore()` có
revision. Kho này **được mượn và vẫn thuộc sở hữu của caller** — runtime đóng
phần đăng ký provider, không đóng kho.

### Token nằm ở đâu, và vì sao

Codex mặc định dùng `.providers/.codex/auth.json` bên dưới `process.cwd()` và
**không bao giờ** dùng tệp thông tin xác thực toàn cục của Codex CLI.

Việc cô lập đó là có chủ ý: refresh token OAuth chỉ dùng một lần và xoay vòng sau
mỗi lần làm mới, nên hai chương trình dùng chung một tệp xác thực rồi sẽ tranh
chấp — chương trình làm mới thứ hai phát lại một token đã tiêu và bạn bị đăng
xuất âm thầm khỏi Codex CLI thật.

### An toàn khi ghi

Việc ghi dùng compare-and-swap dưới một **khoá ghi liên tiến trình**, một tệp tạm
riêng tư cùng thư mục, đồng bộ tệp, đổi tên nguyên tử, chế độ `0600`, và đồng bộ
thư mục. Symlink tới tệp thông tin xác thực bị **từ chối**.

### CLI

```bash
pnpm exec ai-agent-sdk-codex-login             # đăng nhập
pnpm exec ai-agent-sdk-codex-login --status    # chi tiết tài khoản/trạng thái cục bộ
```

Package đóng gói kèm binary này và một thư mục `bin` như một phần bề mặt cài đặt
của nó.

## Đọc tiếp

- [Codex](/vi/09-providers/codex) — provider dùng kho này
- [Security](/vi/10-advanced/security)
