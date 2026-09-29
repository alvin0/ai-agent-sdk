# Multiple-agent audit, cải tiến và benchmark — 27/09/2026

Trạng thái: hoàn tất phạm vi audit/fixes và SDK policy controls đã chọn; local/packed gates và final paired live cohort đã chạy. Có remaining strict-format losses, không tuyên bố universal superiority. Mục tiêu là cải
thiện orchestration đang có, học cơ chế cụ thể từ `.temp/hermes-agent` và
`.temp/openclaw`, rồi đo trước/sau bằng public entrypoints. Không dùng kết quả PTC
trước đây để chứng minh multiple-agent đã cải thiện.

## Scope và source freeze

- SDK HEAD `5b589b6abe6d0a61da3f55b549713456ccc8c7c4` cộng dirty production/sample
  patch `055229ab7ad31aecb71d09a0a5908462db728e28bca545b3ed4caf98b1eb3200` là
  **BASE của đợt này**, bao gồm các sửa trước đó. Snapshot đã build riêng tại
  `artifacts/plan-completion-hHIqY2/candidate-sdk`; xác minh loaded module hashes.
- Hermes `9fc7f17906eab1dd81ddfdf8a1edeecac1e79940`; OpenClaw
  `37259b7cab6b1816211d381200848048a05f197d`. Đọc source local, không chạy upstream
  code với credentials, không sửa `.temp`, không copy application framework.
- Agent không stage, commit, push hoặc đổi checkout; giữ công việc sẵn có. Index đã được thao tác ngoài agent trong khi chạy; không restore index cũ.
  Owned preparation/evidence: `artifacts/multi-agent-audit-n62xvl_w`.

## Research questions

1. Setup đồng thời có giữ cùng write-scope admission không? Revalidate sau await
   có ngăn dispatch sau khi owner đã dispose không?
2. Dependency đã hoàn tất hoặc được đóng có giao đúng producer result cho worker
   phía sau không, kể cả nhiều dependencies, setup failure và shared byte cap?
3. Wait có abort/steer thực, và quiet/completion có chờ delivery cùng synthesis
   không? Không coi session idle là cả workflow đã hoàn tất.
4. Lead nhận terminal success/failure đúng không, kể cả partial answer, budget,
   large reports và presentation callback lỗi? Có cách đọc evidence đầy đủ mà
   không làm context parent phình vô hạn không?
5. Context fork và per-worker session limits có giữ completed prefix, đúng owner
   và isolation không? Existing shared budgets và native policy vẫn phải giữ.

## Cơ chế tham khảo đã đọc

Hermes `tools/delegate_tool_dispatch.py` record từng child khi hoàn tất, trước
join/finalization; `delegate_tool_registry.py` so exact runtime identity và live
owner trước steer/close, tách live registry khỏi retained attribution;
`delegate_tool_results.py` giới hạn summary theo parent headroom, giữ full output,
và serialize host finalization. SDK dùng existing in-process owner, không cần
thêm durable registry/database chỉ vì upstream có.

OpenClaw `subagent-spawn-lifecycle.ts` chỉ emit started sau accepted run;
`subagent-spawn-ownership.ts` phân biệt controller/completion owner;
`subagent-completion-result.ts` ưu tiên producer-owned terminal evidence thay
transcript fallback. `subagent-spawn.preparation-authority.test.ts` tái hiện owner
closure trong awaited preparation và yêu cầu không dispatch child sau closure.
Phạm vi đọc này không phải full upstream audit.

## Benchmark khóa trước implementation

L1 dùng real `ManagedAgentTeam`, `AgentTeam`, `DefinedAgent` và actual session/model
loop với controlled model adapter. Gates/handshakes ở public host factories,
delivery và model boundaries; không gọi private scheduler helper. So cùng cases
trên BASE/final SDK loaded trong process riêng. Record mọi attempt, module/source
hashes, statuses, dispatched model calls, dependency evidence coverage, conflicts,
notification delivery và wait ordering; không dùng synthetic adapter tokens làm
provider-cost claim. Cases lỗi cùng negative controls, bao gồm asynchronous setup,
completed/closed/multi dependencies, teardown, cancelled waits, delivery gap,
equivalent/escaping paths, per-worker fork limits và terminal failure truth.

L2 bổ sung live matched workflow tasks, BASE/final bundles tách module, cùng
providers/models/budgets/instructions/authority. Có dependent synthesis, late
dependency, multi-dependency/slot release, failure/unknown và independent controls;
benchmark phải ghi fixture/oracle/config trước formal run. Task quality dựa facts,
source identity, missing/unknown state và effect counters; không keyword completion
hoặc model tự chấm. Dùng token và latency trên paired-success; all-attempt errors
và usage partial vẫn ở mẫu số. Primary Codex `gpt-6-luna`/medium và replication
ZenMux `dots-studio/dots3-note-prev`; USD không phải metric. Không đổi model/cap
hoặc retry riêng arm thua để làm kết quả đẹp hơn.

