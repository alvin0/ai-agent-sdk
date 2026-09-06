# Ma trận regression đa góc nhìn

Snapshot: `a456e38b3de62d114163ec77ef45433ee7cf20e4`.

**48 kịch bản đề xuất; chưa chạy trên full SDK.** Sáu reduced mechanism checks là bộ riêng, không được dùng thay cho các ca này.


## State machine / model-based

Liên quan: N02

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| A raw-done, report pending, start B | B bị từ chối/queue hoặc có generation độc lập, không stale cleanup |
| compact đồng thời inject/reset/run | Contract busy/idle nhất quán; không mutate context giữa compaction trái policy |
| abort rồi reset/resume trước late completion | Late completion không sửa session mới |
| stream không iterate, iterate hai lần, dừng sớm | Một consumer, bounded buffer, ownership và kết quả cuối rõ ràng |

## Shutdown / structured concurrency

Liên quan: N03, N04

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| team.run rồi team.close | Run được cancel/drain hoặc được công bố rõ là borrowed work |
| wakeup đang chạy rồi runtime.close | Có tracking run, shared deadline và report unsettled đúng |
| dispose callback reject/never resolve | Không báo clean success khi chưa settle |
| close concurrent/idempotent và signal đã abort | Không đọc thay options lần sau; signal đầu tiên được thực thi theo contract |

## Async callback fault injection

Liên quan: N01, N05

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| Endpoint validator never resolves/rejects | Không chờ vượt callback/run deadline |
| Memory load/commit never resolves | Abort kết thúc public wait; late work được theo dõi |
| Hook/approval/exporter never resolves | Mọi extension point cùng chính sách settlement |
| Callback throw đồng bộ và reject bất đồng bộ | Cùng taxonomy; không unhandled rejection |

## Scheduler / failure interleavings

Liên quan: R03 follow-up

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| A reject nhanh, B chờ approval | Rejection của A được observe ngay |
| C admission throw sau khi A/B đã chạy | Cancel siblings và bounded ordered commit/drain |
| Nhiều siblings phớt lờ abort | Đo tổng cleanup deadline, không chỉ timeout mỗi slot |
| Fatal, deny, concludeTurn trong một batch | Không mất result hoặc commit sai thứ tự |

## Multi-agent wait graph

Liên quan: N06

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| Self-wait | Reject ngay với lỗi ổn định |
| A->B->A; A->B->C->A | Detect cycle hoặc bounded failure có chẩn đoán |
| Fork/join không cycle | Không báo false positive deadlock |
| Remote peer restart/timeout và local wake coalescing | Không mất wake hoặc lặp chạy cùng receipt vô hạn |

## Security / trust boundary

Liên quan: R04, R05

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| Public hostname resolve về private IPv4/IPv6 | Egress policy chặn endpoint không được phép |
| DNS thay đổi sau validation; proxy; redirect | IP thực sự kết nối thuộc policy, không chỉ hostname |
| Secret sentinel trong value/content/meta/error/additionalContext | Không xuất hiện trong các sinks thuộc sanitizer contract |
| Tool/schema/skill từ nguồn không tin cậy | Không tự nâng quyền; approval gắn đúng action/resource/tenant |

## Durability / consistency

Liên quan: N05 + host boundary

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| 2 workers cùng expectedRevision | Một CAS thắng, conflict còn lại rõ ràng |
| DB commit thành công rồi disconnect trước reply | Outcome unknown, không giả định rollback |
| Tool effect thành công trước history/report failure | Không retry effect thiếu idempotency |
| Crash ở trước dispatch/sau effect/trước checkpoint | Resume có receipt và policy duplicate rõ ràng |

## Tenant isolation / privacy

Liên quan: Host integration risk

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| Tenant A/B trùng conversationId và agentId | Namespace/authorization vẫn tách biệt |
| Resume snapshot từ tenant khác | Server từ chối dù shape JSON hợp lệ |
| Shared fixed memory scope | Chỉ shared theo policy chủ động, không vô tình |
| Logs/snapshots/support bundles có canary secrets | Redaction và access control bao phủ từng sink |

## Property-based / parser / stream

Liên quan: R07 + protocol acceptance

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| UTF-8 split tại từng byte, CRLF boundaries | Nội dung và tool arguments không thay đổi |
| Duplicate/out-of-order/terminal-missing chunks | Protocol violation báo lỗi xác định, không partial success giả |
| YAML quoted key/comments/duplicate/alias/depth | Parser fail closed đúng contract và bounded resources |
| Snapshot round-trip + random invalid event order | Bảo toàn identity/projection hoặc reject rõ ràng |

## Resource economics / performance

Liên quan: R02, R06

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| 10k create/run/close teams trên cùng runtime | Live registrations và retaining paths không tăng tuyến tính |
| Slow/no event consumer + slow exporter | Backlog bounded; phân biệt failure và telemetry drop |
| Many sessions gần giới hạn; large tool result | Đo RSS, heap, external, arrayBuffers và event-loop delay |
| Long history + frequent snapshot/compaction | Đo clone/serialize cost; không đánh đồng token compaction với RAM release |

## Cost budget / retry semantics

Liên quan: Production policy

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| maxSteps 1/2 với finalizer và structured output | Documented extra request được tính ngân sách |
| Missing usage/estimated usage + retries | Không coi unknown usage bằng zero |
| Compaction/native tools/team sub-runs | Accounting bao phủ chi phí theo đúng phạm vi quy định |
| 429/Retry-After/caller abort/retry burst | Budget/deadline toàn run và fairness không bị vượt vô thức |

## Compatibility / release / mutation testing

Liên quan: G01, N07

| Kịch bản | Điều kiện đúng cần assert |
|---|---|
| Consumer cũ dùng localhost HTTP và redirect | Migration explicit cho defaults bảo mật mới |
| Consumer đọc result.value sau replace | Không phụ thuộc semantics sanitizer cũ |
| Tarball sạch trong project ngoài workspace | Exports/runtime dependencies đúng; không dùng nhầm source aliases |
| Mutation bỏ abort/guard/redaction/generation check | Test phải đỏ; nếu vẫn xanh thì invariant chưa được bảo vệ |
