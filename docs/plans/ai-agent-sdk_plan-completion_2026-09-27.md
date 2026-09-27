# Kiểm chứng hoàn thành toàn bộ plan — 27/09/2026

**Trạng thái: hoàn tất trong phạm vi đã chọn, giữ nguyên các kết luận không đạt/inconclusive.** Implementation trong phạm vi đã chọn, audit
và các lớp đánh giá đã được thực hiện; không có yêu cầu triển khai public package
cho các hướng chưa có consumer. Kết quả thực nghiệm có thể là `needs-review`;
hoàn tất plan không có nghĩa mọi gate phải xanh hoặc SDK tốt hơn mọi workload.

Không tự stage, commit hay push. Code production/sample vẫn khớp bundle đã freeze
với patch SHA-256 `055229ab7ad31aecb71d09a0a5908462db728e28bca545b3ed4caf98b1eb3200`.
Các fixes F01–F12 và evidence HTTP/SSE riêng nằm trong
[deep audit](ai-agent-sdk_deep-audit_fixes_2026-09-27.md).

## Phạm vi và quyết định

| Yêu cầu | Implementation / bằng chứng cuối | Quyết định |
|---|---|---|
| EV-00 / baseline | SDK gốc `5b589b6…`, archive + dirty patch đã freeze; original/final build riêng, loaded session hashes khác nhau | Hoàn tất replay, không switch user checkout |
| Đợt 0 / OUT-01…05 | Recovery wording phân biệt read/retry-safe/mutation; receipt/current-state lookup; output-budget regressions | Implement, normal-runtime gates pass |
| SP-01 / PTC-A01…17 | Shared native admission, root accounting, lifecycle/projection, output schema capture/MCP, scoped result handles, bounded lossless JSON | Sync 15/15, async 16/16; A13/A15 qua unit + packed gates |
| SP-01 value | Current-source FILTER/JOIN + controls, 3 repeats, 72 attempts/model; token/latency trên paired-success targets | Codex go cho target; ZenMux no-go/needs-review vì hai paired losses và usage partial |
| Productization | `experimentalPrograms` / nested port / output schema opt-in; QuickJS ở host sample, không dependency mới trong Universal core | Giữ experimental, mặc định tắt |
| SP-02 / DUR-01…11 | SQLite persisted intent, locked migration, fingerprint/fencing/reconcile, approval ownership, retention, retry publication | 45/45 real-process cases; host sample, không distributed exactly-once |
| SP-03 recall | Current-source revision/ACL join, opaque refs, revoke/undo/delete/index lag | 15/15; host spike, public package chờ consumer |
| SP-04 process | Local/container protocol, output/exit, abort/timeout/tree cleanup, disconnect unknown | 25/25; host protocol sample |
| SP-05 skill | Proposal authority, CAS, explicit publication/rollback | 19/19; proposal-only, không learning efficacy hoặc auto-publish claim |
| PTC Q1 | Child `parentCallId`, host policy/approval/journal, replay child hoặc outer result | 4/4 integration cases; host giữ mutation authority |
| PTC Q2 | Async guest/Promise.all và sequential bridge queue | Real WASM/session conformance pass |
| PTC Q3/Q4 | Continuation ở host durable runner; parallel children hoãn đến khi có consumer | Quyết định phạm vi, không implementation còn thiếu |
| EV-01 | Original SDK/final bundle, matched en/vi, 5 repeats, hai model, OFF, independent prose review, family CI và tất cả raw losses | Hoàn tất thí nghiệm; conclusions bị giới hạn bên dưới |

Source audit là historical research với những phạm vi đã đọc; không biến thành
claim đã audit upstream/production mới nhất. Durable runner/cron, vector recall,
remote process persistence và skill auto-learning không thuộc implementation được
chọn trong plan §1/§8. SQLite/journal và host checkpoints vẫn là hai trách nhiệm,
như ADR đã chấp nhận.

## Neutral evaluation cuối

Cohort v2.2 có 60 synthetic families, 120 matched Việt/Anh variants, giữ source
language và split đã công bố. Final dùng 28 COMMON families trong đủ 10 domains,
5 repeats × 2 languages × 2 arms: **560 live attempts + 8 unsupported records/model**.
BIZ-04/PLAN-06 không được cấu hình cho L2; durable/restart conformance được kiểm ở
L1, không biến unsupported thành quality failure. Cohort author-exposed, frozen
trước lượt chạy; không gọi đây là blind held-out hoặc dữ liệu production đại diện.

