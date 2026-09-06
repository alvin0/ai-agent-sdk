# AI Agent SDK — re-review và mở rộng góc nhìn

Repository: `dinh-ai-system-exe-com-vn/ai-agent-sdk`<br>
Nhánh: `mono-package`<br>
Snapshot mới: `a456e38b3de62d114163ec77ef45433ee7cf20e4`<br>
Baseline trước: `80353b38da2411450a5c4e0c1e6ce7e4c5cdebf7`

## 1. Kết luận

Bản sửa giải quyết đúng nhiều vấn đề trước: lifecycle retention của team, early rejection observation và ordered admission cleanup của scheduler, sanitization envelope, public resource limits, strict YAML parsing và defaults MCP an toàn hơn. Không có lý do từ lần đọc này để yêu cầu viết lại toàn bộ SDK.

Chưa nên approve production mặc định: CI của snapshot đang failure, và còn các bất nhất ở timeout/cancellation, session state và đường thực thi multi-agent. Bảy mục N01–N07 bên dưới là findings/contract gaps được đánh giá từ source. Mức P1 có điều kiện chỉ chặn chức năng tương ứng khi host sử dụng nó.

Đây không phải chứng nhận an toàn toàn bộ 21 package, pentest hoàn chỉnh hay xác nhận không có memory leak.

## 2. Phạm vi và mức chứng cứ

Đã đọc các luồng composition/runtime/session, tool scheduling/policy, team/wakeup/waiting, memory persistence, HTTP endpoint guard, metadata YAML và public event projection; đối chiếu job metadata của CI. Các nguồn code được pin theo SHA ở đầu báo cáo.

Đã chạy `mechanism-checks.mjs` bằng Node v22.16.0: 6/6 reduced mechanism scenarios tái hiện đúng cơ chế dự đoán. Các control cases được mô tả riêng trong JSON. Đây là mô hình JavaScript thu gọn, KHÔNG import SDK và KHÔNG phải 6 test SDK pass/fail. Thời gian trong JSON là clock của container, không phải timestamp của GitHub CI.

Chưa chạy local full workspace build/typecheck/test/pack; chưa đo heap/RSS/soak; chưa gọi provider thật, không dùng API key, không pentest endpoint hoặc hệ thống đích. Truy cập source qua GitHub connector hoạt động; thử tải raw file vào container không thành công do DNS. Không có thay đổi/push nào vào repo.

Job metadata đọc cuối: run `34008842720`, job `101420929301`, SHA đã pin. Frozen install, graph/type/build gates, negative-boundary fixtures và supply-chain gate báo success; baseline tests báo failure; package-owned tests và packed matrix skipped. Các lần đọc CI trước đó không nhất quán về chi tiết bước lỗi; báo cáo không sử dụng tên/count testcase từ log đó để kết luận root cause. Gate success chỉ là kết quả job, không thay thế audit độc lập.

## 3. Đối chiếu R01–R07

| Mục cũ | Kết quả đọc bản mới | Phần chưa được chứng minh |
|---|---|---|
| R01 CI/toolchain | Đã qua install và build gates theo metadata cuối | Baseline đỏ; package tests và pack chưa chạy |
| R02 giữ team đã close | Owner retire registration, clear sessions/mailbox/callbacks; tombstones có cap 1024 | Heap churn/retaining-path test và cancellation truth |
| R03 parallel scheduler | pending.catch ngay; segmentAbort; drainSegment ordered | Regression actual SDK và tổng shared cleanup deadline |
| R04 block/replace | Rebuild envelope, không giữ raw value/meta/errors/additionalContext ngoài policy | Sentinel xuyên tất cả sink, direct tool logs cần policy riêng |
| R05 MCP security | HTTPS mặc định; private network/redirect phải opt-in; async validator | Literal hostname filtering không thay DNS/egress enforcement; N01 |
| R06 limits | historyLimits/ledgerLimits/eventBufferLimits/public runtime limits đã có | Global capacity, peak allocations, snapshot cost |
| R07 YAML | parseDocument strict+uniqueKeys, alias restriction, boolean/schema/depth/node validation | Parser/property fuzz và full CI tests |

