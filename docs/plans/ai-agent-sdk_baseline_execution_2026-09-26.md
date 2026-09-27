# Baseline trước cải tiến SDK — 26/09/2026

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.

**Trạng thái:** baseline ban đầu đã chạy xong và giữ nguyên bằng chứng trước production changes. Các gate từng mở ở mốc này được đối chiếu trong [closeout cuối](ai-agent-sdk_plan-completion_2026-09-27.md); số liệu bên dưới chỉ là historical baseline, không final comparison.

Theo yêu cầu người dùng, cấu hình chính là Codex **`gpt-6-luna` / reasoning `medium`**,
dùng credential store đã có trong repository. Cấu hình được giữ cố định cho lượt sau.
Provider/model/effort là thông tin công khai; credentials và HTTP bodies không vào artifacts.

## Kết quả live đã lưu

[Bản kết quả trong repo](../evaluations/codex-luna-baseline-2026-09-26/analysis.json),
[từng lần thử](../evaluations/codex-luna-baseline-2026-09-26/runs.jsonl),
[manifest](../evaluations/codex-luna-baseline-2026-09-26/manifest.json) và
[review queue](../evaluations/codex-luna-baseline-2026-09-26/review-queue.json).

| Metric | Baseline |
|---|---|
| Live attempts | 170; cùng model/effort/seed/limits |
| Automatic checks | 143 pass / 17 fail trên 160 lượt tự chấm: **89,38%** |
| Held-out split automatic checks | 114/130: **87,69%**; cohort exposed, không blind |
| Equal-domain automatic macro, held-out split | **89,00%**; prose chưa nằm trong điểm này |
| Prose review | 10 lượt chờ review, không tính pass tự động |
| Feature applicability | 2 families unsupported, không tính fail |
| Side effects từ fixture host | 0 mutation/duplicate effect trong các lượt này |
| Latency, tất cả live attempts | median **3,89 s**; p95 **8,89 s**; long-data tail vẫn giữ |
| Reported total tokens, gồm history turns | **214.272**; có cache/reasoning breakdown; không quy đổi USD |
| Usage evidence | 180/180 final/history usage records authoritative; không có run thiếu usage |
| Provider/runtime errors | 0 trong lượt baseline chính |

Các automatic failures: DATA-04 (5 lần), DOC-05 (5), OPS-04 (3), DOC-02 (1),
OPS-06 (1), BASIC-06 (1), BIZ-05 (1). DATA-04 chưa tổng hợp đầy đủ collection;
DOC/OPS có lỗi nguồn/observed IDs; BASIC-06 một lần đúng facts nhưng JSON không hợp lệ;
OPS-06 một lần trả string thay boolean. BIZ-05 dùng `unavailable` thay `unknown`;
đây là khả năng false negative do nhãn trạng thái cần review, chưa coi là lỗi SDK.

Điểm trên là **automatic task-contract score**, không phải điểm semantic tổng thể
đã qua independent review. Review queue giữ cả 17 lượt bị chấm fail và 10 prose outputs;
chưa overwrite/chấm lại điểm frozen. Grader hiện chuẩn hóa string/set; không dùng nó
thay source-provenance/ACL conformance. Host-call records không phải toàn bộ scheduler
spans hoặc provider wire trace.

Checksum đã kiểm tra và số records khớp manifest. SDK source archive không chứa `.env`,
`.providers/` hoặc `.temp/`; không tìm thấy các giá trị credential đã cấu hình trong
artifacts đã kiểm tra. Bản public nằm trong repo; raw source archive/frozen harness/checksums
nằm ở directory artifacts bên dưới, vốn được Git ignore.

## Bộ chạy và cách giữ bằng chứng

- [Runner và hướng dẫn](../../test-human/evaluation/README.md).
- [60 fixture families](../../test-human/evaluation/cases.ts) / [grader](../../test-human/evaluation/grading.ts).
- [Kiểm tra bộ chấm và tính toàn vẹn](../../tests/unit/neutral-evaluation.spec.ts).
- Raw baseline: `artifacts/neutral-evaluation/codex-luna-baseline-20260926-v1/`.
- Source baseline: `5b589b6abe6d0a61da3f55b549713456ccc8c7c4`; production package diff rỗng.

Manifest lưu model/effort, Node, revision, lockfile hash, limits, split/applicability và
hash của runner/fixtures/grader. Mỗi lượt lưu ngay vào JSONL, kể cả lỗi. Directory tạo
bằng exclusive create; không overwrite hoặc tự resume một baseline cũ. Khi kết thúc,
SHA-256 kiểm tra source archive, source diff, fixtures, manifest, records và summary.
Analyzer từ chối artifacts bị đổi hoặc lượt chưa đủ; comparison từ chối config không khớp.

60 families gồm 20 development, 10 calibration và 30 held-out theo split. 28 held-out
families được baseline hỗ trợ chạy 5 lần; các bài development/calibration chạy một lần.
Tổng dự kiến **170 lượt live + 2 unsupported records**. Hai families prose giữ
`needs-review`, không nhận automatic semantic pass. Báo cáo tách counts theo domain,
trung bình ngang trọng số domain, latency, token và actual effect count.