BASE/CANDIDATE chạy xen kẽ, counterbalance; cùng prompts, dữ liệu, quyền read-only,
model/effort và limits. BASE có normal tools, spill và `read_tool_output`. Chỉ
preregistered target families được expose program tool; ở held-out đó là DATA-04.
Mỗi SDK resolve packages từ snapshot riêng, không dùng nhầm current core.

| Model / provider | Raw passes BASE → final (280/arm) | Macro BASE → final | Delta / 95% family CI |
|---|---|---|---|
| Codex `gpt-6-luna` / medium | 248 → 253 | 88.50% → 90.17% | +1.67 pp; [-3.33; +7.33] pp |
| ZenMux `dots-studio/dots3-note-prev` | 187 → 198 | 66.50% → 70.50% | +4.00 pp; [0.00; +7.83] pp |

Macro cân bằng domains; khác raw pass rate. CI là 4.000 stratified paired-family
bootstrap draws, seed 260927; repeats/translations ở cùng cluster, không là 280
independent tasks. Cả hai đạt **metric non-inferiority với margin 5 pp** trên cohort
này. Interval còn chứa/chạm zero, không chứng minh superiority. Raw new losses
vẫn tồn tại; không dùng macro để bỏ qua chúng hoặc xác nhận an toàn mọi workflow.

| Domain | Codex BASE → final | Dots BASE → final |
|---|---|---|
| BASIC | 100.00% → 100.00% | 53.33% → 63.33% |
| BIZ | 75.00% → 75.00% | 55.00% → 60.00% |
| CODE | 100.00% → 96.67% | 76.67% → 70.00% |
| DATA | 66.67% → 100.00% | 66.67% → 80.00% |
| DOC | 56.67% → 46.67% | 50.00% → 56.67% |
| HIST | 96.67% → 96.67% | 83.33% → 93.33% |
| LANG | 96.67% → 90.00% | 56.67% → 60.00% |
| OPS | 93.33% → 96.67% | 76.67% → 73.33% |
| PLAN | 100.00% → 100.00% | 70.00% → 75.00% |
| SUP | 100.00% → 100.00% | 76.67% → 73.33% |

Codex giảm DOC 10 pp, LANG 6.67 pp và CODE 3.33 pp; DATA tăng 33.33 pp. Replication
có pattern khác. Đây là lý do không kết luận SDK tốt hơn toàn diện hoặc quy mọi
khác biệt của bundle cho PTC.

| Language (raw COMMON pass rate) | Codex BASE → final | Dots BASE → final |
|---|---|---|
| en | 89.29% → 92.14% | 69.29% → 73.57% |
| vi | 87.86% → 88.57% | 64.29% → 67.86% |

## Review losses, authority và grader limits

Đã đọc prompt, oracle, cả outputs và trace của **9 Codex + 24 replication raw new
losses**. [Adjudications](../evaluations/plan-completion-2026-09-27/loss-adjudications.json)
giữ nguyên primary grades, phân biệt incomplete facts, citations, enums, field
types, JSON/diff envelopes, compaction errors và bounded stops. Live pair loss chưa
đủ cô lập SDK code regression. Có claim `failed` khi trạng thái thực tế unknown;
không chấp nhận model text như authoritative operation state cho business workflow.

COMMON final có zero observed body effects/private leaks. Dots có **9 BASE + 8
candidate runtime failures**, chủ yếu manual compaction với summary finish
`max-tokens` ở cap 1.024 output tokens. Các failures/costs giữ trong mẫu số; 17
attempts không có final text nên privacy observation không đầy đủ. Source guard
không thay history khi summary thất bại; không khẳng định nguyên nhân error sâu
hơn từ error code đã được sanitize. Mutation requests bị host chặn vẫn được đếm.

Independent reviewer là Codex `gpt-6-sol`/high, tools rỗng, labels A/B được shuffle,
ẩn arm/provider/revision. 20 paired reviews/model + 10 OFF paired reviews; nguyên
criterion/rubric, input/output hashes và reviewer source đã giữ. Đây là một reviewer
model, không human hoặc independent consensus. Semantic pass không override
arithmetic/state/privacy/schema/envelope failure.

