# Cài đặt

## Yêu cầu

| Mục tiêu | Yêu cầu |
| --- | --- |
| Công cụ workspace | Node **22.18** trở lên |
| Package năng lực Node đã cài | Node **22.12** trở lên |
| Package Universal | Bất kỳ runtime dạng Fetch: Edge/Worker, Deno, Bun, trình duyệt, Node |
| Ngôn ngữ | TypeScript với `moduleResolution: "bundler"` hoặc `"nodenext"` |

## Cài đặt

Cả 23 package đã publish trên npm dưới scope `@alvin0`, build và ký từ CI kèm
provenance SLSA.

Chọn tập runtime nhỏ nhất bạn cần.

**Edge/Worker với provider từ xa và telemetry HTTPS có xác nhận**

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-fetch
```

**Harness trình duyệt có khôi phục sau sập bằng IndexedDB**

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-browser
```

**Harness lập trình trên Node — chỉ những năng lực nó dùng**

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-auth-node @alvin0/ai-agent-sdk-provider-codex \
  @alvin0/ai-agent-sdk-mcp-node @alvin0/ai-agent-sdk-observability-node \
  @alvin0/ai-agent-sdk-skill-filesystem
```

Cả ba cấu hình dùng chung một core Universal và một vòng lặp agent.

## Thông tin xác thực

Thông tin xác thực luôn được **tiêm vào**. Các package provider là Universal và
không bao giờ tự đọc biến môi trường hay tệp.

**Trên Node, lấy từ môi trường:**

```ts
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'

openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })
```

`envCredential()` là lười, nhận tín hiệu huỷ của thao tác model, và được provider
mượn — nó không có vòng đời đóng.

**Ở mọi nơi khác, lấy từ kho secret của bạn:**

```ts
const apiKey = defineCredentialSource({
  id: 'openai',
  resolve: () => secretStore.get('openai'),
})

openAiPlugin({ apiKey })
```

**Codex, đăng nhập device-code cục bộ theo dự án:**

```bash
pnpm exec ai-agent-sdk-codex-login             # đăng nhập
pnpm exec ai-agent-sdk-codex-login --status    # chi tiết tài khoản/trạng thái cục bộ
```

Token nằm ở `.providers/.codex/auth.json` (đã git-ignore), **không** nằm ở
`~/.codex/auth.json` của Codex CLI. Việc cô lập này là có chủ ý: refresh token
OAuth chỉ dùng một lần và xoay vòng sau mỗi lần làm mới, nên hai chương trình
dùng chung một tệp xác thực rồi sẽ tranh chấp — chương trình làm mới thứ hai phát
lại một token đã tiêu và bạn bị đăng xuất âm thầm khỏi Codex CLI thật.

## Kiểm chứng cài đặt

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})

console.log(runtime.providers())
console.log(await runtime.modelCatalog('openai'))

await runtime.close()
```

Nếu `providers()` liệt kê đúng tuyến của bạn và `modelCatalog()` trả về danh sách
model, thì cả phép ghép nối lẫn thông tin xác thực đều chạy được.

## Phát triển trong repository

Nếu bạn đang làm việc trên chính SDK thay vì dùng nó:

```bash
pnpm install --frozen-lockfile
pnpm workspace:build
pnpm build:cli
```

## Đọc tiếp

- [Agent đầu tiên](/vi/01-introduction/quick-start)
- [Stream một lời gọi model](/vi/02-agents/streaming)
