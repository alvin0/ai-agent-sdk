# MCP Server

Công bố các tool SDK của bạn — và cả một agent — thành một API MCP mà bất kỳ
client MCP nào cũng dùng được.

## Handler web (Next.js, Worker, Deno, Bun)

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-mcp
```

```ts
// app/api/mcp/route.ts
import { defineTool } from '@alvin0/ai-agent-sdk-core'
import { createSdkMcpHandler } from '@alvin0/ai-agent-sdk-mcp/server'

const lookupInvoice = defineTool({
  name: 'lookup_invoice',
  description: 'Look up an invoice by id.',
  parameters: {
    type: 'object',
    properties: { invoiceId: { type: 'string' } },
    required: ['invoiceId'],
  },
  parse: raw => raw as { invoiceId: string },
  execute: async ({ invoiceId }, ctx) => billing.getInvoice(invoiceId, ctx.signal),
  isConcurrencySafe: () => true,
  timeoutMs: 15_000,
})

const mcp = createSdkMcpHandler({
  name: 'orders-api',
  version: '1.0.0',
  tools: [lookupInvoice],
})

export async function POST(request: Request): Promise<Response> {
  // Xác thực TRƯỚC — handler không kiểm tra header của yêu cầu.
  const user = await authenticate(request)
  if (user === null) return new Response('unauthorized', { status: 401 })

  return mcp.fetch(request)
}
```

> **Handler nhận `authInfo` đã được kiểm tra sẵn, nhưng nó không xác thực header
> của yêu cầu.** Hãy kiểm tra thông tin xác thực và quyền truy cập tài nguyên ở
> framework host trước khi gọi `handler.fetch()`.

Tool xuất ra chạy qua toàn bộ đường ống của SDK: phân tích tham số, deadline cứng
ở vòng ngoài, tháo dỡ có chặn trên, broker phê duyệt, và interceptor. Giá trị tool
trở thành `structuredContent` của MCP; văn bản và ảnh nội tuyến vẫn là nội dung
kết quả hạng nhất.

## Công bố một agent như một tool

```ts
const mcp = createSdkMcpHandler({
  name: 'support-api',
  version: '1.0.0',
  agents: [{
    name: 'run_support',
    agent: supportAgent,
    createSession: async ({ conversationId }) => {
      const snapshot = conversationId === undefined
        ? undefined
        : await sessionStore.load(conversationId)

      return snapshot === undefined
        ? supportAgent.createSession({ registry, conversationId })
        : supportAgent.resumeSession({ registry, snapshot })
    },
  }],
})
```

Server **không** giấu trạng thái hội thoại trong một map toàn cục của tiến trình.
Bạn nhận `conversationId` và tự quyết định tạo hay khôi phục session — nhờ đó
chính sách lưu trữ và cô lập cho web/serverless vẫn tường minh và thuộc về bạn.

## Chặn trên và mức phơi lỗi

Thao tác tool/agent phía server, payload vào/ra, số lời gọi đồng thời, bộ quan
sát lỗi, và việc tháo dỡ đều có giới hạn độc lập.

```ts
createSdkMcpHandler({
  name: 'orders-api',
  version: '1.0.0',
  tools,
  exposeInternalErrors: false,   // mặc định — lỗi nội bộ dạng chung
})
```

Chỉ đặt `exposeInternalErrors: true` cho một bề mặt chẩn đoán **đáng tin cậy**.

## Server stdio trên Node

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-mcp-server @alvin0/ai-agent-sdk-mcp-node-server
```

```ts
import { createMcpServer } from '@alvin0/ai-agent-sdk-mcp-server'
import { serveMcpStdio } from '@alvin0/ai-agent-sdk-mcp-node-server'

const server = createMcpServer({
  name: 'local-tools',
  version: '1.0.0',
  tools,
})

const handle = serveMcpStdio(server, { closeTimeoutMs: 10_000, logger })

process.on('SIGTERM', async () => {
  const report = await handle.close()
  console.error('mcp server closed', report)
})
```

`serveMcpStdio()` trả về một handle **thuộc sở hữu của host**. Hãy luôn xem báo
cáo đóng có chặn trên của nó — việc tắt tầng truyền tải và việc tắt runtime là
hai bằng chứng độc lập.

Điểm vào nâng cao cũ `serveSdkMcpStdio(options, serveOptions)` vẫn còn dùng được.

## Listener HTTP trên Node

```ts
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@alvin0/ai-agent-sdk-mcp-node-server'
import { createServer } from 'node:http'

const handler = toNodeHandler(server)

createServer((req, res) => {
  // Áp dụng TRƯỚC handler.
  if (!localhostHostValidation(req) || !localhostOriginValidation(req)) {
    res.writeHead(403).end()
    return
  }
  handler(req, res)
}).listen(8765, '127.0.0.1')
```

Các bộ kiểm tra này bảo vệ một listener cục bộ khỏi **DNS rebinding** và các
origin trình duyệt không mong muốn. Với triển khai không phải localhost, hãy dùng
danh sách cho phép tường minh (`hostHeaderValidation`, `originValidation`).

## Kiểm chứng

```bash
npm run human:mcp
```

Thực hiện initialize, khám phá, và gọi tool thật qua các tầng truyền tải MCP nối
với nhau, không cần thông tin xác thực của nhà cung cấp. Nó in ra các trạng thái
vòng đời, tên đã khám phá, và kết quả khứ hồi có cấu trúc.

## Đọc tiếp

- [MCP Client](/vi/07-mcp/mcp-client) — phía tiêu thụ
- [Connecting Servers](/vi/07-mcp/connecting-servers)
- [Security](/vi/10-advanced/security) — phần bạn phải tự xác thực