## 4. Findings mới

### N01 — Async MCP endpoint validation nằm ngoài deadline

**Ưu tiên:** P1. **Mức chứng cứ:** source-confirmed availability gap.

**Vị trí:** `packages/mcp/src/client/http-security.ts#createGuardedMcpFetch`; `packages/mcp/src/client/http-security.ts#validateBeforeFetch`

**Kích hoạt:** validateEndpoint trả Promise không settle; hoặc bị treo ở một redirect hop.

**Ảnh hưởng:** Request không hoàn tất trong operationTimeoutMs; caller abort không cắt await của validator.

**Hướng sửa:** Tạo cancellation scope và absolute deadline trước mọi callback; race validation với scope, truyền signal vào validator; kiểm tra abort trước dispatch; vẫn theo dõi cleanup của callback.

**Regression đóng finding:** Never-resolving validator, validator reject, pre-aborted signal, abort-during-validation, redirect validation đều kết thúc theo contract; fetch không chạy sau khi bị từ chối.

**Mô phỏng cơ chế đã chạy:** `M01`; không phải full SDK reproduction.

### N02 — Session có stale finalizer và trạng thái active không thống nhất

**Ưu tiên:** P1. **Mức chứng cứ:** source-confirmed race window; end-to-end regression required.

**Vị trí:** `packages/core/src/composition/agent/session.ts#RuntimeAgentSessionValue.stream`; `packages/core/src/agent/define/session.ts#createRunHandle`; `packages/core/src/composition/observation/port.ts#checkpointTerminal`

**Kích hoạt:** Raw run A đã release nhưng outer report còn chờ audit; B được start; finalizer A chạy sau đó.

**Ảnh hưởng:** A đặt wrapper.active=undefined trong khi B đang chạy; isRunning/whenIdle không còn phản ánh session. compact cũng không đặt marker active ở wrapper.

**Hướng sửa:** Chọn một session execution state machine; guard admission đồng bộ và generation-aware cleanup. Bao phủ run, stream, pending, compact và wakeup.

**Regression đóng finding:** Park terminal report A, thử B: phải reject hoặc queue rõ ràng; stale callback không clear B; whenIdle chỉ resolve theo contract đã định; compact được phản ánh đúng.

**Mô phỏng cơ chế đã chạy:** `M02`; không phải full SDK reproduction.

### N03 — Team cancel nuốt cả timeout khi signal đã aborted

**Ưu tiên:** P1 for cancellable team workloads. **Mức chứng cứ:** source-confirmed cleanup classification gap.

**Vị trí:** `packages/core/src/agent/team/team.ts#cancel`; `packages/core/src/agent/team/team.ts#dispose`; `packages/core/src/agent/team/common.ts#withTimeout`

**Kích hoạt:** wakeTask phớt lờ cancellation; withTimeout reject sau khi wakeController.abort đã được gọi.

**Ảnh hưởng:** cancel có thể resolve mặc dù wakeTask còn pending. Kết quả dispose phụ thuộc outer deadline race; không được coi aborted signal là bằng chứng work đã dừng.

**Hướng sửa:** Phân biệt cancellation acknowledgment, deadline exceeded và task unsettled; không nuốt teardown timeout. Dùng typed error/report và shared deadline.

**Regression đóng finding:** Cancellable worker: sạch; uncooperative worker: timed-out/unsettled rõ ràng. Chạy cùng case qua cancel, team.close, runtime.close.

**Mô phỏng cơ chế đã chạy:** `M05`; không phải full SDK reproduction.

### N04 — Đường wakeup và team.run không dùng cùng lifecycle ownership

**Ưu tiên:** P1 conditional on team/wakeup use. **Mức chứng cứ:** source-confirmed architectural divergence.

**Vị trí:** `packages/core/src/composition/team/runtime.ts#createRuntimeAgentTeam`; `packages/core/src/composition/team/runtime.ts#RuntimeTeamValue.run`; `packages/core/src/agent/team/team.ts#runWakeLoop`; `packages/core/src/composition/agent/session.ts#RuntimeAgentSessionValue.stream`

**Kích hoạt:** Local wakeup gọi raw session.runPending; direct team.run không ghép team lifecycle signal vào run lease.

