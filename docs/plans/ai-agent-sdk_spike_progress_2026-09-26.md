# Phân loại lỗi và bằng chứng spike — 26/09/2026

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.

Latest review: [executor and oracle improvements](ai-agent-sdk_spike_improvement_2026-09-26.md), 18 executor and 6 same-root relay checks; full PTC gate remains incomplete.

**Cập nhật:** xem [spike closeout và decisions](ai-agent-sdk_spike_closeout_2026-09-26.md) cho evidence mới nhất. Các mục 41-case/SP-01 preparation dưới đây là mốc trước khi bổ sung full local durable probes, executor/relay và SP-03…05; giữ để audit lịch sử.

Baseline Codex `gpt-6-luna`, effort `medium` được giữ nguyên. Không sửa điểm, fixture hoặc grader đã freeze để làm kết quả đẹp hơn. Đây là author triage; không phải blind adjudication hay xác nhận production.

## Phân loại 17 lần fail baseline

| Family | Số lần | Bằng chứng / quyết định |
|---|---:|---|
| DATA-04 | 5 | Page JSON vượt retention cap 8192 bytes; raw value cùng content được tính vào cap. Test actual runtime: cap 8192 bị reject, 65536 spill thành công. Lỗi thiết kế utility fixture, không có bằng chứng SDK phải bỏ cap. Giữ nguyên baseline v1; cohort PTC mới dùng cap hợp lệ và negative control riêng. |
| DOC-02 | 1 | Chọn source beta thay vì alpha. Model/source selection; chưa có bằng chứng pipeline sửa sai dữ liệu. |
| DOC-05 | 5 | Abstain đúng nhưng bỏ source ID earth1. Task/source completeness fail. |
| OPS-04 | 3 | Báo incomplete đúng nhưng bỏ observed IDs checked-a/b. Task/source completeness fail. |
| BASIC-06 | 1 | Facts đúng, JSON sai cú pháp. Format fail. |
| OPS-06 | 1 | Deny đúng nhưng restarted là string thay vì boolean false. Contract fail. |
| BIZ-05 | 1 | unavailable thay unknown. Rubric có khả năng mơ hồ; cần independent review, không sửa frozen oracle sau khi thấy đáp án. |

Không coi mọi fail model là bug SDK. Các câu prose vẫn nằm trong hàng đợi human review.

## Đợt 0: bug SDK đã sửa

Expired locator và spill/truncate fallback từng gợi ý rerun original operation. Giờ thông báo mất output không có nghĩa operation thất bại: kiểm receipt/current state, chỉ lặp khi host xác nhận an toàn.

Không thêm retry flag/API hoặc giảm cap. Test actual scheduler chứng minh body mutation chỉ chạy một lần, receipt completed còn nguyên; spill failure giữ completed value; post-policy sentinel không vào spill/events. Sau rebuild core: 8 file, 221 tests pass. Evidence: `artifacts/neutral-evaluation/wave0-regression-20260926.json`.

Bộ live after hoàn tất 172 records = 170 live + 2 unsupported, dùng cùng runner/cases/grader/model/effort/limits/repeats. Integrity/completeness và paired config checks pass. [Raw public results](../evaluations/codex-luna-wave0-after-2026-09-26/runs.jsonl), [paired comparison](../evaluations/codex-luna-wave0-after-2026-09-26/comparison.json), source diff/checksums cùng thư mục; source archive đầy đủ giữ ở raw artifact.

| Metric | Baseline | Wave 0 after |
|---|---:|---:|
| Automatic pass | 143/160 (89.375%) | 147/160 (91.875%) |
| Fail / human review / unsupported | 17 / 10 / 2 | 13 / 10 / 2 |
| Median / p95 latency | 3.894s / 8.892s | 4.129s / 9.160s |
| Reported tokens including history | 214272 | 189128 |
| Authoritative usage | 180/180 | 180/180 |
| Mutation effects | 0 | 0 |

Equal-domain held-out delta +3 percentage points; family bootstrap interval +1 to +5 points chỉ mô tả cohort này, chưa xử lý drift giữa hai đợt hoặc uncertainty của toàn bộ model repeats. Không kết luận cost win bằng token count; không kết luận causal improvement từ wording. Không dùng biến động điểm live để quy lợi ích cho wording fix; invariant recovery được kiểm bằng fault tests, baseline không ghi nhận duplicate mutation.

## SP-02: phạm vi proof và gate còn mở

