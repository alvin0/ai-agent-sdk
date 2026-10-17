# Nâng cấp lên 0.1.13

Nâng cấp đồng loạt các package SDK lên **0.1.13**. Workspace có 28 manifest
package, trong đó 27 package được publish; `testkit` vẫn là private. Một lần push
lên `main` kích hoạt bước publish có kiểm soát, còn chạy Release thủ công mặc
định là dry run. Kiểm tra local không chứng minh việc publish lên npm hay CI
hosted đã thành công.

Mục 0.1.13 trong `CHANGELOG.md` của repository là nguồn chính thức. Trang này
liệt kê những gì host cần kiểm tra.

## Các giới hạn dừng lượt chạy giờ là tự chọn

Một lượt chạy không còn dừng giữa chừng vì một giới hạn số lượng, chống lặp hay
thời gian mặc định. Mỗi giới hạn dưới đây chỉ áp dụng khi bạn đặt một con số.

| Thiết lập | Mặc định cũ | Mặc định 0.1.13 |
| --- | --- | --- |
| `maxTurns` / `maxSteps` | 16 | `'auto'` (không trần) |
| `maxToolCalls` | 64 | `'auto'` |
| Run ledger `maxModelCalls`, `maxAttemptsPerCall`, `maxToolCalls`, `maxSerializedBytes` | 1.024 / 16 / 10.000 / 16 MiB | không giới hạn |
| `repeatToolLimit`, `toolCycleLimit`, `maxConsecutiveToolErrors` | 6 / 3 / 8 | `'auto'` (chỉ cảnh báo) |
| `maxModelStreamEvents` | 100.000 | không giới hạn (số byte phản hồi vẫn chặn bộ nhớ) |

Muốn giữ trần, hãy đặt rõ:

```ts
const session = agent.createSession({
  registry,
  runtimeLimits: { repeatToolLimit: 6, maxConsecutiveToolErrors: 5, modelTimeoutMs: 600_000 },
  ledgerLimits: { maxModelCalls: 1_024 },
})
const bounded = agent.with({ maxTurns: 16, maxToolCalls: 64 })
```

Các chốt chống lặp vẫn điều hướng model. Nhắc nhở lặp y hệt và chu trình giờ
bắn ở mỗi bội số của `repeatToolWarningAt` (mặc định 3) và `toolCycleWarningAt`
(mặc định 2). Tùy chọn mới `consecutiveToolErrorWarningAt` (mặc định 4) bảo model
đổi cách làm sau nhiều lỗi tool liên tiếp. Code dựa vào outcome
`budget-exhausted` với `budget: 'repeated-tool-call'`, `'tool-call-cycle'`,
`'consecutive-tool-errors'`, `'tool-calls'` hoặc `'steps'` chỉ thấy nó khi giới
hạn tương ứng được đặt.

## Không còn deadline mặc định cho công việc của agent

Các tùy chọn sau không còn deadline mặc định. Đặt tùy chọn để khôi phục.

| Tùy chọn | Mặc định cũ |
| --- | --- |
| `runtimeLimits.modelTimeoutMs` (tổng lời gọi model) | 10 phút |
| `runtimeLimits.maxToolDurationMs`, bước `runToolCalls`, `defaultTimeoutMs` của `dispatchToolCall` | 10 phút |
| `runtimeLimits.hookTimeoutMs` | 10 phút |
| `runtimeLimits.userInputTimeoutMs` (`request_user_input`) | 10 phút |
| Managed `workerTimeoutMs`, `spawnTimeoutMs`; collaboration `joinTimeoutMs` | 10 phút / 30 giây / theo worker timeout |
| Team `operationTimeoutMs`, `waitTimeoutMs` (`wait_agents`, `awaitWorker`) | 10 phút / 120 giây |
| HTTP transport `requestTimeoutMs` | 10 phút |
| Compaction `summaryTimeoutMs`; skill `operationTimeoutMs`; callback memory | 10 phút / 120 giây / 30 giây |
| MCP client `toolCallTimeoutMs`, `operationTimeoutMs` (kể cả HTTP/SSE) | 120 giây |
| MCP server `operationTimeoutMs`; A2A client `timeoutMs`; A2A server `taskTimeoutMs` | 10 phút / 120 giây / 10 phút |
| Decision adapter `timeoutMs`; `requestTimeoutMs` của OpenAI và TypeSafe decision | 30 giây |

Nơi thư viện bắt buộc một con số, mặc định là giá trị tối đa của timer,
2.147.483.647 ms. Deadline tự chọn lớn hơn giá trị đó bị từ chối (`timeoutMs` của
tool thì bị kẹp lại), vì nếu không timer sẽ bắn sau 1 ms.

