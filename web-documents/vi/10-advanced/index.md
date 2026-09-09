# Advanced — Tổng quan

Mọi thứ ở đây là về việc **chạy cái này trên production**, không phải về việc làm
cho nó chạy được. Phần này giả định bạn đã đọc [Agents](/vi/02-agents/) và
[Tools](/vi/03-tools/).

| Trang | Trả lời |
| --- | --- |
| [Error Handling](/vi/10-advanced/error-handling) | Hệ phân loại toàn SDK, chính sách thử lại, và mọi mã lỗi |
| [Observability](/vi/10-advanced/observability) | Bus quan sát, độ phủ usage, và cách cấu hình |
| [Security](/vi/10-advanced/security) | Thông tin xác thực, chính sách endpoint, mặc định riêng tư |
| [Performance](/vi/10-advanced/performance) | Mọi chặn trên, ngân sách, và quyết định hạch toán token |
| [Production Deployment](/vi/10-advanced/production-deployment) | Khởi động, shutdown, và checklist theo từng runtime |
| [Troubleshooting](/vi/10-advanced/troubleshooting) | Triệu chứng → nguyên nhân → cách sửa |
| [Edge Worker](/vi/10-advanced/deploy-edge-worker) · [Node CLI](/vi/10-advanced/deploy-node-cli) · [Trình duyệt](/vi/10-advanced/deploy-browser) | Các phép ghép nối hoàn chỉnh, chạy được |

## Bốn thứ production thực sự cần

**1. Đọc báo cáo đóng.** Không phải cho có — mà như bằng chứng.

```ts
const report = await runtime.close()
if (report.unsettledRuns > 0) alert('something ignored cancellation')
```

**2. Đọc *độ phủ* usage, không chỉ đọc con số tổng.**

```ts
response.report.coverage        // số lời gọi logic, lượt thử vật lý, số bị thiếu
response.report.authoritative   // có được gọi đây là tổng hay không?
```

`reported` là **tổng cận dưới** khi độ phủ chưa đầy đủ. Đừng bao giờ gọi một con
số không có thẩm quyền là "tổng chi phí".

**3. Đăng ký một exporter nêu đúng mức bền vững thật của nó.**

```ts
{ exporter, ownership: 'owned', requirement: 'required', boundary: 'local-durable' }
```

Giao nhận trong bộ nhớ **không bao giờ** tuyên bố tính bền vững. Chế độ giao nhận
`reliable` và `audit` đòi một package exporter bền vững.

**4. Chặn vòng lặp theo khối lượng công việc thật, không theo bản demo.**

```ts
runtimeLimits: { maxTotalTokens: 250_000, maxToolDurationMs: 120_000 }
```

Mặc định an toàn cho vận hành không giám sát — 16 bước model, 64 tool được điều
phối, trần 500.000 token tổng đã báo cáo — nhưng chúng không được tinh chỉnh cho
mô hình chi phí của bạn.

## SDK cho bạn gì, và phần nào vẫn của bạn

Package này là một **SDK, không phải control plane cho production**.

| SDK cung cấp | Bạn cung cấp |
| --- | --- |
| Trạng thái có chặn trên, TTL, huỷ, giải phóng | Middleware xác thực |
| Hệ phân loại lỗi có kiểu và bản ghi lỗi đã làm sạch | Kho lưu bền |
| Bus quan sát có cấu trúc với mặc định riêng tư | Giới hạn tần suất |
| Quyền sở hữu tường minh và bằng chứng đóng | Cưỡng chế mạng và DNS |
| Hook chính sách ở mọi ranh giới | Quản lý secret |
| Tầng runtime được cưỡng chế bởi cổng kiểm tra tĩnh | Triển khai và backend telemetry |

Mọi giới hạn trong chương này là **hàng rào tài nguyên trung lập với triển khai**.
Không cái nào là tenant, gói cước, hay tính năng control plane.

## Tầng runtime quyết định tập package của bạn

| Tầng | Ràng buộc | Package |
| --- | --- | --- |
| **Universal** | Chỉ Web Standards | core, provider-*, protocol-*, mcp, mcp-server, observability-fetch, observability-otel |
| **Browser** | IndexedDB, vòng đời trang | observability-browser |
| **Node** | Builtin của Node 22.12+ | auth-node, mcp-node, mcp-node-server, skill-filesystem, observability-node, a2a |

Một cổng kiểm tra tĩnh chặn khai báo Universal nào import builtin Node, và chặn
một hành trình Edge bị nâng tầng bởi năng lực Node. Nếu bundle Edge của bạn kéo
theo `node:fs`, thì một package tầng Node đã lọt vào đồ thị — xem
[Troubleshooting](/vi/10-advanced/troubleshooting).

## Phần nội bộ nằm ngay bên cạnh

Topology package, đường ống adapter, và cổng design contract nằm trong
[Internals](/vi/11-internals/). Hãy đọc chúng khi bạn đang mở rộng SDK, không
phải khi đang triển khai nó.
