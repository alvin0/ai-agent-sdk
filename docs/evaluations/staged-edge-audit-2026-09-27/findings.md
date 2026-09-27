# Audit staged changes — 27/09/2026

Đã kiểm tra inventory của **900 staged paths**, đối chiếu code/test/plan với evidence, sửa các edge cases bên dưới và chạy lại validation. Trong inventory, 767 paths là archival evidence; 133 paths còn lại gồm implementation, tests, harness, docs và configuration. Việc kiểm archive dùng parse/coverage/checksum, không coi đọc lại mọi dòng raw output là code review.

Index đầu và cuối có cùng SHA-256 của `git diff --cached --binary`:
`2e9db6b7c5662ffbec7534adbc877a487baede168b442dc04111b82dbf8f2c36`.
HEAD là `5b589b6abe6d0a61da3f55b549713456ccc8c7c4`. Mọi sửa trong audit này nằm ở working tree; không stage, commit, reset hoặc push. Bản sao staged patch đầy đủ nằm tại `artifacts/staged-edge-audit-jlzvtmjt/staged.patch`.

## Findings đã sửa

| Mức | Edge case và hậu quả trước sửa | Sửa và regression |
|---|---|---|
| P1 | Nested port gọi catalog/observer đồng bộ trước khi giữ `inFlight`; callback reentrant có thể mở hai child đồng thời. | Giữ promise trước khi chạy child; vẫn snapshot arguments ngay lúc gọi. Test synchronous reentry. |
| P1 | Direct/nested checkpoint không hợp tác với abort có thể giữ turn vô hạn; cancelled direct checkpoint vẫn có thể xác nhận budget ticket. | Race checkpoint với signal, chờ settlement có teardown bound; không chạy body hoặc charge dispatch sau cancel. Tests direct/nested noncooperative checkpoint và cancelled budget. |
| P1 | Exception từ retained-result authority có thể bị guest catch, khiến outer tool thành công; throw `null`/`undefined` không giữ được fatal latch. Exception không stringify/read được còn có thể làm promise bridge không settle. | Normalize escaped host errors thành fatal `ToolError`, đóng port và giữ failure đến outer completion; đọc code/message có fallback an toàn. Tests catalog load, swallowed host failure, null/undefined, null-prototype và throwing getter. |
| P1 | Managed worker đã hoàn thành nhận follow-up thì mất write claim; bounded close cũng có thể giải phóng claim trong khi session hoặc queued follow-up vẫn ghi. Dependency overlap có thể bắt đầu quá sớm. | Kiểm actual session/team work; giữ draining write claims đến `team.whenIdle`, fence cleanup bằng conversation ID; chờ overlapping dependencies. Tests follow-up, queued third turn, close timeout và unaffected read work. Policy `warn`/`off` vẫn do host chọn. |
| P1 | `raceWithSignal` nhận promise đã reject và signal đã abort có thể bỏ observer, gây unhandled rejection. | Đăng ký rejection observer trước early-abort branch. Test child Node process và event-loop rejection behavior. |
| P2 | Handle allocator collision ghi đè retained result của owner khác và làm sai byte accounting. | Từ chối collision trước mutation; test owner isolation và accounting. |
| P2 | Node worker sample có thể bỏ cleanup khi observer ném lỗi hoặc message handler/load ném; wall/heap config sai vẫn tạo worker. | Exit listener được cài trước observer, observer best effort, message exception thành controlled failure; validate positive safe integers trước spawn. Actual QuickJS sync/async regression. |
| P2 | JSON bridge chấp nhận array có extra/symbol/getter properties rồi âm thầm mất dữ liệu. | Reject non-JSON own properties trước serialization, không invoke getter; vẫn chấp nhận dense JSON array. Tests actual guest prelude. |
| P2 | Command sample decode từng chunk có thể phá UTF-8; live output buffer còn giữ burst vượt cap. | UTF-8 decoder riêng mỗi pipe và bounded live buffer; tests split euro character và million-character burst. Search-limit note chỉ nói additional matches có thể tồn tại. |
| P2 | Grader join IDs bằng `\|` làm delimiter/empty IDs alias; missing effects/privacy observations và empty cohort có thể được coi là zero incidents. | So sánh sorted JSON/list identities giữ multiplicity; numeric answers hữu hạn; strict nonempty incident gate. TS/Python grader và missing-observation regressions. |
| P2 | Full staged patch vượt buffer 32 MiB của bundle preparation; SHA manifests tham chiếu 27 files không có trong retained docs. | Stream staged hash với bounded stderr; khôi phục đúng 27 pinned files từ original artifacts, không đổi manifest/checksum/grade. Integrity recheck không còn lỗi. |
| P2 | Sample web typecheck phụ thuộc `.next-live` local; UI đọc `defaultEffort` không có trong SDK model contract. | Dùng standard Next generated types; hiển thị `provider default` khi host chưa chọn effort. Next typegen và web TypeScript pass. |
| P3 | Interruption marker tự gán ý định cho user và cấm resume; nested API docs sai tên trường/public status; Python bytecode được stage. | Marker chỉ ghi trạng thái và để next message quyết định; sửa docs; bỏ bytecode trong worktree và ignore generated files. Index vẫn giữ bản staged cũ đến khi người dùng restage. |