> **Superseded.** Mục này là mốc 41/41, trước fencing/approval restart/delivery retry. Kết quả cuối **45/45, go-for-local-host-spike** ở [closeout](ai-agent-sdk_spike_closeout_2026-09-26.md#sp-02--recovery-fencing-và-approvaldelivery); ADR chính thức ở [SP-02 stable identity ADR](ai-agent-sdk_sp-02_stable-identity_adr_2026-09-26.md). Giữ nguyên nội dung dưới đây để audit lịch sử.

Harness: `test-human/spikes/durable-operation.ts`. Node built-in SQLite, WAL/FULL, pending intent persist trước dispatch, unique atomic claim; worker chạy AgentRuntime/session/interceptor thật. Service riêng luôn tăng counter khi POST, **không dedupe** nên không che replay.

Controller SIGKILL tại boundary handshake; worker mới mở lại DB. Hai worker có barrier để tranh claim trong khi owner vẫn sống. Repeated 10 lần cho concurrent, after-effect, after-complete. Journal giữ raw trusted result; post-policy chạy lại khi reuse, kiểm sentinel trong model messages và public events. Unknown chỉ reconcile bằng GET receipt độc lập; thiếu receipt giữ unknown.

Bản cuối **41/41 cases pass**, gồm abort-after-claim: `artifacts/spikes/durable-2026-09-26T04-51-32-136Z/summary.json`. Source harness cùng hash được giữ cạnh summary; bản public tại [durable-summary.json](../evaluations/spikes-2026-09-26/durable-summary.json). Không thay thế evidence cũ.

| Gate | Mức chứng minh |
|---|---|
| DUR-01…05 | Process concurrency / crash windows có counter, DB và trace |
| DUR-06 | Injected commit exception; chưa có real disk-full/corruption proof |
| DUR-07 | Args/tool/principal conflict |
| DUR-08 | Fresh/recovered post-policy không leak public/model sentinel |
| DUR-09 | No receipt → unknown, không replay |
| DUR-10 | Host abort sau claim: body 0, resume unknown; chưa stale approval waiter restart |
| DUR-11 | Kill sau publication rồi reuse; chưa delivery transport retry protocol |

**Decision: needs-review, chưa productize.** Còn thiếu atomic session/checkpoint/journal transaction, stale writer fencing, approval restart và production retention/migration. Không quảng bá exactly-once hoặc distributed durability. Adapter research không export vào core.

### Stable identity và store ownership — ADR tạm thời (đã thay thế)

> Đã thay bằng [SP-02 stable identity ADR](ai-agent-sdk_sp-02_stable-identity_adr_2026-09-26.md). Nhận định "chưa có generation/fencing token" bên dưới không còn đúng: harness cuối đã commit CAS theo owner + generation và kiểm late writer.

Host persist operation ID cùng exact pending intent; provider call ID được tạo mới mỗi worker và không làm key journal. Fingerprint gồm args/tool/principal; thay fingerprint giữ conflict. Claim chưa completed không bị reclaim theo tuổi. Receipt lookup đọc trạng thái, không phải replay.

SQLite sample hiện commit bằng operation ID và `result IS NULL`, chưa có generation/fencing token cho stale writer. Research fixture chỉ có một owner chưa bị thu hồi khi commit; reconciliation diễn ra sau khi worker đã kết thúc. Không dùng thiết kế này để suy ra safety khi live owner và reconciler cùng commit. Trước adapter production phải chốt CAS owner/generation, identity scope, pending-intent checkpoint transaction, approval revalidation, schema migration và retention của unknown operations.

Runtime chọn Node-only harness vì built-in SQLite có sẵn; không thêm dependency hoặc public package. Quyết định cuối sample hay optional package vẫn chờ consumer và các gate thiếu.

## SP-01: chuẩn bị phép đo trước prototype

> Mốc trước executor/relay. Trạng thái hiện tại: `needs-review`, architecture gate false — xem [closeout](ai-agent-sdk_spike_closeout_2026-09-26.md) và [improvement](ai-agent-sdk_spike_improvement_2026-09-26.md).

Harness chuẩn bị: `test-human/spikes/prepare-ptc.ts`; 12 development tasks (FILTER 4, JOIN 4, CONTROL 4), source IDs/oracles từ bảng host trước execution. Controls gồm direct answer, single read, schema unknown và mutation ngoài allowlist. Resource overflow tách khỏi utility score.

Fixture artifact: `artifacts/spikes/ptc-preparation-2026-09-26T04-51-14-586Z/fixtures.json`; SHA256 `f801f6047e75c9cf904a31a0c67067fa34e3a1e25b035029da86fe07b0750254`. Pages 16886–16933 bytes, cap 65536; token projection 2048. Cả BASE spill và PTC phải dùng cùng retention/budget. 72 planned development runs không phải held-out evidence.

Readiness report đánh dấu PTC-A01…15 **not-evaluated** và `liveBenchmarkAllowed: false`. Chưa có QuickJS guest/nested admission; không gọi trực tiếp tool.execute để giả conformance. Trước live phải kiểm dependency/license, limits/isolation, policy/root accounting/lifecycle; khóa paired runner/prompt/catalog, cost ceiling, kill switch và pricing. Giữ nguyên cohort neutral v1 cho broad regression; cohort PTC v1 chỉ đánh giá workload mục tiêu.

## Lệnh chạy lại

```sh
rtk proxy node --experimental-strip-types test-human/spikes/durable-operation.ts
rtk proxy node --experimental-strip-types test-human/spikes/prepare-ptc.ts
```

Mỗi lần tạo thư mục timestamp riêng, không ghi đè evidence. SQLite thử nghiệm hiện phụ thuộc Node có node:sqlite; chưa phải yêu cầu runtime của SDK portable.

## Verification bổ sung

`pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm check:docs`, `pnpm check:human` pass; contract 4 files / 57 tests pass. Đây là các gate đã chạy, không phải toàn bộ packed/browser/CI suite.
