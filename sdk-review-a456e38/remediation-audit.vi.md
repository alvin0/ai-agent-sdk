# Audit sau sửa — 2026-09-06

Phạm vi: diff hiện tại của các bản sửa N01–N07 và các lỗi phát hiện tiếp trong
session/team lifecycle, memory callbacks, MCP HTTP cancellation. Các báo cáo
snapshot gốc trong folder này được giữ làm đầu vào review, không phải trạng thái
của worktree sau sửa.

## Đối chiếu findings gốc

| Finding | Invariant đã kiểm tra | Bằng chứng regression trong `tests/unit/` |
| --- | --- | --- |
| N01 | Deadline bao validation, redirect và response body; abort chặn fetch; cleanup không giữ lỗi byte-limit | `mcp-http-security.spec.ts`: validator timeout/reject/pre-abort, redirect validation, body timeout/caller abort, oversized body với cancel không settle |
| N02 | Một operation giữ active tới terminal checkpoint; compact cùng admission; finalizer không xóa generation khác | `composition/runtime-agent-handle.spec.ts`: generation guard, compact active, early return, sealed run và single consumer |
| N03 | Cancellation không bị nhầm với work đã settle; timeout có lỗi/report riêng | `team.spec.ts`: uncooperative wake/dispose; `composition/runtime-agent-team.spec.ts`: close timeout và runtime unsettled |
| N04 | Direct run, retained session, wakeup và compaction nhận ownership của runtime/team | `composition/runtime-agent-team.spec.ts`: direct/retained run close, active follow-up, wakeup tracking, compact cancellation và retained-reference guards |
| N05 | Memory callback bounded; không dispatch sau abort; commit mất acknowledgment là outcome unknown; late result không sửa report | `composition/runtime-memory.spec.ts`: queued cancellation, logging cancellation, callback timeout, late commit, CAS failure và best-effort behavior |
| N06 | Self-wait và local wait cycles bị từ chối; dependency hợp lệ vẫn chờ đúng | `team.spec.ts`: self/two-node/three-node cycles, scheduled worker wait và idle race |
| N07 | Public tool result phân biệt rejected/aborted/failed/completed theo stable code | `composition/runtime-agent.spec.ts`: actual unknown tool, approval denial và parameterized status projection |

## Các vòng review tiếp theo

Các lỗi sau đã được tái hiện, sửa và có regression:

- Follow-up tới worker đang chạy bị active guard chặn.
- Retained-session run không nhận cancellation khi đóng team.
- MCP deadline kết thúc ở headers thay vì body; pre-aborted race bỏ sót rejection.
- Direct-run drain không có timeout bao ngoài; close caller signal chưa được dùng.
- Compaction thiếu team owner signal.
- Close reentrant từ abort handler tạo promise/cleanup thứ hai.
- Runtime quiescence hết deadline khiến team disposal không được bắt đầu.
- MCP body vượt byte limit chờ callback cancel treo trước khi trả lỗi.
- Memory load đã queued vẫn dispatch sau caller abort.
- `team-closed` phát trước khi direct-run drain hoàn tất.
- Custom fetch trả response sau timeout/caller abort nhưng body đến muộn không được hủy.
- Final response URL bị endpoint policy từ chối nhưng body chưa được cleanup.
- Validator đã queued vẫn chạy sau caller abort; bổ sung guard tại callback và trước fetch dispatch.

Các regression mới cho close reentrant, exhausted runtime deadline, oversized
MCP body, queued memory load và premature close event đã được chạy trên bản
chưa sửa và thất bại trước khi chuyển xanh. Memory race còn được kiểm tra khi
logging hủy operation trước lúc cài race listener, để không bỏ sót rejection
của callback đã queued.

Vòng kiểm tra MCP tiếp theo có bốn regression RED → GREEN: late response sau
timeout, late response sau caller abort, rejected final URL cleanup và queued
validator cancellation. Một diagnostic chạy trực tiếp source với 24 lịch abort
ở các microtask khác nhau (có/không có validator) ghi nhận zero dispatch với
signal đã aborted.

## Vòng audit cuối

Đọc lại đường admission → callback dispatch → abort → report/idle → cleanup;
đối chiếu signal ownership, thời điểm phát close event, idempotent promise,
deadline đã hết, late settlement và error projection. Không tìm thấy finding
cần sửa thêm trong phạm vi diff đã review sau các sửa trên.

Bằng chứng kiểm tra trên source cuối:

- `pnpm exec vitest run`: 118 files, 1.310 tests passed.
- `pnpm exec tsc --noEmit`: passed.
- `pnpm lint`: package graph, dependency, agent và runtime boundaries passed.
- `pnpm check:docs`: 43 Markdown files, 21 package READMEs, zero findings.
- `pnpm check:supply-chain`: 390 integrity records, zero findings.
- Build, `check:publint`, `check:types` với ESM profile và `test:pack` cho cả
  `@ai-agent-sdk/core` và `@ai-agent-sdk/mcp`: passed.
  Sau vòng MCP cuối, các gate MCP được chạy lại trên artifact mới; core không đổi.
- `git diff HEAD --check`: passed cho diff staged + unstaged.

Đây là audit SDK tại local worktree. Ma trận 48 kịch bản đề xuất còn chứa các
thử nghiệm thuộc ứng dụng host như DNS pinning, DB crash, authorization đa
tenant và kiểm tra tải/RSS; các kết quả ở đây không được coi là bằng chứng đã
chạy những thử nghiệm hạ tầng đó. Chưa stage hoặc commit các sửa mới.
