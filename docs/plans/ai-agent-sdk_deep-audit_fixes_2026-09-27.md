# Deep audit và sửa lỗi — 27/09/2026

Đã sửa ba finding của review staged ban đầu và các lỗi bổ sung phát hiện qua audit
session lifecycle, nested scheduler, guest JSON boundary, durable store và evaluation
analyzer. Các sửa đổi nằm trong working tree; không stage, commit hoặc push. Evidence
benchmark đã freeze được giữ nguyên, không dùng lại để tuyên bố source mới đã qua value gate.

## Các lỗi đã sửa

| ID | Trigger và lỗi trước sửa | Hành vi sau sửa và regression |
|---|---|---|
| F01 | Inject trong `beforeStep` bị giữ lại dù request còn có thể refresh; inject trong checkpoint lại nằm trước output của request đã build | Bắt đầu giữ input đúng lúc request được build, qua binding nội bộ tách khỏi user-hook accounting; regression kiểm request và thứ tự history |
| F02 | Snapshot trong model round mất input đã inject nhưng chưa drain | Snapshot v1 giữ queued input ở tail; resume giữ input, live history chưa giao sớm |
| F03 | Pending input không bounded; drain vào history đầy có thể mất phần còn lại hoặc giữ session ở trạng thái running | Pending dùng history guards; drain atomic và giữ buffer khi lỗi; luôn giải phóng session/idle waiters; reset xóa pending |
| F04 | Unsupported schema branch vắng trong value vẫn được báo validated; malformed constraints được coi supported | Preflight toàn contract, gồm absent properties/items và numeric/required/enum/type constraints; trả unsupported/unchecked đúng |
| F05 | Hai process cùng mở schema v1, đọc version trước write lock rồi chạy trùng migration | Đọc version dưới cùng `BEGIN IMMEDIATE` lock với DDL; regression hai SQLite workers thực có barrier |
| F06 | Timeout riêng của outer program không hủy child đang chạy | Bind body execution signal vào program shutdown; responsive child nhận abort và teardown sạch |
| F07 | Deny/parse/checkpoint failure trả về trước result byte cap | Bound mọi result sau execute, trước publication; deny reason lớn không bypass cap |
| F08 | Native port arguments qua `JSON.stringify` gọi getter/toJSON, bỏ undefined hoặc đổi NaN | Snapshot bounded lossless JSON trước stringify; sáu invalid inputs không chạy body hoặc serialization hook |
| F09 | Guest serializer đã biến đổi arguments trước khi core có thể kiểm | Validate ngay trong QuickJS trước gửi host; PTC-A16 pass sync/async, zero reads và zero getter/toJSON invocations |
| F10 | VM dump projection bỏ undefined fields, đổi NaN thành null, rồi host báo success | Validate/serialize projection trong guest trước dump; PTC-A17 pass sync/async; giữ CPU/projection limits |
| F11 | Analyzer coi số dòng đúng là đủ cohort, hoặc chấp nhận checksum thiếu file đầu vào | Kiểm exact family/split/repeat/arm, duplicate, unsupported status và mandatory integrity entries |
| F12 | Paired analyzer báo usage authoritative dù history turn còn thiếu authoritative usage | Kiểm cả final turn và history; regression giữ kết quả false khi bất kỳ turn nào thiếu usage |

Guest regression trước sửa đã ghi nhận sáu host reads và hai getter/toJSON invocations.
Projection `{ missing: undefined, invalid: NaN }` được báo success với `{ invalid: null }`.
Hai bằng chứng đỏ cùng kết quả xanh được giữ riêng trong
[evidence mới](../evaluations/deep-audit-fixes-2026-09-27/verification.json).

## Kiểm chứng

