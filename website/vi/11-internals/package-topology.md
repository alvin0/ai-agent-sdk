# Topology package

Topology hiện tại được thực thi bởi `scripts/package-policy.mts`, manifest của
các package, và các cổng graph/runtime-boundary ở mọi thay đổi.

## Topology đóng băng những gì

Workspace ghi lại **20 package đích và 34 định danh công khai**:

- tầng runtime của từng package và đúng baseline tính năng host mà nó giả định;
- quy tắc core-peer, tập phụ thuộc workspace thông thường, và các peer tuỳ chọn;
- bảy khai báo phụ thuộc/peer runtime bên ngoài với phiên bản chính xác;
- một điểm vào có tên được khuyến nghị, một slot ghép nối có kiểu, đối tượng dùng,
  và quy tắc vòng đời/quyền sở hữu cho mỗi package ngoài core;
- bản đồ export điều kiện tường minh cho mọi package
  (`manifest-blueprints.json`);
- tập package cài ra thực tế cho **25 hành trình biên dịch**
  (`install-closures.json`).

Package chưa được hành trình nào dùng vẫn nhận một chỗ giữ quyền sở hữu khai báo
— không có gì bị bỏ vô chủ một cách âm thầm.

## Tầng runtime và baseline của chúng

| Tầng | Baseline tính năng host |
| --- | --- |
| **Universal** | Web Platform: ECMAScript, kiểu tương thích Fetch, Web Streams, `AbortController`, đo thời gian hiệu năng, Web Crypto |
| **Browser** | Baseline Universal cộng IndexedDB và các API vòng đời trang tuỳ chọn |
| **Node** | Builtin của Node 22.12: hệ tệp, `process`, tiến trình con, stdio |

Schema v5 đóng băng các baseline này một cách tường minh, **để một nhãn runtime
không thể qua cửa chỉ vì phần import nhìn có vẻ sạch**.

## 20 package đích

| Package | Tầng | Vai trò |
| --- | --- | --- |
| `core` | universal | core-runtime |
| `provider-http` | universal | provider-extension-kit |
| `protocol-responses` | universal | wire-protocol |
| `protocol-anthropic-messages` | universal | wire-protocol |
| `protocol-gemini-interactions` | universal | wire-protocol |
| `provider-openai` | universal | model-provider |
| `provider-anthropic` | universal | model-provider |
| `provider-codex` | universal | model-provider |
| `provider-gemini` | universal | model-provider |
| `mcp` | universal | mcp-client, tool-source |
| `mcp-server` | universal | mcp-server |
| `mcp-node` | node | mcp-client-transport |
| `mcp-node-server` | node | mcp-server-transport |
| `a2a` | node | agent-transport |
| `auth-node` | node | credential-source, credential-store |
| `skill-filesystem` | node | skill-provider |
| `observability-fetch` | universal | observation-exporter |
| `observability-otel` | universal | observation-processor |
| `observability-browser` | browser | observation-exporter |
| `observability-node` | node | observation-exporter, diagnostics |

(`testkit` là package private chỉ dùng lúc phát triển, nằm ngoài tập đích phát
hành.)

## Package nhiều điểm vào

Năm package có nhiều hơn một điểm vào công khai:

| Package | Điểm vào |
| --- | --- |
| `core` | `.` `./agent` `./memory` `./provider` `./skills` `./tools` `./observability` |
| `auth-node` | `.` `./env` `./codex` |
| `a2a` | `.` `./client` `./server` |
| `mcp` | `.` `./client` `./server` |
| `observability-node` | `.` `./journal` `./diagnostic` |

MCP `/server` và auth `/codex` là **khung nhìn theo peer tuỳ chọn**; các tuyến
danh tính được ghi riêng.

## Quy tắc manifest

Cả 20 package:

- **cấm tuyến wildcard và tuyến `require`**;
- có export `"./package.json"` tường minh;
- kết xuất một đối tượng metadata `aiAgentSdk` không-thực-thi từ topology —
  `runtime`, `coreApi: 1`, và một danh sách `roles` có chặn trên.

Metadata đó **chỉ là metadata tài liệu và phát hành**. Mã runtime không bao giờ
quét nó và không bao giờ tự nạp plugin từ nó.

Chính sách manifest cũng giữ lại các bề mặt cài đặt không phải TypeScript: các
tệp đóng gói thông dụng, binary đăng nhập Codex và thư mục `bin` của `auth-node`,
các bản phản chiếu `main`/`types` ở root, và metadata engine chỉ dành cho Node.

## Phân loại phụ thuộc

Topology định nghĩa đúng cách mã hoá trong manifest nguồn cho:

- phụ thuộc thông thường;
- peer core bắt buộc;
- peer workspace tuỳ chọn và metadata;
- phụ thuộc runtime bên ngoài;
- peer API bên ngoài, bắt buộc và tuỳ chọn.

Bộ kiểm tra chặn:

| Vi phạm | Vì sao nó quan trọng |
| --- | --- |
| Chồng lấn giữa dependency và optional-peer | Nhập nhằng ai sở hữu phiên bản. |
| Peer tuỳ chọn không có tuyến sở hữu | Sẽ chẳng bao giờ có gì nạp nó. |
| Nâng tầng runtime qua một tuyến tuỳ chọn chưa phân loại | Một package Universal âm thầm biến thành Node. |
| Lựa chọn phiên bản bên ngoài mâu thuẫn nhau | Hai package ghim hai phiên bản khác nhau của cùng một phụ thuộc. |

Peer tuỳ chọn chỉ vào tập cài đặt **khi được chọn trực tiếp**.

## Tập cài đặt

`install-closures.json` đóng băng tập workspace, tập bắt buộc bên ngoài, và tập
runtime hiệu dụng cho cả 25 hành trình biên dịch. Nó còn thử **từng package trong
17 package ngoài core khi được chọn trực tiếp cạnh core**, để một hành trình Node
lớn không thể che giấu một runtime sai ở mức package hay một phụ thuộc ẩn.

## Các công thức cài đặt

Tám công thức `pnpm add` được đối chiếu với tập package chính xác của từng hành
trình: năm cách ghép nối ứng dụng và ba đường viết provider bên thứ ba. Nhờ vậy
các package hỗ trợ vẫn là phụ thuộc bắc cầu với người dùng thông thường, trong
khi bề mặt mở rộng thì tiếp cận trực tiếp được.

## Đọc tiếp

- [Design contract](/vi/11-internals/design-contracts)
- [Bản đồ package](/vi/01-introduction/getting-started)