**Ảnh hưởng:** Wakerun không đi qua wrapper stream nơi đăng ký agent-run lease/active và public final-report checkpoint. team.close không tự truyền cancellation cho direct team.run. Raw ledger vẫn có thể ghi log; không kết luận mất toàn bộ telemetry.

**Hướng sửa:** Adapter TeamSessionPort phải đi qua admission/ownership primitive thống nhất; xác định rõ borrowed session vs team-owned work; direct runs nhận team cancellation hoặc được drain theo contract.

**Regression đóng finding:** Chạy cùng fixture bằng generate, session.run, stream, team.run và wakeup: tracking, policy, report, idle, close nhất quán. Giữ session reference rồi close team để kiểm tra quyền sử dụng sau close.

**Thực thi:** chưa tái hiện bằng full SDK; kết luận dựa trên call graph và ownership trong source.

### N05 — Memory load/commit await callback nhưng không bound settlement khi abort

**Ưu tiên:** P1 conditional on persistent store adapters. **Mức chứng cứ:** source-confirmed host-callback availability gap.

**Vị trí:** `packages/core/src/composition/memory/run.ts#loadMemory`; `packages/core/src/composition/memory/run.ts#commitMemory`; `packages/core/src/agent/define/session/runtime-memory.ts`; `packages/core/src/agent/define/session.ts#createRunHandle`

**Kích hoạt:** Store/DB driver bị treo hoặc không hỗ trợ AbortSignal; caller hủy run.

**Ảnh hưởng:** Abort checks trước/sau await không làm Promise đang chờ tự reject. Public run có thể tiếp tục bị giữ ở preparation/commit.

**Hướng sửa:** Callback deadline + prompt cancellation settlement + quarantine/ownership cho công việc chưa settle. Với commit bị mất acknowledgment, phân biệt outcome unknown; không tự retry side effect.

**Regression đóng finding:** Store never resolves, aborted before/after dispatch, commit success rồi mất reply, revision conflict, late completion: state và report không được ghi đè sai.

**Mô phỏng cơ chế đã chạy:** `M03`; không phải full SDK reproduction.

### N06 — wait_agents cho phép self-wait và chưa chặn wait cycles

**Ưu tiên:** P2; raise if multi-agent latency is critical. **Mức chứng cứ:** source-confirmed liveness gap.

**Vị trí:** `packages/core/src/agent/team/team.ts#toolsFor`; `packages/core/src/agent/team/team.ts#whenIdle`; `packages/core/src/agent/team/common.ts#parseWaitTool`

**Kích hoạt:** Agent A gọi wait_agents targets=[A]; hoặc A chờ B và B chờ A.

**Ảnh hưởng:** Run chờ chính điều kiện hoàn tất của nó cho tới timeout/cancellation. Không gọi đây là deadlock vô hạn vì SDK có bounds.

**Hướng sửa:** Reject self-wait trước dispatch; cân nhắc wait-for graph để phát hiện cycle; trả lỗi điều phối ổn định và cho phép fork/join hợp lệ.

**Regression đóng finding:** Self-wait, 2/3-node cycle, peer timeout, remote cycle, duplicate targets, fork/join hợp lệ.

**Mô phỏng cơ chế đã chạy:** `M06`; không phải full SDK reproduction.

### N07 — Public tool-result status làm phẳng denied/aborted thành failed

**Ưu tiên:** P2. **Mức chứng cứ:** source-confirmed API/observability semantics gap.

**Vị trí:** `packages/core/src/composition/agent/types.ts#RuntimeAgentRunEvent`; `packages/core/src/composition/agent/session.ts#projectEvent`

**Kích hoạt:** Tool bị deny, bị abort, hoặc execution failed.

**Ảnh hưởng:** Status union có rejected/aborted nhưng projection chỉ chọn failed/completed. Nested error vẫn giữ thông tin; consumer chỉ dùng status dễ hiển thị hoặc retry sai.

**Hướng sửa:** Một bảng mapping từ stable error code/disposition sang public status; phân biệt rejected, aborted, failed, completed. Test streaming và terminal report nhất quán.

