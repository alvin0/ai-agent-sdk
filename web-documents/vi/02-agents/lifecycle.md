# Lifecycle

Bốn vòng đời, mỗi cái có điểm bắt đầu và điểm kết thúc tường minh.

```text
createAgentRuntime()  ── provider sẵn sàng ── các lượt chạy ── close() ── RuntimeCloseReport
      │
      runtime.agent()  ── gắn kết đã đóng băng, không I/O ────────── (không có gì để đóng)
            │
            createSession()  ── lịch sử + bộ nhớ + skill ── reset() / bỏ tham chiếu
                  │
                  run() / stream()  ── turn hook ── sự kiện kết thúc ── RuntimeRunReport
```

## Khởi động runtime

```ts
const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
  startupTimeoutMs: 10_000,
  closeTimeoutMs: 30_000,
  signal: bootController.signal,
})
```

`createAgentRuntime()` là async vì các plugin provider có ranh giới vòng đời
`ready()`. Đó là nơi một năng lực thực sự chiếm giữ tài nguyên — ví dụ
`jsonlObservationExporter()` là **trơ** khi khởi tạo và chỉ chạm vào hệ tệp khi
runtime gọi `ready()`.

Việc đăng ký provider là **có giao dịch**: các yêu sách tuyến được khai báo ngay
từ đầu, nên xung đột thất bại *trước khi hoàn tất thiết lập*, không phải tới lúc
dùng lần đầu. Một lần khởi động thất bại sẽ rollback mọi đăng ký dở dang.

## Việc gắn agent không có vòng đời

`runtime.agent({ … })` không gây I/O và không giữ tài nguyên nào. Nó là một gắn
kết đã đóng băng. Không có gì để đóng, và không có bước `ready()`.

`defineAgent()` cũng vậy — một định nghĩa được kiểm tra, chuẩn hoá, và đóng băng
ở phạm vi module.

## Vòng đời của session

Session sở hữu trạng thái thay đổi được: lịch sử, bộ nhớ, skill đã kích hoạt, và
một khoá loại trừ theo từng session.

```ts
session.isRunning              // có lượt nào đang chạy?
await session.whenIdle(signal) // chờ nó lắng xuống
session.reset()                // conversation id mới, vẫn cùng agent/tool
```

Một session **ngăn hai lượt chạy chồng nhau** trên cùng hội thoại.
`session.compact()` chiếm cùng khoá loại trừ như một lượt model, nên việc nén và
thực thi bình thường không thể cùng lúc ghi đè một lịch sử.

`session.reset()` cố ý bắt đầu một conversation id mới và xoá trạng thái kích
hoạt skill trong phạm vi hội thoại, đồng thời phục hồi các mầm bộ nhớ ở mức định
nghĩa.

Session không có `close()`. Muốn lưu thì chụp snapshot; muốn bỏ thì bỏ tham chiếu.

## Turn hook

```ts
const session = agent.createSession({
  hooks: {
    beforeStep: ctx => ({ kind: 'proceed' }),
    onRequestError: ctx => 'retry',
    checkpoint: async ctx => { await store.save(ctx) },
    onTurnEnd: async ctx => { metrics.record(ctx) },
  },
})
```

| Hook | Chữ ký | Mục đích |
| --- | --- | --- |
| `beforeStep` | `(ctx) => StepDecision` | Chặn hoặc bổ sung cho bước model kế tiếp |
| `onRequestError` | `(ctx) => 'retry' \| 'fail'` | Quyết định cách phục hồi khi yêu cầu model thất bại |
| `checkpoint` | `(ctx) => void` | Điểm bền vững — lưu lại tiến độ |
| `onTurnEnd` | `(ctx) => void` | Hạch toán kết thúc cho một lượt |

### `beforeStep` trả về một quyết định

```ts
type StepDecision =
  | { kind: 'proceed'; prepend?: readonly Message[] }
  | { kind: 'reject'; reason: string }
```

