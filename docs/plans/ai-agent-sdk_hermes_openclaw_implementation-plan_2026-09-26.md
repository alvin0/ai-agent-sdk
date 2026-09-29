# Kế hoạch cải tiến SDK từ audit Hermes và OpenClaw

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.

**Ngày:** 26/09/2026  
**Trạng thái:** hoàn tất implementation và kiểm chứng trong phạm vi đã chọn. PTC experimental opt-in; SP-02 host sample. [Audit sửa lỗi](ai-agent-sdk_deep-audit_fixes_2026-09-27.md) và [closeout cuối](ai-agent-sdk_plan-completion_2026-09-27.md) có source fingerprints và current-source evidence; benchmark lịch sử vẫn chỉ áp dụng source đã pin.
**Điểm hiện tại:** original/final, hai model, en/vi, independent prose review và raw-loss audit đã hoàn tất. Codex FILTER/JOIN đạt value gate; ZenMux không đạt quality/usage gate. Không mở rộng kết luận thành superiority hoặc mọi model/workload. Xem [closeout cuối](ai-agent-sdk_plan-completion_2026-09-27.md).\
**Tài liệu nền:** [Source audit 24/09](ai-agent-sdk_hermes_openclaw_source-audit_2026-09-24.md).  
**Đánh giá bắt buộc:** [Test specification trung lập trước/sau](ai-agent-sdk_neutral_before-after_evaluation_2026-09-26.md).  
**Bằng chứng thực thi:** [Baseline execution và applicability](ai-agent-sdk_baseline_execution_2026-09-26.md).
**Mục tiêu:** sửa một vấn đề recovery đã tái hiện, kiểm chứng PTC read-only, và kiểm chứng operation persistence qua process restart trước khi mở rộng tính năng.

## 1. Phạm vi và thứ tự thực hiện

| Đợt | Công việc | Kết quả cần có | Điều kiện chuyển tiếp |
|---|---|---|---|
| EV-00 | Thiết kế/triển khai task suite trung lập, grader và baseline | Coverage 10 chuyên mục, fixtures/oracle/config frozen, baseline trước sửa | Harness/self-tests pass; baseline và applicability có evidence |
| 0 | Inventory và sửa hướng dẫn recovery output | Không khuyến khích chạy lại side effect chỉ vì mất output | Regression và các test liên quan pass |
| 1 | SP-01: spike PTC read-only | Prototype qua đường AgentRuntime thực; benchmark với agent thường đã bật spill | Architecture gate pass trước live benchmark; quality/cost gate quyết định productization |
| 2 | SP-02: spike durable operation | Store thật, stable operation identity, test hai process và kill/restart | Recovery semantics được chứng minh ở boundary thực |
| 3 | Productize phần đã qua gate | API nhỏ, opt-in, sample, docs, packed-runtime checks | Chỉ lấy phần có bằng chứng; không tự thêm feature phụ |
| Theo nhu cầu | SP-03 recall; SP-04 process environment; SP-05 skill proposal | Spike riêng khi có consumer cụ thể | Không đưa thành dependency bắt buộc của core |

EV-00, đợt 0 và các spike là công việc cần thực hiện theo kế hoạch này. Productization là nhánh có điều kiện: spike có thể kết luận `no-go` hoặc `needs-review`. Không xem kết quả đó là lý do bỏ qua gate để hoàn thành feature list. EV-00 phải freeze dataset/oracle/config và thu baseline trước mọi thay đổi production behavior; baseline unit hiện có không thay task evaluation.

Thực hiện theo thứ tự; SP-01 không cần chờ SP-02 vì MVP chỉ dùng read-only tools. SP-02 kiểm chứng recovery nền tảng riêng, không dùng kết quả đó để tự mở mutation trong PTC.

Chưa triển khai: detached PTC continuation, nested subagents, durable runner/cron, vector recall, auto-publish skill, nhiều executor hoặc nhiều process backend. Không thay team, approval broker, compaction router hay execution contract hiện có.

## 2. Baseline và bằng chứng hiện tại

| Repository | Commit local đã đối chiếu |
|---|---|
| SDK | `5b589b6abe6d0a61da3f55b549713456ccc8c7c4` |
| OpenClaw | `37259b7cab6b1816211d381200848048a05f197d` |
| Hermes | `9fc7f17906eab1dd81ddfdf8a1edeecac1e79940` |

Trước implementation phải ghi full SHA và dirty diff thực tế. Hai source upstream mới hơn các commit trong source audit; giữ cả mốc audit và mốc reference của spike. Không pull hoặc đổi checkout chỉ để cập nhật reference.

Review ngày 26/09 đã chạy 8 file test, **217 test pass**:

```sh
rtk proxy pnpm exec vitest run \
  tests/unit/tool-execution.spec.ts \
  tests/unit/tool-pipeline.spec.ts \
  tests/unit/tool-loop.spec.ts \
  tests/unit/tool-output-budget.spec.ts \
  tests/unit/memory-compaction.spec.ts \
  tests/unit/compaction-usage-stop.spec.ts \
  tests/unit/team-delegation-contract.spec.ts \
  tests/unit/chat-agents-approval-rules.spec.ts
```

Đã tái hiện bằng `createMemorySpillStore({ maxEntries: 1 })`: save receipt của thao tác tạo dữ liệu, save output thứ hai để evict receipt, rồi gọi `read_tool_output` với locator cũ. Kết quả gợi ý chạy lại original call dù output gốc thuộc thao tác đã hoàn tất. Đây là bằng chứng về lời hướng dẫn recovery không phù hợp; chưa chứng minh model thực tế đã gây side effect trùng.

