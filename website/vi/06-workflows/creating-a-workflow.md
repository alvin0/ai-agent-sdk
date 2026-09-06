# Creating a Workflow

Workflow trong SDK này là một **phép ghép nối do bạn viết**, không phải một đồ
thị bạn khai báo. Có ba hình dạng, và chọn giữa chúng là quyết định thiết kế thật
sự duy nhất.

## Hình dạng 1 — Một agent với các tool

Workflow đơn giản nhất. Model quyết gọi tool nào và theo thứ tự nào, bên trong
các chặn trên của vòng lặp.

```ts
const agent = runtime.agent({
  id: 'migrator',
  model,
  instructions: 'Complete the migration and verify every change.',
  tools: [readFile, writeFile, runTests],
  mode: 'deep',
  maxTurns: 24,
  maxToolCalls: 96,
})

const session = agent.createSession()
const result = await session.run('Di trú module billing sang API v2.')
```

Dùng khi *các bước* chưa biết trước nhưng *các năng lực* thì đã biết.

`mode: 'deep'` thêm một hợp đồng hoàn thành: lượt không thể kết thúc cho tới khi
bài tự kiểm cấu trúc `submit_result` của model được chấp nhận. Đó là câu trả lời
của SDK cho tình huống "agent dừng quá sớm".

## Hình dạng 2 — Mã của bạn điều phối

Khi topology là kiến trúc chứ không phải quyết định lúc chạy, hãy viết nó thành
mã thông thường.

```ts
const planner = runtime.agent({ id: 'planner', model, instructions: 'Produce a plan.' })
const reviewer = runtime.agent({ id: 'reviewer', model, instructions: 'Find risks.' })
const tester = runtime.agent({ id: 'tester', model, instructions: 'Design verification.' })
const lead = runtime.agent({ id: 'lead', model, instructions: 'Integrate and decide.' })

const plan = await planner.generate(objective)

const [review, tests] = await Promise.all([
  reviewer.generate(plan.text),
  tester.generate(plan.text),
])

const decision = await lead.generate(
  `Plan:\n${plan.text}\n\nReview:\n${review.text}\n\nTests:\n${tests.text}`,
)
```

Mỗi `generate()` là một lượt chạy độc lập với ngân sách, vết, và báo cáo riêng.
Không có gì được chia sẻ ngầm — và chính vì thế cách này ghép nối an toàn.

## Hình dạng 3 — Một agent team

Khi các agent phải nói chuyện với **nhau**, không chỉ với mã của bạn, hãy dùng
team. Hai khái niệm, cùng cho ra một `AgentTeam`.

### Dạng quản lý — agent dẫn dắt quyết lúc chạy

```ts
import { createManagedAgentTeam, defineAgent } from '@ai-agent-sdk/core'

const harness = createManagedAgentTeam({
  registry,
  lead: defineAgent({
    id: 'lead',
    instructions: 'Own the objective, delegate independent research, and synthesize.',
  }),
  maxWorkers: 6,
})

const answer = await harness.run('Điều tra hồi quy và đề xuất cách sửa.')
console.log(answer.text, harness.workers())
```

Agent dẫn dắt nhận một tool `spawn_agent` gắn danh tính người gửi và quyết **lúc
chạy** xem uỷ nhiệm có ích không, cần bao nhiêu chuyên gia, và mỗi người nhận
nhiệm vụ có chặn trên nào. Nhiều lời gọi `spawn_agent` trong một bước model là an
toàn khi chạy đồng thời.

### Dạng dựng sẵn — bạn chốt danh bạ

```ts
import { createDefinedAgentTeam } from '@ai-agent-sdk/core'

const composed = createDefinedAgentTeam({
  registry,
  team: { id: 'release-team' },
  members: [
    { agent: lead, role: 'lead' },
    { agent: reviewer },
    { agent: tester },
  ],
})

await composed.run('lead', 'Chuẩn bị phát hành abc123.')
await composed.team.followup('lead', 'reviewer', 'Review abc123.')
```

Mỗi định nghĩa trở thành một session bền và giữ nguyên danh tính. Thành viên team
dựng sẵn **không** nhận `spawn_agent`, nên việc chọn khái niệm này không thể âm
thầm làm đổi topology đã khai báo.

## Cách chọn

| Câu hỏi | Trả lời |
| --- | --- |
| Các bước đã biết trước khi chạy? | Có → hình dạng 2. Không → hình dạng 1 hoặc team quản lý. |
| Các agent có cần ngữ cảnh của nhau? | Có → team. Không → hình dạng 2. |
| Danh bạ có bị kiến trúc chốt cứng? | Có → team dựng sẵn. Không → team quản lý. |
| Một agent với tool là đủ chưa? | Thường là đủ. Hãy bắt đầu từ đó. |

Bắt đầu từ hình dạng 1. Chuyển sang hình dạng 2 khi bạn cần ngân sách và vết độc
lập. Chỉ chuyển sang team khi các agent phải trao đổi message có quy kết.

## Bốn tool được gắn sẵn cho team

Tham gia một team mặc định phơi ra:

| Tool | Làm gì |
| --- | --- |
| `list_agents` | Đích cục bộ và từ xa, giao thức, chế độ giao nhận, trạng thái |
| `send_message` | Tiêm ngữ cảnh im lặng vào một session **cục bộ** khác |
| `followup_task` | Công việc tuần tự trên đích cục bộ **hoặc từ xa**, trả về kết quả |
| `wait_agents` | Chặn cho tới khi các công việc đã lên lịch được chọn trở nên rảnh |

Agent dẫn dắt trong team quản lý còn nhận thêm `spawn_agent`. Đặt
`team: { team, tools: false }` khi chỉ host được phép giao tiếp.

**Danh tính người gửi được gắn ngay lúc tạo session**, nên model không thể giả
mạo `from`.

## Tự sở hữu việc thực thi

Dưới `session.run()` còn hai điểm vào thấp hơn, dành cho khi bạn cố ý tự sở hữu
lịch sử hoặc mọi ranh giới:

```ts
// Bạn sở hữu lịch sử; SDK sở hữu chính sách thực thi.
for await (const event of runAgent({ mode: 'deep', registry, history, tools, maxTurns: 8 })) { … }

// Bạn sở hữu mọi ranh giới thực thi — chỉ một lượt.
for await (const event of runTurn({ registry, config, history, tools })) { … }
```

`runTurn()` thực thi **một lượt**. Việc lặp qua nhiều lượt, quyết định khi nào
nhiệm vụ xong, và áp ngân sách tổng thể là việc của bạn ở tầng đó.

## Những gì bạn không bao giờ phải tự viết

```text
thử lại khi nhà cung cấp lỗi thoáng qua  → decorator withRetry
mỗi hội thoại một lượt tại một thời điểm → khoá loại trừ của session
trần token / bước / tool                 → chặn trên vòng lặp
khôi phục khi tràn ngữ cảnh              → nén tự động
việc huỷ vươn tới mọi tool               → tín hiệu được tổ hợp
một cây vết cho cả luồng                 → traceId / spanId / parentSpanId
"có gì rò rỉ lúc shutdown không?"        → RuntimeCloseReport.unsettledRuns
```

## Đọc tiếp

- [Sequential Execution](/vi/06-workflows/sequential-execution)
- [Parallel Execution](/vi/06-workflows/parallel-execution)
- [A2A](/vi/08-a2a/) — team vượt ranh giới dịch vụ
