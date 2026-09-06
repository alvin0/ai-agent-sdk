# Sequential Execution

Có bốn cơ chế cưỡng chế thứ tự, ở bốn tầng khác nhau. Hãy chọn tầng thấp nhất mà
thực sự giữ được thứ tự.

## 1. Mã của bạn `await`

Bảo đảm thứ tự mạnh nhất, vì nó không phụ thuộc model chút nào.

```ts
const plan = await planner.generate(objective)
const impl = await implementer.generate(plan.text)
const verdict = await reviewer.generate(impl.text)
```

Mỗi lượt chạy xong trước khi lượt sau bắt đầu. Ngân sách độc lập, vết độc lập,
báo cáo độc lập.

Dùng cách này mỗi khi thứ tự là **yêu cầu**, không phải sở thích.

## 2. Nối tiếp các lượt trong một session

Trong cùng một hội thoại, các lượt vốn đã tuần tự — một session **ngăn hai lượt
chạy chồng nhau**.

```ts
const session = agent.createSession()

await session.run('Đọc bài test đang fail và giải thích nguyên nhân.')
await session.run('Giờ viết bản sửa.')        // thấy lượt trước
await session.run('Giờ kiểm chứng là nó pass.')
```

Nếu bạn gọi `run()` khi một lượt đang chạy, khoá loại trừ của session sẽ từ chối
thay vì đan xen hai lượt trên cùng một lịch sử.

```ts
session.isRunning              // kiểm tra trước
await session.whenIdle(signal) // hoặc chờ
```

`session.compact()` chiếm **cùng** khoá đó, nên việc nén không bao giờ ghi lại
lịch sử trong lúc một lượt đang đọc nó.

## 3. Tool exclusive

Bên trong một lượt, model có thể phát ra nhiều lời gọi tool cùng lúc. Việc lập
lịch là **fail-closed**: một lời gọi chạy một mình trừ khi `isConcurrencySafe`
trả về đúng `true`.

```ts
const writeFile = defineTool({
  name: 'write_file',
  description: 'Write a file in the project.',
  parameters: { /* … */ },
  parse: raw => Args.parse(raw),
  execute: async (args, ctx) => write(args, ctx.signal),
  isConcurrencySafe: () => false,   // không bao giờ chạy cạnh lời gọi khác
})
```

Bộ phân loại ném lỗi hoặc không khai báo cũng bị coi là exclusive. Kiểu thất bại
khi đoán sai là hỏng dữ liệu âm thầm, nên mặc định đứng về phía bảo vệ bạn.

## 4. Rào chắn của bộ lập lịch

Một số tool được sinh ra là **rào chắn**: chúng giữ đúng thứ tự model cho một lô
thay vì chạy song song.

Tool skill là ví dụ dựng sẵn. `load_skill` rồi `read_skill_resource` chạy theo
đúng thứ tự model đã phát ra, vì việc đọc tài nguyên là vô nghĩa trước khi skill
của nó được nạp — và vì một provider từ xa có thể không an toàn khi truy cập
đồng thời.

Bạn đạt được đúng hiệu ứng đó cho tool của mình bằng cách trả `false` từ
`isConcurrencySafe`, thay vì cố tự phối hợp bên trong `execute`.

## Xếp thứ tự xuyên một team

`followup()` khởi động công việc **tuần tự** trên một đích và chờ nó xong.

```ts
await composed.run('lead', 'Chuẩn bị phát hành abc123.')
await composed.team.followup('lead', 'reviewer', 'Review abc123.')
await composed.team.whenIdle('reviewer')
```

Hai bảo đảm thứ tự đáng dựa vào:

**Công việc đánh thức chờ sau lượt đang chạy.** Một `followup_task` nhắm tới một
agent đang bận sẽ được xếp hàng và gọi `runPending()` đúng một lần cho ngữ cảnh
đã chấp nhận — nó không cắt ngang lượt đang diễn ra.

**Việc gửi đi xa theo FIFO.** Các lời gọi tới cùng một đích A2A từ xa được xếp
thứ tự, và mỗi cặp `(team, người gửi)` giữ một `contextId` từ xa nên các lần
follow-up sau nối lại đúng cuộc hội thoại.

## Ngữ cảnh im lặng trước một lượt

Để đưa cho agent thông tin **mà không** khởi động một lượt:

```ts
await team.sendMessage({
  from: 'lead',
  target: 'reviewer',
  message: 'The candidate commit is abc123.',
  delivery: 'quiet',
})

// Sau đó, khi bạn thực sự muốn công việc diễn ra:
await team.followup('lead', 'reviewer', 'Review abc123 and report back.')
```

Giao nhận `quiet` ghi thêm ngữ cảnh có quy kết vào lịch sử của đích và không đánh
thức một agent đang rảnh. Chính sự tách bạch đó cho phép bạn dàn sẵn nhiều đầu
vào rồi kích hoạt một lượt duy nhất thấy được tất cả.

Trong cùng một session, `session.inject(text)` làm đúng việc đó.

## Làm cho model tôn trọng thứ tự

Thứ tự phụ thuộc model cần được nêu ở ba chỗ, nếu không nó sẽ không giữ được:

```ts
const agent = runtime.agent({
  id: 'migrator',
  model,
  instructions: 'Read the file before editing it. Run tests after every edit.',
  tools: [readFile, writeFile, runTests],
})
```

| Chỗ | Cần nói gì |
| --- | --- |
| `instructions` | Quy tắc thứ tự, nói thẳng |
| `description` của tool | "Use after `read_file`." / "Call this last." |
| `isConcurrencySafe` | `false`, để bộ lập lịch dù sao cũng không đảo được |

Chỉ cái thứ ba là bảo đảm. Hai cái đầu là prompt.

## Khi thứ tự bị vỡ

| Triệu chứng | Nguyên nhân | Cách sửa |
| --- | --- | --- |
| Hai lần ghi tranh chấp | Tool ghi trả `true` từ `isConcurrencySafe` | Trả `false` |
| Model sửa trước khi đọc | Thứ tự chỉ nêu bằng văn xuôi | Cho tool ghi thành exclusive; nêu trong description |
| Một follow-up cắt ngang một lượt | Đúng như thiết kế — nó được xếp hàng, không cắt ngang | `await team.whenIdle(target)` |
| `run()` chồng nhau bị từ chối | Khoá session đã làm việc của nó | Kiểm tra `isRunning` hoặc `whenIdle()` |

## Đọc tiếp

- [Parallel Execution](/vi/06-workflows/parallel-execution)
- [Tool Execution](/vi/03-tools/tool-execution) — đường ống điều phối, chi tiết