Chưa có: benchmark LLM PTC, database crash test, kiểm thử isolation guest, remote/container conformance hoặc số liệu self-learning. Kết quả unit test không thay thế những bằng chứng này.

### 2.1. Inventory phải giữ đúng

| Năng lực | Hiện trạng | Phần cần kiểm chứng/thêm |
|---|---|---|
| Execution backend | `ToolExecutionBackend`, interceptor và trusted identity đã có | Adapter cụ thể khi có consumer |
| Operation journal | `ToolExecutionStore`, claimed/completed/unknown/conflict đã có | Store durable và tích hợp checkpoint thật |
| Approval | Broker và persistence seam đã có | Khôi phục waiter/quyết định theo identity hiện tại; không reuse capability cũ |
| Output lớn | Text spill/read/search và sample file store đã có | Recovery an toàn; structured JSON handles cho PTC |
| Output contract | Core `ToolSchema` mô tả input; MCP protocol có `outputSchema` | Metadata output cho program catalog và bảo toàn qua capture/bridge |
| Session/team | Snapshot, memory binding, managed team đã có | Không xem live promise/team là durable runner |
| Compaction | Summarization provider/model/effort riêng đã có | Không tạo router mới chỉ cho compaction |

Điểm đọc source chính: [execution](../../packages/core/src/agent/tool/execution.ts), [pipeline](../../packages/core/src/agent/tool/pipeline.ts), [scheduler](../../packages/core/src/agent/loop/schedule.ts), [spill](../../packages/core/src/agent/tool/output-budget.ts), [tool capture](../../packages/core/src/agent/tool/capture.ts), [source snapshot](../../packages/core/src/agent/tool/source-types.ts), [MCP bridge](../../packages/mcp/src/client/connection.ts).

Các reference upstream phải đọc lại ở commit đã pin khi thực hiện spike:

| Spike | Source tham khảo trong checkout `.temp` | Semantics cần lấy |
|---|---|---|
| SP-01 | OpenClaw `src/agents/code-mode-tool-api.ts`, `code-mode-bridge.ts`, `docs/tools/code-mode/executors.md`; Hermes `tools/code_execution_rpc.py` | Output contract/unknown, nested bridge, guest boundary, call cap và cấm process detached |
| SP-02 | SDK `tool-execution.spec.ts`; OpenClaw `src/gateway/session-lifecycle-state.ts` | Unknown/conflict; writer ownership và late settlement, không copy gateway |
| SP-03 | Hermes `tools/session_search_tool.py`; OpenClaw `extensions/memory-core/src/tools.ts`, `src/memory/memory-artifact-provenance.ts` | Lineage/undo, host corpus, provenance |
| SP-04 | Hermes `tools/environments/base.py`; OpenClaw `src/agents/sandbox/backend-handle.types.ts` | Partial output sau timeout, acquire/launch/cleanup và retired authority |
| SP-05 | Hermes `tools/skill_manager_guards.py`, `agent/curator.py`; OpenClaw `src/skills/workshop/experience-review.ts`, `service-evaluation.ts` | Actor/action guards, revision/evaluation và commit authority |

Chuyển semantics/test trước. Nếu port code, ghi nguồn/commit và kiểm notice/dependency license của phần đó; không coi cùng TypeScript hoặc root MIT là đủ để import nguyên application module.

## 3. Invariants áp dụng cho mọi đợt

1. Identity, scope, operation ID và tool grants do host cấp; model args hoặc retrieved content không cấp authority.
2. Tool con đi qua prepare, pre-policy, approval, execution/backend/journal và post-policy. Guest chỉ nhận envelope đã qua post-policy.
3. Budget thuộc lượt chạy gốc. Không cấp budget mới cho mỗi chương trình hoặc mỗi call con; không để `budgetExempt` tạo vòng lặp không giới hạn.
4. Audit operational đầy đủ, còn projection cho LLM có thể ngắn. Không giảm token bằng cách bỏ receipts, accounting hoặc trace.
5. Output mất, timeout, disconnect và delivery error không tự cấp quyền retry side effect. Outcome unknown phải được reconcile.
6. Isolation/executor thiếu thì lỗi rõ; không fallback từ isolated guest sang host execution.
7. Authority bị thu hồi trong lúc await phải được kiểm lại trước dispatch và publication. Cancel không có nghĩa remote side effect chắc chắn đã dừng.
8. Core vẫn portable. Guest workers, filesystem và database nằm ở adapter/runtime phù hợp; consumer bình thường không cần chúng.
9. Prompt/tool catalog và dữ liệu cũ không được rewrite tùy tiện giữa run. Metadata discovery phải bounded, deterministic và gắn catalog revision.
10. Định dạng hợp lệ, task thành công, tiết kiệm chi phí và mức isolation là các kết luận riêng; không dùng một kết quả để thay thế các kết luận còn lại.

## 4. Đợt 0 — output recovery và inventory

### 4.1. Thay đổi cụ thể

- Trong `output-budget.ts`, thay lời nhắc chạy lại original call khi locator expired/unknown bằng thông báo output không còn khả dụng và hướng recovery dựa trên receipt/trạng thái đã lưu.
- Trong `schedule.ts`, sửa lời nhắc `Re-run more narrowly` khi truncate hoặc spill thất bại theo cùng semantics.
- Không suy ra retry-safe từ tên tool, `isConcurrencySafe`, HTTP method hoặc MCP annotation chưa được host tin cậy.
- Ưu tiên lời nhắc trung tính ở đợt này: không thêm public flag retry/idempotency chỉ để sửa câu hướng dẫn. Chỉ thiết kế metadata mới nếu spike có consumer cần nó.
- Giữ output preview, locator, pagination và fallback truncate. Mất output không đổi một thao tác thành failed/unknown nếu receipt đã chứng minh completed.
- Bổ sung inventory của audit: text spill đã có; JSON object handles và cross-session recall vẫn là trách nhiệm khác.

