# PTC quick plan — mutation, async guest, continuation

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.

**Ngày:** 27/09/2026\
**Nguyên tắc:** SDK chỉ cung cấp móc (seam) cho hệ thống của host. Không đưa durable runner, policy engine hay executor vào core. Mọi quyền và quyết định an toàn vẫn thuộc host, thông qua các interceptor, store và grant sẵn có.\
**Nền:** [nested admission design](ai-agent-sdk_sp-01_nested-admission_design_2026-09-26.md), [closeout](ai-agent-sdk_spike_closeout_2026-09-26.md).

| ID | Hạng mục | Quyết định | Phần thay đổi trong SDK |
|---|---|---|---|
| Q1 | Program gọi tool có side effect | **Cho phép, qua đúng các móc hiện có.** Child đã đi qua pre-policy, approval, execution interceptor/journal và post-policy. Host chặn mutation bằng interceptor `before`, không cần cơ chế mới. Thiếu duy nhất một thứ: interceptor và journal không phân biệt được child với call thường, nên không scope được operation ID. | Thêm field optional `parentCallId` vào `ToolCallContext`, chỉ có giá trị với child. Không thêm flag hay API mới. |
| Q2 | Guest async (`await`, `Promise.all`) | **Làm ở executor sample, không đụng core.** Executor v2 dùng QuickJS thường, không dùng asyncify: `callTool` trả Promise, host resolve rồi chạy `executePendingJobs`. Child vẫn chạy lần lượt ở executor, vì port chỉ cho một child in-flight. | Không có |
| Q3 | Continuation (program chạy tiếp sau khi turn kết thúc hoặc process restart) | **Không đưa vào SDK.** Chạy tiếp một program là việc của durable runner phía host. SDK đã có đủ móc: operation ID ổn định của child (`outer:seq`), `parentCallId` trong checkpoint và context, journal SP-02, handle store theo turn. Host muốn resume thì chạy lại outer call với cùng operation ID; journal trả kết quả child đã completed mà không chạy lại. | Không có (chỉ ghi quyết định) |
| Q4 | Nhiều child song song | **Hoãn.** Chưa có consumer; nếu làm sẽ phải khóa lại semantics admission và serialization. | Không có |

## Acceptance

| ID | Kiểm | Oracle |
|---|---|---|
| Q1-A | Program gọi tool mutation qua `createToolExecutionInterceptor` + journal SP-02 | Effect đúng 1 lần; operation ID do host lấy từ `parentCallId` + `callId`; kết quả `unknown` làm port latch và turn fail |
| Q1-B | Chạy lại cùng outer call ID sau khi child đã completed | Journal trả kết quả đã lưu; body không chạy lại |
| Q1-C | Interceptor `before` từ chối mutation khi có `parentCallId` | Program nhận `TOOL_DENIED`; effect 0 |
| Q1-D | Call thường (không phải child) | `parentCallId` là `undefined`; hành vi cũ giữ nguyên |
| Q2-A | `await callTool`, async IIFE, `Promise.all` với 3 call | Kết quả đúng; child chạy lần lượt; không có `CALL_IN_FLIGHT` lộ ra guest |
| Q2-B | Các case A01–A14 chạy lại với executor v2 | Conformance pass |
| Q2-C | Promise không bao giờ settle; CPU loop trong async | `PROGRAM_PENDING` hoặc deadline; worker bị terminate |

Gate: unit, contract, `tsc`, lint, conformance cho cả hai executor. Public surface chỉ thêm một field optional trong type `ToolCallContext`; fixture sẽ được regenerate sau review.

## Kết quả (27/09)

| ID | Trạng thái | Evidence |
|---|---|---|
| Q1-A…D | Pass: 4/4 | `tests/unit/nested-tool-mutation.spec.ts`. Test cho thấy có hai mô hình journal, host chọn qua cùng một móc: journal cả program (chạy lại thì trả kết quả program đã lưu) hoặc chỉ journal child (chạy lại thì child lấy từ journal) |
| Q2-A…C | Pass: conformance async 14/14, trong đó có Q2-A; conformance sync 13/13 | `test-human/spikes/ptc-conformance.ts --executor async\|sync`. Mutation "bỏ hàng đợi tuần tự" làm Q2-A fail |
| Q3 | Quyết định: không đưa vào SDK | README sample, mục "Programs that change state" |
| Q4 | Hoãn | — |

Thay đổi public: chỉ thêm field optional `ToolCallContext.parentCallId`, fixture surface đã regenerate. Executor mặc định vẫn là `sync`.
