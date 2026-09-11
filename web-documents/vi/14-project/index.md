# Thông tin dự án

## Trạng thái

| Mục | Giá trị |
| --- | --- |
| Phiên bản | `0.1.0` |
| Giấy phép | MIT |
| Yêu cầu Node | 22.18+ cho công cụ workspace; 22.12+ cho package năng lực Node đã cài |
| Publish lên registry | **Đã publish** — 23 package dưới scope `@alvin0` |

## Publish lên registry

Cả 23 package publish được đều đã lên npm dưới scope `@alvin0`, tên
`@alvin0/ai-agent-sdk-<capability>`. Scope `@ai-agent-sdk` thuộc một account
khác, nên tên đã publish mang tên dự án ở dạng tiền tố thay vì ở scope.

Release chạy từ `.github/workflows/release.yml` khi push tag `v*`: các gate CI
chạy, `pnpm pack` giải `workspace:^` và `catalog:` thành range thật, rồi từng
tarball được publish bằng `npm publish --provenance`, nên mỗi version đều có
attestation provenance SLSA.

`@alvin0/ai-agent-sdk-testkit` vẫn private — nó chỉ là devDependency của các
package provider.

Nếu muốn cài từ tarball cục bộ:

```bash
pnpm add ./artifacts/alvin0-ai-agent-sdk-core-0.1.0.tgz
```

## Đánh phiên bản

Hiện mọi package đều `private` và phiên bản được đặt trực tiếp trong từng
manifest. Repo không có công cụ sinh ghi chú phát hành.

Đồ thị package được cưỡng chế bởi `PACKAGE_RULES` trong
`scripts/package-policy.mts`, kiểm bởi các cổng graph và runtime-boundary trong
CI. Giữ nguyên là mặc định: xoá một export khỏi điểm vào công khai là thay đổi
phá vỡ tương thích, cần một lộ trình di trú cho người dùng.

## Bề mặt công khai

Root đã ghi tài liệu cộng với các subpath được liệt kê là công khai. Đường dẫn mã
nguồn nội bộ **không** phải hợp đồng tương thích — import sâu vào nội bộ `dist/`
hay `src/` sẽ vỡ mà không cần đổi major version.

Xem [bản đồ package](/vi/01-introduction/getting-started) để biết điểm vào công khai
của từng package.

## Quyết định được ghi ở đâu

| Quyết định | Ghi trong |
| --- | --- |
| Giữ đúng `eventsource-parser@4.1.0` trong `provider-http` | [Chính sách phụ thuộc](/vi/14-project/dependency-policy) và `docs/dependency-policy.md` |
| Việc tách package theo năng lực và hợp đồng API | `docs/core-capability-composition-design.md` |

## Trong mục này

- [Đóng góp](/vi/14-project/contributing)
- [Kiểm thử và nghiệm thu](/vi/14-project/testing)
- [Chính sách phụ thuộc](/vi/14-project/dependency-policy)
- [testkit](/vi/14-project/testkit)
- [Giấy phép](/vi/14-project/license)

## Tài liệu thiết kế

Thư mục `docs/` chứa bản ghi thiết kế đứng sau tài liệu này:

| Tài liệu | Chủ đề |
| --- | --- |
| `agent-definitions.md` | Chế độ, native tool, biến thể, quyền sở hữu session |
| `memory-and-compaction.md` | Lưu trữ, khôi phục khi tràn, sự kiện vòng đời |
| `tool-loop-design.md` | Kiến trúc vòng lặp, các chặn trên, hợp đồng checkpoint |
| `mcp.md`, `a2a.md` | Ranh giới tích hợp |
| `observability-and-usage-architecture.md` | Mô hình dữ liệu quan sát |
| `monorepo-package-architecture.md` | Lý do tách package |
| `core-capability-composition-design.md` | Thiết kế ghép nối |
| `dependency-policy.md` | Ngoại lệ chuỗi cung ứng và hạn rà soát lại |
| `public-api-baseline.md` | Danh mục API công khai đã đóng băng |