Ví dụ recovery mong muốn: “Saved output is unavailable. This does not mean the original operation failed. Check an existing receipt or current state; repeat the operation only when the host confirms it is safe.” Câu chữ cuối có thể ngắn hơn nhưng phải giữ semantics.

### 4.2. Acceptance

| ID | Tình huống | Kết quả bắt buộc |
|---|---|---|
| OUT-01 | Locator evicted, tool gốc có side effect | Không khuyến khích retry trực tiếp; execute count không tăng chỉ vì đọc output |
| OUT-02 | Locator còn tồn tại | Read/search/pagination trả output đúng như trước |
| OUT-03 | Spill save lỗi | Preview/truncation hoạt động; recovery không mặc định rerun |
| OUT-04 | Truncate không có store | Nội dung có marker rõ; không gợi ý retry side effect vô điều kiện |
| OUT-05 | Kết quả đã bị post-policy redact | Spill và read không chứa sentinel bị cấm |

Mở rộng test hiện hữu, ưu tiên assertion hành vi: expiry không chạy body, truncate không mất trạng thái completed và post-policy không bị bypass. Tránh snapshot toàn bộ câu văn.

**Gate:** targeted output/pipeline/loop/execution tests pass; inventory phản ánh public source hiện tại. Sau đó chuyển SP-01. Không cần database hoặc guest executor ở đợt này.

## 5. SP-01 — programmatic tool calling read-only

### 5.1. Câu hỏi cần trả lời

PTC có giảm tổng chi phí trên workflow lọc/nối dữ liệu so với agent thường đã dùng spill, trong khi giữ task correctness, root budget, policy, cancellation và audit hay không?

Spike có hai gate độc lập:

- **Architecture gate:** tích hợp đúng boundary và runtime, không dựa vào helper gọi trực tiếp `tool.execute`.
- **Value gate:** đo trên workload/model đã cố định; không suy rộng kết quả sang mọi agent.

### 5.2. MVP và kiến trúc thử nghiệm

Host Node cho prototype đầu tiên; bridge và các contract dữ liệu giữ portable. Thử **một executor QuickJS trong worker với WASM guest**, dependency/version/license được kiểm trước khi cài. Đây là hướng thử nghiệm, chưa phải quyết định public package hoặc cam kết isolation đã được chứng minh. Nếu dependency không đáp ứng limits/lifecycle, báo `needs-review`; không dùng Node VM thay thế rồi tuyên bố cùng mức bảo vệ.

Chỉ có: plain JavaScript, lossless JSON, host allowlist read-only, giới hạn runtime/calls/output/JSON retention và một projection cuối. Không ambient filesystem/network/env/module loading; external action chỉ đi qua tool bridge. Không continuation/detach, subagents, mutations, cron hoặc secret passthrough.

```text
AgentRuntime / session / run hiện tại
  → execute_program được host bật cho run
      → owner + catalog revision + root admission/accounting
      → isolated guest
          → call con do host cấp identity
          → validate args theo contract của tool
          → policy + approval + checkpoint
          → execution interceptor/backend
          → post-policy + byte/resource bounds
          → operational receipt/trace
          → trả dữ liệu được phép cho guest
      → projection cuối có giới hạn cho LLM
```

`execute_program`, `ProgramResultStore` và `NestedToolAdmission` trong plan là tên trách nhiệm đề xuất, chưa phải API được chốt. Chỉ tạo public export sau khi có implementation consumer và packed-runtime proof.

### 5.3. Các bước thực hiện

**SP-01A — output contract và dữ liệu có cấu trúc**

1. Dùng local tools có output JSON schema rõ; thêm MCP fixture có `structuredContent` và schema, không gọi service production.
2. Thử metadata output optional ở tool definition hoặc catalog descriptor do host cấp. So sánh vị trí với trách nhiệm hiện có, chọn một owner duy nhất.
3. Nếu đặt ở definition, phải bảo toàn qua `captureToolDefinition`, catalog snapshot và MCP bridge; freeze/detach và áp dụng schema size/depth limits. Không chỉ sửa interface TypeScript.
4. Giữ provider-facing input schemas như hiện tại; output metadata phục vụ program discovery, không gửi thêm field không được provider hỗ trợ.
5. Thiếu schema/unsupported shape trả `unknown`; không quảng bá typed output từ dữ liệu chưa được kiểm. Unsupported schema không mặc định coi result hợp lệ.
6. Metadata mô tả contract không tự chứng minh dữ liệu runtime đúng. Thử validation của structured result theo schema được host chấp nhận; ghi rõ cách xử lý schema không hỗ trợ.
7. Post-policy replace có thể xóa `value`; guest không được lấy raw value cũ, hoặc tự parse rendered text để khôi phục dữ liệu đã redact. Trả representation được policy cho phép hoặc lỗi typed rõ.
8. Thử JSON result store riêng: opaque handle gắn owner/revision, read/delete bounded, TTL/close cleanup, per-entry và aggregate retention cap, provenance do host quản lý. Text spill hiện có tiếp tục phục vụ LLM output; không biến text thành structured JSON bằng đoán schema.

**SP-01B — nested admission**

