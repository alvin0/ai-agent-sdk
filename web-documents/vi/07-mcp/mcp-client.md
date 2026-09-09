# MCP Client

Bốn package. Client và server tách riêng, rồi các tầng truyền tải Node lại tách
riêng lần nữa, để người dùng web/quy trình không bao giờ phải kế thừa phụ thuộc
của CLI.

| Package | Runtime | Vai trò |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-mcp` | Universal | Client HTTP + `ToolSource` |
| `@alvin0/ai-agent-sdk-mcp-server` | Universal | Server `Request`/`Response` dạng trơ |
| `@alvin0/ai-agent-sdk-mcp-node` | Node | Tầng truyền tải client qua stdio |
| `@alvin0/ai-agent-sdk-mcp-node-server` | Node | Hosting server qua stdio / `node:http` |

---

## `@alvin0/ai-agent-sdk-mcp`

Runtime: **Universal**. Điểm vào: `.`, `./client`, `./server`.
Ghép nối: `runtime-agent.toolSources`. Vòng đời: `connected-caller-owned`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-mcp
```

```ts
export class McpClientConnection implements ToolSource { … }
export function createMcpHttpClient(options: McpHttpClientOptions): McpClientConnection
export function connectMcpHttp(options: McpHttpClientOptions): Promise<McpClientConnection>
export { McpConnectionError }
export type { McpCloseReport }
```

### Các tuỳ chọn chính

| Tuỳ chọn | Mục đích |
| --- | --- |
| `serverName` | Không gian tên cho tên tool có tiền tố. |
| `url` | Endpoint Streamable HTTP. |
| `headers` | Header tĩnh cho yêu cầu. |
| `toolFilter` | `{ allow: [...] }` / `{ deny: [...] }`. |
| `prefixToolNames` | Chỉ đặt `false` khi host bảo đảm không gian tên duy nhất. |
| `protocol` | `'auto'` (mặc định) / `'modern'` / `'legacy'`. |
| `legacySse` | `{ url }` cho endpoint SSE riêng, hoặc `false` để tắt dự phòng. |
| `reconnect` | `{ maxAttempts }`, hoặc `false`. |
| `transport.authProvider` | Một `OAuthClientProvider` của MCP SDK. |
| `transport.onInsufficientScope` | `'throw'` để đưa việc xin đồng ý qua giao diện của bạn. |
| `allowedOrigins`, `requireHttps`, `allowPrivateNetwork`, `allowRedirects`, `validateEndpoint` | Chính sách endpoint; mặc định HTTPS/public/không redirect, kèm validator cuối nhận signal deadline của operation. |
| `closeTimeoutMs` | Chặn trên khi tắt tầng truyền tải. |
| `logger` | Truyền `runtime.logger({ fields: … })`. |
| `onStateChange` | Hook cho giao diện sức khoẻ/gỡ lỗi. |

### Bề mặt của kết nối

`operationTimeoutMs`, `toolCallTimeoutMs`, `closeTimeoutMs` và
`initialDelayMs` / `maxDelayMs` của reconnect phải là số nguyên mili giây từ
`1` đến `2147483647`. Giá trị ngoài khoảng bị từ chối trước khi tạo timer;
các giới hạn byte và số lượng được kiểm tra riêng.

```ts
connection.state                 // trạng thái + era/version/transport/fallback đã thương lượng
connection.connect()             // từ chối ngay lỗi lần đầu
connection.finishOAuth(params, { expectedState })
connection.withClient((client, signal) => …)   // tài nguyên/prompt thô
connection.closeWithReport()     // McpCloseReport
```

---

## `@alvin0/ai-agent-sdk-mcp-server`

Runtime: **Universal** (Edge/Worker, trình duyệt, Deno, Bun, Node).
Ghép nối: `host.mcp-server`. Vòng đời: `inert-host-mounted`.

```ts
export { createMcpServer, type McpServerDefinition, type McpWebServer }
export * from './server/advanced.ts'   // createSdkMcpServer, SdkMcpServerOptions, …
```

`createMcpServer()` trả về một bề mặt host `Request`/`Response` dạng trơ. Ứng
dụng sở hữu việc xác thực và gắn route; **mỗi yêu cầu sở hữu tài nguyên giao thức
của chính nó**, nên server trả về không có handle dọn dẹp mức ứng dụng nào bị bịa
ra.

Tuyến `@alvin0/ai-agent-sdk-mcp/server` phơi ra `createSdkMcpHandler()` cho cùng mục
đích, từ phía package MCP.

---

## `@alvin0/ai-agent-sdk-mcp-node`

Runtime: **Node 22.12+**. Ghép nối: `runtime-agent.toolSources`.
Vòng đời: `connected-caller-owned`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-mcp @alvin0/ai-agent-sdk-mcp-node
```

```ts
export interface McpStdioConnection extends McpClientConnection {}
export interface McpStdioClientOptions extends McpClientLifecycleOptions, StdioServerParameters {}

export function createMcpStdioClient(options: McpStdioClientOptions): McpStdioConnection
export function connectMcpStdio(options: McpStdioClientOptions): Promise<McpStdioConnection>
export { McpConnectionError }
export type { McpCloseReport }
```

`createMcpStdioClient()` dựng một client có giám sát **nhưng chưa sinh tiến trình
con**. `connectMcpStdio()` sinh tiến trình, thương lượng, khám phá tool, và trả
về một client sẵn sàng — còn khi thất bại thì đóng kèm báo cáo và ném
`McpConnectionError` mang theo báo cáo đó.

Tham số stdio lấy từ MCP SDK: `command`, `args`, `env`, `stderr`, `cwd`,
`maxBufferSize`.

---

## `@alvin0/ai-agent-sdk-mcp-node-server`

Runtime: **Node 22.12+**. Ghép nối: `host.mcp-server`.
Vòng đời: `host-owned` — gọi `handle.close({ signal })` và giữ lại bằng chứng về
deadline/các yêu cầu chưa lắng.

```ts
export function serveMcpStdio(
  server: McpWebServer,
  options?: { closeTimeoutMs?: number; logger?: SdkLogger },
): McpNodeServerHandle

export function serveSdkMcpStdio(
  options: SdkMcpServerOptions,
  serveOptions?: ServeStdioOptions,
): StdioServerHandle

// Chuyển đổi node:http và bảo vệ chống DNS rebinding
export {
  toNodeHandler, hostHeaderValidation,
  localhostHostValidation, localhostOriginValidation, originValidation,
}
export type { NodeMcpRequestHandler, ToNodeHandlerOptions, McpNodeServerCloseReport }

// Re-export cho tiện
export { createMcpServer, type McpServerDefinition, type McpWebServer }
```

```ts
const handle = serveMcpStdio(server, { logger })
const report = await handle.close({ signal })
```

Khi mở một listener HTTP cục bộ, hãy đặt `localhostHostValidation()` và
`localhostOriginValidation()` — hoặc danh sách cho phép tường minh — **trước**
handler, để bảo vệ khỏi DNS rebinding và các origin trình duyệt không mong muốn.

## Đọc tiếp

- [Connecting Servers](/vi/07-mcp/connecting-servers) — bắt tay, OAuth, chính sách endpoint
- [Using MCP Tools](/vi/07-mcp/using-mcp-tools) — đặt tên, lọc, revision
- [MCP Server](/vi/07-mcp/mcp-server) — phía công bố