Audit phát hiện một normalized-output group ở Codex được chấm không nhất quán:
“Kính đề nghị chuyển lịch họp…” pass ở candidate repeat 1 / BASE repeat 4, fail ở
candidate repeat 3. [Consistency diagnostic](../evaluations/plan-completion-2026-09-27/prose-consistency-codex.json)
giữ cả ratings. Conditional unblinded sensitivity nếu cả request outputs đều fail
làm mỗi arm mất một pass; delta/CI không đổi. Primary scores không bị sửa. OFF
reference review cũng disagreement một lần với cùng candidate output; đã công khai.

Một số exact oracles có giới hạn: BIZ-05 không enumerate status ngay trong prompt,
`unavailable` có thể là abstention hợp lý nhưng oracle yêu cầu `unknown`; HIST-04
có ambiguity với resource-name citation fallback; DOC-05 thiếu citation khác với
sai factual abstention. Các lỗi này không được regrade chọn lọc sau khi thấy điểm.
Không coi pass/fail hiện tại là kiểm chứng mọi unsupported claim trong mọi output.

## OFF ablation và value gate

OFF dùng cùng final SDK/dữ liệu/budgets, nhưng chạy sau lượt xen kẽ. Ten-family
selection đã freeze trước results, phủ **9 domains** (hai DATA families, không
PLAN); hầu hết domains chỉ một family. CI không ước lượng được, không xuất zero-width
interval. ON policy đạt 82/100, OFF 81/100; equal-domain macro ON − OFF **−3.33 pp**.
DATA-04 đạt **10/10 ON vs 2/10 OFF**. Tất cả 12 raw ON-policy losses nằm ở controls
mà PTC tắt ở cả hai lượt; đã [review riêng](../evaluations/plan-completion-2026-09-27/ablation-loss-adjudications.json).
Không quy control/timing/model/rater variations cho việc bật PTC; không dùng ablation
nhỏ này để khẳng định overall non-inferiority hoặc latency causality.

Current-source development value gate dùng fixture `f801f604…` đã freeze, native
spill/budgets hiện có; mỗi model 24 BASE + 24 PTC target attempts và 12 + 12 controls.
Không phải original SDK/final bundle comparison và không blind held-out.

| Model | Target BASE → PTC /24 | New paired losses | Paired-success token reduction | Paired-success p95 latency | Decision |
|---|---|---|---|---|---|
| Codex | 16 → 23 | 0 | 91.93% (16 pairs) | −0.23% | Go cho target workload; usage complete |
| ZenMux Dots | 12 → 22 | 2 | 78.53% (10 pairs) | −76.24% | No-go / needs-review; usage partial |

Codex controls pass 12/12 mỗi arm, zero effects; median paired token ratio +27%.
Giữ policy opt-in theo workload, không bật PTC mặc định. JOIN-2/r0 PTC sai năm
pairs thừa/hai thiếu sau projection-too-large guard và recovery; BASE cũng fail,
không có paired loss ở đó. Không đổi limits/prompt để làm benchmark xanh.
ZenMux controls pass 12/12 mỗi arm, zero effects; median paired token ratio tăng
20,11%. Hai new paired losses JOIN-3/r0 và JOIN-2/r2 đều timeout ở 180 giây:
JOIN-3 đã đọc/spill rồi hoàn tất một program nhưng chưa có final answer;
JOIN-2 thử async/await ở executor sync đã khóa, bị reject đúng, rồi recovery trước
khi timeout. BASE trả đúng 57/57 và 72/72 pairs tương ứng. Async sample có gate
riêng; không thay executor của cohort đã freeze để rerun chọn lọc. Trace chưa cô
lập lỗi mới trong core/scheduler. [Value loss adjudications](../evaluations/plan-completion-2026-09-27/value-loss-adjudications.json)
giữ primary grades và usage thiếu. Vì quality/usage gate fail, không chấp nhận
replication dù aggregate passes và paired-success efficiency cải thiện.

USD không phải deliverable theo quyết định user (implementation plan §10); không
có monetary savings claim. Chi phí infrastructure chưa đo đủ, quyết định provisional.

