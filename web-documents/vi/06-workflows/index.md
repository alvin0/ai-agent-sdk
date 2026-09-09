# Workflows — Tổng quan

> **Không có workflow engine.** SDK không có `defineWorkflow()`, không có đồ thị
> bước, không có DSL, và không có bộ lập lịch nào bạn cấu hình theo kiểu khai
> báo. Tìm trong mã nguồn `defineWorkflow`, `createWorkflow`, hay `WorkflowStep`
> đều không ra kết quả.
>
> Thứ SDK có là các **nguyên thuỷ điều phối**: vòng lặp agent, lập lịch tool,
> agent team, turn hook, và ranh giới phê duyệt. Chương này trình bày cách dựng
> luồng tuần tự, song song, có điều kiện, và có người chốt từ chúng.

## Các nguyên thuỷ

| Bạn muốn | Nguyên thuỷ | Ở đâu |
| --- | --- | --- |
| Các bước theo thứ tự | `session.run()` nối tiếp, tool exclusive, rào chắn lập lịch | [Sequential](/vi/06-workflows/sequential-execution) |
| Các bước cùng lúc | `isConcurrencySafe`, `maxParallel`, `spawn_agent`, `wait_agents` | [Parallel](/vi/06-workflows/parallel-execution) |
| Một nhánh hoặc một cổng | `TurnHooks.beforeStep` → `StepDecision`, `toolChoice`, mã của bạn | [Conditional](/vi/06-workflows/conditional-execution) |
| Một con người quyết định | `createApprovalBroker()`, `mode: 'deep-human-in-loop'` | [Human Approval](/vi/06-workflows/human-approval) |
| Nhiều agent hợp tác | `AgentTeam`, dạng quản lý hoặc dựng sẵn | [Creating a Workflow](/vi/06-workflows/creating-a-workflow) |
| Một hợp đồng hoàn thành | `mode: 'deep'` và bài tự kiểm `submit_result` | [Creating a Workflow](/vi/06-workflows/creating-a-workflow) |

## Ai sở hữu luồng điều khiển

Đó mới là câu hỏi thật, và SDK cho bạn ba câu trả lời.

```text
┌─ MODEL quyết định ──────────────────────────────────────────────┐
│  runtime.agent({ tools, mode: 'deep' })                         │
│  createManagedAgentTeam({ lead })   → spawn_agent lúc chạy      │
│  Tốt nhất khi chưa biết trước hình dạng công việc.              │
└─────────────────────────────────────────────────────────────────┘
┌─ MÃ CỦA BẠN quyết định ─────────────────────────────────────────┐
│  await a.run(x); await b.run(y)                                  │
│  createDefinedAgentTeam({ members })                             │
│  hooks.beforeStep → { kind: 'reject' }                           │
│  Tốt nhất khi topology là kiến trúc, không phải chọn lúc chạy.   │
└─────────────────────────────────────────────────────────────────┘
┌─ MỘT CON NGƯỜI quyết định ──────────────────────────────────────┐
│  broker phê duyệt theo từng lời gọi tool                         │
│  mode: 'deep-human-in-loop' → request_user_input                 │
│  Tốt nhất khi quyết định quan trọng và chỉ đảo được bằng tay.    │
└─────────────────────────────────────────────────────────────────┘
```

Phần lớn hệ thống thật trộn cả ba: mã của bạn chốt topology, model quyết chiến
thuật bên trong đó, và một con người chốt các bước không thể đảo.

## Vì sao không có engine

Một engine khai báo sẽ phải sở hữu lịch sử, thử lại, huỷ, ngân sách, và lưu trữ
— đúng những thứ mà vòng lặp agent đã sở hữu, kèm chặn trên và khả năng quan sát.
Khi đó hai bộ lập lịch sẽ mâu thuẫn về việc ai đang cưỡng chế trần token.

Hệ quả cho bạn: **luồng điều khiển là TypeScript thông thường**. Nó kiểm thử được
bằng công cụ bạn vẫn dùng, và không cần một mô hình tư duy thứ hai.

```ts
// Một "workflow" chỉ là thế này.
const plan = await planner.run(objective)
const [review, tests] = await Promise.all([
  reviewer.run(plan.text),
  tester.run(plan.text),
])
const final = await lead.run(`Integrate:\n${review.text}\n${tests.text}`)
```

## SDK vẫn bảo đảm những gì

Bạn viết luồng, nhưng bạn không phải viết các hàng rào an toàn:

| Bảo đảm | Đến từ đâu |
| --- | --- |
| 16 bước model, 64 lời gọi tool, trần 500.000 token mỗi lượt chạy | Chặn trên vòng lặp, host cấu hình được |
| Phát hiện lặp y hệt và chu trình ngắn | Chặn trên vòng lặp |
| Mỗi hội thoại chỉ một lượt tại một thời điểm | Khoá loại trừ của session |
| Lời gọi song song không bao giờ vô tình chia sẻ trạng thái thay đổi được | `isConcurrencySafe` fail-closed |
| Việc huỷ tổ hợp qua runtime, lượt chạy, và tool | Tín hiệu được tổ hợp |
| Mọi bước đều có vết `traceId` / `spanId` / `parentSpanId` | Bus quan sát |
| Shutdown báo cáo công việc chưa lắng | `RuntimeCloseReport` |

## Trong chương này

| Trang | Trả lời |
| --- | --- |
| [Creating a Workflow](/vi/06-workflows/creating-a-workflow) | Chọn topology, và ba hình dạng ghép nối |
| [Sequential Execution](/vi/06-workflows/sequential-execution) | Thứ tự thực sự được giữ |
| [Parallel Execution](/vi/06-workflows/parallel-execution) | Đồng thời an toàn ngay từ mặc định |
| [Conditional Execution](/vi/06-workflows/conditional-execution) | Phân nhánh, chặn cổng, và từ chối một bước |
| [Human Approval](/vi/06-workflows/human-approval) | Chặn lại chờ người, và tiếp tục đúng cách |
