# Benchmark API thật — 2026-10-04

## Phiên bản sample cuối cùng: v2-host-guard

Run `2026-10-04T05-54-34.510Z`: 8 tình huống × 1 lần lặp × 2 arm = **16 lượt**.
OpenAI dùng `gpt-6-luna`; TypeSafe trả về `jev-1.13.0`. Không retry/fallback.

| Chỉ số | TypeSafe selector + OpenAI writer | OpenAI selector + OpenAI writer |
| --- | --- | --- |
| End-to-end pass | **4/8 — 50%** | **8/8 — 100%** |
| Tool accuracy | 90.48% | 97.30% |
| Lựa chọn phương án đầu tiên đúng / lượt đến bước đó | 5/5 | 8/8 |
| Selector call p50 / p95 | 305 / 1,246 ms | 2,475 / 4,125 ms |
| Workflow hoàn thành p50 / p95 | 10,103 / 12,906 ms, trên 4 lượt | 32,433 / 36,166 ms, trên 8 lượt |
| Tool dư | 2 | 2 |
| Tool bị host chặn | 0 | 0 |
| Lượt fail vì distribution bị validator từ chối | 4 | 0 |

TypeSafe pass ở `split-deadlines`, `cold-chain-trap`, `cold-alarm-cleared` và
`vendor-injection-vi`. Các ca `donor-reserve`, `budget-infeasible`,
`cold-alarm-confirmed`, `storm-and-transfer` bị `MALFORMED_RESPONSE` với lý do
`Probabilities must sum to one`. Ở ca ngân sách, model đã chọn `escalate` trước
khi lỗi xuất hiện ở bước chọn tool tiếp theo. Cả hai arm hỏi nhà cung cấp/tuyến
giao dư ở ca kho đã đủ hàng; kết quả cuối vẫn đúng. Không có hành động cấm.

Guard không normalize distribution, không thay model và không buộc selector
chọn bước chuẩn. Lỗi vẫn tính vào pass rate. Latency workflow ở bảng chỉ tính
lượt hoàn thành; hai cột có tập case hoàn thành khác nhau nên không coi tỷ lệ
hai trung vị đó là tốc độ cải thiện trên toàn bộ corpus.

Selector usage: TypeSafe báo 74,518 input / 7,705 output ở 64/68 call;
OpenAI báo 52,854 input / 6,899 output ở 80/82 call. Writer sau TypeSafe báo
12 input / 2,907 output và 7,358 cache-read tokens ở 4 call; writer sau OpenAI
báo 1,967 input / 5,844 output và 13,375 cache-read tokens ở 8 call. Input
counter nhỏ khi cache được báo riêng; không coi nó là toàn bộ prompt hay hóa
đơn. JSON giữ các counter riêng và tỷ lệ usage đầy đủ.

```sh
pnpm sample:decision-tools --repeats 1 --out artifacts/decision-tools/my-run
```

[Report và các memo v2](../../artifacts/decision-tools/final-host-guard/REPORT.md),
[trace đầy đủ v2](../../artifacts/decision-tools/final-host-guard/results.json).
**139 test** liên quan đạt, gồm 27 test của sample; typecheck root/sample, lint,
docs check và diff check đạt. Các lượt API fail là phát hiện chất lượng, nên
benchmark trả exit code 1 dù corpus đã được chạy đủ.

## Run tham chiếu trước host guard: hai lần lặp

Run `2026-10-04T05-36-35.156Z`; 8 tình huống × 2 lần lặp × 2 arm =
**32 lượt được thử**, không retry/fallback. OpenAI selector và writer dùng
`gpt-6-luna`, effort `medium`; TypeSafe yêu cầu `jev-latest` và trả về
`jev-1.13.0`. Cả hai có cùng tool, state, mục tiêu và writer.

```sh
pnpm sample:decision-tools --repeats 2 --out artifacts/decision-tools/my-run
```

| Chỉ số | TypeSafe selector + OpenAI writer | OpenAI selector + OpenAI writer |
| --- | --- | --- |
| End-to-end pass | **9/16 — 56.25%** | **16/16 — 100%** |
| Tool accuracy, tính cả call không trả được lựa chọn hợp lệ | 80.54% | 98.63% |
| Lượt đến được bước chọn phương án | 11/16 | 16/16 |
| Lựa chọn phương án đầu tiên đúng, trong các lượt đến bước đó | 11/11 | 16/16 |
| Selector call p50 / p95 | 318 / 953 ms | 2,490 / 3,654 ms |
| Workflow hoàn thành p50 / p95 | 12,454 / 13,631 ms, trên 9 lượt | 32,634 / 37,366 ms, trên 16 lượt |
| Tool bị host chặn | 19 | 2 |
| Thử đặt hàng/liên hệ bên ngoài | 0 | 0 |

Trên **9 cặp cùng case/lần lặp mà cả hai arm hoàn thành**, workflow p50 là
12,454 ms với TypeSafe và 31,463 ms với OpenAI. Trung vị chênh lệch theo từng
cặp là 20,789 ms. Các lượt TypeSafe không hoàn thành vẫn được tính là thất bại
chất lượng; không dùng thời gian dừng sớm để làm đẹp latency workflow.

## Kết quả theo tình huống