Kết nối treo vẫn bị phát hiện. Tùy chọn mới `runtimeLimits.modelIdleTimeoutMs`
(mặc định 10 phút) được đặt lại ở mỗi chunk của stream và chỉ cắt một stream
model đã im lặng. Provider HTTP giữ `streamIdleTimeoutMs`. Các chặn trên cho
teardown, dispose, close, observer và setup credential/catalog không đổi.

Một lần chờ không có deadline vẫn kết thúc: `wait_agents` trả về khi các target
kết thúc, khi có input mới điều hướng bên gọi (`interrupted: true`), hoặc khi
lượt chạy bị huỷ. `timeout_ms` do model yêu cầu vẫn có mức sàn 10 giây
(`DEFAULT_MIN_WAIT_TIMEOUT_MS`).

## Export và tùy chọn bị xoá

- `holdWaitMs` (bị bỏ qua từ khi chuyển sang điều phối theo sự kiện) bị xoá khỏi
  `ManagedAgentTeamOptions`. Hãy xoá nó khỏi code host.
- `DEFAULT_HOLD_WAIT_MS` và `DEFAULT_WAIT_TIMEOUT_MS` không còn được export.
- `AgentTeam.recordTimeline` và `observeSession` bị xoá. Dùng
  `onEvent`/`subscribe` và `snapshot()`.

## Managed team

Hướng dẫn `docs/multi-agent.md` trong repository (mục Migrate from 0.1.12) có
bảng đầy đủ. Tóm tắt:

- Bề mặt tool mặc định là lean: `spawn_agent`, `spawn_agents`, `send_input`,
  `wait_agents`, `close_agent` và `get_agent_result` có phân trang. Đặt
  `modelToolSurface: 'legacy'` để dùng tên và schema tool cũ.
- Catalog của agent dẫn dắt dành riêng `spawn_agents` và `progress_updates`.
  Đổi tên tool host trùng tên, hoặc đặt `progressUpdates: false`.
- Hướng dẫn mặc định phân công chủ động và worker sinh ra kế thừa các tool đủ
  điều kiện của agent dẫn dắt. Dùng `delegationMode: 'explicit'` và
  `inheritLeadTools: false` để tắt.
- Worker đã xong tự giải phóng slot. `close_agent` ở bề mặt lean huỷ công việc
  chưa xong trừ khi tắt quyền huỷ của model.
- `run()` của managed team chờ tới bước tổng hợp. Khi agent dẫn dắt cứ nhường
  lượt mà không có báo cáo worker mới, lượt chạy giờ trả về câu trả lời gần nhất
  của agent dẫn dắt và ghi budget `synthesis` là đã cạn, thay vì thất bại.
- Lời gọi `spawn_agents` bị abort trả về địa chỉ worker với `cancelled: true`.
- `stopProgressUpdates(reason)` chỉ nhận `host` (mặc định), `run-ended` hoặc
  `aborted`.
- Tùy chọn mới: `AgentTeamOptions.mailboxOverflow` (mặc định `'reject'`; control
  plane của managed team mặc định `'evict-oldest'`) và
  `ManagedAgentTeamOptions.maxRetainedWorkers` (mặc định 256).

## Bổ sung event và hook

- `AgentTeamEvent` thêm `team-timeline` và `team-progress`;
  `RuntimeAgentTeamEvent` thêm `team-progress`. Các switch vét cạn phải xử lý
  chúng hoặc giữ nhánh default.
- `onTurnEnd` có thể trả về `{ kind: 'yield' }`; `lastOutcome().yielded` báo lại.
- `member-run-end` và `member-run-error` mang `response` của thành viên;
  `AgentMemberOutcome` thêm `status` và `structured`.

## Ghi JSON trong workspace

Sample chat và các tool workspace của agentcode từ chối nội dung `.json` không
hợp lệ trước khi ghi. Đặt `validateJsonWrites: false` để tắt, hoặc dùng hook
`validateJsonFileContent` của core trong tool tuỳ biến.

## Checklist

1. Nâng cấp mọi package `@alvin0/ai-agent-sdk-*` lên 0.1.13 cùng lúc.
2. Quyết định deployment của bạn cần giới hạn và deadline nào, rồi đặt chúng.
3. Xoá `holdWaitMs` và các hằng số đã bị xoá.
4. Xử lý `team-timeline` / `team-progress` trong các switch event vét cạn.
5. Đổi tên tool host tên `spawn_agents` hoặc `progress_updates`.
6. Chạy bộ test; các outcome dựa vào giới hạn mặc định sẽ thay đổi.

## Đọc tiếp

- [Hiệu năng và giới hạn](/vi/10-advanced/performance)
- [Thực thi song song](/vi/06-workflows/parallel-execution)
- [Tham chiếu API Agent](/vi/13-api-reference/agent)
- [Nâng cấp lên 0.1.12](/vi/01-introduction/upgrading-to-0-1-12)
