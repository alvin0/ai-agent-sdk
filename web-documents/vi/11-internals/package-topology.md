# Topology package

Topology hiện tại được thực thi bởi `scripts/package-policy.mts`, manifest của
các package, và các cổng graph/runtime-boundary ở mọi thay đổi.

## Những gì được cưỡng chế

`PACKAGE_RULES` trong `scripts/package-policy.mts` là đồ thị chuẩn. Với mỗi
package, nó ghi tầng runtime, các phụ thuộc workspace được phép, và các phụ thuộc
runtime bên ngoài mà package đó trực tiếp sở hữu.

Các cổng CI đối chiếu manifest thật và đồ thị import thật với nó:

| Cổng | Chặn |
| --- | --- |
| `check-package-graph` | Manifest có phụ thuộc khác với quy tắc đã ghi |
| `check-dependency-cruiser` | Một cạnh import mà đồ thị không cho phép |
| `check-runtime-boundaries` | Package Universal chạm tới builtin của Node |
| `check-agent-boundaries` | Cạnh ở tầng agent tạo ra phụ thuộc team cụ thể |

Thêm một package nghĩa là thêm một mục vào `PACKAGE_RULES`. Không có sổ cái riêng
nào phải giữ đồng bộ.

## Tầng runtime và baseline của chúng

| Tầng | Baseline tính năng host |
| --- | --- |
| **Universal** | Web Platform: ECMAScript, kiểu tương thích Fetch, Web Streams, `AbortController`, đo thời gian hiệu năng, Web Crypto |
| **Browser** | Baseline Universal cộng IndexedDB và các API vòng đời trang tuỳ chọn |
| **Node** | Builtin của Node 22.12: hệ tệp, `process`, tiến trình con, stdio |

Schema v5 đóng băng các baseline này một cách tường minh, **để một nhãn runtime
không thể qua cửa chỉ vì phần import nhìn có vẻ sạch**.

## 21 package đích

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
| `instructions-node` | node | context-section |
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

Cả 21 package:

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

`pnpm test:pack` đóng gói mọi package sẽ phát hành rồi cài các tarball đó vào
fixture dùng-một-lần, nên lỗi runtime ở mức package hay một phụ thuộc ẩn sẽ hiện
ra thành một lần cài thất bại, thay vì hiện ra ở lần import đầu tiên của người
dùng.

## Các công thức cài đặt

Tám công thức `pnpm add` được đối chiếu với tập package chính xác của từng hành
trình: năm cách ghép nối ứng dụng và ba đường viết provider bên thứ ba. Nhờ vậy
các package hỗ trợ vẫn là phụ thuộc bắc cầu với người dùng thông thường, trong
khi bề mặt mở rộng thì tiếp cận trực tiếp được.

## Đọc tiếp

- [Bản đồ package](/vi/01-introduction/getting-started)
