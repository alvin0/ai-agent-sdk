# MCP — Tổng quan

MCP (Model Context Protocol) là một **ranh giới tuỳ chọn**. SDK trung lập không
import MCP, và ứng dụng chỉ cài những điểm vào nó dùng.

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp
```

## Hai chiều

| Chiều | Bạn nhận được | Package |
| --- | --- | --- |
| **Tiêu thụ** — tool MCP từ xa thành tool của SDK | Một `ToolSource` có phiên bản | `@ai-agent-sdk/mcp` |
| **Công bố** — tool và agent của SDK thành API MCP | Một handler theo chuẩn web | `@ai-agent-sdk/mcp` `/server`, `@ai-agent-sdk/mcp-server` |

## Bốn package

| Package | Runtime | Vai trò |
| --- | --- | --- |
| `@ai-agent-sdk/mcp` | Universal | Client HTTP + `ToolSource`; kèm `/server` |
| `@ai-agent-sdk/mcp-server` | Universal | Host server `Request`/`Response` dạng trơ |
| `@ai-agent-sdk/mcp-node` | Node | Tầng truyền tải client qua stdio |
| `@ai-agent-sdk/mcp-node-server` | Node | Hosting server qua stdio / `node:http` |

Client và server tách riêng, rồi các tầng truyền tải Node lại tách riêng lần nữa,
nên người dùng web hoặc quy trình **không bao giờ phải kế thừa phụ thuộc của
CLI**. Root thông thường và tuyến `/client` không chứa server, stdio, hệ tệp,
`node:http`, hay tích hợp vòng đời tiến trình nào.

## Ví dụ ngắn nhất mà hữu dụng

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { connectMcpHttp } from '@ai-agent-sdk/mcp'

const runtime = await createAgentRuntime({ providers: [modelProvider] })
let mcp: Awaited<ReturnType<typeof connectMcpHttp>> | undefined

try {
  mcp = await connectMcpHttp({
    serverName: 'billing',
    url: 'https://tools.example.com/mcp',
    logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
  })

  const agent = runtime.agent({ id: 'support', model, instructions: '…', toolSources: [mcp] })
  await agent.generate('Kiểm tra hoá đơn INV-42.')
} finally {
  try {
    await runtime.close()          // làm lắng các lượt chạy trước
  } finally {
    await mcp?.closeWithReport()   // rồi mới đóng thứ bạn đã kết nối
  }
}
```

**Thứ tự đóng rất quan trọng.** Vòng đời là `connected-caller-owned`: tạo runtime
trước, đóng runtime để làm lắng các lượt chạy, rồi mới đóng kết nối đang mượn và
xem `closeWithReport()`.

## Cầu nối ánh xạ gì, và không ánh xạ gì

Cầu nối tự động cố ý chỉ ánh xạ **tool của MCP** sang `ToolCatalog`, vì đó mới là
trừu tượng mà vòng lặp tool của agent tiêu thụ.

**Tài nguyên và prompt** của MCP vẫn khả dụng mà không bị ép vào trừu tượng tool —
hãy với tới chúng qua `withClient()`:

```ts
const resources = await mcp.withClient((client, signal) =>
  client.listResources(undefined, { signal }))
```

## Các tính chất an toàn nên biết ngay từ đầu

| Tính chất | Hành vi |
| --- | --- |
| Đặt tên tool | Gắn tiền tố `mcp__<serverName>__<tool>` để tránh va chạm |
| Hoán đổi danh mục | Chỉ một ảnh chụp **đã lấy xong hoàn toàn** mới được công bố |
| Làm mới thất bại | Vẫn giữ danh mục tốt gần nhất |
| Ảnh chụp | Đồng bộ và nguyên tử — một revision gắn cả schema **lẫn** việc thực thi |
| Mất kết nối | Kết nối lại theo hàm mũ có chặn trên; `close()` huỷ việc đó |
| Thế hệ | Một thế hệ sống tại một thời điểm |
| Xác thực phía server | Handler **không** xác thực header — bạn làm, trước khi gọi `fetch()` |
| Chính sách endpoint | Do host chọn: HTTPS, origin, mạng riêng, trần byte |

## Trong chương này

| Trang | Trả lời |
| --- | --- |
| [MCP Client](/vi/07-mcp/mcp-client) | Bề mặt API của client và mọi tuỳ chọn |
| [Connecting Servers](/vi/07-mcp/connecting-servers) | Bắt tay, dự phòng truyền tải, OAuth, chính sách endpoint |
| [Using MCP Tools](/vi/07-mcp/using-mcp-tools) | Đặt tên, lọc, revision danh mục, tài nguyên và prompt |
| [MCP Server](/vi/07-mcp/mcp-server) | Công bố tool và agent của SDK thành API MCP |

## Kiểm chứng mà không cần thông tin xác thực

```bash
npm run human:mcp
```

Thực hiện initialize, khám phá, và gọi tool thật qua các tầng truyền tải MCP nối
với nhau, **không cần thông tin xác thực của nhà cung cấp**, và in ra các trạng
thái vòng đời, tên đã khám phá, cùng kết quả khứ hồi có cấu trúc.
