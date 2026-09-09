---
title: AI Agent SDK
---

# AI Agent SDK

> SDK TypeScript trung lập với nhà cung cấp, dùng để xây dựng AI agent.

Một mô hình message, một giao thức streaming, một hệ phân loại lỗi — dùng chung
cho Anthropic Messages API, OpenAI Responses API, và endpoint Codex chạy nền
ChatGPT.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai @alvin0/ai-agent-sdk-auth-node
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'gpt-5.4' },
})

console.log((await agent.generate('Giải thích cây Merkle trong một câu.')).text)
await runtime.close()
```

## Bắt đầu từ đây

| Tôi muốn… | Đọc |
| --- | --- |
| Cài đặt và chạy được ngay hôm nay | [1. Giới thiệu](/vi/01-introduction/) → [Cài đặt](/vi/01-introduction/installation), [Quick Start](/vi/01-introduction/quick-start) |
| Xây một agent | [2. Agents](/vi/02-agents/) |
| Cấp cho nó các hàm có kiểu | [3. Tools](/vi/03-tools/) |
| Cấp cho nó kiến thức tiết lộ dần | [4. Skills](/vi/04-skills/) |
| Duy trì liên tục qua tác vụ dài | [5. Memory](/vi/05-memory/) |
| Điều phối nhiều bước hoặc nhiều agent | [6. Workflows](/vi/06-workflows/) |
| Dùng hoặc công bố tool MCP | [7. MCP](/vi/07-mcp/) |
| Nói chuyện với agent ở dịch vụ khác | [8. A2A](/vi/08-a2a/) |
| Trỏ SDK tới một endpoint model | [9. Providers](/vi/09-providers/) |
| Đưa lên production | [10. Advanced](/vi/10-advanced/) |
| Hiểu phần nội bộ | [11. Internals](/vi/11-internals/) |
| Biết cái gì còn có thể đổi | [12. Experimental](/vi/12-experimental/) |
| Tra cứu một export chính xác | [13. Tham chiếu API](/vi/13-api-reference/) |
| Đóng góp, kiểm thử, hoặc xem giấy phép | [14. Dự án](/vi/14-project/) |

## Ba tầng API

SDK được phân tầng có chủ ý. Bắt đầu từ tầng cao nhất, chỉ đi xuống khi bạn thực
sự cần tự sở hữu một ranh giới.

| Tầng | Điểm vào | Sở hữu |
| --- | --- | --- |
| Gốc ghép nối | `createAgentRuntime()` | Provider, observability, vòng đời, báo cáo đóng |
| Định nghĩa tái dùng | `defineAgent()` + `createSession()` | Danh tính agent, chính sách, trạng thái hội thoại |
| Vòng lặp thô | `runAgent()`, `runTurn()`, `ModelRegistry.stream()` | Mọi ranh giới thực thi, một cách tường minh |

Xem [Getting Started](/vi/01-introduction/getting-started) để biết cách chọn.

## Trạng thái

Phiên bản `0.1.0`, giấy phép MIT. Việc publish lên registry đang hoãn có
chủ ý trong lúc thu xếp quyền sở hữu trên npm — xem
[Experimental](/vi/12-experimental/) và
[Thông tin dự án](/vi/14-project/).