1. Trace scheduler hiện tại từ AgentRuntime đến call body/finalization trước refactor.
2. Tách hoặc dùng lại một owner của admission/accounting. Port caller phải dùng đúng owner đó; không tạo scheduler thứ hai với counter riêng.
3. Outer call có bookkeeping riêng; tổng child calls phải tiêu thụ root tool budget, đồng thời có hard program call cap áp dụng cả tool budget-exempt. Chốt cách đếm outer call trong kết quả benchmark.
4. Chốt serialization: outer program không giữ execution slot khiến child chờ chính slot đó. Test exclusive/parallel và limits qua cùng đường production.
5. Child call có identity host-generated, parent correlation, result receipt và accounting. Args đi qua parser/validator hiện hữu; không giả định JSON Schema tự được validate nếu tool không có parser tương ứng.
6. Giữ operational receipts ngoài model-visible intermediate transcript. Không tạo history với cặp assistant/tool thiếu liên kết chỉ để giấu intermediate data.
7. Latch các lỗi phải dừng ở host: revoked owner, exhausted hard cap, fatal/unknown operation, teardown failure. Guest `catch` không mở lại admission hoặc biến unknown thành retry-safe.

**SP-01C — executor và limits**

1. Enforce wall-clock deadline kể cả synchronous loop; terminate worker khi cần.
2. Bound input bytes, reply inbox, structured data, emitted output và retained handles trước khi copy/serialize lớn. Ghi riêng guest heap, worker/host memory nếu đo được; không nói guest memory limit là total RSS limit.
3. Nested results đến guest nguyên vẹn hoặc resource error; không cắt JSON rồi đưa vào chương trình như object hợp lệ.
4. Abort trong acquire, tool dispatch, approval wait và finalization; drain owned child calls; close/cleanup idempotent và bounded.
5. Revalidate owner/capability sau await; reject stale handles hoặc late publication. Phân biệt dừng worker với trạng thái remote tool.

**SP-01D — integration và live benchmark**

1. Chạy deterministic conformance trước; không dùng LLM để phát hiện boundary cơ bản.
2. Chạy AgentRuntime/session thật với synthetic tools; bật interceptor, checkpoint, logging/accounting và approval broker của fixture.
3. Chỉ sau architecture gate mới chạy paired live benchmark. Không thay model/prompt/dataset sau khi thấy kết quả của một nhánh mà không tạo version benchmark mới.

### 5.4. Acceptance bắt buộc

| ID | Case | Oracle |
|---|---|---|
| PTC-A01 | Guest gọi tool ngoài allowlist, kể cả tool mới được đăng ký sau capture | Body không chạy; không mở rộng authority ngầm |
| PTC-A02 | Root còn 3 calls, guest yêu cầu 10 | Child body count không vượt 3; accounting phản ánh calls thực |
| PTC-A03 | Guest lặp tool budget-exempt | Hard program cap vẫn chặn; root exemption giữ semantics đã công bố |
| PTC-A04 | Post-policy replace value/meta/additionalContext chứa sentinel | Guest, output và public events không có sentinel |
| PTC-A05 | Outer/child exclusive; concurrent sibling | Không deadlock; serialization được giữ |
| PTC-A06 | Admission sibling lỗi sau khi sibling khác chạy | Cancel/drain đúng; không bỏ owned promise hoặc late publication |
| PTC-A07 | User cancel lúc approval pending | Waiter và guest settle; resolve approval cũ không dispatch body |
| PTC-A08 | Missing executor hoặc worker startup lỗi | Lỗi rõ; không host fallback |
| PTC-A09 | CPU loop, pending promise, output spam, dữ liệu quá cap | Deadline/resource policy hoạt động; không phá host event loop |
| PTC-A10 | Output schema thiếu/sai; JSON vượt giới hạn | Unknown/validation/resource error đúng; không guessed/corrupt object |
| PTC-A11 | Guest catch fatal/unknown rồi gọi tiếp | Host latch vẫn chặn; không retry side effect |
| PTC-A12 | Save/load result qua owner khác, expired, revoked hoặc closed run | Không trả data; provenance không mất |
| PTC-A13 | Đổi source/catalog revision hoặc quyền trong lúc await | Live authority đúng; stale captured capability không dispatch/publication |
| PTC-A14 | Agent thường không bật PTC | Kết quả, history/event ordering và package imports giữ contract hiện hữu |
| PTC-A15 | Capture/clone definition và MCP catalog refresh | Metadata detached, bounded, revision nhất quán; provider wire không thêm field lạ |

### 5.5. Dataset và đối chứng

Evaluation chính theo [test specification trung lập](ai-agent-sdk_neutral_before-after_evaluation_2026-09-26.md): 10 chuyên mục, 60 task families ban đầu, split theo family, L1/L2/L3 và COMMON/FEATURE/REGRESSION report riêng. FILTER/JOIN/CONTROL dưới đây chỉ là workload discovery của spike; không đủ để kết luận cải thiện chung cho SDK và không thay held-out evaluation.

Fixtures dùng local synthetic data và oracle xác định trước. Mỗi đáp án có record/source IDs khi task yêu cầu nguồn; chấm correctness bằng dữ liệu thật, không chỉ dùng LLM judge. Chấp nhận các cách giải hợp lệ, không chấm theo việc dùng PTC hoặc chuỗi tool đã định sẵn.

| Nhóm | Công việc | Số case development đề xuất |
|---|---|---|
| FILTER | Paginated records → đọc details cần thiết → lọc/top-k | 4 |
| JOIN | Orders + customers + status → join/aggregate → báo cáo có IDs | 4 |
| CONTROL | Lookup nhỏ và output không đủ schema → xử lý đúng uncertainty | 4 |

Trong mỗi nhóm có ít nhất một case output lớn cần spill/handle, hoặc empty/missing data. Một phần oracle thay đổi bằng deterministic seed; không viết skill riêng cho dữ liệu một arm.

Hai arms:

- **BASE:** agent dùng tools thường, output budget + spill + `read_tool_output` đã bật.
- **PTC:** cùng tools/data/model/effort/limits, thêm chương trình và catalog tối thiểu. Khác biệt prompt/tool exposure bắt buộc của PTC phải được lưu để review.