Các thay đổi qua L1 mới tới L2. L2 cần counterbalanced attempts, repeated tasks,
paired raw losses và review từng new loss. Báo exposed synthetic cohort và độ rộng
coverage thật; superiority/generalization chỉ khi evidence đủ. Cải thiện lifecycle
deterministic và model task-quality được kết luận riêng.

## Completion gates

- [x] Source audit owner/call paths/siblings và findings có reproduction thực.
- [x] Baseline và frozen benchmark manifest tồn tại trước production edit.
- [x] Implement cả class lỗi đã chọn, không chỉ chỉnh prompt để né reproduction.
- [x] Meaningful regressions + existing team/shared-budget/packed boundaries pass.
- [x] Matched live before/after + replication, mọi raw losses được review.
- [x] Báo metrics/limitations/remaining findings, source/integrity và reproduction.

## Findings đã tái hiện và implementation

| Nhóm | Trước sửa | Cơ chế sửa | Evidence L1 |
|---|---|---|---|
| Admission/owner | setup đồng thời bỏ qua write conflict; dispose không ngăn factory đang await tạo worker | reserve cả name/slot/scope trước await; lifecycle cancellation/revalidation; frozen declarations | concurrent-write, dispose-during-setup, failed-spawn-cleanup |
| Producer identity | late dependency không có result; close/reuse address làm mất hoặc đổi producer | bind exact runtime instance; unified handoff; detached retained evidence | late/closed/multi dependencies, async setup, name reuse |
| Required context | host từ chối dependency message nhưng vẫn gọi model | fail visible trước dispatch, release downstream theo terminal failure | failed-dependency-handoff-no-dispatch |
| Waiting | abort không kết thúc wait; quiet trả trước preparation/report delivery | abortable waits; chờ preparation/settlement/delivery và lead | abort-await/quiet, quiet-waits-for-setup/report |
| Closure | nhiều close cùng tên có thể detach instance mới; host cancel giữ close quá deadline | coalesce per-instance close; shared close deadline; settled terminal closure | close-coalesces-instance, close-bounds-host-cancellation |
| Result truth | resolved max-output wakeup bị báo completed; report lớn bị rơi | terminal response check; giữ partial failure text; bounded head/tail notification | wake-budget-failure-truth, oversized-worker-notification |
| Full evidence | closed producer không đọc được phần report bị cắt | `read_dependency_result` scoped đúng commissioned producers, paginated byte bound | closed-dependency-full-read, denied unrelated producer |
| Unicode | page cuối chứa `�` hợp lệ bị xóa, cursor không tiến | decoder streaming giữ code point hoàn chỉnh, byte-aligned tail | unicode-dependency-pagination: intermediate fail, final pass |
| Cancellation boundary | factory vừa abort vừa reject gây unhandled rejection | luôn gắn rejection observer, kể cả cancellation đã thắng | aborted-setup-rejection-observed |
| Context/steer | scoped fork limit bị bỏ qua; steer không đánh thức automatic hold | dùng merged worker history limits; interrupt hold bằng steer + owner/run signal | fork-scoped-history-limit, steer-interrupts-automatic-hold |

33 ca gồm các control về scheduling và quyền host. BASE trước đợt multi-agent: **5/33**; final
bundle: **33/33**. Đây là regression suite được mở rộng theo findings audit,
không phải random/blind task sample. Intermediate bundle đã đạt 27/27 trước khi
bổ sung ca Unicode; reproduction thứ hai mới bao phủ ký tự replacement ở cuối
trang. Giữ cả raw attempts để phân biệt ca thử chưa đủ mạnh và bug thật.

Production thay đổi chỉ ở `packages/core/src/agent/team/{managed,team,types}.ts`.
Existing test fixture còn được cập nhật assertions theo protocol prose mới; lifecycle/concurrency assertions giữ nguyên. Hai sửa fixture trước đó: path `/tmp/no-write` thành relative
`no-write` để kiểm tra đúng collision/omit-writes contract; controlled adapter
kiểm tra signal đã aborted trước khi subscribe, tránh chờ một abort đã xảy ra.
Không giảm assertion, timeout hoặc loại bỏ test lỗi để làm suite pass.

## Ranh giới SDK và policy của host

Không đưa workflow của ứng dụng vào SDK. Hướng dẫn lead/worker chỉ mô tả lifecycle,
identity và các tool được cấp. Bỏ quy tắc bắt buộc plan trước, tự làm critical path,
scaffold workspace, tự synthesis hoặc trả báo cáo ngắn. Task, roles, output format,
permissions và cách chia việc do developer quyết định.

`ManagedAgentTeam` là helper tùy chọn trên `AgentTeam`/sessions. Host có thể đặt
`autoLeadCoordination: false` để tự quản lý lượt lead, `workerTeamTools: 'full'`
hoặc `false` để chọn quyền điều phối worker, và `requireWorkerText: true` nếu
ứng dụng yêu cầu text. Mặc định clean tool-only completion hợp lệ; reporting-only
và automatic coordination vẫn là convenience defaults có thể tắt. Factories,
fresh/fork, write conflict reject/warn/off và scoped tools giữ nguyên extension points.
Bốn ca policy kiểm tra quyền tool thực, không kéo dài/restart lead khi host chọn
manual, completion sau tool action không có text, và opt-in bắt buộc text.

