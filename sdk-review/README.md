# Review pack — AI Agent SDK / mono-package

Snapshot: `80353b38da2411450a5c4e0c1e6ce7e4c5cdebf7`, review date06/09/2026.

- `AI-Agent-SDK-premerge-review-80353b3.vi.md`: báo cáo tiếng Việt, findings và acceptance gates.
- `mechanism-repros.mjs`: kiểm tra cơ chế độc lập; đã chạy bằng Node22.16.0, không import SDK.
- `mechanism-results.json`: kết quả thực tế của kiểm tra cơ chế.
- `premerge-review.regression.spec.ts`: năm regression tests đề xuất cho workspace; CHƯA chạy/typecheck với repository.

Chạy kiểm tra độc lập bằng `node mechanism-repros.mjs`.

Để dùng regression file, copy vào `tests/unit/composition/premerge-review.regression.spec.ts`
trong repo rồi chạy `pnpm exec vitest run tests/unit/composition/premerge-review.regression.spec.ts`
sau khi sửa build toolchain. Các tests biểu diễn contract an toàn đề xuất và dự kiến
có failure trên snapshot được review. Không có API call thật hoặc credentials.

Không có xác nhận full build/unit/integration pass, heap/soak test hay audit CVE trong gói này.
Không có thay đổi nào đã được đẩy lên GitHub.