Đây là **frozen regression cohort đã được tác giả xem**, không phải blind holdout.
Việc lặp 5 lần không biến một family thành 5 bài độc lập. Tokens không phải chi phí USD;
không kết luận tiết kiệm từ task thất bại. So sánh tuần tự trước/sau vẫn có provider/time drift.

## Bằng chứng xác định đã lưu

| Gate | Kết quả | Artifact |
|---|---|---|
| 8 file regression SDK | 217 tests pass | `artifacts/neutral-evaluation/deterministic-baseline-20260926.json` |
| Grader/integrity/pairing self-tests | 10 tests pass | `tests/unit/neutral-evaluation.spec.ts` |
| Existing SDK stress, 6 scenarios × 2 | 12 cases pass; 5.120 iterations; 0 aborted | `artifacts/neutral-evaluation/compatibility/neutral-baseline-20260926/summary.json` |
| Expired output recovery diagnostic | Unsafe retry wording tái hiện | `artifacts/neutral-evaluation/expired-spill-baseline-20260926.json` |
| Build, TypeScript, docs/human checks | Pass tại baseline | Tool execution trong phiên; không đồng nghĩa hosted/production validation |

Diagnostic expired output chỉ chứng minh lời hướng dẫn retry không phù hợp sau receipt
eviction. Chưa được diễn giải thành bằng chứng live model gây duplicate effect.

## Applicability và phần chưa được chứng minh

| Capability | Bằng chứng hiện có | Giới hạn/gate còn thiếu |
|---|---|---|
| Output recovery | Deterministic expiry; BIZ-03 receipt/current state; DATA-04 phân trang/output lớn | Full faultpoint matrix, failed-save/path variants và no-receipt recovery phải bổ sung ở wave 0 |
| PTC utility | Filter/join/aggregate và các task nhỏ/unknown/prose làm controls | Chưa có executor; chưa có architecture/isolation/root-budget gates. Một large-data family không đủ chứng minh PTC go/no-go |
| Structured handles/output contracts | Existing text spill; bounded generic resource tools | Không chứng minh JSON handles, output schema capture/MCP/post-policy/revision |
| Durable operation | BIZ-04 ghi unsupported; execution contract unit evidence riêng | Chưa có adapter/process-kill harness; không tính unsupported thành failure |
| Durable task owner | PLAN-06 ghi unsupported; process-local team unit tests | Chưa chứng minh writer generation qua process boundary |
| Recall | Historical-record selection/absence/supersession proxies | Chưa có cross-session corpus, real compaction recall, undo/delete/revoke/index lag |
| Process backend | Command status/timeout/permissions trên synthetic records | Không phải subprocess/network/container execution hoặc cleanup proof |
| Skill proposal | Không triển khai/kích hoạt | Không có utility/publication/rollback evidence |
| Runtime regressions | Tool/team/compaction unit tests và hermetic stress | Live BASIC-06 chỉ short session continuity; không thay real long-context compaction hay packed/runtime checks |

Fixture CODE-04 kiểm formula bằng parser bounded và các behavioral vectors độc lập;
không phải arbitrary patch application trong sandbox. Các bài LANG-01/02 hiện là
factual extraction, không đại diện toàn bộ chất lượng tóm tắt. BASIC-05 hiện kiểm host
denial, không đại diện cancel lúc approval đang chờ. SUP-03 kiểm counts; chưa có riêng
private-contact redaction fixture. Không dùng các proxies này để đóng toàn bộ EV-00 hoặc
release gates trong [evaluation specification](ai-agent-sdk_neutral_before-after_evaluation_2026-09-26.md).

## Các lượt thử giữ riêng

- Gemini preflight thành công; pilot dừng khi người dùng chọn Codex.
- Codex `gpt-6-sol/high` pilot: 8/10 automatic checks pass. Hai prompt-field ambiguities
  được ghi lại; kết quả cũ không bị chấm lại/overwrite.
- `codex-baseline-20260926-v1`: dừng ở protocol validation khi phát hiện missing-evidence
  paraphrase bị so chuỗi đánh sai. Bản tiếp theo chỉ làm rõ output labels/path; không sửa SDK.
- `codex-baseline-20260926-v2`: 17 records giữ lại; dừng khi người dùng chọn `gpt-6-luna`.
- `codex-luna-preflight-20260926`: live arithmetic check pass trước lượt chính.

Không trộn các lượt khác model hoặc khác giao thức vào điểm baseline chính.

## Sau baseline

Giữ nguyên cohort/config/grader. Mỗi thay đổi SDK cần build và chạy `--phase after` vào
directory mới, rồi pair family/repeat bằng analyzer. Việc phát hiện lỗi protocol sau
freeze phải tạo cohort/version mới và giữ toàn bộ evidence cũ; không âm thầm sửa điểm.
Các spike chỉ được productize sau capability gates riêng nêu trên; baseline hiện tại
không phải bằng chứng rằng mọi hạng mục trong implementation plan đã được đánh giá đủ.
