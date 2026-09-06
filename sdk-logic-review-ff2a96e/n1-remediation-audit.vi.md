# N1 — Mandatory usage stop sau compaction

Baseline working tree: `166526335d3beb41b4831e5340da0e8380d25025`.
Không giữ finding CI đỏ cũ: người review đã xác nhận CI của baseline xanh.
Lượt này sửa N1, không rewrite compaction hoặc đổi scope token cap ngầm.

## Hợp đồng và sửa đổi

- Ledger giữ quyết định mandatory usage stop đầu tiên của invocation, bao gồm
  summary. Một report hợp lệ đến sau không xóa quyết định đó.
- Model round kiểm tra trước/sau `beforeStep` và sau checkpoint, trước dispatch.
  Loop kiểm tra shared decision khi admission và sau overflow recovery hook.
  User hook không override decision mà compaction đã ghi nhận.
- Compaction xử lý cả `usageRequired` và `usageUnavailable`, không commit summary
  hoặc mở summary mới sau stop. Lỗi maintenance thông thường vẫn fail-open.
- Giữ nguyên raw summary evidence. Required usage dừng bằng `USAGE_REQUIRED`;
  unavailable usage giữ `usage-unavailable` và `modelCallId` của summary gây dừng.
- Stop chỉ thuộc một invocation; session có thể chạy invocation mới với ledger mới.
- Giữ scope `maxTotalTokens` cho normal rounds/retry/finalizer, **không gồm summary**.
  Summary dùng `maxSummaryTokens`, `summaryTimeoutMs`, `compactionRetries`,
  `maxOverflowRetries`; chưa có cumulative summary-token cap riêng. Report cộng
  cả main và summary, không phải bằng chứng cap toàn invocation. Đã ghi vào
  API JSDoc, docs contract và web EN/VI, có regression cho scope này.

## Bằng chứng

Test fixture đầu tiên thiếu `summarizationProvider`; lỗi setup này được sửa trước
khi tái hiện baseline. Sau đó test qua public package build trước sửa tái hiện
cả 4 biến thể: fail, estimator throw, estimator timeout, warn đều dispatch main
sau summary; 2 control PASS. Bản test baseline tạm đã xóa; regression chính thức
là `tests/unit/compaction-usage-stop.spec.ts` chạy source SDK.

Regression chính thức gồm 12 tổ hợp (4 usage modes × pressure trước main,
context-overflow recovery, pressure trước structured final), 2 control fail-open,
1 ca invocation mới, 1 ca scope normal-turn cap. Assert raw summary report,
dispatch count, bounded settlement và reason/modelCallId, không chỉ logger.
Ledger có thêm 2 test giữ stop sau report thành công và 1 test nhánh duplicate
report ở production mode cũng giữ quyết định mandatory stop. Packed core fixture chạy
fail/warn qua composition facade thật từ tarball trên Node, standards-only,
browser và Worker. Harness Worker hiện có được giữ nguyên theo hướng dẫn Wrangler.

Nhóm source regression bản cuối đã PASS 5 lượt × 71 test (N1 + L1–L3 + ledger).
Full baseline bản cuối PASS 124 files / 1.421 tests; package core PASS 850 tests.
Packed core (gồm assertion N1 qua composition facade) PASS Node, standards-only,
browser, Worker. Không dùng số fixture làm số request provider thật.
Full gate bản cuối PASS, exit 0: workspace build/typecheck, CLI build, root tsc,
lint/graph/runtime boundaries, negative fixtures, supply-chain, baseline,
package suites, publint, package types, toàn bộ packed/runtime matrix và docs
check/build. Frozen install đã PASS trước đó, lockfile/dependencies không đổi.
`git diff --check` PASS. Sau self-audit và validation, chưa thấy finding còn mở
trong phạm vi N1; không phải chứng nhận toàn hệ thống không còn bug.
`gates.log` lỗi TypeScript không phải evidence PASS;
`final-gates.log` PASS trước hardening duplicate-report. Log bản cuối:
`/tmp/sdk-n1-compaction.PNuJ9H/verified-gates.log`;
repetition: `/tmp/sdk-n1-compaction.PNuJ9H/verified-repeated.log`.

Lệnh gate bản cuối:

```sh
rtk proxy npm exec --yes --package=node@22.18.0 -- sh -c 'pnpm workspace:build && pnpm workspace:typecheck && pnpm build:cli && pnpm exec tsc --noEmit && pnpm lint && pnpm check:boundary-fixtures && pnpm check:supply-chain && pnpm test && pnpm test:packages && pnpm test:pack && pnpm check:docs && pnpm docs:build'
```

SHA-256 log:

```text
f6788c8fed672fa91df92d6c2a3eea34324b9a98c42ac995daf3ebb62efe9c35  verified-gates.log
d8a5947054eb36191b297d056e083298a646e145c4ebd3d1e261e52e10ef0aec  verified-repeated.log
```

Source identity: SHA-256 của `git diff -- packages tests docs website`:
`5a94e58b068751cacf4d44b70b71508d44a472aecc71fc090575badfb789fd75`.
File implementation/test mới:

```text
172f4537f0440b49a3dcba0d265e19d36886dd56de0d4a7e585078f13e8cf92f  packages/core/src/agent/loop/turn/usage-stop.ts
62fccf17ffb190c31146904b3075ebb5e402cddb96eb520233bf1e85a5bff496  tests/unit/compaction-usage-stop.spec.ts
```

Không chạy paid provider/soak/invoice trong lượt này. Không commit/push; local
gate không thay thế GitHub CI cho commit mới chưa tồn tại.
