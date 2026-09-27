# chat-agents live workflows: findings and fixes (27/09/2026)

**Phương pháp:** `test-human/chat-agents-live/run.ts` chạy sample `chat-agents` thật (Next dev server, DB, workspace và spill cô lập) qua HTTP API với model thật:
- Codex `gpt-6-luna`;
- ZenMux `dots-studio/dots3-note-prev` (free), qua route `openai`.

Có 16 workflow: đọc/ghi file có approval, abort, steer, human-in-the-loop, team-dynamic, hai phiên song song, file lớn, lệnh shell, sửa code rồi chạy kiểm tra. Oracle dựa trên file trong workspace hoặc đáp án chính xác.

## Kết quả

| Model | Trước khi sửa | Sau khi sửa (×2) |
|---|---|---|
| Codex `gpt-6-luna` | S1–S9 9/9; S10 (steer) 2/4; S11 (team) 1/2 | **32/32** |
| dots3 (free) | S1–S9 ×2: 14/18 (có retry storm 95s, S6 tiếp tục task đã hủy) | **31/32** (lần fail còn lại: model bỏ sót 1 file, S14) |

## Lỗi tìm thấy và đã sửa

| # | Tầng | Lỗi | Bằng chứng live | Sửa | Kiểm |
|---|---|---|---|---|---|
| 1 | **SDK core** | Message được `AgentSession.inject` đưa vào khi một model round đang stream bị ghi *trước* output của chính round đó. Round sau đọc thấy "steer rồi đến phần việc đã bỏ qua nó", và coi như steer đã được xử lý. | S10 Codex 2/4. Trace cho thấy request của step 2 có `messageCount: 4`, tức chưa có steer. | Chỉ giữ message trong hàng chờ khi round đang stream; xả ở `beforeStep`, ở `step-end`, khi có câu trả lời cuối không kèm tool call, và khi run kết thúc. Inject giữa các round (hook, thông báo của team) vẫn ghi ngay như cũ. | `session-inject-ordering.spec.ts` (đã kiểm bằng mutation); S10 **5/5** |
| 2 | **SDK core** | Turn bị abort không để lại dấu vết cho model. Turn sau vẫn tiếp tục task đã bị hủy và bỏ qua message mới. | S6 dots3 fail | Khi turn kết thúc `aborted`, thêm message nguồn `app` (producer `turn-interrupted`), giống cách Codex và Claude Code làm. | `tool-loop.spec.ts`; S6 pass trên cả hai model |
| 3 | **SDK core** | Instruction sau `submit_result` ở deep mode bắt model viết báo cáo dài, kể cả khi user yêu cầu "chỉ JSON". | S11 dots3 0/2: tính đúng nhưng trả "Final Report" | Instruction giờ nói: nếu user yêu cầu một định dạng cụ thể thì trả lời đúng định dạng đó. | S11 dots3 **3/3** |
| 4 | Sample | `retryHooks` đếm số lần thử theo `turn.step`, nhưng mỗi lần retry lại sang step mới, nên `MAX_MODEL_ATTEMPTS` không bao giờ có hiệu lực. | 30 lần "retrying (2/3)" trong một turn, mất 95s | Đếm số lần fail liên tiếp theo các step liền kề. | Test loop thật `runTurn` + adapter luôn fail: đúng 3 lần gọi; bản cũ bị treo (mutation) |
| 5 | Sample | `read_file` cắt ở 400 dòng, nhưng phần render cho model bỏ mất `truncated`/`totalLines`. | S11 Codex: worker nói "observed 400 lines" rồi đếm 5 thay vì 31 | Thêm dòng cuối: khoảng dòng đang hiển thị, tổng số dòng, offset để đọc tiếp. | `chat-agents-read-file.spec.ts`; S11 Codex **3/3** |
| 6 | Sample | `search_files` dừng im lặng ở 60 kết quả; `run_command` cắt output ở 20k ký tự mà không báo. | Cùng loại lỗi với #5 | Thêm `limited` kèm ghi chú cho search, và marker khi output lệnh bị cắt. | `chat-agents-read-file.spec.ts` |
| 7 | Sample (UX) | Steer đến tay model như một user message trần. | — | Bọc thành "sent while you were working, wins on conflict". Khi làm riêng, cách này **không** sửa được S10 (vẫn 2/5); nguyên nhân gốc là #1. | Chạy live |

## Phát hiện bên ngoài SDK

- **Bộ lọc nội dung của gateway ZenMux:** câu "Remember this code word for later…" bị trả 403 ngay trong stream ở turn 2, trên mọi wire và cả khi dùng system prompt ngắn. Retry đôi khi qua được. SDK coi lỗi trong stream là `SERVER` (retryable) là hợp lý; sau fix #4, số lần retry có giới hạn. S5 đã đổi sang câu chữ trung tính.
- **Model yếu:** dots3 đôi khi bỏ sót một file (S14), không hỏi trước khi làm ở chế độ human-in-the-loop (S7), hoặc cắt mã lỗi sai trong lệnh shell (S4). Đây là chất lượng model; SDK và sample đã báo đúng trạng thái.

## Kiểm tra

Unit 2965/2965; `tsc` (root và backend sample), lint, docs, human coverage, core `check:types`/`test:pack`, `git diff --check`: pass.

Evidence: `before-*.jsonl` và `after-*.jsonl` cùng thư mục. Event stream đầy đủ nằm ở `artifacts/chat-agents-live/`, bị git ignore.