| Gate | Kết quả và giới hạn |
|---|---|
| Unit + contract | **230 files, 2.984 tests pass** trên core build cuối |
| Typecheck | `pnpm typecheck` pass; `pnpm exec tsc --noEmit` pass sau các sửa harness cuối |
| Package/runtime boundaries | Lint, dependency graph, agent ownership, runtime boundaries pass |
| Docs/human coverage | Cả hai checks pass |
| Packed runtime | Core build cuối pass packed runtime; MCP packed runtime và core/MCP ESM declaration checks pass |
| QuickJS conformance | **15/15 sync, 16/16 async**, gồm PTC-A16/A17 mới; scripted model, real session/scheduler/WASM worker |
| Durable | **45/45** real kill/restart/concurrent/fencing/disk-full/delivery cases qua journal đã sửa |
| Process environment | **25/25** real local và container cases; Docker image pin sẵn, không fallback backend |
| Recall / skill proposal | **15/15 và 19/19** spike cases |
| Live chat | **16/16** workflows, Codex `gpt-6-luna`, repeat 1, HTTP/SSE thật với DB/workspace riêng |
| Final lifecycle rerun | **S6, S10, S15: 3/3** trên core cuối sau internal model-request binding; abort/resume, steer, abort approval |

Lượt 16 workflows chạy trước thay đổi cuối về internal request binding; ba workflow
liên quan đã được chạy lại sau build cuối. Đây là live HTTP/model validation, chưa phải
browser visual check hoặc hosted/production validation. Spike harnesses là deterministic
protocol checks, không phải benchmark LLM về quality/cost.

Trong một lượt kiểm tra trung gian, chạy build đồng thời với tests/server gây import
errors do dist đang được clean; wrapper checkpoint cũng tăng sai hook count. Đã thay
wrapper bằng binding nội bộ và chạy lại tests sau build hoàn tất: toàn suite xanh,
hook accounting giữ nguyên. Server tạm đã dừng và các file Next tự chỉnh được khôi phục
từ backup trước lượt chạy.

`git diff --check` của lượt sửa này pass. `git diff --cached --check` vẫn báo whitespace
trong index cũ, gồm Markdown hard breaks, captured patch và blank EOF của `program.ts`.
Blank EOF đã được sửa ở working tree; không stage lại hoặc chỉnh historical patch
chỉ để làm sạch cảnh báo, vì đó là evidence đã freeze.

Docs sample cũng được cập nhật: PTC có sync/async executor và host chọn mutation
authority; pruning durable records kết thúc deduplication của các operation IDs đó,
nên host phải quản lý retention horizon. Source fingerprints của serializer mới được
thêm vào harness/benchmark manifests cho các lượt chạy tương lai.

## Plan đã hoàn thành đến đâu

Implementation trong phạm vi đã chọn đã có: output recovery, experimental opt-in PTC,
host durable SQLite sample và research spikes/decisions. Audit này bổ sung sửa lỗi và
regression cho những đường đó. Không phát hiện thêm code bug cần sửa trong phạm vi
đã kiểm sau lượt verification cuối.

**Chưa thể đóng toàn bộ neutral evaluation plan:**

- Chưa có cohort xen kẽ **SDK baseline gốc đã freeze với SDK bundle cuối**. Runner
  paired hiện tại so PTC bật/tắt trên cùng current SDK; đã ghi rõ `ptc-ablation-on-current-sdk`.
- Independent prose review vẫn là gate mở.
- Cohort cuối phải đáp ứng cân bằng ngôn ngữ đã đặt trong specification.

Không sửa điểm số hoặc checksum của historical cohorts để làm chúng thành evidence
cho source cuối. Các retained cohorts đã được kiểm exact attempt coverage; điều đó
chứng minh tính đầy đủ của records, không thay original-versus-final evaluation.

## Closeout các gate sau audit

Các gate original/final replay, replication, OFF, prose review, current-source value và raw-loss adjudication đã chạy xong; kết quả và giới hạn ở [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Production/sample fingerprint vẫn khớp source sau F01–F12. Latest full local run: 235 files / 3.009 tests pass. Current-source Codex target value gate đạt; ZenMux no-go/needs-review được giữ nguyên. Không có thêm production source fix sau freeze cuối.