## Validation cuối

| Gate | Kết quả |
|---|---|
| Full Vitest | **239 files / 3.077 tests pass** |
| Team follow-up/write regressions | 23/23 pass |
| Public SDK/session team conformance | **33/33 pass**; controlled adapter, không live-model quality |
| Actual QuickJS worker conformance | Sync **15/15**, async **16/16** |
| Workspace build | 26 packages pass; core rebuilt sau các sửa cuối |
| TypeScript | Root, core và sample web pass |
| Package/runtime/agent dependency gates | Zero findings |
| Core packed runtime | Pass sau các sửa cuối |
| Core publint/public type resolution | Pass |
| Retained evidence | 447 JSON; 68 JSONL / 6.837 rows; 1.099 SHA entries; zero errors |
| Historic primary-grade replay | 216 outputs; **0 changed grades**, 0 new provider calls |
| Working-tree diff whitespace / staged index | Pass / unchanged |

Named logs và machine-readable summaries nằm cạnh report; `validation.json` ghi commands/scope và `SHA256SUMS.json` khóa evidence của audit. Red reproductions `nested-before.txt` và `team-before.txt` giữ nguyên để review bug trước sửa. Các expected worker termination probes có thể in Node warnings; exit và conformance verdict vẫn pass.

## SDK boundary và phần chưa chứng minh

Core giữ cơ chế lifecycle/admission/accounting; host tiếp tục quyết định tasks, roles, permissions, write policy, tools, output contract và model effort. Experimental nested tools vẫn opt-in; QuickJS nằm trong Node sample. Write scopes là scheduling coordination, không thay filesystem/tool authorization hoặc bảo đảm external side effects của tool không hợp tác đã dừng.

Implementation trong phạm vi được chọn của các plan đã có; audit này bổ sung correctness fixes. Không mở rộng sang application workflow, distributed exactly-once, automatic skill publication hay public recall package chưa có consumer. Historical plan closeouts và frozen sources là evidence cho snapshot được ghi trong chúng; working tree sau audit có source mới.

**Chưa thể xác nhận “không giảm chất lượng/performance” cho source sau audit.** Không chạy cohort provider mới hoặc browser UI trong lượt này. Regrading 216 raw outputs chỉ kiểm grader tương thích với lịch sử, không đo lại model trên code mới. Kết quả quality v7 trước đó giữ nguyên: zero new losses versus v10 REFERENCE, nhưng hai ZenMux losses versus original BASE; global zero-loss gate vẫn NOT MET. Các kết luận no-go/needs-review của PTC/neutral evaluation không được nâng thành pass vì local tests xanh. Trước khi tuyên bố quality/performance improvement của source mới, cần freeze source và chạy lại cùng paired protocol, giữ mọi raw loss, usage và latency.
