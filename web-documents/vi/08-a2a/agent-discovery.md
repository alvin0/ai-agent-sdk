# Agent Discovery

Khám phá trả lời hai câu hỏi khác nhau: **hiện tại danh bạ có ai** (cục bộ) và
**endpoint từ xa kia tự nhận mình là gì** (Agent Card).

## Danh bạ, từ phía model

Tham gia một team cho session một tool `list_agents` được gắn sẵn. Model gọi nó
để biết mình có thể nói với ai.

```text
list_agents → với mỗi thành viên:
                name
                kind         session cục bộ | peer A2A từ xa
                protocol     tầng truyền tải đã thương lượng, với peer từ xa
                delivery     nó nhận chế độ nào (quiet / đánh thức)
                status        rảnh | đang chạy | có việc đang chờ
```

Hai hệ quả đáng tính tới khi thiết kế:

**Model không cần biết peer nằm ở đâu.** Một peer từ xa xuất hiện bên cạnh các
peer cục bộ, nên `followup_task` dùng như nhau cho cả hai.

**Chế độ giao nhận được công bố, không phải đoán.** Một peer từ xa báo rằng nó
chỉ nhận công việc kiểu đánh thức, nên model không thử `send_message` với nó rồi
nhận thất bại.

## Danh bạ, từ phía host

```ts
harness.workers()          // team quản lý: các worker đang được sinh ra
harness.removeWorker(name) // cho một worker nghỉ
team.messages()            // khung nhìn kiểm toán bất biến, cục bộ trong tiến trình
await team.whenIdle(name)  // chờ an toàn trước tranh chấp
```

`AgentTeam.messages()` là **khung nhìn kiểm toán bất biến** của lưu lượng cục bộ
trong tiến trình: ai gửi gì cho ai, kèm quy kết. Đó là bản ghi bạn đọc khi một
agent làm điều gì bất ngờ.

## Bất biến ở mức team

Team cưỡng chế những điều sau để bạn không phải tự làm:

| Bất biến | Tác dụng |
| --- | --- |
| Tên duy nhất | Hai thành viên không thể dùng chung một địa chỉ |
| Một agent dẫn dắt cục bộ | Mỗi team một agent điều phối duy nhất |
| Giới hạn thành viên / message / hộp thư | Toả rộng và độ sâu hàng đợi có chặn trên |
| Giới hạn metadata và kích thước message UTF-8 | Không có payload vô hạn |
| Từ chối tự gửi cho mình | Một agent không thể gửi message cho chính nó |
| Gửi đi xa được tuần tự hoá | FIFO theo từng đích từ xa |
| Chờ rảnh an toàn trước tranh chấp | `whenIdle()` phân giải đúng trong cả hai trường hợp |
| Huỷ và giải phóng | Việc tháo dỡ team vươn tới các thành viên |

## Khám phá một agent từ xa

`linkA2AAgent()` khám phá Agent Card, để SDK chính thức chọn một tầng truyền tải
được hỗ trợ, và thêm peer vào đúng danh bạ mà các agent cục bộ đang dùng.

```ts
import { linkA2AAgent } from '@alvin0/ai-agent-sdk-a2a/client'

const { link, unlink } = await linkA2AAgent(team, {
  name: 'security',
  baseUrl: 'https://security-agent.example.com',
})
```

### Ba đường khởi tạo — bắt buộc đúng một

| Đầu vào | Dùng khi | Có gọi mạng lúc nối? |
| --- | --- | --- |
| `baseUrl` | Bạn muốn khám phá qua Agent Card | Có — lấy card |
| `agentCard` | Bạn đã lấy sẵn hoặc cache card | Không |
| `client` | Bạn đã tự dựng một `Client` A2A chính thức | Không |

Truyền thẳng `agentCard` là cách bạn tránh một vòng khứ hồi khám phá ở mỗi lần
khởi động lạnh — hãy cache card rồi đưa nó vào.

### Card quyết định điều gì

```ts
await linkA2AAgent(team, {
  name: 'security',
  baseUrl: 'https://security-agent.example.com',
  streaming: true,     // GHI ĐÈ; bỏ trống thì theo năng lực trong card
})
```

Agent Card công bố năng lực của peer, bao gồm việc nó có hỗ trợ streaming hay
không. Bỏ trống `streaming` thì SDK theo card. Chỉ truyền nó khi bạn biết rõ hơn
card.

Tầng truyền tải JSON-RPC và HTTP+JSON được bật. Tương thích v0.3 **mặc định tắt**
và bật tường minh bằng `legacyCompat: true`.

## Công bố card của chính bạn

```ts
import { createAgentCardFromDefinition } from '@alvin0/ai-agent-sdk-a2a/server'

const agentCard = createAgentCardFromDefinition(reviewer, {
  url: 'https://agents.example.com/reviewer/a2a',
  protocolBinding: 'JSONRPC',
  version: '1.0.0',
  tags: ['review', 'release'],
})
```

Card được sinh **từ định nghĩa**, nên `id`, `name`, và `description` trên
`defineAgent()` của bạn trở thành danh tính công bố của peer. Đó là lý do thực
dụng để viết một `description` tử tế: nó là thứ các dịch vụ khác đọc khi quyết
định có gọi bạn hay không.

Các lược đồ bảo mật trong Agent Card được truyền qua khi có cấu hình, nhưng SDK
này **không** tự bịa ra và cũng không tự cưỡng chế chúng.

## Khám phá được quan sát

Các thao tác khám phá và năng lực từ xa xuất hiện trên bus quan sát dưới tên
`sdk.integration.request` với pha start/end, nên một lần lấy Agent Card chậm hoặc
thất bại hiện ra thành lỗi tích hợp, chứ không thành một độ trễ khởi động không
lý do.

## Đọc tiếp

- [Agent Communication](/vi/08-a2a/agent-communication)
- [Remote Agents](/vi/08-a2a/remote-agents) — chính sách truyền tải và endpoint
- [A2A Server](/vi/08-a2a/a2a-server)
