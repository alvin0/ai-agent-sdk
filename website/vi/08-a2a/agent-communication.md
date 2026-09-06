# Agent Communication

## Bốn tool được gắn sẵn

Tham gia một team mặc định phơi những tool sau cho model:

| Tool | Đích | Tác dụng |
| --- | --- | --- |
| `list_agents` | — | Đích cục bộ và từ xa, giao thức, chế độ giao nhận, trạng thái |
| `send_message` | **Chỉ cục bộ** | Tiêm ngữ cảnh im lặng vào một session khác |
| `followup_task` | Cục bộ **hoặc từ xa** | Khởi động công việc tuần tự, trả về kết quả |
| `wait_agents` | Cục bộ | Chặn cho tới khi các công việc đã lên lịch được chọn trở nên rảnh |

Agent dẫn dắt trong team quản lý còn nhận thêm `spawn_agent`.

```ts
// Chỉ host được phép giao tiếp; model không nhận tool team nào.
defineAgent({ id: 'worker', instructions: '…' })
  .createSession({ registry, team: { team, tools: false } })
```

## Danh tính người gửi không thể giả mạo

**Danh tính người gửi được gắn ngay lúc tạo session.** Model không thể đặt `from`
— đó không phải tham số model kiểm soát.

```ts
const lead = defineAgent({ id: 'lead', instructions: '…' })
  .createSession({ registry, team: { team, role: 'lead' } })
```

Chính điều đó làm khung nhìn kiểm toán trở nên đáng tin: mọi message trong
`team.messages()` được quy cho session thực sự đã gửi nó, không phải cho thứ model
tự nhận.

## Hai chế độ giao nhận

```ts
// Im lặng: ngữ cảnh bền vững, không lượt nào bắt đầu, agent đang rảnh vẫn rảnh.
await team.sendMessage({
  from: 'lead',
  target: 'reviewer',
  message: 'The candidate commit is abc123.',
  delivery: 'quiet',
})

// Đánh thức: công việc diễn ra — ngay, hoặc ngay sau lượt hiện tại của đích.
await team.followup('lead', 'reviewer', 'Review abc123 and report back.')
await team.whenIdle('reviewer')
```

| Chế độ | Khởi động một lượt | Cục bộ | Từ xa |
| --- | --- | --- | --- |
| `quiet` | Không | ✓ | ✗ |
| Đánh thức (`followup`) | Có | ✓ | ✓ |

Sự tách bạch đó là phần hữu dụng: bạn có thể dàn sẵn nhiều đầu vào một cách im
lặng rồi kích hoạt **một** lượt duy nhất thấy được tất cả, thay vì trả tiền một
lượt cho mỗi đầu vào.

Peer từ xa chỉ hỗ trợ kiểu đánh thức, vì A2A không có thao tác chuẩn nào để âm
thầm sửa lịch sử riêng tư của agent khác.

## "Chấp nhận" nghĩa là gì ở phía cục bộ

Chấp nhận cục bộ nghĩa là lịch sử của đích **sở hữu một message vai user có quy
kết**. Đó không phải kênh phụ — message nằm trong bản ghi hội thoại, kèm người
gửi được ghi lại.

Công việc đánh thức chờ sau lượt đang chạy và gọi `runPending()` **đúng một lần**
cho ngữ cảnh đã chấp nhận. Nó không cắt ngang lượt đang diễn ra, và không chạy
nhân đôi khi nhiều message tới trong lúc agent đang bận.

## Hợp lại trước khi tổng hợp

Một agent điều phối tóm tắt trước khi các peer xong việc sẽ cho ra thứ vô nghĩa
nhưng đầy tự tin. `wait_agents` tồn tại cho việc đó.

```ts
// Model gọi wait_agents từ vòng lặp tool của chính nó.
// Từ mã của host:
await Promise.all([team.whenIdle('reviewer'), team.whenIdle('tester')])
const decision = await composed.run('lead', 'Integrate the peer findings and decide.')
```

`whenIdle()` **an toàn trước tranh chấp** — nó phân giải đúng dù đích đã rảnh hay
vẫn đang chạy vào lúc bạn gọi.

## Uỷ nhiệm động

Trong một team quản lý, agent dẫn dắt nhận `spawn_agent` và quyết lúc chạy xem uỷ
nhiệm có ích không.

```ts
const harness = createManagedAgentTeam({
  registry,
  lead: defineAgent({
    id: 'lead',
    instructions: 'Own the objective, delegate independent research, and synthesize.',
  }),
  maxWorkers: 6,
  workerTemplate: specialistDefinition,   // mặc định là nhân bản agent dẫn dắt
})
```

Một lời gọi `spawn_agent` tạo ra một bản sao `DefinedAgent` thật và một
`AgentSession`, gắn nó làm peer, giao nhiệm vụ ban đầu **kèm xuất xứ từ agent dẫn
dắt**, chờ kết quả, rồi trả kết quả đó về vòng lặp tool của agent dẫn dắt.

**Nhiều lời gọi `spawn_agent` trong cùng một bước model là an toàn khi chạy đồng
thời**, nên các worker độc lập chạy song song. Worker đã hoàn thành vẫn địa chỉ
hoá được qua `list_agents`, `send_message`, và `followup_task` cho tới khi bị gỡ
bằng `removeWorker()`.

### Cô lập các danh tính được sinh ra

```ts
createManagedAgentTeam({
  registry,
  lead,
  maxWorkers: 6,
  workerFactory: ({ name, task, specialty }) => buildSpecialist(name, specialty),
  workerSessionOptionsFactory: request => ({
    tools: toolsFor(request),        // danh mục khác nhau cho mỗi worker
    approvals: brokerFor(request),
    interceptors: [scopeGuard(request)],
  }),
})
```

Đây là điều làm cho việc uỷ nhiệm song song an toàn trong thực tế: mỗi danh tính
được sinh ra có danh mục tool, không gian làm việc, và broker phê duyệt riêng, nên
hai worker về mặt vật lý không thể ghi cùng một tệp.

## Ghép thủ công

Muốn kiểm soát hoàn toàn, hãy tự nối team:

```ts
import { AgentTeam, defineAgent } from '@ai-agent-sdk/core/agent'

const team = new AgentTeam({ id: 'release-team', maxMembers: 8 })

const lead = defineAgent({ id: 'lead', instructions: '…' })
  .createSession({ registry, team: { team, role: 'lead' } })

defineAgent({ id: 'reviewer', instructions: '…' })
  .createSession({ registry, team: { team } })
```

`AgentSession.inject()`, `runPending()`, và `whenIdle()` vẫn có sẵn như các
nguyên thuỷ tầng thấp, nhưng phần lớn ứng dụng nên dùng `AgentTeam`.

## Dấu vết kiểm toán

```ts
const log = team.messages()   // bất biến, cục bộ trong tiến trình
```

Mọi message đã chấp nhận kèm người gửi, đích, chế độ giao nhận, và thời điểm. Kết
hợp với `traceId` / `spanId` theo từng lượt chạy, một luồng nhiều agent tái dựng
lại chính xác — và đó là khác biệt giữa việc gỡ lỗi một team và việc đoán về nó.

## Đọc tiếp

- [Remote Agents](/vi/08-a2a/remote-agents)
- [Parallel Execution](/vi/06-workflows/parallel-execution)
