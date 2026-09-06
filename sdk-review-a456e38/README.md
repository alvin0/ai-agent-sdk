# SDK review bundle — a456e38

- review-a456e38.vi.md: Báo cáo tiếng Việt.
- findings.json: 7 source findings/contract gaps và acceptance criteria.
- regression-matrix.vi.md / .json: 48 test scenarios đề xuất, chưa chạy full SDK.
- mechanism-checks.mjs / mechanism-results.json: 6 reduced mechanism scenarios đã chạy; không import SDK.

Không có source checkout, dependency, API key, signed download URL, heap dump hay full SDK test result trong bundle. Không có thay đổi repo. CI metadata báo failure ở baseline tests tại lúc đọc cuối; chi tiết log không nhất quán nên không gán tên/count testcase làm root cause.
