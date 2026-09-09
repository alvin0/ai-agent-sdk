# Remote Agents

Runtime: **Node 22.12+**. Điểm vào: `.`, `./client`, `./server`.
Ghép nối: `runtime-team.linkAgent`. Vòng đời: `borrowed-caller-owned`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-a2a
```

Cầu nối được nâng lên tầng Node giữa agent/team của ai-agent-sdk và API
client/server chính thức [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js),
hiện thực A2A Protocol v1.0.

> **Vì sao là Node.** Bộ mã hoá A2A chính thức dùng `Buffer.from` để tuần tự hoá
> `Part` nhị phân thô. Văn bản, dữ liệu có cấu trúc, URL, và giá trị nhị phân đều
> được hỗ trợ trên Node, nhưng package không được quảng bá cho runtime Edge/Worker
> cho tới khi cổng kiểm tra phủ định đã cam kết được thông qua mà không cần biến
> toàn cục của Node. Root `.` cùng các subpath `./client` và `./server` là bí danh
> tương thích trên cùng một hiện thực.

---

## `/client`

```ts
export class A2AAgentLink implements LinkedAgentTransport { … }
export function createA2AAgentLink(options: A2AAgentLinkOptions): Promise<A2AAgentLink>
export function linkA2AAgent(team, options): Promise<{ link: A2AAgentLink; unlink(): Promise<void> }>
```

```ts
import { linkA2AAgent } from '@alvin0/ai-agent-sdk-a2a/client'

const { link, unlink } = await linkA2AAgent(team, {
  name: 'security',
  baseUrl: 'https://security-agent.example.com',
  streaming: true,
})
```

### Khởi tạo — bắt buộc đúng một

| Đầu vào | Dùng khi |
| --- | --- |
| `baseUrl` | Bạn muốn khám phá qua Agent Card. |
| `agentCard` | Bạn đã lấy sẵn card. |
| `client` | Bạn đã tự dựng một `Client` A2A chính thức. |

### Truyền tải và tương thích

Tầng truyền tải JSON-RPC và HTTP+JSON được bật. Tương thích v0.3 **mặc định tắt**
và bật tường minh bằng `legacyCompat: true`.

`streaming` ghi đè năng lực trong Agent Card; bỏ trống thì theo card. Sự kiện
vòng đời streaming quan sát được bằng `onStreamEvent`.

### Chính sách endpoint — phải bật tường minh

Client trung lập với chính sách triển khai và chấp nhận endpoint HTTP/HTTPS chuẩn
lẫn endpoint riêng tư, trừ khi host bật ràng buộc:

```ts
{
  requireHttps: true,
  allowPrivateNetwork: false,
  allowRedirects: false,
  allowedOrigins: ['https://security-agent.example.com'],
  // hoặc tự cấp `fetch` / `validateEndpoint` của bạn
}
```

Ngân sách cho yêu cầu, phản hồi, thân HTTP, sự kiện/byte của luồng, số ngữ cảnh,
TTL, và timeout đều cấu hình độc lập.

### Giữ ngữ cảnh

Mỗi cặp `(team, người gửi)` giữ một `contextId` từ xa, nên các lời gọi
`followup_task` sau đó nối lại đúng cuộc hội thoại từ xa. Việc gửi tới cùng một
đích từ xa theo thứ tự **FIFO**.

Hủy gửi chỉ kết thúc việc chờ của caller, không bảo đảm callback transport đã
dừng. Team giữ thứ tự FIFO đến khi callback thực sự hoàn tất: lượt gửi tiếp
theo vẫn chờ và không thể unlink khi còn việc pending. Cancel/dispose báo timeout
nếu không drain kịp deadline. Báo cáo đóng runtime vẫn ghi nhận transport chưa
settle; không phát event sau khi runtime đã đóng. Team không đóng transport
borrowed. Với mỗi remote member, `AgentTeamOptions.maxMessages` cũng giới hạn số
lượt gửi chưa settle; vượt giới hạn trả về `TEAM_REMOTE_PENDING_LIMIT`.

Peer từ xa **chỉ hỗ trợ giao nhận kiểu đánh thức**, vì A2A không có thao tác
chuẩn nào để âm thầm sửa lịch sử riêng tư của agent khác. Do đó `send_message`
nhắm tới session cục bộ; `followup_task` nhắm tới cả hai loại.

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

- [A2A Server](/vi/08-a2a/a2a-server) — phía công bố
- [Agent Communication](/vi/08-a2a/agent-communication)
- [Security](/vi/10-advanced/security) — chính sách endpoint trong ngữ cảnh
