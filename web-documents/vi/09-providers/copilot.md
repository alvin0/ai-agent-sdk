# Copilot

Bề mặt subscription của GitHub Copilot. Runtime: **Universal**, với một
`CopilotCredentialStore` được **tiêm vào**; một package Node cấp bản dựa trên
hệ tệp.

```bash
# Universal — bạn tự tiêm kho vào
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-copilot

# Node — kèm đăng nhập device flow cục bộ theo dự án
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-copilot @alvin0/ai-agent-sdk-auth-node
```

Một route Copilot điều phối tới **hai** wire protocol — `/responses` cho các
model khớp tiền tố responses, `/chat/completions` cho phần còn lại — sau cùng một
provider id.

## Trên Node — đăng nhập cục bộ theo dự án

```bash
pnpm exec ai-agent-sdk-copilot-login             # đăng nhập bằng device flow
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { copilotNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/copilot'

const runtime = await createAgentRuntime({ providers: [copilotNodeProviderPlugin()] })

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'copilot' },     // danh mục khám phá từ tài khoản
})
```

Credential nằm ở `.providers/.copilot/auth.json` bên dưới `process.cwd()`. Ghi đè
đường dẫn bằng `AI_AGENT_SDK_COPILOT_AUTH`. Kho này **được mượn và vẫn thuộc sở
hữu của caller** — runtime đóng phần đăng ký provider, không đóng kho.

## Ở mọi nơi khác — tiêm kho vào

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { copilotPlugin, memoryCopilotCredentialStore } from '@alvin0/ai-agent-sdk-provider-copilot'

const registry = new ModelRegistry()
registry.install(copilotPlugin({ authStore: memoryCopilotCredentialStore(tokens) }))
```

Hợp đồng `CopilotCredentialStore` là Universal — một browser, Worker, secret
manager, hoặc package Node sở hữu phần lưu trữ.

## Tradeoff của việc dùng bề mặt Copilot subscription

Provider này nói chuyện với đúng những endpoint mà một **extension editor** của
Copilot nói chuyện. Đó là một thứ khác với sản phẩm API của nhà cung cấp, và
những khác biệt đó đáng đọc trước khi bạn xây dựng lên trên nó.

**SDK tự nhận mình là một editor client.** Ba hằng số được export quyết định đó
là client nào:

| Hằng số | Cách ghi đè |
| --- | --- |
| `COPILOT_OAUTH_CLIENT_ID` | option `clientId` |
| `COPILOT_EDITOR_VERSION` | `editorHeaders.editorVersion` |
| `COPILOT_EDITOR_PLUGIN_VERSION` | `editorHeaders.editorPluginVersion` |

Các giá trị mặc định là điều kiện để bề mặt này trả lời:
`copilot_internal/v2/token` chỉ nhận token do một OAuth App nằm trong allowlist
của GitHub phát hành, và các endpoint Copilot trả HTTP 400 khi thiếu bất kỳ header
editor nào. Chúng là **option có tên, export được và ghi đè được thay vì hằng số
ẩn** chính vì việc tự nhận là một client khác là một quyết định bạn phải đọc được
ra từ source và đổi được — không phải một quyết định bị chôn trong module riêng.

Hai trong ba giá trị mặc định đã được xác nhận trên một tài khoản Copilot thật;
một lượt chạy ngày 2026-09-10 gửi cả hai header editor trên token exchange,
`GET /models`, và một lệnh gọi streaming mà không nhận HTTP 400.
`COPILOT_OAUTH_CLIENT_ID` **chưa được xác nhận**: lượt chạy đó dùng user token
sẵn có thay vì device flow, nên client id này chưa từng đi qua bước kiểm allowlist.

Tổng lại:

| Điểm cân nhắc | Thực tế trên bề mặt này |
| --- | --- |
| Hợp đồng | Không có hợp đồng API công bố, không có chính sách versioning hay thời hạn deprecation. Hình dạng endpoint, danh sách model và header bắt buộc có thể đổi mà không báo trước. |
| Rate và quota | Do subscription Copilot của bạn quyết định, không phải một gói API tính theo lượng dùng. Subscription được cấp cho việc soạn thảo tương tác, không cho tải lập trình liên tục. |
| Điều khoản | Việc dùng tự động ngoài editor có thể không nằm trong điều khoản của subscription. Đó là quyết định của bạn, trên tài khoản của chính bạn. |
| Xác thực | Chỉ OAuth device flow. Personal access token không phát hành được Copilot API token ở bề mặt này. |
| Danh tính client | SDK tự nhận là một editor client, do bắt buộc. |
| Tenancy | Các tenant data-residency (`*.ghe.com`) nằm ngoài phạm vi hỗ trợ. |

> **Khuyến nghị.** Dùng **tài khoản của chính bạn**, và với môi trường production
> hãy ưu tiên provider chính thức của nhà cung cấp —
> [`openai`](/vi/09-providers/openai),
> [`anthropic`](/vi/09-providers/anthropic), hoặc
> [`gemini`](/vi/09-providers/gemini) — nơi bạn có hợp đồng công bố, chính sách
> deprecation, và một quota có thể lập luận được. Copilot phù hợp cho phát triển
> cục bộ, công cụ cá nhân, và bản thử nghiệm khi subscription sẵn có chính là
> credential bạn đang có.

Cùng lập luận với ghi chú [Codex](/vi/09-providers/codex), thêm một bước: Codex
tự nhận danh tính bằng một header `originator`, còn Copilot cần một OAuth client
id nằm trong allowlist **cộng** hai header editor.

## Embedding

> **Chưa có cho Copilot.** `copilotEmbeddingPlugin` và entry point
> `@alvin0/ai-agent-sdk-provider-copilot/embedding` **không tồn tại**.

Bản thân năng lực embedding đã có:
[`@alvin0/ai-agent-sdk-core/embedding`](/vi/09-providers/embeddings) là một entry
point của core, và cả OpenAI lẫn Gemini đều đã có embedding adapter. Thứ còn
thiếu là một adapter cho Copilot. `provider-copilot` hiện chỉ export `"."`, và
danh mục Copilot đã tách các model embedding khỏi danh sách generation
(`CopilotEmbeddingModel`), nên phía catalog đã sẵn sàng — nhưng chưa có gì để
đăng ký. Cách đăng ký, và khác biệt usage so với các provider embedding khác, sẽ
được ghi ở đây khi phần đó xong.

## Đọc tiếp

- [auth-node](/vi/09-providers/auth-node) — chi tiết kho credential
- [Codex](/vi/09-providers/codex) — bề mặt subscription còn lại
- [Protocols](/vi/09-providers/protocols) — dùng lại protocol Chat Completions ở nơi khác