Live cohort v1 dùng intermediate v4; cohort v2 đo đủ 144 attempts trên v8.
Đợt v3 trên v9 dừng khi SDK-neutrality review phát hiện thêm strategy-prescriptive
prose trong generic team guidance: giữ 28 started attempts/26 results, hai usage
bị ngắt là unknown. Không retry theo score hoặc thay oracle. Final matrix v4 dùng
frozen v10, đo lại toàn bộ 144 attempts. Không pool cohorts hoặc chọn kết quả tốt.
Fixture, oracle, limits, models, effort, repeats và counterbalancing giữ nguyên.
Harness final thêm attempt-start log, hashes toàn bộ 26 built packages và xử lý
null/primitive output thành strict failure; không nới primary grading.

## Giới hạn còn lại

- Scope viết là scheduling declaration, không phải filesystem sandbox. Lexical
  normalization không xác minh symlink/case-folding; host giữ quyền file/tool.
- Dependencies phải là workers đã register; preparing/future names không được
  chấp nhận. Independent producers có thể spawn đồng thời, consumer spawn sau
  registration nhưng trước completion. Không thêm DAG chứa future nodes.
- Lead model muốn đọc đầy đủ oversized roster phải mount existing `leadSessionOptions.spillStore` rồi dùng `list_agents` / `read_tool_output`. Không mount thì tool-output policy hiện có sẽ truncate; host `workers()` vẫn giữ full current report. Closed dependency reader mới có scope riêng cho consumer.
- Full reports giữ trong memory theo lifetime consumer, không phải durable
  cross-restart registry. Retained evidence không giữ producer session/ancestors.
- Handoff tổng vượt custom team message cap sẽ fail visible, không silently
  dispatch consumer thiếu context. Không có auto summarizer suy đoán thay facts.
- Deadline/abort không forcibly terminate provider/host callback bỏ qua signal.
  Managed dispose dừng admission/workers của nó; shared `AgentTeam` vẫn host-owned.
- Live limits là per-session, không chứng minh aggregate workflow spending cap.
  Existing accounting/budget tests được chạy lại; không tuyên bố đã thêm global
  team budget hoặc filesystem authorization.
- Failure-family oracle đòi `sourceIds=[]` khi không có evidence. Task frozen
  không nói rõ empty IDs cho failed producer; model có thể trả worker address
  `source_a`. Giữ raw failure và báo assumption này, không regrade thuận lợi.
- Live workflow scheduling do host kiểm soát, dữ liệu synthetic và author-exposed.
  Native lead-tool smoke riêng kiểm tra integration; không dùng nó làm benchmark
  superiority. Không suy ra production/domain-wide chất lượng từ sáu families.


Index observation: baseline index SHA `a3f0f2abf361b386238ddf5c40eb1c144435865c7e8de28eb1f1d4e00b9b8780` còn khớp ở checks trước đó; sau đó chuyển thành `bf68b0d8b8c547d51ece2aa4e2391f00b0e1a9a25bf0ca02aaf11311b4fef0c9`. Không có git stage/add/commit/reset/stash trong tool actions của agent. Cached production/sample patch hiện tương ứng intermediate v4 (`474dc8c9...`); final working-tree patch v10 (xem candidate-freeze-v10.json) đã freeze riêng. Không khẳng định staged snapshot đã qua final validation hoặc đã chứa những sửa cuối.

## Kết quả cuối và evidence

Final frozen v10: 33/33 public orchestration cases; full suite 236 files/3.042 tests,
root/core types, public types, publint, architecture/runtime gates, packed core và
26-package isolated build pass. Live đủ 144 attempts, hashes không đổi và usage
đầy đủ/reconciled cho mọi arm/provider. Codex strict quality 21→30/36; ZenMux
15→17/36. Có 3/8 new losses tương ứng, đã review nguyên trạng. Không tuyên bố
mọi workflow đều tốt hơn; ZenMux early/parallel controls có regression về format.
Token paired-success giảm 22,47% trên 18 pairs Codex và 40,91% trên 7 pairs ZenMux;
chỉ là efficiency conditional của cohort này.

Native lead-tool smoke: cả hai provider dùng spawn/measurement/dependency thật;
Codex exact output pass, ZenMux thêm prose nên strict final-format fail. Không
đổi SDK để ép JSON schema hoặc workflow của fixture. Source evidence, mọi raw
losses, methods, checks và giới hạn tại
[findings](../evaluations/multi-agent-improvement-2026-09-27/findings.md).

Current staged source bằng intermediate v4, chỉ đạt 28/33; còn lỗi Unicode cursor,
unhandled setup rejection và thiếu policy controls mới. Final fixes nằm working
tree và frozen v10; agent không stage/commit. Không xem final validation là proof
cho cached snapshot.
