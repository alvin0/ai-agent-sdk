# Parallel Execution

Ba tầng song song, mỗi tầng một hợp đồng an toàn khác nhau.

## 1. Các lượt chạy độc lập — mã của bạn

Các lượt chạy riêng không chia sẻ gì ngầm, nên cách này luôn an toàn:

```ts
const [review, tests, security] = await Promise.all([
  reviewer.generate(plan.text),
  tester.generate(plan.text),
  auditor.generate(plan.text),
])
```

Mỗi lượt có ngân sách, vết, lịch sử, và báo cáo riêng. Không có gì phối hợp chúng
— và chính vì thế không có gì phá được gì.

> **Không** an toàn: gọi `session.run()` hai lần đồng thời trên **cùng** một
> session. Khoá loại trừ sẽ từ chối lời gọi thứ hai thay vì đan xen hai lượt trên
> một lịch sử. Hãy dùng các session riêng.

## 2. Lời gọi tool song song — fail-closed

Trong một lượt, model có thể phát ra nhiều lời gọi tool cùng lúc. Chỉ lời gọi mà
bộ phân loại trả về **đúng `true`** mới đủ điều kiện chạy cạnh lời gọi khác.

```ts
const readFile = defineTool({
  name: 'read_file',
  description: 'Read a file at a pinned revision.',
  parameters: { /* … */ },
  parse: raw => Args.parse(raw),
  execute: async ({ path, revision }, ctx) => readAt(path, revision, ctx.signal),
  isConcurrencySafe: () => true,     // đọc thuần từ nguồn bất biến
})
```

Bộ phân loại ném lỗi hoặc không khai báo đều bị coi là **exclusive**. Cả hai hiện
thực tham chiếu đều mặc định exclusive và đòi bật tường minh, vì kiểu thất bại khi
đoán sai là **hỏng dữ liệu âm thầm** do hai tool cùng sửa một trạng thái — không
phải một lỗi nhìn thấy được.

### Phép thử để trả `true`

Chỉ trả `true` khi lời gọi không thể quan sát hay sửa trạng thái mà một lời gọi
song song khác chạm tới.

| An toàn | Không an toàn |
| --- | --- |
| Đọc tại một revision đã ghim | Đọc thứ đang có trên đĩa, khi một lời gọi khác đang ghi |
| Truy vấn một read replica | Ghi vào primary |
| Tính toán thuần | Chạy một lệnh shell |
| Lấy một URL bất biến | Bất cứ thứ gì dùng chung cursor, cache, hay đường dẫn tạm |

"Chắc là ổn" thì không đủ. Nếu bạn phải ngồi suy luận về các cách đan xen, hãy
trả `false`.

### An toàn phụ thuộc tham số

```ts
isConcurrencySafe: args => args.mode === 'read',
```

Bộ phân loại nhận tham số đã parse, nên một tool có thể an toàn khi đọc và
exclusive khi ghi.

### Chặn độ rộng

```ts
runtimeLimits: { /* … */ }   // maxParallel chặn số lời gọi an toàn chạy cùng lúc
```

`maxParallel` chặn số lời gọi đủ điều kiện thực sự chạy đồng thời. Kết hợp với
`maxToolCalls` (64 mỗi lượt chạy) và `maxToolDurationMs`, một lần toả rộng không
thể vét cạn hệ thống hạ nguồn của bạn.

## 3. Agent song song — một team quản lý

`createManagedAgentTeam()` cho agent dẫn dắt một tool `spawn_agent`. **Nhiều lời
gọi `spawn_agent` trong cùng một bước model là an toàn khi chạy đồng thời**, nên
các worker độc lập chạy song song.

```ts
const harness = createManagedAgentTeam({
  registry,
  lead: defineAgent({
    id: 'lead',
    instructions: 'Delegate independent research, then synthesize the findings.',
  }),
  maxWorkers: 6,
})

const answer = await harness.run('Điều tra hồi quy trên cả ba dịch vụ.')
console.log(harness.workers())
```

Một lời gọi `spawn_agent` tạo ra một bản sao `DefinedAgent` thật và một
`AgentSession`, gắn nó làm peer, giao nhiệm vụ ban đầu kèm xuất xứ từ agent dẫn
dắt, chờ kết quả, rồi trả kết quả đó về vòng lặp tool của agent dẫn dắt.