`proceed` có thể kèm `prepend` để thêm message vào riêng yêu cầu đó — hữu ích khi
cần tiêm trạng thái mới mà model phải thấy ngay. `reject` dừng bước lại kèm lý
do, và đó chính là cách bạn biểu diễn **thực thi có điều kiện** khi không có
workflow engine. Xem
[Conditional Execution](/vi/06-workflows/conditional-execution).

Việc gọi hook được quan sát dưới dạng sự kiện `sdk.hook.call`, chỉ mang loại hook
đã đóng và lỗi đã làm sạch, và bị chặn bởi giới hạn thời gian riêng của chúng.

## Báo cáo lượt chạy

Mỗi lượt chạy sinh ra một bản ghi kết thúc:

```ts
const response = await agent.generate(input)

response.report.usage        // reported + estimated, giữ tách bạch
response.report.coverage     // số lời gọi logic, lượt thử vật lý, số bị thiếu
response.report.authoritative // có được gọi đây là tổng hay không?
response.report.errors       // bản ghi lỗi có tương quan, đã làm sạch
```

`reported` là **tổng cận dưới** khi độ phủ chưa đầy đủ. Không giá trị nào được
gọi là "tổng chi phí" hay "tổng token" trừ khi `authoritative` là true.

## Đóng runtime

```ts
const report = await runtime.close({ signal })

report.state                 // 'closed'
report.quiescenceEnd         // 'settled' | 'timeout' | 'caller-abort'
report.deadlineReached
report.activeRunsAtClose
report.abortedRuns
report.unsettledRuns         // > 0 nghĩa là có thứ gì đó phớt lờ tín hiệu huỷ
report.operations            // tóm tắt đóng theo từng thao tác
report.components            // báo cáo đóng theo từng thành phần
report.observationHealth     // số sự kiện và byte đã giữ/đã loại bỏ
```

Việc chấp nhận đóng là **nguyên tử**, tín hiệu huỷ được **tổ hợp**, các thế hệ
tới muộn bị **niêm phong**, bằng chứng đóng theo từng loại là **tất định**, một
tác vụ đóng chung duy nhất an toàn trước việc caller huỷ, và các logger trở thành
no-op sau khi đóng.

Hãy coi `unsettledRuns > 0` là một khiếm khuyết, không phải nhiễu.

## Đóng thứ bạn đã kết nối

Runtime đóng những gì nó **sở hữu**. Nó không bao giờ đóng một tài nguyên đang
mượn, và không bao giờ bịa ra hành động đóng cho thứ nó không chiếm giữ.

```ts
try {
  await runtime.close()          // làm lắng các lượt chạy trước
} finally {
  await mcp?.closeWithReport()   // rồi mới đóng thứ bạn đã kết nối
}
```

| Nhãn vòng đời | Ai đóng nó |
| --- | --- |
| `inert-value` | Không ai — không chiếm giữ tài nguyên nào |
| `inert-runtime-owned-registration` | Runtime gỡ phần đăng ký |
| `connected-caller-owned` | Bạn, **sau khi** đóng runtime |
| `borrowed-caller-owned` | Bạn; runtime chỉ dùng nó |
| `host-owned` | Bạn, và bạn đọc báo cáo trả về |
| `explicit-owned-or-borrowed` | Nêu rõ ngay lúc đăng ký |

Một observation exporter **thuộc sở hữu** sẽ được runtime đóng sau khi mọi lượt
chạy đang hoạt động lắng xuống. Cái **đang mượn** thì là của bạn.

## Lease thao tác

Runtime giữ một registry lease thao tác, bao phủ các lượt chạy agent, việc làm
mới danh mục, nén thủ công, và công việc của team. Chính nó cho phép `close()`
báo `activeRunsAtClose` và `unsettledRuns` một cách trung thực thay vì đoán, và
niêm phong các thế hệ tới muộn để một lượt chạy khởi động trong lúc shutdown
không thể lọt qua.

## Đọc tiếp

- [Production Deployment](/vi/10-advanced/production-deployment) — shutdown trên Edge, trình duyệt, và Node
- [Conditional Execution](/vi/06-workflows/conditional-execution) — `beforeStep` trong thực tế
- [Observability](/vi/10-advanced/observability) — mỗi pha phát ra sự kiện gì