Nếu dùng workload discovery này, 12 task × 3 lần × 2 arms = **72 development runs**, giới hạn theo ngân sách đã khóa. Không tính các runs đã dùng để tune prototype là held-out evidence. Pilot evaluation chính là 10 dev tasks, một task mỗi domain. Final chính là 30 held-out families × 5 repeats × 2 arms = **300 runs/model**; replication model/provider thứ hai báo riêng theo test specification. Nếu applicability yêu cầu thêm families thì freeze sample size mới trước final.

Pilot không được dùng làm bộ acceptance duy nhất. Freeze dataset/oracle/thresholds trước implementation; chỉ tuning trên development split. Calibration dùng để kiểm scorer, không biến thành bài tune feature. Final held-out theo quy tắc blind/exposed rõ trong test specification. Mỗi run bắt đầu bằng session mới và cùng seed/data tương ứng của pair, để history của run trước không làm sai đối chứng.

Thứ tự paired/alternating arms, ghi warm/cold cache và thời điểm; fixture services reset giữa runs. Không đánh đồng nhiều kết quả cùng warm cache với tiết kiệm ổn định. Repeats không thay independent task families; report confidence intervals và giữ `inconclusive` khi thiếu power.

Đo từng run: task correctness, source-ID correctness, model rounds, child/outer calls, tool-result bytes vào LLM và guest, provider input/output/cached tokens, latency, errors/retries, cancellation và đo memory khả dụng. Thiếu usage là `missing/partial`, không ghi 0. Tính chi phí bằng pricing snapshot của đúng provider/model; không tự tính cached tokens hai lần. Ghi cả chi phí model và chi phí executor đo được.

Trước live run phải cấu hình model/credentials, cost ceiling, max runs và kill switch của harness. Pilot vượt ceiling hoặc usage không đủ để kiểm cost thì dừng live benchmark và sửa runner. Không đọc/in nội dung `.env` vào evidence. Plan không tự kích hoạt paid service mới.

### 5.6. Go/no-go

**Architecture gate:** toàn bộ acceptance áp dụng phải pass. Case thiếu proof là `skipped/blocked`, không được tính pass. Không live benchmark trước khi leak/budget/cleanup invariants được chứng minh.

**Ngưỡng value đề xuất, phải khóa trước full run:**

Các ngưỡng sau chỉ áp dụng target workload đã đăng ký của PTC. Productization còn phải qua quality/conformance/regression gates và per-domain/model report của test specification; cost win trên FILTER/JOIN không đủ đóng evaluation.

- FILTER/JOIN: PTC không giảm số task thành công so với BASE; mọi task được tính thành công phải có đúng output/source IDs. Báo cả kết quả tuyệt đối, không chỉ chênh lệch.
- FILTER/JOIN: median tổng chi phí đo được giảm ít nhất 20%; báo phân phối từng task, không dùng trung bình che task đắt hơn.
- Không tăng p95 latency quá 15% trên workload mục tiêu. Với sample nhỏ, p95 chỉ là chỉ báo; giữ raw samples.
- CONTROL và schema-unknown: không có câu trả lời bịa hoặc quyền mới; nếu PTC đắt hơn thì cần policy opt-in theo workload, không bật mặc định.
- Usage/pricing thiếu thì chưa kết luận đạt cost gate. Chi phí hạ tầng chưa đo đủ phải ghi giới hạn và giữ quyết định provisional.

20%/15% là tiêu chí ra quyết định của spike, không phải lợi ích đã quan sát. Nếu không đạt: thu hẹp workload hoặc `no-go`; không productize chỉ vì prototype chạy được.

**Đầu ra:** prototype có thể chạy lại, conformance results, benchmark dataset/oracle, paired raw measurements, decision và ADR về nested admission/result projection/executor lifetime. Chỉ giữ public API thực sự có consumer.

## 6. SP-02 — durable operation qua process restart

### 6.1. Câu hỏi và phạm vi

Một host dùng contract `ToolExecutionStore` hiện có có giữ stable operation identity, tránh duplicate mutation và phân biệt completed/unknown khi process chết ở các cửa sổ lỗi thật không?

Dùng **SQLite trên host Node** cho spike local để có fixture process độc lập; chọn driver phù hợp Node/toolchain sau kiểm dependency. Không đưa SQLite vào Universal core. Multi-process trên cùng máy là phạm vi chứng minh đầu tiên; chưa chứng minh distributed/multi-host store.

Một fake external service riêng giữ effect counter và receipt theo idempotency key; worker process có thể bị kill mà service vẫn sống. Mọi state/port/database disposable, không dùng dữ liệu production.

### 6.2. Thiết kế cần kiểm chứng

- Atomic claim với unique scoped operation ID; full operation fingerprint gồm tool, args và host identity. Conflict không reuse kết quả.
- `complete` persist trước khi resolve. Giữ claimed/unknown sau crash; không chuyển thành retryable chỉ vì lease/timestamp cũ.
- Stable operation ID được persist cùng pending intent/checkpoint **trước dispatch**. Không tạo ID mới từ random run ID khi resume hoặc tin provider call ID sẽ lặp lại.
- Resume tiếp tục exact recorded intent; nếu host cho model replan và tạo intent mới, không được dùng journal như bằng chứng chống duplicate cho intent đó.
- Thử thứ tự checkpoint → claim → side effect → result commit → publication. Ghi owner và receipt của từng boundary.
- Journal có thể lưu pre-post-policy result theo interceptor hiện tại. Store là trusted host storage: access/retention phải rõ; guest/public projection vẫn qua post-policy khi fresh/recovered. Không nói stored result đã redact nếu chưa có proof.
- Reconciliation do host sở hữu: đọc receipt external để xác nhận completed, hoặc giữ unknown khi không có bằng chứng. Không tự tạo claim mới để né unknown.
- SP-02 không thêm queue, cron, delivery worker hoặc lease-based automatic replay.

