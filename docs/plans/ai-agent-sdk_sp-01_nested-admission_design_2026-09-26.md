# SP-01B — trace scheduler và owner của nested admission

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.

**Ngày:** 26/09/2026\
**Trạng thái:** bước (a)–(e) đã implement; architecture gate **đạt** — xem [§8](#8-bước-be-và-architecture-gate). Value gate xem [plan §10](ai-agent-sdk_hermes_openclaw_implementation-plan_2026-09-26.md#10-bước-tiếp-theo-sau-spike).\
**Source đọc:** SDK `5b589b6` + working tree hiện tại (wave-0 wording fix).\
**Phạm vi:** SP-01B.1–4 (trace, owner admission/accounting, cách đếm outer, serialization). Outer projection, output descriptor và handle store là bước (b)–(d).

## 1. Đường đi hiện tại của một tool call

```text
runTurn (loop/run-turn.ts)
  L324-326  remaining = maxToolCalls - toolCalls        ← counter của turn, tính trước step
  L349-373  guardDeclined ? 0 : onExhausted!=='continue' ? remaining : round.calls.length
            → dispatchLimit (cố định cho cả step)
  L366      runToolCalls({ dispatchLimit, catalog, history, interceptors, approvals, checkpoint, emit, ... })
  L403      toolCalls += scheduled.budgeted               ← chỉ cộng sau khi mọi call đã commit

runToolCalls (loop/schedule.ts)
  L102-171  exclusive: start → commit tuần tự; parallel: segment ≤ maxParallel, commit theo thứ tự model
  L108/134  start(..., hasBudget = budgeted < dispatchLimit)   ← counter `budgeted` là biến local
  start()
    L211-215  history.append(tool-call) + span-start + tool-call event
    L218-222  !hasBudget && !budgetExempt → declined, không dispatch
    L249-261  authorizeToolCall (pre-policy + approval) race với signal
    L267      checkpoint 'before-tool-dispatch'
    L277      dispatchAuthorizedToolCall → pending
    L283      budgeted: !exempt   ← budget chỉ tốn khi thực sự dispatch
  commit()
    L369-387  chờ body, finalizeToolCall (post-policy), teardown bounded
    L388      boundOutput (token budget → spill/truncate) + immutableResult (byte cap)
    L395-406  history.append(tool-result) + tool-result event + span-end + additionalContext

pipeline (tool/pipeline.ts)
  L91   prepareToolCall: catalog.get live, parse đúng một lần, mode
  L122  authorizeToolCall: before-chain, ask → broker
  L184  dispatchAuthorizedToolCall: around-chain → withTimeout → tool.execute(args, runContext)
  L192  runContext = position + callId/toolName/signal/logger/concludeTurn/addContext
  L262  finalizeToolCall: after-chain; replace/block dựng lại envelope (value bị bỏ)

accounting (define/session/trace-accounting.ts L9-27)
  span-start kind 'execute_tool' → startOperation('tool'); span-end → endOperation
```

## 2. Phát hiện

| ID | Phát hiện | Hệ quả cho PTC |
|---|---|---|
| F1 | Budget chia hai nơi: `remaining` tính ở run-turn trước step, `budgeted` đếm local trong `runToolCalls`, run-turn chỉ cộng sau khi step kết thúc. Tool body không có handle nào tới counter. | Mọi đường nested hiện tại buộc phải tạo counter thứ hai — đúng nguyên nhân fresh-session candidate chạy 10 bodies với limit 3. Cần một owner sống trong suốt step. |
| F2 | Budget chỉ tốn khi dispatch (sau authorize + checkpoint). Denied, approval deny, checkpoint lỗi không tốn. | Nested phải giữ đúng semantics này, không trừ lúc request. |
| F3 | `onExhausted: 'continue'` đặt `dispatchLimit = round.calls.length`. | Con số này vô nghĩa cho child calls; cần mode "không giới hạn budget" tường minh, program cap vẫn chặn. |
| F4 | Repeat/cycle/token guards tính trên model calls trước step; `guardDeclined` → limit 0. | Child calls không đi qua các guard này. Nếu guard chặn step, outer program bị declined nên không có child. |
| F5 | Không có semaphore toàn cục: exclusive = chạy tuần tự trong vòng lặp; parallel = segment giới hạn `maxParallel`. | Child chạy bên trong body của outer không chờ slot nào → không có deadlock A05 **trừ khi** thêm semaphore. Không thêm. |
| F6 | `start()`/`commit()` gộp admission với publication (history, events, spill). | Child phải dùng lại prepare/authorize/checkpoint/dispatch/finalize nhưng **không** append history hay spill. |
| F7 | Tool accounting suy ra từ span `execute_tool`. | Child span có `parentSpanId` = span outer → ledger đếm child mà không cần event type mới. |
| F8 | `ToolCatalog` là view live, không có revision; definition sau `captureToolDefinition` là object frozen. | Identity của definition dùng làm generation cho từng tên tool; không cần thêm catalog revision API. |
| F9 | `ToolRunContext` không có capability gọi tool khác. | Port nested phải do scheduler inject, chỉ cho tool host đã cấu hình. |
| F10 | Checkpoint `before-tool-dispatch` chỉ có `call` + `snapshot`. | Child checkpoint cần correlation tới outer call. |

## 3. Quyết định

**D1 — Owner duy nhất: `ToolAdmission` nội bộ trong `loop/`.** `runToolCalls` tạo một instance mỗi step từ `dispatchLimit` (hoặc mode `unbounded` khi `onExhausted: 'continue'`). `start()` và nested port cùng gọi instance đó; `ToolCallsOutcome.budgeted` đọc từ nó. Run-turn giữ nguyên `toolCalls += scheduled.budgeted`. Không export.

**D2 — Reserve → confirm → release.** Reserve trước authorization; confirm khi dispatch; release nếu declined/denied/checkpoint lỗi/abort trước dispatch. Với start tuần tự, kết quả trùng hành vi hiện tại (F2); vẫn đúng nếu sau này child chạy song song.

**D3 — Cách đếm.** Outer program tốn 1 budget như call thường; program tool **không được** `budgetExempt` (từ chối khi cấu hình). Mỗi child non-exempt được dispatch tốn 1 root budget. Program hard cap đếm **mọi child request** tới port, kể cả exempt, denied, lỗi args — chặn cả vòng lặp denial. Report benchmark tách `outer` và `children`.

**D4 — Serialization.** Port chỉ gắn khi outer có mode `exclusive` (mặc định nếu tool không khai `isConcurrencySafe`). MVP: tối đa một child in-flight (guest bridge đồng bộ). Không thêm semaphore → không deadlock (F5).

**D5 — Guards.** Repeat/cycle guard giữ ở mức model call. Child bị chặn bởi root budget, program cap, deadline outer và fatal latch.

**D6 — Đường nested.** Hàm nội bộ `runNestedToolCall(outer, request)` trong `schedule.ts`:
prepare → admission.reserve → authorize (cùng broker, cùng `approval-request` event) → checkpoint → dispatch → finalize → `immutableResult` (byte cap). Không `boundOutput`/spill, không history append, không `tool-call`/`tool-result` event. Emit `span-start`/`span-end` kind `execute_tool` với `parentSpanId` = span outer và attribute `sdk.tool.parent_call_id` (F7).

**D7 — Identity.** Child `callId` = `${outerCallId}:${seq}` do host tạo, không lấy từ guest. **Đã chốt:** checkpoint `before-tool-dispatch` thêm field optional `parentCallId`, chỉ có giá trị với child call. Additive nên consumer cũ không đổi; host có correlation chuẩn thay vì parse `callId`.

**D8 — Fatal latch.** Port latch khi: child pipeline throw fatal, teardown timeout, catalog stale, cap hết, outer abort. Sau latch mọi request bị từ chối. Outer body rethrow fatal đã latch sau khi teardown executor, để `commit()` xử lý như fatal thường. Guest `catch` không mở lại port.

**D9 — Authority và catalog generation.** Allowlist + `maxCalls` do host cấp qua option nội bộ của `RunToolCallsOptions` trong giai đoạn research (public surface chốt ở bước b). Khi tạo port: snapshot `catalog.get(name)` cho từng tên được phép. Trước dispatch **và** trước khi trả kết quả cho guest: kiểm lại identity; khác → `STALE_CATALOG` + latch (F8). Tool đăng ký sau không nằm trong snapshot → không gọi được.

**D10 — Kết quả cho guest.** Chỉ envelope đã finalize. `value` undefined sau policy replace → `STRUCTURED_OUTPUT_UNAVAILABLE`; lỗi → typed error code; không parse `content`.

**D11 — Cancellation.** Child signal = `AbortSignal.any([outer signal, port close])`. Port close chờ child in-flight tối đa `teardownTimeoutMs`; quá hạn → fatal `TEARDOWN_TIMEOUT`. Kết quả về sau close bị bỏ; span-end vẫn emit trạng thái `aborted` để đóng accounting.

## 4. Phủ architecture gate

| Case | Quyết định | Kiểm ở |
|---|---|---|
| PTC-A01 | D9 snapshot allowlist | Bước (a) implementation |
| PTC-A02 | D1–D3 cùng owner | Bước (a) implementation |
| PTC-A03 | D3 program cap đếm cả exempt | Bước (a) implementation |
| PTC-A04 | D10 + `finalizeToolCall` hiện có | Bước (a); matrix meta/context ở (b) |
| PTC-A05 | D4 exclusive outer, không semaphore | Bước (a) implementation |
| PTC-A06 | D11 drain; segment drain hiện có giữ nguyên | Bước (a) implementation |
| PTC-A07 | D6 dùng chung broker + D11 | Bước (a) implementation |
| PTC-A08 | Executor startup | Bước (e) |
| PTC-A09 | Executor limits | Bước (e) |
| PTC-A10 | Output descriptor/schema | Bước (c) |
| PTC-A11 | D8 latch | Bước (a) implementation |
| PTC-A12 | Handle store | Bước (d) |
| PTC-A13 | D9 recheck trước dispatch/publication | Bước (a) implementation |
| PTC-A14 | D1 refactor giữ hành vi; port chỉ tồn tại khi host bật | Bước (a) regression |
| PTC-A15 | Capture/MCP metadata | Bước (c) |

## 5. Việc chưa chốt (chuyển sang bước b–d)

- Public surface để host bật program (session option hay field trên `ToolDefinition`); D9 chỉ là option nội bộ.
- Outer `execute_program` trả gì cho model và history: projection cuối có giới hạn, phân biệt với receipt vận hành (bước b).
- Output schema owner và bảo toàn qua capture/MCP (bước c).
- Handle store owner/revision/TTL (bước d).

## 6. Thứ tự implementation đề xuất

1. **Tách `ToolAdmission`** giữ nguyên hành vi: unit test reserve/confirm/release, `continue` mode, exempt; chạy lại 8 file regression (217 → 221 tests hiện tại) và contract tests. Đây là thay đổi production source đầu tiên của SP-01: ghi fingerprint mới, không rerun live evaluation vì hành vi không đổi, nhưng phải có regression evidence.
2. **`runNestedToolCall` + port nội bộ**, test deterministic bằng tool body JavaScript thường gọi port (chưa QuickJS): A01–A07, A11, A13, A14.
3. Nối executor QuickJS research qua port ở bước (e); chỉ khi đó mới xét A08/A09.

Không public export, không package mới, không dependency mới trong các bước trên.

## 7. Kết quả implementation bước (a)

| File | Thay đổi |
|---|---|
| `packages/core/src/agent/loop/admission.ts` | Mới: `createToolAdmission` (reserve/confirm/release, `unbounded`) |
| `packages/core/src/agent/loop/schedule.ts` | `runToolCalls` giữ signature, gọi `scheduleToolCalls(options, internal)`; `start()` dùng admission; `ProgramRun` + port; `commit()` đóng port và rethrow fatal đã latch |
| `packages/core/src/agent/loop/run-turn.ts` | Gọi `scheduleToolCalls` với `admissionLimit` (`unbounded` khi `onExhausted: 'continue'`) |
| `packages/core/src/agent/loop/events.ts` | D7: `parentCallId?` trong checkpoint `before-tool-dispatch` |
| `packages/core/src/agent/tool/nested.ts` | Mới, nội bộ: `ProgramGrant`, `NestedToolPort`, error codes, `nestedToolPort(context)`; không export từ package entry |
| `packages/core/src/agent/tool/pipeline.ts` | Gắn port vào `ToolRunContext` của đúng outer call qua WeakMap |
| `tests/unit/nested-tool-admission.spec.ts` | 15 tests: admission + PTC-A01/02/03/04/05/07/11/13/14 + D7 |

Kết quả: 8-file regression 221/221 trước và sau refactor; unit toàn bộ 2868/2868; contract 57/57; root `tsc`, lint, core `check:types`/`check:publint`/`test:pack`, `check:docs`, `check:human` pass. Hai mutation (counter child riêng; bỏ recheck sau approval) đều bị test bắt. Evidence: [verification.json](../evaluations/sp-01-nested-admission-2026-09-26/verification.json).

Unit suite ban đầu fail 1 test `privacy-sentinel-policy` do literal `PRIVATE_SENTINEL` trong `tool-output-budget.spec.ts` (thay đổi wave 0, không phải bước này). Đã sửa thành `PRIVATE/SENTINEL` theo policy; không đổi assertion.

Giới hạn: test ở mức scheduler với program body JavaScript, chưa QuickJS; program chưa bật được qua AgentRuntime/session vì public enablement là bước (b). A04/A06/A14 mới partial; A08/A09/A10/A12/A15 chưa đánh giá. `architectureGatePassed` vẫn false, live benchmark vẫn tắt.

## 8. Bước (b)–(e) và architecture gate

**(b) Bật program qua AgentRuntime.** Runtime từ chối mọi option lạ, kể cả symbol key, nên không có cách nào chạy qua đường thật mà không có field public. Surface nhỏ nhất, mặc định tắt, có tiền tố để dễ gỡ:

- Session option `experimentalPrograms: [{ tool, allow, maxCalls }]`, được capture và validate ở runtime (tối đa 16 grant, 64 tool, `maxCalls` từ 1 đến 1000). Option đi qua composition → `AgentSession` → run-agent → run-turn → `scheduleToolCalls`.
- `experimentalNestedToolPort(context)` cùng các type `Experimental*` và `EXPERIMENTAL_NESTED_TOOL_ERROR_CODES` trong `@alvin0/ai-agent-sdk-core/agent` và `./tools`. Fixture public surface được regenerate sau khi review, chỉ thêm 8 tên.
- Outer projection: kết quả của program tool là tool result bình thường, nên vẫn chịu `maxToolResultTokens`, spill và post-policy như mọi call khác. Child không vào history.
- Exception thoát khỏi child pipeline (interceptor throw, teardown) bị latch thành fatal và làm fail turn, giống call do model phát ra.

**(c) Output contract.** Owner là `ToolDefinition.experimentalOutputSchema`:
- Được capture, detach, freeze và giới hạn size như `parameters`, và không bao giờ vào provider schema.
- MCP bridge map `outputSchema` của remote vào nửa `structuredContent` của value mà bridge trả về.
- Port validate value theo một subset JSON Schema (`output-schema.ts`). Value hợp lệ thì trả `validated`, sai schema thì trả `PROGRAM_OUTPUT_SCHEMA_MISMATCH`. Schema thiếu hoặc nằm ngoài subset thì value vẫn được trả nhưng đánh dấu `unchecked`, không bao giờ được coi là đã kiểm.
- `port.catalog()` trả descriptor theo thứ tự grant, lấy tại thời điểm program bắt đầu.

**(d) Handle store.** `ProgramResultStore` sống theo turn: tạo trong `runTurn` và đóng ở `finally`.
- Handle opaque, có owner là program tool, và gắn với identity của definition đã sinh ra value.
- Có TTL và cap theo từng entry lẫn tổng. Không evict handle còn sống.
- Load kiểm lại owner, TTL, store còn mở và catalog hiện tại, rồi trả kèm provenance do host ghi.

**(e) Executor.** QuickJS/WASM chạy trong Node worker (nay ở `samples/programmatic-tools/program-tool.ts` và `program-worker.mjs`; lúc chạy gate nằm ở `test-human/spikes/`).
- Worker chỉ lo cô lập và giới hạn tài nguyên. Mọi authority nằm ở port.
- Program là thân một hàm đồng bộ. Probe cho thấy gọi asyncified host call bên trong QuickJS job làm hỏng stack WASM, nên code có `async`/`await` bị từ chối bằng `PROGRAM_ASYNC_UNSUPPORTED`.

**Architecture gate: đạt 15/15** ([gates.json](../evaluations/sp-01-architecture-gate-2026-09-26/gates.json)).
- 13 case chạy qua AgentRuntime + worker thật ([conformance-summary.json](../evaluations/sp-01-architecture-gate-2026-09-26/conformance-summary.json)).
- A13 có proof ở scheduler; qua runtime thì catalog được snapshot theo run nên không thể đổi giữa chừng.
- A15 có proof ở capture/provider wire/MCP.
- Regression lúc chốt gate: unit 2942/2942, contract 57/57; root `tsc`, lint, docs, human coverage và pack của core/MCP đều pass.

Giới hạn: không đo và không claim giới hạn RSS tổng; mỗi program chỉ có một child in-flight; chỉ hỗ trợ program đồng bộ. Gate này là conformance, không nói gì về chất lượng hay chi phí.