**Regression đóng finding:** Unknown tool, denial, approval deny, abort-before-dispatch, timeout, genuine execution error, success; assert status lẫn nested code.

**Mô phỏng cơ chế đã chạy:** `M04`; không phải full SDK reproduction.

## 5. Các chuỗi lỗi quan trọng

### A. Finalization chạy sau execution

Raw session release không đồng nghĩa public report đã xong: non-operational observation checkpoint có thể chờ exporter. Khi stream không kiểm tra wrapper.active và cleanup không kiểm tra generation, run cũ có thể clear marker của run mới. Không nên sửa bằng sleep. Phải định nghĩa admission, execution, finalizing, idle cùng một invariant.

### B. Store treo → wake task không settle → cancel báo xong

Memory store không cooperative có thể giữ raw runPending. Team cancel đã abort controller, sau đó timeout chờ wakeTask. Catch dùng signal.aborted để quyết định nuốt lỗi nên có thể nuốt chính timeout. Outer dispose/runtime còn deadline riêng; chưa chạy đầy đủ timer interleavings nên không khẳng định mọi lần close đều báo sai. Tuy vậy local cancellation classification đã không đủ để chứng minh work stopped.

### C. Endpoint validation chậm ở giai đoạn bảo mật

Thêm async DNS/policy validation là đúng hướng, nhưng timeout phải bắt đầu trước callback này. Mỗi redirect không được reset ngân sách end-to-end. Truyền AbortSignal không tự giết Promise không cooperative; public wait và actual work settlement phải được theo dõi riêng.

### D. Self-wait không phải bài toán “prompt tốt hơn”

wait_agents có sender closure nhưng không loại sender khỏi targets. Khi model chọn chính mình hoặc tạo cycle giữa peers, chờ idle là chờ trạng thái mà tool đang ngăn xảy ra. Timeout là phanh cuối; guard trước dispatch hoặc wait-for graph mới xử lý nguyên nhân.

## 6. Mười hai góc nhìn mở rộng

Xem `regression-matrix.vi.md` và JSON: 48 scenario đã viết kèm oracle, tất cả đánh dấu PROPOSED_NOT_RUN_AGAINST_SDK.

State-machine review kiểm tra linearization point và generation ownership; fault injection kiểm tra mọi callback never-resolve/throw/reject; shutdown review phân biệt admission stopped, cancellation requested, work settled, resource released. Multi-agent graph review kiểm tra self-wait, cycles và wake coalescing.

Threat modeling không chỉ hỏi “có validate không”: phải xác định ai điều khiển URL, tool, snapshot, tenant namespace và credential. DNS guard phải kiểm tra địa chỉ thực sự kết nối hoặc dựa vào egress enforcement; HTTPS không có nghĩa endpoint thuộc trust boundary. Bản đọc này không thực hiện SSRF exploit.

Durability review tách model result, external side effect, memory commit và audit delivery. expectedRevision cần được adapter thực thi atomically; timeout sau commit là outcome unknown, không thể kết luận rollback. Không giữ transaction DB xuyên suốt model call chỉ để mong được exactly-once. Idempotency/receipt/outbox hoặc equivalent host design cần được xác định theo loại tool.

Tenant review cần thử hai tenant trùng conversation ID, snapshot tráo tenant, fixed/shared memory scope và support bundle. Tenant authorization thuộc host; shape validation trong SDK không thay thế quyền truy cập.

Property/metamorphic tests nên assert cùng input SSE chia chunk khác nhau vẫn cho cùng normalized result, YAML thêm comment không đổi policy, serialize/deserialize snapshot bảo toàn identity. Duplicate terminal/tool IDs và invalid order phải cho lỗi xác định, không partial success giả. Các property phải theo protocol contract thực tế; không yêu cầu chấp nhận mọi reorder.

Performance/resource review phải đo live resources và retained paths, không chỉ RSS tức thời hoặc bytes serialized. History compaction cho model không tự chứng minh giảm append-only retention. Các profile nhiều session, slow consumer, slow exporter, large output, frequent snapshot phải chạy cùng các cap production dự kiến.

