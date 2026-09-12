# Thông tin dự án

## Trạng thái

| Mục | Giá trị |
| --- | --- |
| Phiên bản | `0.1.1` |
| Giấy phép | MIT |
| Yêu cầu Node | 22.18+ cho công cụ workspace; 22.12+ cho package năng lực Node đã cài |
| Publish lên registry | Release candidate `0.1.1` — 23 package dưới scope `@alvin0` |

## Publish lên registry

Cả 23 package có thể publish đều dùng scope `@alvin0`, với tên
`@alvin0/ai-agent-sdk-<capability>`. Scope `@ai-agent-sdk` thuộc một account
khác, nên tên trên registry mang tên dự án ở dạng tiền tố thay vì ở scope. Một
version chỉ được xem là có sẵn sau khi workflow release hoàn tất trên registry.

Sau khi merge vào `main`, `.github/workflows/release.yml` chạy lại các gate build,
test, package, boundary và supply-chain. Chỉ sau đó `pnpm pack` mới giải
`workspace:^` và `catalog:` thành range thật rồi publish từng tarball chưa tồn
tại trên npm bằng `npm publish --provenance`, nên mỗi version đều có attestation
provenance SLSA. Khi chạy lại release, các version đã có trên npm sẽ được bỏ qua
an toàn.

`@alvin0/ai-agent-sdk-testkit` vẫn private — nó chỉ là devDependency của các
package provider.

Nếu muốn cài từ tarball cục bộ:

```bash
pnpm add ./artifacts/alvin0-ai-agent-sdk-core-0.1.1.tgz
```

## Đánh phiên bản

Phiên bản package được đặt trực tiếp trong từng manifest và phát hành đồng bộ.
Ghi chú phát hành được duy trì trong file `CHANGELOG.md` của repository.

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