Worker đã hoàn thành vẫn địa chỉ hoá được qua `list_agents`, `send_message`, và
`followup_task` cho tới khi bị gỡ bằng `removeWorker()`.

### Cô lập những gì mỗi worker được chạm tới

```ts
createManagedAgentTeam({
  registry,
  lead,
  maxWorkers: 6,
  workerFactory: ({ name, task, specialty }) => buildSpecialist(name, specialty),
  workerSessionOptionsFactory: request => ({
    tools: toolsFor(request),          // danh mục khác nhau cho mỗi worker
    approvals: brokerFor(request),
    interceptors: [scopeGuard(request)],
  }),
})
```

Đây chính là cơ chế làm cho agent song song an toàn trong thực tế: cấp cho mỗi
danh tính được sinh ra một danh mục tool, không gian làm việc, và broker phê duyệt
riêng, để hai worker về mặt vật lý không thể ghi cùng một tệp.

Số worker, dung lượng team, tính duy nhất của địa chỉ, việc huỷ, và việc dọn dẹp
đều do harness cưỡng chế.

## Điểm hợp: `wait_agents`

Một agent điều phối tổng hợp kết quả trước khi các worker xong việc sẽ cho ra thứ
vô nghĩa nhưng đầy tự tin. `wait_agents` chặn cho tới khi các công việc đã lên
lịch được chọn trở nên rảnh.

```ts
// Từ vòng lặp tool của chính agent dẫn dắt, model gọi wait_agents.
// Từ mã của host:
await team.whenIdle('reviewer')
await team.whenIdle('tester')
```

`whenIdle()` an toàn trước tranh chấp — nó phân giải đúng dù đích đã rảnh hay vẫn
đang chạy vào lúc bạn gọi.

## Toả rộng rồi hợp lại, từ đầu đến cuối

```ts
const team = createDefinedAgentTeam({
  registry,
  team: { id: 'release-team' },
  members: [{ agent: lead, role: 'lead' }, { agent: reviewer }, { agent: tester }],
})

// Dàn ngữ cảnh một cách im lặng — chưa lượt nào bắt đầu.
await Promise.all([
  team.team.sendMessage({ from: 'lead', target: 'reviewer', message: candidate, delivery: 'quiet' }),
  team.team.sendMessage({ from: 'lead', target: 'tester', message: candidate, delivery: 'quiet' }),
])

// Toả rộng.
await Promise.all([
  team.team.followup('lead', 'reviewer', 'Review the candidate.'),
  team.team.followup('lead', 'tester', 'Verify the candidate.'),
])

// Hợp lại.
await Promise.all([team.team.whenIdle('reviewer'), team.team.whenIdle('tester')])
const decision = await team.run('lead', 'Integrate the peer findings and decide.')
```

## Vết vẫn không nhập nhằng

Các lời gọi song song tới **cùng** một tool luôn nhận **span id khác nhau**, trong
khi id lời gọi tool vẫn là id tương quan. `buildTraceTree()` chiếu các sự kiện
`span-start` / `span-end` thành một cây tiến trình bất biến, nên một lần toả rộng
hiện ra thành đồ thị lời gọi thật, chứ không phải một log phẳng.

## Ngữ nghĩa thất bại

| Tình huống | Hành vi |
| --- | --- |
| Một tool song song thất bại | Lời gọi cạnh nó vẫn commit; cả lô commit cùng nhau |
| Một tool gọi `concludeTurn()` | Lượt kết thúc **sau khi** cả lô commit |
| Một tool thất bại | Nó không bao giờ kết thúc được lượt — `concludesTurn` kiểu `never` khi thất bại |
| Một worker thất bại | Kết quả của nó là một thất bại mà agent dẫn dắt đọc được; các worker khác tiếp tục |
| Lượt chạy bị huỷ | Việc huỷ tổ hợp và vươn tới mọi tín hiệu tool đang chạy |

Quy tắc "cả lô commit cùng nhau" là điều làm cho việc điều phối song song trở nên
dự đoán được: công việc đã hoàn thành của một lời gọi không bao giờ bị vứt bỏ vì
một lời gọi khác đã kết thúc lượt.

## Đọc tiếp

- [Sequential Execution](/vi/06-workflows/sequential-execution)
- [Tool Execution](/vi/03-tools/tool-execution)
- [A2A](/vi/08-a2a/) — song song xuyên dịch vụ