### 6.3. Fault injection và oracle

Failpoints có handshake từ worker đến controller, để kill đúng boundary thay vì sleep/race ngẫu nhiên. Controller dùng process kill thật, reopen DB từ process mới, kiểm effect counter của service và trace.

| ID | Failpoint/case | Kỳ vọng |
|---|---|---|
| DUR-01 | Hai process claim cùng operation đồng thời | Chỉ một claimant dispatch; bên còn lại unknown/completed theo trạng thái đã commit |
| DUR-02 | Kill sau persist intent, trước claim | Resume cùng operation ID; không mất/đổi intent |
| DUR-03 | Kill sau claim, trước side effect | Unknown bảo thủ; không tự dispatch lần nữa |
| DUR-04 | Kill sau side effect, trước result commit | External effect count = 1; resume unknown; reconcile receipt mới xác nhận completed |
| DUR-05 | Kill sau result commit, trước publication/checkpoint kế tiếp | Reuse durable result, post-policy chạy lại; effect count vẫn = 1 |
| DUR-06 | Complete lỗi/disk failure hoặc worker mất kết nối | Không trả completed nếu persist chưa xác nhận; recovery không retry mù |
| DUR-07 | Same ID nhưng args/tool/principal khác | Conflict; không đọc result của operation khác |
| DUR-08 | Recovered raw result có sentinel; policy hiện tại redact | Guest/public output không có sentinel; quyền mới được áp dụng |
| DUR-09 | External service không có receipt đáng tin | Giữ unknown; không báo thành công hoặc tự replay |
| DUR-10 | Abort hoặc approval stale trước dispatch | Không side effect mới; unresolved claim xử lý đúng contract |
| DUR-11 | Kill publication/delivery sau completed | Retry publication theo identity/host contract; không rerun body |

**Go:** mọi case áp dụng pass qua host/session thật, counter/DB/trace đồng thuận, không có ID đổi ngầm khi resume. Repetition deterministic tối thiểu 10 lần cho race DUR-01 và cửa sổ DUR-04/05; failure phải phân biệt code lỗi với harness failpoint lỗi.

**No-go/needs-review:** chỉ pass khi gọi interceptor trực tiếp; không có pending-intent checkpoint để resume; không định nghĩa reconciliation; hoặc cần hứa exactly-once với external service không có idempotency/receipt support.

**Đầu ra:** adapter spike + host recovery sample, process harness, fault matrix, stable-ID ADR. Quyết định adapter nên ở sample hay optional Node package dựa trên consumer; không đổi store contract nếu seam hiện tại đủ.

## 7. Productization sau spike

### 7.1. PTC

1. Chốt public surface nhỏ nhất từ prototype: host options/allowlist/limits, output metadata khi cần, executor seam và operational events phù hợp owner hiện tại.
2. Đưa admission logic dùng chung vào đúng owner; bỏ logic duplicate của prototype. Không để nhánh normal và PTC có hai policy/accounting implementations khác nhau.
3. Chọn package topology theo runtime. Core không import worker/QuickJS/Node database; executor đầu tiên có runtime target được ghi rõ.
4. Default PTC tắt; host bật explicit cho workload phù hợp. Missing executor fail rõ. Giữ normal session behavior và public event contracts.
5. Sample dùng data/local fixture, thể hiện output schema missing, sanitized value và cancellation; docs mô tả limitations thật.
6. Mutation hoặc continuation cần plan và acceptance mới, không gộp vào lần productize read-only.

### 7.2. Durable adapter

Productize store/host sample đã chứng minh, bao gồm migration/open/close, contention và retention đúng runtime. Không quảng bá process-local SQLite như distributed runner. Reconciliation/sample stable IDs phải đi cùng adapter; không cung cấp adapter standalone rồi mặc định consumer có exactly-once.

### 7.3. Gates theo thay đổi

- **Output-only fix:** focused unit tests và gates mà CI hiện tại yêu cầu; không chạy provider benchmark chỉ để sửa lời hướng dẫn.
- **Core/MCP contract/capture/admission:** relevant unit + composition/tool-source/MCP tests, normal-path regression, contract tests, build/typecheck/lint/runtime boundary checks.
- **Public export/package/dependency:** publint, types và packed fixtures của packages thay đổi; test import target Node/browser/worker đúng runtime. Dependency mới cần supply-chain/license gate.
- **Guest executor:** conformance + real worker lifecycle/resource tests; fake executor không đủ chứng minh isolation/termination.
- **Durable adapter:** real multi-process kill/restart suite; in-memory test không thay thế được.
- **Docs/package topology:** inventory/README/install/runtime metadata và docs gate; chạy docs site build khi thay docs site.

Lệnh hiện có để dùng theo scope:

```sh
rtk proxy pnpm build
rtk proxy pnpm typecheck
rtk proxy pnpm lint
rtk proxy pnpm test:contract
rtk proxy pnpm check:supply-chain
rtk proxy pnpm check:docs
rtk proxy pnpm --filter @alvin0/ai-agent-sdk-core check:publint
rtk proxy pnpm --filter @alvin0/ai-agent-sdk-core check:types
rtk proxy pnpm --filter @alvin0/ai-agent-sdk-core test:pack
rtk proxy pnpm --filter @alvin0/ai-agent-sdk-mcp test:pack
```

Trước chạy phải xác nhận scripts/dependencies thực tế. Tách baseline failure khỏi regression; không dùng targeted tests để khẳng định toàn bộ CI hoặc production pass. Không sửa baseline bằng ignore/snapshot mới để làm gate xanh.