## Efficiency denominators

| Model | All-attempt tokens BASE → final | Paired-success pairs | Median tokens BASE → final | Paired-success p95 ms BASE → final |
|---|---|---|---|---|
| Codex | 1,070,662 → 755,076 | 239 | 1,029 → 1,029 | 14,426 → 13,748 |
| Dots | 1,288,809 → 921,689 | 163 | 1,786 → 1,818 | 10,546 → 12,491 |

All-attempt totals giảm không tự thành efficiency win: cohort bao gồm failed tasks.
Paired-success median tokens không giảm ở toàn suite; Dots p95 còn tăng khoảng 18.45%.
Target FILTER/JOIN gate không áp dụng mọi domain. Các reports giữ distributions,
per-task samples, cache/input/output/reasoning, rounds/outer+child calls và latency.
`inputTokens` là uncached, cache counters riêng; reasoning là subset output, không
cộng lần hai vào `totalTokens`. Không dùng token như USD.

Raw `modelVisibleBytes` trong worker là serialized canonical history + host events,
kể cả hidden children. Derived report đặt tên `auditSnapshotAndEventBytes`; actual
model/guest byte efficiency chưa đo, không có byte-savings claim. Shared local host,
cache và provider/backend drift chưa bị loại hết; latency nhỏ chỉ là chỉ báo.

## Các sửa bổ sung trong lượt hoàn tất

- Value analyzer kiểm exact task/repeat/arm/category/integrity, không để task thắng
  bù một new paired loss; effects ở target cũng làm safety gate fail.
- Token **và latency** gates cùng dùng paired-success target tasks. Slow failed BASE
  timeout không làm PTC thành latency win; regression tương ứng đã pass.
- Neutral stats sửa cache counters, byte metric labels và không bootstrap CI giả khi
  mỗi domain thiếu independent families. Prose scores phải bind với frozen raw hashes.
- CODE-04 dùng real unified diff/hidden behavioral tests trong pinned, no-network,
  non-root read-only Docker; valid alternative patch pass, incorrect code fail.
- Test stream dùng child handshake thay ngưỡng 700/400 ms phụ thuộc tải máy;
  giữ proof rằng onChunk được gọi trước child exit, không đổi implementation stream.

## Protocol history và verification

v2 active public RuntimeAgentSession.inject không được API hỗ trợ; host constraint
revision dùng active resource update rồi invocation tiếp theo hợp lệ. Calibration
v2 từng có một mutation body effect do host chưa khóa read-only; đã sửa authority
cho cả arms. v2.1 final dừng sau pair khi phát hiện raw cap 8 KiB không admit DATA-04
page ~17 KiB / DOC-04 ~24 KiB: **26 records/model**, toàn cohort giữ diagnostic,
không chọn lọc arm thua. v2.2 raw cap chung 64 KiB, model cap vẫn 2.048 tokens;
preflight thực trên cả SDK xác nhận large calls success và spill recovery available.
Oracles/input không retune theo đáp án. Pilots/calibration/partial cohorts giữ riêng,
không trộn vào final quality score.

Local verification: **235 files / 3.009 tests pass**; focused mới 12/12, workspace
build 26 packages, typecheck/CLI/package tests, toàn bộ applicable publint/types/
packed Node/browser/worker matrix, lint, negative boundary fixtures, supply-chain,
docs/human checks. QuickJS sync 15/15, async 16/16; durable 45/45; process 25/25;
recall 15/15; skill 19/19 đều rerun trên source hiện tại. HTTP/SSE evidence riêng:
16 workflows trước final internal request binding; S6/S10/S15 3/3 sau binding,
production/sample fingerprint vẫn khớp. Không có hosted CI, browser visual hoặc
production validation mới trong lượt này.

[Verification và source fingerprints](../evaluations/plan-completion-2026-09-27/verification.json),
[retained artifacts](../evaluations/plan-completion-2026-09-27/retained-artifacts.json)
và checksums chứa raw inputs/runs/reviews/analyses, protocol diagnostics và final
candidate patch. Baseline archive/snapshots vẫn giữ tại owned artifacts, không copy
credentials hoặc node_modules vào docs. Historical scores/manifests/checksums giữ
nguyên; reanalysis mới chỉ là derived report riêng.
