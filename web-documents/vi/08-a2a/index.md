# A2A — Tổng quan

SDK kết hợp **hai tầng sau cùng một danh bạ agent**:

| Tầng | Nó là gì | Package |
| --- | --- | --- |
| `AgentTeam` | Cộng tác giữa các session sống lâu **trong cùng tiến trình** | `@alvin0/ai-agent-sdk-core/agent` |
| A2A Protocol v1.0 | Khám phá Agent Card và gọi **từ xa** qua JSON-RPC / HTTP+JSON | `@alvin0/ai-agent-sdk-a2a` |

Sự phân biệt này quan trọng. Chỉ tương thích giao thức thì không tạo ra một bộ
lập lịch cục bộ, còn một hộp thư trong tiến trình thì không với tới được agent ở
dịch vụ khác. `AgentTeam` định tuyến **cả hai** loại đích qua cùng một danh bạ,
nên một model gọi `followup_task` không cần biết nó đang nói với loại nào.

Phần hỗ trợ A2A là hiện thực chính thức
[`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) — SDK làm cầu nối tới nó
chứ không hiện thực lại giao thức.

> **Tầng runtime: Node.** `@alvin0/ai-agent-sdk-a2a` hiện được **nâng lên tầng Node** vì
> bộ mã hoá nhị phân ở thượng nguồn gọi `Buffer.from` để tuần tự hoá `Part` nhị
> phân thô. Văn bản, dữ liệu có cấu trúc, URL, và giá trị nhị phân đều chạy được
> trên Node. Các đường văn bản tình cờ chạy được trong Worker nghiêm ngặt, nhưng
> package không được quảng bá cho runtime Edge/Worker cho tới khi cổng kiểm tra
> phủ định đã cam kết được thông qua mà không cần biến toàn cục của Node. Xem
> [Experimental](/vi/12-experimental/).

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-a2a
```

## Một danh bạ, hai loại thành viên

```text
                    ┌─────────── Danh bạ AgentTeam ──────────┐
                    │                                         │
   session cục bộ ──┤  reviewer   tester   lead               │
                    │                                         │
   peer từ xa     ──┤  security (https://security.example.com)│
                    │                                         │
                    └─────────────────────────────────────────┘
                                     ▲
                     list_agents · send_message · followup_task · wait_agents
```

| Năng lực | Session cục bộ | Peer A2A từ xa |
| --- | --- | --- |
| `list_agents` | ✓ | ✓ |
| `followup_task` (công việc đánh thức) | ✓ | ✓ |
| `send_message` (ngữ cảnh im lặng) | ✓ | ✗ |
| Dùng chung bộ nhớ tiến trình | ✓ | ✗ |

Peer từ xa **chỉ hỗ trợ giao nhận kiểu đánh thức**, vì A2A không có thao tác
chuẩn nào để âm thầm sửa lịch sử riêng tư của agent khác. Đó là một hạn chế của
giao thức được nói thẳng, không phải một lối tắt của SDK.

## Hai khái niệm team

Cả hai đều cho ra một `AgentTeam`. Chúng chỉ khác nhau ở **ai sở hữu topology và
vòng đời worker**.

```ts
// Agent dẫn dắt quyết lúc chạy: có uỷ nhiệm không, và cho bao nhiêu người.
createManagedAgentTeam({ registry, lead, maxWorkers: 6 })

// Bạn chốt danh bạ; danh tính là kiến trúc, không phải lựa chọn lúc chạy.
createDefinedAgentTeam({ registry, team: { id: 'release-team' }, members })
```

Thành viên team dựng sẵn **không** nhận `spawn_agent`, nên việc chọn khái niệm
dựng sẵn không thể âm thầm làm đổi topology đã khai báo.

## Hai chiều

| Chiều | Điểm vào |
| --- | --- |
| **Tiêu thụ** — nối một agent từ xa vào danh bạ của bạn | `@alvin0/ai-agent-sdk-a2a/client` → `linkA2AAgent()` |
| **Công bố** — phơi `DefinedAgent` của bạn thành A2A server | `@alvin0/ai-agent-sdk-a2a/server` → `createDefinedAgentA2AServer()` |

## Phần nào vẫn thuộc host

Package này là một **SDK, không phải control plane cho production**. Nó cung cấp
trạng thái có chặn trên, TTL, huỷ và giải phóng, làm sạch lỗi, phân phạm vi theo
chủ sở hữu, và các hook chính sách.

Dịch vụ nhúng vẫn chịu trách nhiệm về middleware xác thực, kho lưu bền, giới hạn
tần suất, cưỡng chế mạng và DNS, secret, triển khai, và backend observability.

## Trong chương này

| Trang | Trả lời |
| --- | --- |
| [Agent Discovery](/vi/08-a2a/agent-discovery) | Agent Card, danh bạ, và model tìm một peer thế nào |
| [Agent Communication](/vi/08-a2a/agent-communication) | Bốn tool được gắn sẵn, chế độ giao nhận, danh tính người gửi |
| [Remote Agents](/vi/08-a2a/remote-agents) | Nối peer, giữ ngữ cảnh, chính sách truyền tải và endpoint |
| [A2A Server](/vi/08-a2a/a2a-server) | Phơi một agent, vòng đời task, quyền sở hữu session |

## Nghiệm thu trực tiếp

```bash
npm run human:a2a-managed
npm run human:a2a-defined
```

Cả hai chạy với provider thật: các product engineer đồng thời hiện thực những
lát dọc được test độc lập, tự nén ngữ cảnh của mình, và trả về các bàn giao có
quy kết, trong khi một agent điều phối tích hợp kết quả. Mỗi agent nhận một
**danh sách cho phép ghi chính xác**; script của package, mạng, tiến trình con,
và truy cập ngoài không gian làm việc dùng-một-lần đều bị từ chối.
