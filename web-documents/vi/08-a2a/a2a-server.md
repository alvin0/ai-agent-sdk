# A2A Server

Phơi một `DefinedAgent` để các dịch vụ khác gọi được qua A2A Protocol v1.0.

Runtime: **Node 22.12+**. Điểm vào: `@alvin0/ai-agent-sdk-a2a/server`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-a2a
```

Cầu nối này dựng trên API server chính thức của
[`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js). Nó cho bạn một request
handler trung lập với tầng truyền tải — **không phải** một listener — nên
framework vẫn là lựa chọn của bạn.

## Export

```ts
export { createAgentCardFromDefinition }
export class DefinedAgentA2AExecutor implements AgentExecutor { … }
export function createDefinedAgentA2AServer(
  options: DefinedAgentA2AServerOptions,
): DefinedAgentA2AServer
export interface A2ADisposeReport { … }
```

```ts
const agentCard = createAgentCardFromDefinition(reviewer, {
  url: 'https://agents.example.com/reviewer/a2a',
  protocolBinding: 'JSONRPC',
  version: '1.0.0',
  tags: ['review', 'release'],
})

const { requestHandler } = createDefinedAgentA2AServer({
  agent: reviewer,
  registry,
  agentCard,
})
```

`requestHandler` là `DefaultRequestHandler` chính thức, trung lập với tầng truyền
tải. Hãy gắn nó với handler JSON-RPC/REST Express chính thức, dịch vụ gRPC, hoặc
một tầng truyền tải tuỳ biến — giữ mã framework HTTP bên ngoài package này tránh
việc ép Express hay gRPC lên mọi người dùng SDK.

### Tuỳ chọn

| Tuỳ chọn | Mục đích |
| --- | --- |
| `agent` | `DefinedAgent` cần công bố. |
| `registry` | Registry dùng chung, khi mọi yêu cầu đều dùng được cùng một cái. |
| `createSession(context)` | Registry, tool, hoặc chính sách theo từng yêu cầu. Thay cho `registry`. |
| `sessionOwner(context)` | Chọn ranh giới cô lập — người dùng, thiết bị, không gian làm việc, API client. |
| `requireAuthenticated` | Chỉ đặt `true` khi tầng truyền tải cung cấp một `User` đã xác thực. |
| `agentCard` | Lược đồ bảo mật được truyền qua khi có cấu hình. |

### Vòng đời task

Cầu nối hiện thực đúng vòng đời chính thức: `Task` ban đầu, `WORKING`, cập nhật
artifact, rồi `COMPLETED`, `FAILED`, hoặc `CANCELED`.

Mỗi cặp `(chủ sở hữu session, contextId A2A)` giữ một session, nên một task mới
trong ngữ cảnh đã thuộc sở hữu sẽ thấy các message trước đó **mà không chia sẻ
lịch sử giữa các chủ sở hữu khác nhau**. Chủ sở hữu mặc định là principal A2A đã
xác thực khi có, ngược lại là `anonymous`.

Message đi vào được ghi với `source.kind === 'a2a-message'` cùng `contextId`,
`messageId`, và `taskId` của giao thức.

---

---

## Thứ tự đóng

Đóng runtime/team trước, rồi giữ riêng các báo cáo `unlink()` (bất biến khi gọi
lại) và báo cáo giải phóng server (`A2ADisposeReport`).

## Phần nào vẫn thuộc host

Xác thực, chính sách endpoint, lưu trữ, và việc thích ứng framework HTTP đều
thuộc host. Package này cung cấp trạng thái có chặn trên, TTL, huỷ/giải phóng,
làm sạch lỗi, phân phạm vi theo chủ sở hữu, và các hook chính sách — không phải
một control plane cho production.

## Đọc tiếp

- [Remote Agents](/vi/08-a2a/remote-agents) — phía tiêu thụ
- [Agent Discovery](/vi/08-a2a/agent-discovery) — công bố Agent Card của bạn
- [Security](/vi/10-advanced/security) — xác thực vẫn là chính sách của host
