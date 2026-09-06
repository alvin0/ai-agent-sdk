# Internals — Tổng quan

Dành cho người đóng góp, tác giả provider, và bất kỳ ai đang gỡ lỗi một hành vi
mà tài liệu hướng người dùng không giải thích.

| Trang | Bao gồm |
| --- | --- |
| [Topology package](/vi/11-internals/package-topology) | 20 package đích, 34 định danh, tầng runtime, quy tắc phụ thuộc |
| [Đường ống adapter](/vi/11-internals/adapter-pipeline) | Provider cung cấp gì và lớp cơ sở sở hữu gì |
| [Design contract](/vi/11-internals/design-contracts) | Cổng kiểm tra tĩnh giữ cho topology trung thực |

## Hai quy tắc cấu trúc

Phần lớn kiến trúc suy ra từ hai quy tắc.

**Adapter là tầng duy nhất biết định dạng wire.** Mọi thứ phía trên nói bằng từ
vựng trung lập trong `core/`.

**`stream()` nằm ở lớp cơ sở, không nằm trong provider.** Một provider cung cấp
bốn thứ — `connect`, `endpointPath`, `buildBody`, `translate` — và không thể vô
tình tự viết vòng lặp fetch riêng rồi quên header quy kết, xử lý sai abort, hoặc
bịa mã lỗi.

## Phân tầng bên trong core

Đọc các thư mục theo thứ tự phụ thuộc. Đó là thiết kế, không phải ngẫu nhiên:

```text
primitives/     id có nhãn, đóng băng sâu, kiểm tra vét cạn   ← không phụ thuộc gì
async/          nguyên thuỷ dàn xếp có chặn trên
observation/    cổng tương quan, usage, telemetry
plugin/         hợp đồng mở rộng provider có giao dịch
errors/         hệ phân loại theo code và bản song sinh tuần tự hoá được
message/        content block, message bất biến, phép chiếu
stream/         giao thức chunk, bộ lắp ráp, SSE và chặn trên khi rảnh
contract/       adapter phải hiện thực gì và nhận gì
runtime/        registry định tuyến lời gọi, và thử lại
http/           vấn đề xác thực và quy kết mà các adapter dùng chung
```

## Tầng runtime được cưỡng chế, không chỉ ghi tài liệu

Mỗi package khai báo `universal`, `browser`, hoặc `node`. Một cổng kiểm tra tĩnh
sẽ chặn:

- khai báo Universal nào import package hoặc builtin của Node;
- một hành trình Edge bị nâng tầng bởi năng lực Node;
- import facade chưa khai báo hoặc bị cấm;
- sự trôi lệch giữa ánh xạ package trong `tsconfig` và topology;
- các lựa chọn package trực tiếp không còn khớp với công thức đã ghi tài liệu.

## Bố cục repository

```text
packages/core                 Runtime Universal, agent, observability, hợp đồng, registry
packages/provider-http        tầng truyền tải Fetch/SSE dùng chung
packages/protocol-*           giao thức wire tái dùng
packages/provider-*           plugin provider tường minh
packages/observability-*      exporter và cầu nối theo từng runtime
packages/auth-node, mcp-node  nâng tầng Node một cách tường minh
design-contracts/             cổng biên dịch tĩnh và các sổ cái API đã đóng băng
docs/                         tài liệu thiết kế và bằng chứng hiện thực
spikes/                       các đánh giá lịch sử — không phải mã production
test-human/                   harness nghiệm thu tương tác
website/                      chính site tài liệu này
```

## Bản ghi thiết kế nằm ở đâu

`docs/` chứa phần lập luận đứng sau các trang này: `tool-loop-design.md`,
`observability-and-usage-architecture.md`,
`core-capability-composition-design.md`, `monorepo-package-architecture.md`, và
các ADR trong `docs/adr/`.

Chương này tóm tắt chúng. Khi hai bên không khớp, bản ghi thiết kế và các sổ cái
đã đóng băng trong `design-contracts/` mới là bản có thẩm quyền.
