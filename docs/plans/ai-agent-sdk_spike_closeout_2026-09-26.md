# Spike decisions and evidence — 26/09/2026

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.

Latest review: [executor and oracle improvements](ai-agent-sdk_spike_improvement_2026-09-26.md), 18 executor and 6 same-root relay checks. **Superseded 27/09:** PTC architecture gate đạt với phương án scheduler-owned nested admission; xem [cập nhật cuối](#cập-nhật-27092026-productization-và-ev-01).

Đã thực thi cả năm hướng trên fixture local. **Không đồng nghĩa mọi spike đã qua productization gate.** PTC có hai phương án được kiểm: session con bị loại; relay cùng root chứng minh được một số invariants nhưng vẫn `needs-review`. Không có live PTC efficacy/cost result vì architecture gate chưa đủ. Các hướng còn lại có proof trong phạm vi host sample, chưa tạo public API/package.

Production SDK và lockfile giữ nguyên so với wave-0 after. Baseline, grader và 172 records trước/sau không bị rewrite. Manifest ghi source SHA, dirty package diff, environment và hashes; snapshots nằm cạnh raw summaries. Không port upstream application code. Các implementation này là research code riêng, không thay source `.temp`.

| Spike | Proof đã chạy | Decision | Giới hạn quyết định |
|---|---|---|---|
| SP-01 PTC | Closeout: 14 executor/counterexample + 5 same-root relay checks; sau [improvement](ai-agent-sdk_spike_improvement_2026-09-26.md): **18/18** executor + **6/6** relay | Session con: **no-go**; relay: **needs-review** | Chưa đủ PTC-A01…15; không live benchmark, không public executor/nested API |
| SP-02 durable | **45/45** cases; SIGKILL, concurrent workers, SQL capacity failure, stale approval, writer fencing, HTTP delivery disconnect | **Go cho local host spike** | Không distributed exactly-once hoặc atomic toàn bộ agent/session stack; chưa migration/retention package |
| SP-03 recall | **15/15** scope/revision/lifecycle cases, SQLite FTS5 | **Go cho host sample** | Không semantic efficacy; index lag có thể miss, handles process-local |
| SP-04 process | **25/25** local + Docker cases qua SDK backend interceptor | **Go cho host protocol sample** | Chỉ host-owned command modes; không guarantee cleanup khi daemon mất kết nối |
| SP-05 skill proposal | **19/19** draft/evidence/capability/CAS/rollback cases | **Go cho proposal-only** | Không có independent efficacy evidence để auto-publish skill |

Các counts là số case/check research, không phải số live model tasks hoặc độ phủ chung. `go-for-host-sample` không cho phép suy thành release-ready SDK feature. [Evidence manifest](../evaluations/spike-closeout-2026-09-26/manifest.json) dẫn đến raw directories, public summaries và source hashes.

## SP-01 — hai phương án và lý do giữ architecture gate

Executor QuickJS/WASM chạy trong Node worker, không ambient process/require/fetch/WebSocket. Các probes kiểm allowlist, integer args, JSON bridge, hard cap khi guest catch lỗi, CPU loop, memory stress termination, projection/result bytes và pending bridge termination. Config heap 8 MiB không được quảng bá là total RSS cap. Dependency research pin `quickjs-emscripten@0.32.0`, nằm trong artifact prefix riêng; package lock/licensing/audit snapshot giữ tại [dependency review](../evaluations/spike-closeout-2026-09-26/dependency-review.json). Không thêm dependency vào workspace hoặc core.

**Fresh-session bridge counterexample:** guest thật yêu cầu 10 reads; mỗi child đi qua actual AgentRuntime/session policy/checkpoint. Root có 3 calls nhưng 10 child bodies vẫn chạy. Đây là bằng chứng loại **phương án cấp session/budget mới cho mỗi child**, không phải bug của normal SDK và không chứng minh mọi kiến trúc PTC đều không khả thi. [Executor/counterexample report](../evaluations/spike-closeout-2026-09-26/sp-01-executor-summary.json).

**Same-root relay:** guest requests được chuyển thành tool calls của cùng root run, không gọi trực tiếp `tool.execute`. Khi root limit 3 và outer start chiếm 1, chỉ 2 read bodies chạy. Trace root giữ chung, SDK policy/checkpoint vẫn chạy. `budgetExempt` không né program cap 3. Forward sang guest chỉ lấy finalized post-policy structured value qua event; khi policy bỏ value, trả `STRUCTURED_OUTPUT_UNAVAILABLE`, không parse rendered text. Wrong output shape cũng trả unknown/error. Worker được đóng khi run kết thúc. [Relay report](../evaluations/spike-closeout-2026-09-26/sp-01-root-relay-summary.json).

Relay trả outer phase `started`, giữ child calls trong canonical history và dùng scripted adapter rounds. Chưa đáp ứng lifecycle/projection của một ordinary `execute_program` call; chưa có catalog/output metadata/MCP refresh hoặc owner/TTL structured handle store. Vì vậy không tính 5 case này là full architecture conformance hoặc token savings.

| Architecture gate | Trạng thái bằng chứng |
|---|---|
| PTC-A01 | Standalone allowlist probe; dynamic capture/revision integration chưa kiểm |
| PTC-A02 | Fresh-session candidate **fail** (10 bodies với limit 3); relay focused case pass (outer 1 + reads 2) |
| PTC-A03 | Relay budget-exempt + program hard-cap focused case pass; full owner contract chưa chốt |
| PTC-A04 | Relay post-policy structured-value removal case pass; full value/meta/context matrix chưa kiểm |
| PTC-A05…08 | Root exclusive/admission drain/approval/startup matrix chưa hoàn tất |
| PTC-A09 | Worker executor CPU/resource/pending termination probes; chưa full integrated limits matrix |
| PTC-A10 | JSON/args/shape/byte probes; output schema missing/unsupported catalog contract chưa hoàn tất |
| PTC-A11…13 | Fatal latch, owner-scoped handles và live catalog authority chưa hoàn tất |
| PTC-A14 | Không đổi production path; wave-0 source fingerprint giữ nguyên; không coi đó là full PTC regression proof |
| PTC-A15 | Core/MCP output metadata preservation chưa triển khai/kiểm |

**Decision:** feasibility research đã có kết luận; productization và live value gate **chưa đạt**. Khuyến nghị giữ PTC tắt, giữ benchmark fixtures đã freeze. Nếu chọn tiếp hướng relay/nested port, phải chốt owner tại scheduler, outer result/history projection, output descriptor/capture/MCP revision và chạy full conformance trước 72 development runs. Không lấy standalone microbenchmark để vượt gate này.

## SP-02 — recovery, fencing và approval/delivery

Pending intent và stable operation ID được persist trước dispatch. Claim unique/atomic; journal commit CAS theo owner + generation. Unresolved claim không tự reclaim theo tuổi. Reconciler phải đọc receipt độc lập rồi fence generation và commit trong transaction; late writer không thể overwrite. Provider call ID mới ở resume không làm đổi operation ID. Store raw là trusted host storage; projection fresh/recovered qua current post-policy.

| Gate | Evidence cuối |
|---|---|
| DUR-01 | Barrier giữ claimant sống, worker khác báo unknown; 10 repetitions |
| DUR-02/03 | Kill sau pending intent / sau claim / trước effect; resume đúng ID, body không replay |
| DUR-04/05 | Kill sau effect / sau commit; mỗi cửa sổ 10 repetitions, counter/DB/trace đồng thuận |
| DUR-06 | Injected commit error và SQLite `max_page_count` tạo **SQLITE_FULL (13)** thật; chưa coi là OS disk-full/corruption proof |
| DUR-07 | Same ID khác args/tool/principal → conflict |
| DUR-08 | Raw sentinel trong trusted journal không leak model/public events sau policy |
| DUR-09 | No receipt → unknown, không fabricated reconciliation |
| DUR-10 | Abort sau claim; kill ở pending approval; old saved allow không áp dụng cho fresh request, host deny → body 0 |
| DUR-11 | HTTP receiver nhận delivery rồi disconnect trước ack; retry cùng ID, 2 delivery requests nhưng mutation body/effect chỉ 1 |
| Bổ sung | Reconciler fence live old generation; late writer commit failed, không overwrite receipt |

[Durable report](../evaluations/spike-closeout-2026-09-26/sp-02-summary.json). Delivery retry không có nghĩa receiver xử lý exactly-once; consumer vẫn cần receiver dedupe/ack contract. Không restart toàn conversation stack/approval promise hoặc renew authority từ saved record. Checkpoint/journal/session chưa phải một transaction chung. Không xóa unknown operations khi cleanup/rollback.

**ADR:** [stable operation identity và store ownership](ai-agent-sdk_sp-02_stable-identity_adr_2026-09-26.md) — thay ADR tạm thời trong progress doc; liệt kê các quyết định còn mở trước production adapter.

## SP-03 — host corpus và stale index

Scope gắn tại host, model không cấp scope. Search dùng FTS phrase và join source hiện tại theo scope, visible state và revision. Handles opaque gắn source/revision/scope/TTL. Read kiểm lại nguồn hiện tại, không dùng index/cache như authority và không fallback guessed paths. Archived evidence còn hợp lệ; withdrawn/deleted/cron noise bị loại. Tests có literal Vietnamese query, cross-scope handle, revoke giữa search/read, revision change, stale FTS, expiry và close.

Probe ban đầu phát hiện stale index vẫn khớp source đổi revision; **đã sửa** join revision và rerun. Source-ID/excerpts fixture đúng; không nói multilingual literal probe chứng minh semantic language neutrality hoặc production recall quality. [Recall report](../evaluations/spike-closeout-2026-09-26/sp-03-summary.json).

**ADR:** corpus/index/source lifecycle ở host; SDK memory/session không bị thay. Consumer cần authorized corpus, undo/delete semantics, transactional indexing strategy và retention trước package hóa.

## SP-04 — real process lifecycle

Tool parser chỉ nhận finite host command modes; backend interceptor chọn local hoặc pinned Docker image. Không serialize arbitrary closures và không fallback local khi container thiếu. Container read-only root, network none, cap-drop, no-new-privileges, nonroot user, memory/PID limits; không mount workspace/credentials/daemon socket. Local execution có host filesystem/network capability được khai báo đúng.

Cases có success/nonzero, stdout/stderr partial sau timeout, bounded oversized ASCII/UTF-8 output, env canary, process-group kill (child PID state kiểm độc lập), Docker removal kiểm qua daemon, filesystem/network denial, missing image, checkpoint abort trước acquire, abort approval, stale capability sau approval và trước publication. Disconnect với unresolved journal không được replay. [Process report](../evaluations/spike-closeout-2026-09-26/sp-04-summary.json).

Docker engine thực tế 29.8.0; image digest `sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`. Cleanup best-effort trên daemon failure; tests này không tạo guarantee distributed cleanup hoặc fake full sandbox cho local backend. No PTY/persistent shell/mount/upload abstraction.

## SP-05 — proposals và host writer

Learner chỉ có bounded draft tool, không publish capability. Target owner unknown/external/user/pinned bị deny. Draft giữ host actor, base revision, body và evidence revisions. Validator chỉ minh họa deterministic numeric operation, không đánh giá skill prompt efficacy. Publish do host writer riêng: kiểm current grant/target/evidence sau await rồi CAS revision trong transaction; duplicate/stale publication bị từ chối. Rollback tạo revision mới và không overwrite edit mới.

Tests có evidence/dependency inaccessible, withdrawn/missing refs, draft không đổi active skill, learner không có publish tool, required validation, source/writer revoke sau await, target edit sau approval, malicious grants trong candidate, stale rollback và successful rollback. [Proposal report](../evaluations/spike-closeout-2026-09-26/sp-05-summary.json).

**Decision:** giữ proposal-only. Publish/rollback fixture chỉ chứng minh commit controls; trước active skill adoption cần independent held-out/negative task evaluation, target consumer và human/host publish authority. Không auto-consolidate/archive/publish hoặc mutate user skills.

## Reproduction và retention

```sh
rtk proxy npm install --prefix artifacts/spikes/quickjs-dependencies-v1 --ignore-scripts --no-audit --no-fund --save-exact quickjs-emscripten@0.32.0
rtk proxy docker pull node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
rtk proxy node --experimental-strip-types test-human/spikes/ptc-probe.ts
rtk proxy node --experimental-strip-types test-human/spikes/ptc-root-relay.ts
rtk proxy node --experimental-strip-types test-human/spikes/durable-operation.ts
rtk proxy node --experimental-strip-types test-human/spikes/scoped-recall.ts
rtk proxy node --experimental-strip-types test-human/spikes/process-environment.ts
rtk proxy node --experimental-strip-types test-human/spikes/skill-proposal.ts
```

Node tested 24.9.0; SQLite built-in experimental. Missing dependencies fail explicitly. Mỗi run tạo directory timestamp mới; không ghi đè evidence cũ. Image/dependency cache giữ để chạy lại; owned worker/process/container được teardown. Evidence public chỉ chứa synthetic inputs/results; raw databases/source snapshots giữ ở artifacts. Không commit/stage/push/release hoặc đổi `.env`.

## Validation và closeout boundary

Final research harnesses pass trong scope được ghi; `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm check:docs`, `pnpm check:human` và contract 4 files / 57 tests pass. `git diff --check` sạch. Không coi đây là toàn bộ CI, packed/browser/deployment proof. Docker audit không còn owned `sdk-spike-*` containers. Source SDK fingerprint vẫn khớp wave-0 after, nên không rerun broad live evaluation chỉ vì thay research files.

[Machine-readable PTC gates](../evaluations/spike-closeout-2026-09-26/sp-01-gates.json) giữ mandatory gate chưa hoàn tất, không biến probe passes thành full architecture pass. Bước tiếp theo và các quyết định còn chờ nằm ở [implementation plan §10](ai-agent-sdk_hermes_openclaw_implementation-plan_2026-09-26.md#10-bước-tiếp-theo-sau-spike); riêng PTC cần follow-up integration research trước khi có phép đo efficacy/cost.

## Cập nhật 27/09/2026: productization và EV-01

Phương án relay cùng root trong closeout này đã được thay bằng **nested admission do scheduler sở hữu** ([design note](ai-agent-sdk_sp-01_nested-admission_design_2026-09-26.md)). Các bảng SP-01 ở trên là lịch sử.

| Hạng mục | Kết quả | Evidence |
|---|---|---|
| PTC architecture gate | 15/15: 13 case qua AgentRuntime + QuickJS worker; A13 ở scheduler, A15 ở capture/MCP | [gates.json](../evaluations/sp-01-architecture-gate-2026-09-26/gates.json) |
| PTC value gate (development) | FILTER/JOIN: 24/24 vs 14/24; median token −77%; p95 latency −15%; CONTROL 12/12 cả hai arm, 0 mutation; usage authoritative 72/72 | [report.json](../evaluations/sp-01-value-gate-2026-09-26/report.json), [runs.jsonl](../evaluations/sp-01-value-gate-2026-09-26/runs.jsonl) |
| Pilot | v1 lộ ra 3 lỗi usability của executor (`await`, async IIFE, shape wrapper); đã sửa và giữ v1 làm lịch sử; v2 ổn định | `pilot-v1-runs.jsonl`, `pilot-v2-runs.jsonl` |
| Productization PTC | Surface experimental, mặc định tắt; executor là host sample, không thêm dependency workspace | [samples/programmatic-tools](../../samples/programmatic-tools/README.md) |
| SP-02 | Host sample; 45/45 case kill/restart qua sample | [durable-summary.json](../evaluations/sp-02-sample-2026-09-26/durable-summary.json) |

**Quyết định SP-01:** `go-for-target-workload`, chỉ ở mức experimental opt-in. Không bật mặc định, vì task nhỏ tốn token hơn. Ngoài phạm vi: USD (không có pricing), held-out/blind, model thứ hai, mutation, async guest, continuation.

**Replication trên model/provider thứ hai không chạy.** Người dùng đã chọn Codex ở baseline, và plan không tự kích hoạt dịch vụ trả phí mới. Kết luận vì vậy chỉ giới hạn ở `gpt-6-luna`/medium.

### EV-01: regression và paired final (27/09)

| Đánh giá | Kết quả | Evidence |
|---|---|---|
| Regression neutral, PTC tắt, source cuối (170 run) | Auto-pass 148/160 (wave-0 147, baseline 143); 0 mutation; usage 180/180. p95 latency 19.2s so với 9.2s: các run chậm vẫn có cùng số model call, và stress hermetic không có mạng không chậm hơn (1.77s so với 1.97s). Nguyên nhân quy cho drift provider/thời điểm và tải cục bộ, không quy cho SDK, nhưng phép so tuần tự không loại trừ hẳn được. | [regression-summary.json](../evaluations/codex-luna-sp01-after-2026-09-27/regression-summary.json) |
| Paired final held-out, BASE và PTC xen kẽ (280 run) | 26 family có tự chấm × 5 × 2. PTC 123/130 so với BASE 118/130; macro +3.3pp, CI95 [0, +8.7]; non-inferior ở margin 5pp; 0 family bị kém đi; 0 mutation; 0 runtime error. Token +26%, p95 latency +9%. Model **không gọi** `execute_program` trên các task này, nên cải thiện (DOC-05, OPS-04) đến từ việc có thêm tool trong prompt, không phải từ program. | [interpretation.json](../evaluations/codex-luna-ptc-paired-final-2026-09-27/interpretation.json), [report.json](../evaluations/codex-luna-ptc-paired-final-2026-09-27/report.json) |

**Generalization gate:** bật PTC trên mọi task an toàn và không làm giảm chất lượng trên cohort này, nhưng tốn thêm token và latency mà không tạo lợi ích từ program. Quyết định giữ nguyên: opt-in cho workload phân trang hoặc tổng hợp, không bật mặc định.

### Audit sau khi hoàn tất (27/09)

Các lỗi tìm thấy và đã sửa, mỗi mục kèm test hoặc harness đã chạy lại:

1. Lỗi trả về lấy message của lần latch trước, lệch với code budget/stale. Đã chuyển sang message tường minh.
2. Keyword số sai kiểu trong output schema bị kết luận `invalid`. Giờ trả `unsupported`; có test.
3. Journal SP-02 tự đánh stale mọi approval đang pending khi mở, làm hỏng approval của writer khác còn sống. Đã thêm migration 3 (cột `owner`) và API `expirePendingApprovals()`; có test; harness 45/45.
4. Journal SP-02 không xóa entry trong map `owned` sau khi complete. Đã sửa.
5. Deadline CPU của guest tính cả thời gian chờ host chạy tool. Đã loại phần chờ ra; thêm case A09 child chậm, đã kiểm bằng mutation.
6. README của sample nói worker không có fs/network. Sai: chỉ guest QuickJS không có. Đã sửa câu chữ.
7. Grant: mảng `allow` bị đọc hai lần, và program-in-program đến turn đầu mới báo lỗi. Giờ đọc một lần và từ chối ngay khi tạo session; có test.

Sau audit: unit 2953/2953, contract 57/57, root `tsc`, lint, docs, human coverage, supply-chain, pack/types/publint của core và MCP đều pass; conformance 13/13; SP-02 45/45.

### PTC quick plan: mutation, async, continuation (27/09)

Làm theo nguyên tắc SDK chỉ cung cấp móc ([quick plan](ai-agent-sdk_ptc_quick-plan_2026-09-27.md)):

- **Mutation qua program:** không thêm mode mới. Thêm field optional `ToolCallContext.parentCallId` để interceptor và journal scope được theo program. Q1 4/4: effect đúng 1 lần, dedupe khi chạy lại, `unknown` làm latch, policy chặn được.
- **Guest async:** executor v2 `executor: 'async'` trong sample, không dùng asyncify, child xếp hàng lần lượt. Conformance async 14/14, sync 13/13 ([evidence](../evaluations/ptc-quick-plan-2026-09-27/)).
- **Continuation:** không đưa vào SDK; đó là việc của durable runner phía host, dựng trên các móc sẵn có.
- **Nhiều child song song:** hoãn.

**Replication trên model thứ hai:** dùng ZenMux `dots-studio/dots3-note-prev`, là model free duy nhất trong `.env` chạy được. Các model free khác trả `HTTP_402` hoặc timeout. Chi phí đo bằng token theo quyết định của người dùng.

### Replication trên model thứ hai (ZenMux `dots3-note-prev`, free, 27/09)

| Đánh giá | Kết quả | Evidence |
|---|---|---|
| Value gate trên workload mục tiêu (72 run) | FILTER/JOIN: PTC 23/24 so với BASE 8/24; median token −78%; p95 latency thấp hơn; CONTROL 12/12 ở cả hai arm, 0 mutation. Rule đã đăng ký vẫn cho `needs-review` vì usage thiếu, nhưng phần thiếu chỉ nằm ở 4 run BASE bị timeout. Token của BASE vì vậy bị đếm thiếu, nên con số −78% là **cận dưới**. | [interpretation](../evaluations/sp-01-value-gate-zenmux-dots3-2026-09-27/interpretation.json) |
| Paired final, bật PTC trên mọi task (280 run) | **Không đạt non-inferior:** 103/130 so với 111/130, −4pp, CI [−8.3, +0.3]. Có 1 mutation: model tự gọi `perform_operation` ở DATA-04, một fixture không có interceptor chặn, không đi qua program. Chỉ 1/140 run có dùng program; các lần thua chủ yếu là lỗi định dạng JSON. | [interpretation](../evaluations/zenmux-dots3-ptc-paired-final-2026-09-27/interpretation.json) |

**Kết luận sau replication:** giá trị trên workload phân trang/tổng hợp lặp lại được trên cả hai model. Bật PTC toàn cục thì có hại với model yếu hơn (thêm tool làm model trả sai format). Quyết định cuối: PTC **chỉ opt-in theo workload**; quyền mutation phải chặn bằng interceptor của host, không dựa vào instructions. Kết luận theo ngôn ngữ vẫn chưa đủ, vì held-out chỉ có 1 family tiếng Việt/hỗn hợp; muốn kết luận cần một cohort v2 cân bằng ngôn ngữ.