## 8. Các spike chỉ kích hoạt khi có consumer

### 8.1. SP-03 — scoped recall keyword-first

**Trigger:** ứng dụng có yêu cầu tìm quyết định/bằng chứng từ conversation khác; đã xác định transcript source, quyền đọc và semantics undo/delete. SDK không phải tự xây RAG để đáp ứng nhu cầu chưa có consumer.

**Prototype:** keyword/full-text index ở host; `search` và bounded `read` nhận scope host-bound, opaque reference gắn source revision. Không thay session snapshot/task memory.

**Dataset/oracle:** hai scopes trùng keyword, archived do compaction, undo/delete, quyền bị revoke sau search, index trễ, cron noise. Danh sách records được phép trả xác định trước.

**Tests:** cross-scope search/read; expired/stale handle; deleted source còn trong index/cache; missing source không fallback; bounded excerpt; source IDs đúng; retrieved instructions không cấp authority.

**Go:** zero unauthorized/withdrawn excerpts; source-reference validity 100% trên fixture; recall đúng các expected keyword hits. Semantic/hybrid search chỉ thêm sau dataset chứng minh keyword miss; không suy keyword-first luôn tối ưu.

**Đầu ra:** host adapter/tools + lifecycle tests; quyết định optional package chỉ khi có consumer dùng lại. Không index raw token/chunk chưa commit hoặc toàn append-only audit bất kể undo policy.

### 8.2. SP-04 — process environment adapter

**Trigger:** có ít nhất một consumer cần chạy cùng command tool trên local và một backend tách biệt cụ thể. Chọn container **hoặc** remote; không làm nhiều backend cùng lúc.

**Prototype:** `ToolExecutionBackend` hiện có, acquire/execute/release và bounded artifact read nếu cần. Không serialize arbitrary JS closure sang remote; adapter có tool/command protocol rõ và host validation.

**Tests:** nonzero exit, timeout giữ partial output, abort lúc acquire/spawn, retired handle sau approval, close khi child còn sống, cleanup lặp, oversized artifact, disconnect sau mutation, missing required confinement và credential env allowlist.

**Go:** real process-tree cleanup/termination được chứng minh trên target OS/backend; không host fallback; disconnect mutation giữ unknown; capabilities mô tả đúng mức enforcement. Fake backend chỉ chứng minh logic, không chứng minh confinement.

**Đầu ra:** một adapter + conformance suite/platform evidence. PTY/persistent shell/mount/upload/hibernation chỉ theo nhu cầu riêng.

### 8.3. SP-05 — skill proposal và revision gate

**Trigger:** đã có workflow lặp lại, evidence hợp lệ và tập task held-out để đo skill candidate. Không bật learner chỉ vì upstream có curator.

**Prototype:** learner đọc evidence và ghi draft; writer capability riêng với read-provider. Proposal giữ evidenceRefs, actor/scope, baseRevision, validation/eval; publish/rollback do host quyết định và CAS revision.

**Tests:** ownership unavailable; pinned/external/user-owned target; target đổi sau read/approval; source quyền bị revoke; dependency refs không đọc được; task không liên quan; prompt/skill cố tự cấp tool/secret quyền.

**Go:** candidate không mutate active skill trước publish; CAS/rollback đúng; quyền/source revalidate tại commit; không regression trên held-out/negative tasks; task quality và cost báo riêng. Không có efficacy evidence thì giữ proposal-only.

**Đầu ra:** proposal store/validation/eval sample; không auto-consolidate/archive/publish. Curator deterministic vẫn cần dependency/retention policy trước khi làm.

Durable runner là hướng riêng sau SP-02 và nhu cầu job thật: admission/owner lease, fencing, result inbox, delivery idempotency. Không xem PTC VM snapshot hoặc operation journal là đủ để resume toàn stack agent.

## 9. Evidence, closeout và rollback

Mỗi spike tạo một thư mục evidence do task sở hữu, ghi location trong báo cáo; không dùng `.temp/openclaw` hoặc `.temp/hermes-agent` làm nơi viết artifacts. Không yêu cầu source `.temp` tồn tại để chạy test SDK sau productization.

Report tối thiểu:

```json
{
  "spike": "SP-01",
  "status": "not-run | running | completed | blocked",
  "decision": "go | no-go | needs-review | null",
  "sourceCommits": { "sdk": "full-sha", "reference": "full-sha" },
  "implementationRevision": "commit-or-working-diff-id",
  "environment": { "runtime": "version", "os": "platform", "executor": "version" },
  "cases": [{ "id": "PTC-A01", "status": "passed | failed | skipped", "evidence": [] }],
  "quality": {},
  "usage": { "coverage": "complete | partial | missing" },
  "pricingSnapshot": null,
  "limitations": [],
  "nextAction": "concrete action"
}
```

Schema minh họa; không phải kết quả. Raw fixtures/metrics phải sanitize credentials và private content. Giữ artifacts được dùng làm bằng chứng hoặc người dùng yêu cầu; cleanup disposable services/processes/database qua lifecycle của harness, không xóa state không rõ ownership.

Rollback theo đợt: output fix độc lập; PTC opt-in có thể disable mà normal tools vẫn hoạt động; structured handles ephemeral không tạo data migration cho mọi consumer. Durable adapter phải có migration/retention plan riêng; không xóa unknown operations khi rollback. Không commit/push/release tự động từ việc hoàn tất spike.

### Checklist hoàn thành một spike