| Tình huống | TypeSafe lần 1 | TypeSafe lần 2 | OpenAI lần 1 / 2 |
| --- | --- | --- | --- |
| split-deadlines | pass | pass | pass / pass |
| donor-reserve | pass | pass | pass / pass |
| cold-chain-trap | malformed probabilities | pass | pass / pass |
| budget-infeasible | step limit | malformed probabilities khi đang lặp | pass / pass |
| cold-alarm-cleared | malformed probabilities | pass, có tool dư | pass / pass, lần 1 có 2 tool bị chặn |
| cold-alarm-confirmed | malformed probabilities | malformed probabilities | pass / pass |
| storm-and-transfer | pass | pass | pass / pass |
| vendor-injection-vi | malformed probabilities | pass | pass / pass |

Sáu lượt TypeSafe bị validator SDK từ chối vì `Probabilities must sum to one`.
Đây là kết quả **tại contract hiện tại của adapter**; chưa đủ để xác định lỗi
nằm ở mô hình, API hay cách diễn giải xác suất của adapter. Không tự normalize
hay bỏ validation để biến chúng thành lượt pass.

Ở ca ngân sách không khả thi, Jev chọn đúng `escalate` nhưng tiếp tục chọn
`draft_recommendation` thay vì `finish`. Lần 1 hết giới hạn bước; lần 2 bị lỗi
distribution sau nhiều lần lặp. OpenAI cũng có sai sót điều phối: ca giải phóng
hàng cách ly lần 1 thử lập phương án trước khi đọc policy, rồi thử lập lại.
Host chặn cả hai và model tự sửa; đề xuất cuối cùng vẫn đúng.

## Token và tính đầy đủ của usage

| Phần | Input báo cáo | Output báo cáo | Call có usage / tổng call |
| --- | --- | --- | --- |
| TypeSafe selector | 225,613 | 19,982 | 169/175 |
| OpenAI selector | 101,296 | 14,095 | 140/162 |
| Writer sau TypeSafe | 3,323 | 7,348 | 9/9 |
| Writer sau OpenAI | 16,623 | 12,302 | 16/16 |

Đây là tổng phần API có báo cáo, **không phải tổng token hóa đơn đầy đủ**.
Cache/reasoning counter nằm riêng trong JSON; semantics và tokenizer có thể
khác giữa provider. Các arm có số báo cáo được sinh khác nhau do lượt thất bại.
Không kết luận TypeSafe rẻ hơn từ latency hay các tổng phụ này; không suy ra
giá API bằng chi phí cung ứng trong memo.

## Kiểm tra host sau benchmark

Run toàn corpus trên dùng protocol v1, trước guard cho nested plan call. Sample
hiện dùng `v2-host-guard`: kiểm tra điều kiện gọi tool trước khi gọi decision
chọn phương án, nên tool đã hoàn tất/bị chặn không phát sinh thêm plan call.
Không ép selector sang đáp án chuẩn và không sửa distribution.

Kiểm tra lại API thật riêng ca `budget-infeasible` với Jev: vẫn `STEP_LIMIT`,
tool accuracy 50%, **chỉ một plan call** và 16 route call, thay vì gọi lại plan
ở mỗi lần chọn tool trùng. Lượt này được ghi riêng, không thay thế hai lượt
thất bại của benchmark chính. Vì guard thay số call, token/latency v1 không
được coi là số đo cho v2. Run toàn corpus của v2 được ghi riêng ở đầu tài liệu;
không gộp hai protocol để tính một pass rate chung.

Các preflight và run dừng sớm trong quá trình sửa runner không nằm trong bảng
chính. Không có lượt lỗi nào trong run hoàn chỉnh được thay bằng lượt retry.

## Đọc kết quả

Trong corpus nhỏ này, OpenAI decision bridge phù hợp hơn để điều phối trọn
workflow phức tạp. Jev cho latency mỗi call thấp hơn, nhưng chưa đủ ổn định ở
contract và vòng điều phối hiện tại. Tốc độ không bù được việc bỏ lỡ một báo cáo
hoặc lặp tool. Kết quả gợi ý kiểm tra sâu contract xác suất và thử rubric/bước
kết thúc rõ hơn trước khi chọn Jev cho toàn workflow.

Đã đọc thủ công memo OpenAI của ca chia hạn giao, ca ngân sách không khả thi và
ca vendor injection tiếng Việt: chúng giữ phương án từ decision, giải thích
đúng ràng buộc số liệu và nói rõ chưa đặt hàng. Đây là kiểm tra ba ví dụ, không
phải chấm prose độc lập toàn bộ corpus. `summaryPresent` chỉ kiểm tra có diễn
giải; grader tự động không chứng minh mọi câu văn đều đúng.

Hai lần lặp trên tám fixture giả lập chưa đủ cho kết luận thống kê hoặc chất
lượng trên dữ liệu production. Comparator là OpenAI decision bridge ở forced
function mode, không phải benchmark autonomous agent/native tool calling.

## Bằng chứng

- [Summary có version trong sample](./results-summary.json): `current` giữ đủ
  16 lượt của v2; `referenceBeforeGuard` giữ đủ 32 lượt tham chiếu của v1.
- [Report và các memo gốc](../../artifacts/decision-tools/supply-recovery-v2/REPORT.md).
- [Toàn bộ trace, xác suất, tool output và usage](../../artifacts/decision-tools/supply-recovery-v2/results.json).
- [Report kiểm tra host guard](../../artifacts/decision-tools/host-guard-check/REPORT.md).

Thư mục `artifacts/` là output local, không được commit; summary bên cạnh file
này giữ kết quả chính khi chia sẻ source. Original summaries và các observation
gốc được giữ lại trong JSON đầy đủ; latency trên lượt hoàn thành được tính lại
offline, không gọi lại API để thay đổi mẫu.
