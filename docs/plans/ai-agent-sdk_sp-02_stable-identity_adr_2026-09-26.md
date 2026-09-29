# ADR SP-02 — stable operation identity và store ownership

> **Trạng thái cuối 27/09/2026:** implementation trong phạm vi đã chọn và các lượt kiểm chứng đã hoàn tất; xem [kiểm chứng hoàn tất ngày 27/09](ai-agent-sdk_plan-completion_2026-09-27.md). Original SDK/final bundle đã chạy hai model, matched Việt/Anh, 5 repeats, independent prose review và raw-loss audit. PTC Codex đạt gate cho FILTER/JOIN; ZenMux giữ kết luận `no-go / needs-review`. SP-02 là host sample; SP-03–05/public package và Q4 giữ quyết định có điều kiện. Các trạng thái, điểm số và gate mở bên dưới là lịch sử tại thời điểm ghi, được giữ để audit. Không có superiority, USD savings hoặc production-validation claim.

**Ngày:** 26/09/2026\
**Trạng thái:** accepted; **host sample đã implement** tại [samples/durable-operations](../../samples/durable-operations/README.md), không public package.\
**Thay thế:** mục "Stable identity và store ownership — ADR tạm thời" trong [spike progress](ai-agent-sdk_spike_progress_2026-09-26.md). Bản tạm thời ghi "chưa có generation/fencing"; nhận định đó đã lỗi thời.\
**Bằng chứng:** [spike closeout §SP-02](ai-agent-sdk_spike_closeout_2026-09-26.md#sp-02--recovery-fencing-và-approvaldelivery), [sp-02-summary.json](../evaluations/spike-closeout-2026-09-26/sp-02-summary.json) (45/45 cases), harness `test-human/spikes/durable-operation.ts`.

## Bối cảnh

`ToolExecutionStore` đã có claimed/completed/unknown/conflict. SP-02 kiểm host dùng contract đó qua process kill/restart thật, với SQLite built-in của Node và fake external service không dedupe. Câu hỏi: identity nào ổn định qua resume, ai được commit, và recovery phân biệt completed/unknown bằng gì.

## Quyết định

1. **Operation ID do host cấp và persist cùng exact pending intent trước dispatch.** Provider call ID sinh mới mỗi worker, không làm key journal. Resume đọc lại intent đã lưu, không sinh ID từ random run ID.
2. **Fingerprint = tool + args + host principal.** Same ID khác fingerprint là `conflict`; không đọc result của operation khác.
3. **Claim atomic, unique theo operation ID.** `INSERT … ON CONFLICT DO NOTHING`; bên thua nhận unknown/completed theo trạng thái đã commit.
4. **Commit là CAS theo owner + generation.** `UPDATE … WHERE id=? AND result IS NULL AND owner=? AND generation=?`; `changes !== 1` là mất ownership, không trả completed.
5. **Không tự reclaim theo tuổi claim.** Claim chưa completed giữ unknown sau crash; lease/timestamp cũ không tạo quyền retry.
6. **Reconciliation do host sở hữu.** Reconciler đọc receipt độc lập ở external service, rồi trong một transaction tăng generation, đổi owner và ghi result. Late writer của generation cũ commit thất bại, không overwrite. Không receipt thì giữ unknown.
7. **Journal là trusted host storage.** Có thể giữ raw result trước post-policy; projection ra model/public events luôn qua post-policy hiện tại, cả khi fresh lẫn recovered.
8. **Approval không khôi phục từ record cũ.** Quyết định allow đã lưu không áp dụng cho request mới sau restart; host phải quyết lại.
9. **Delivery retry dùng cùng identity, không chạy lại body.** Receiver vẫn cần dedupe/ack riêng; retry không đồng nghĩa exactly-once phía receiver.

## Hệ quả và giới hạn

- Chứng minh trong phạm vi: nhiều process trên một máy, SQLite WAL/`synchronous=FULL`, AgentRuntime/session/interceptor thật. Không phải distributed store hay multi-host lease.
- Checkpoint, journal và session **chưa** nằm trong một transaction. Resume dựa vào pending intent đã persist trước dispatch, không dựa vào atomic snapshot toàn stack.
- DUR-06 chứng minh bằng injected error và `SQLITE_FULL (13)` thật qua `max_page_count`; chưa phải OS disk-full hay corruption.
- Schema là research schema. Không có migration, retention hay cleanup policy cho unknown operations.
- `node:sqlite` còn experimental trên Node 24.9.0; không phải runtime requirement của core portable.

## Quyết định productization (26/09/2026)

Người dùng giao quyết định các mục còn mở. Thứ tự: **SP-01 làm trước**; SP-02 productization chạy sau, theo các quyết định dưới đây. Không đổi `ToolExecutionStore` contract (`claim`/`complete` trong `packages/core/src/agent/tool/execution.ts`).

| Mục | Quyết định | Lý do |
|---|---|---|
| Topology | **Host sample** trong `samples/` (đề xuất `samples/durable-operations/`), không public package. Nâng lên optional Node package chỉ khi có consumer thứ hai dùng lại nguyên adapter. | Chưa có consumer bên ngoài; plan §7.2 cấm quảng bá adapter standalone như exactly-once. Sample giữ reconciliation + stable ID đi cùng adapter. |
| Runtime target | **Node `>=22.18`** (khớp `engines` của repo) với `node:sqlite` built-in. Không thêm `better-sqlite3` hay native dependency. Sample kiểm availability lúc open và fail rõ nếu thiếu. | `node:sqlite` có sẵn không cần flag ở version này; tránh supply-chain/native build. Vẫn experimental nên chỉ ở sample, không vào core. |
| Migration | `PRAGMA user_version` làm schema version; migrations forward-only, mỗi bước chạy trong một transaction lúc open. DB có version mới hơn code thì **từ chối open**, không downgrade. | Đơn giản, atomic, không cần bảng meta; rollback code không làm hỏng dữ liệu mới. |
| Retention | Completed + publication đã ack: host prune theo TTL cấu hình (sample mặc định 30 ngày). `claimed`/`unknown`: **không bao giờ tự xóa**; chỉ host retire bằng lệnh explicit, ghi tombstone (operation ID, fingerprint, lý do, actor, thời điểm) và từ chối claim lại ID đó. Intent xóa cùng operation. Approval pending ghi owner; host gọi `expirePendingApprovals()` khi biết writer cũ đã dừng, để đánh stale approval của owner khác (không tự làm khi open vì writer khác có thể còn sống). Không reuse decision cũ. Delivery đã ack prune cùng operation. | Giữ invariant 5 và §9: unknown phải reconcile, không mất khi cleanup/rollback. Tombstone chặn ID cũ bị claim lại thành side effect mới. |
| Transaction boundary | **Chấp nhận tách**: pending intent + claim + journal nằm trong journal DB; session checkpoint giữ ở session store hiện có. Thứ tự bắt buộc: persist intent → claim → side effect → commit CAS → publication → checkpoint. Không xóa intent trước khi checkpoint chứa kết quả được ghi. | Transaction chung đòi đổi session persistence contract, vượt phạm vi SP-02. Evidence DUR-02…05/11 đã chứng minh recovery dựa trên intent đã persist. |
| Receipt contract | Host cung cấp `lookupReceipt(operationId)` trả `completed` + receipt hoặc `unknown`; external service phải nhận operation ID làm idempotency key. Service không hỗ trợ key/receipt thì operation giữ `unknown` vĩnh viễn cho đến khi người vận hành retire. | Khớp quyết định 6; không hứa exactly-once với service không có receipt (plan §6.3 no-go). |

### Acceptance cho sample

- Chạy lại 45 cases SP-02 qua sample thay harness research; DUR-01/04/05 lặp 10 lần.
- Thêm: migration từ version 0 → hiện tại; từ chối DB version mới hơn; prune không đụng `claimed`/`unknown`; retire tạo tombstone và claim lại ID bị từ chối; approval pending sau restart là stale.
- Docs sample ghi rõ: local multi-process, không distributed, không exactly-once phía receiver, `node:sqlite` experimental.

## Kết quả sample (26/09/2026)

- [journal.ts](../../samples/durable-operations/journal.ts) implement đúng các quyết định ở trên: `user_version` với schema 3 (bản 1 là research schema, nên database research tự migrate; bản 3 thêm owner cho approval), CAS theo owner + generation, `reconcile` có fence, `retire` kèm tombstone, `prune` chỉ xóa entry đã completed và đã publish, `expirePendingApprovals()` do host gọi rõ ràng.
- Audit 27/09: bản đầu tự đánh stale mọi approval pending khi mở journal, làm hỏng approval của writer khác đang sống. Đã sửa bằng migration 3 và API rõ ràng; `owned` map giờ xóa entry sau khi complete.
- [Unit tests](../../tests/unit/durable-operations-sample.spec.ts): 9/9. Gồm migrate từ database trống và từ research schema, từ chối DB có version mới hơn, restart tái dùng result, unknown/conflict, fence late writer, retire/tombstone, prune, approval stale, pending intent.
- Harness SP-02 đã chuyển sang dùng sample và chạy **45/45** case kill/restart: DUR-01/04/05 lặp 10 lần, có `SQLITE_FULL` (13) thật và stale writer bị fence. Evidence: [durable-summary.json](../evaluations/sp-02-sample-2026-09-26/durable-summary.json).