- [x] Source baseline và dirty scope đã ghi; giữ nguyên thay đổi người dùng.
- [x] Câu hỏi, runtime, dataset/oracle, limits và gate được khóa trước từng cohort; diagnostic bị dừng giữ riêng, không trộn điểm final.
- [x] Tests đi qua entrypoint thực; fake/helper proof được ghi riêng.
- [x] Mọi case có evidence hoặc lý do skipped; không đổi skipped thành pass.
- [x] Model benchmark ghi paired data và usage coverage; USD được user bỏ khỏi scope, không kết luận monetary cost.
- [x] Public/packed/runtime gates phù hợp thay đổi đã chạy; failures được phân loại.
- [x] ADR chốt owner/API/lifetime cần thiết, không chốt API không có consumer.
- [x] Report có decision, limitations và bước tiếp theo cụ thể.
- [x] Task-owned process/resource được đóng; evidence và user work được giữ đúng phạm vi.

## 10. Bước tiếp theo sau spike

Thứ tự ban đầu (EV-00 → đợt 0 → SP-01A/B) đã thực hiện. Bảng dưới đây là trạng thái theo [closeout](ai-agent-sdk_spike_closeout_2026-09-26.md) và [improvement](ai-agent-sdk_spike_improvement_2026-09-26.md), cùng input còn thiếu trước đợt 3.

| Hướng | Trạng thái | Việc tiếp theo được phép | Input còn thiếu trước productization |
|---|---|---|---|
| EV-00 / đợt 0 | Baseline + wave-0 after đã giữ; wording fix đã merge vào working tree | Không chạy lại live nếu production source không đổi | Blind held-out và replication model thứ hai chưa có |
| SP-01 PTC | Architecture gate **đạt 15/15** ([gates](../evaluations/sp-01-architecture-gate-2026-09-26/gates.json)); value gate development **đạt** trên FILTER/JOIN ([report](../evaluations/sp-01-value-gate-2026-09-26/report.json)): PTC pass 24/24 vs 14/24, median token −77%, p95 latency không tăng; CONTROL an toàn nhưng PTC tốn thêm ~27% token | Productize dạng experimental: core `experimentalPrograms`/`experimentalNestedToolPort`/`experimentalOutputSchema`, mặc định tắt; executor là host sample [samples/programmatic-tools](../../samples/programmatic-tools/README.md), không thêm dependency workspace | Paired final held-out đã chạy: non-inferior, không có mutation, token +26% khi bật trên mọi task. Còn mở: replication model thứ hai, pricing USD, mutation/async/continuation (cần plan mới) |
| SP-02 durable | Host sample **đã implement** [samples/durable-operations](../../samples/durable-operations/README.md): unit 9/9, harness kill/restart 45/45 qua sample ([evidence](../evaluations/sp-02-sample-2026-09-26/durable-summary.json)) | Giữ sample; package chỉ khi có consumer thứ hai | Không distributed/exactly-once; checkpoint và journal tách nhau (đã chấp nhận trong ADR) |
| SP-03 recall | Go cho host sample, 15/15 | Giữ sample | Consumer theo trigger §8.1; authorized corpus, undo/delete, transactional indexing, retention |
| SP-04 process | Go cho host protocol sample, 25/25 | Giữ sample | Consumer theo trigger §8.2; chọn một backend target |
| SP-05 skill | Proposal-only, 19/19 | Giữ sample | Consumer, held-out/negative efficacy evaluation, publish authority |

Quyết định ngày 26/09:

**Mốc cập nhật đầu ngày 27/09 (trước full original/final replay):** các bước (a)–(e) của SP-01, architecture gate, value gate development, productization experimental, SP-02 sample, EV-01 (regression với PTC tắt, paired final held-out) và audit sau cùng đều đã xong. Kết quả và giới hạn ghi trong [spike closeout](ai-agent-sdk_spike_closeout_2026-09-26.md#cập-nhật-27092026-productization-và-ev-01). Sau đó, theo yêu cầu người dùng: USD không cần đo (chỉ đo token); mutation/async/continuation của PTC làm theo [quick plan](ai-agent-sdk_ptc_quick-plan_2026-09-27.md); replication chạy trên model free của ZenMux.

1. **Ưu tiên SP-01 integration research trước**, theo thứ tự: (a) trace scheduler hiện tại và chốt owner nested admission (SP-01B.1–4) — [design note](ai-agent-sdk_sp-01_nested-admission_design_2026-09-26.md), **đã implement + kiểm deterministic**; (b) outer `execute_program` lifecycle + history projection; (c) output descriptor owner + capture/MCP (SP-01A.2–3); (d) owner/revision/TTL handle store (SP-01A.8); (e) chạy đủ PTC-A01…15. Live benchmark chỉ sau architecture gate.
2. **SP-02** làm sau SP-01 dưới dạng host sample; các mục migration/retention/runtime/transaction/receipt đã chốt trong ADR.
3. SP-03/04/05 giữ host sample, chờ consumer theo §8.

Vẫn giữ: không thêm package `tool-program`, database vào core hay generic scheduler mới; không public export khi chưa có consumer và packed-runtime proof.

Plan hoàn tất khi các spike đã có quyết định được chứng minh và phần được chọn đã qua productization gates; không yêu cầu làm mọi hướng đang để theo nhu cầu.

### Closeout cuối ngày 27/09

EV-01 original/final từng bị thiếu trong mốc trên đã được thực hiện đầy đủ ở [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Cohort v2.2 frozen sau implementation là author-exposed regression cohort; không thay thế blind production generalization. Hai model đạt macro non-inferiority trong cohort; raw losses và runtime failures vẫn được công khai. Replication value gate không đạt, nên không mở rộng PTC mặc định hoặc coi mọi model/workload đã được chấp nhận. Các nhánh chờ consumer là quyết định phạm vi, không việc implementation bắt buộc còn bỏ dở.