Cost review phải nêu rõ maxSteps có bao gồm finalizer, compaction, retries và child runs hay không. Không gọi soft budget là hard financial limit. Usage missing/estimated không được biến thành zero. Đây là acceptance risks cần test, không phải kết luận đã phát hiện billing sai trong SDK.

Release review dùng tarball sạch bên ngoài workspace và xác nhận behavior migration: MCP local HTTP/redirect nay cần explicit opt-in, policy.replace có thể không còn raw value. Security fixes đúng vẫn có thể thay đổi hành vi consumer cũ. Mutation testing phải làm test đỏ khi bỏ một guard/abort/redaction/generation check, thay vì chỉ đo coverage dòng.

## 7. Invariants tôi đề xuất khóa thành contract

1. Mỗi session chỉ có một execution owner theo contract công bố; stale completion không mutate owner mới.
2. Mọi run path có cùng admission, cancellation và final-report semantics hoặc khác biệt được công bố/test rõ.
3. Abort requested không được báo như actual settlement; close report không che giấu unsettled work.
4. Mọi callback async có bounded public wait; callback không cooperative vẫn có owner cho cleanup/late result.
5. Post-policy data chỉ qua các sink được phép; denied/aborted/failed không bị trộn khi quyết định retry.
6. Per-session caps không được quảng bá thành global capacity guarantees.
7. Memory commit conflict/unknown outcome không tự retry external effects.
8. Model không thể khiến một member chờ chính mình mà không bị guard từ runtime.

## 8. Thứ tự sửa và merge gates

Đầu tiên đưa CI về xanh trên đúng SHA candidate, không bỏ/skips các test đang bắt invariant lỗi. Đồng thời ưu tiên N02 và N01/N05 (session/deadline), sau đó N03/N04/N06 cho multi-agent và N07 cho event contract. Mỗi fix cần regression reproducer ở source thực tế, không dùng reduced mechanism file của báo cáo thay thế.

Trước production, yêu cầu passing full workspace + packed consumer; callback fault tests; cross-path lifecycle tests; sentinel/tenant/egress tests theo deployment; DB adapter race/crash tests; resource soak với workload và threshold đã chốt; rollback/feature flag. Không có số RSS ngưỡng chung hợp lý khi chưa biết workload và hosting.

Có thể tích hợp hẹp sau các gate tương ứng: provider tin cậy, read-only tools, explicit caps, bounded host request, feature flag. Chưa mở arbitrary MCP URL, untrusted skills hoặc production write tools chỉ dựa vào kết quả static review.

## 9. Nguồn và cách dùng bundle

Mọi source bên dưới thuộc cùng SHA. Các selector #function trong findings.json dùng để định vị, không phải line-number citation đã kiểm chứng.

- `packages/core/src/agent/define/session.ts`
- `packages/core/src/agent/define/session/runtime-memory.ts`
- `packages/core/src/agent/team/common.ts`
- `packages/core/src/agent/team/team.ts`
- `packages/core/src/agent/tool/pipeline.ts`
- `packages/core/src/composition/agent/session.ts`
- `packages/core/src/composition/agent/types.ts`
- `packages/core/src/composition/memory/run.ts`
- `packages/core/src/composition/observation/port.ts`
- `packages/core/src/composition/runtime/owner.ts`
- `packages/core/src/composition/team/runtime.ts`
- `packages/mcp/src/client/http-security.ts`
- `packages/skill-filesystem/src/provider/filesystem-provider.ts`

Nguồn kỹ thuật nền: Node.js globals documentation về AbortSignal; OWASP SSRF Prevention Cheat Sheet về application/network allowlist và DNS; PostgreSQL transaction isolation documentation về concurrent updates và serialization failure. Chúng hỗ trợ nguyên tắc thiết kế, không chứng minh repository đã bị exploit.

Chạy bộ mô phỏng không cần dependency:

```sh
node mechanism-checks.mjs mechanism-results-local.json
```

Exit 0 nghĩa các cơ chế lỗi đã được mô phỏng đúng. Không có nghĩa code SDK an toàn. regression-matrix là backlog nghiệm thu; không phải test results. findings.json phù hợp để chuyển thành tickets, nhưng báo cáo không tạo issue hoặc sửa repo.
