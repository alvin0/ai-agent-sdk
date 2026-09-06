# Connecting Servers

## Kết nối

```ts
import { connectMcpHttp } from '@ai-agent-sdk/mcp/client'

const mcp = await connectMcpHttp({
  serverName: 'billing',
  url: 'https://tools.example.com/mcp',
  headers: { authorization: `Bearer ${token}` },
  toolFilter: { allow: ['lookup_invoice', 'refund_preview'] },
  logger: runtime.logger({ fields: { integration: 'mcp-http' } }),
})
```

`connectMcpHttp()` thương lượng, khám phá tool, và trả về một kết nối sẵn sàng.
`createMcpHttpClient()` dựng một kết nối **mà chưa** kết nối, dành cho ứng dụng tự
điều khiển việc khởi động:

```ts
const mcp = createMcpHttpClient({
  serverName: 'optional_search',
  url: 'https://search.example.com/mcp',
  reconnect: { maxAttempts: 4 },
  onStateChange: state => updateHealthUi(state),
})

await mcp.connect()   // từ chối ngay lỗi lần đầu; việc kết nối lại nền theo chính sách
```

## Ngữ nghĩa kết nối

Kết nối sở hữu **một thế hệ sống tại một thời điểm**. Nó:

- thương lượng thời đại MCP hiện đại kèm phương án dự phòng legacy;
- **chỉ** công bố tool sau khi bắt tay **và** `tools/list` thành công;
- lắng nghe thay đổi danh sách tool;
- chỉ hoán đổi một ảnh chụp **đã lấy xong hoàn toàn**;
- giữ danh mục tốt gần nhất khi một lần làm mới thất bại.

Mất kết nối bất ngờ sẽ **kết nối lại theo hàm mũ có chặn trên**. `close()` huỷ
việc kết nối lại, làm lắng phần khám phá đang chờ, đóng tầng truyền tải, và gỡ
đăng ký các tool.

## Thương lượng và truyền tải là hai tầng riêng

```ts
protocol: 'auto'     // mặc định: thử hiện đại, lùi về `initialize` legacy
protocol: 'modern'   // ghim
protocol: 'legacy'   // ghim
```

Kết nối HTTP dùng **Streamable HTTP** trước. Nếu khởi động thất bại vì lý do
không liên quan tới xác thực, phạm vi uỷ quyền, hay việc huỷ, SDK tạo một protocol
client mới và thử tầng truyền tải **SSE** đã lỗi thời **một lần**.

```ts
// Một endpoint legacy riêng:
createMcpHttpClient({ serverName: 'inventory', url, legacySse: { url: `${base}/sse` } })

// Hoặc từ chối hẳn phương án dự phòng:
createMcpHttpClient({ serverName: 'inventory', url, legacySse: false })
```

SSE chỉ là đường di trú cho server cũ. Triển khai MCP mới nên dùng Streamable
HTTP.

### Triển khai legacy vẫn hiện rõ

```ts
mcp.state.protocol   // { era, version, transport, fallback }
```

`state.protocol` phơi ra thời đại đã thương lượng, phiên bản **chính xác**, tầng
truyền tải đã chọn, và có xảy ra dự phòng truyền tải hay không. Đó là có chủ ý:
một triển khai legacy nên hiện rõ trong giao diện sức khoẻ, không bị ẩn âm thầm.

## OAuth 2.1

Truyền `OAuthClientProvider` của MCP SDK qua `transport.authProvider`.

```ts
import { UnauthorizedError } from '@modelcontextprotocol/client'

const mcp = createMcpHttpClient({
  serverName: 'github',
  url: 'https://api.githubcopilot.com/mcp/',
  reconnect: false,
  transport: { authProvider: oauthProvider },
})

try {
  await mcp.connect()
} catch (error) {
  if (!(error instanceof UnauthorizedError)) throw error
  // redirectToAuthorization() đã đưa URL cho trình duyệt/giao diện của bạn.
  const callbackParams = await receiveOAuthCallback()
  await mcp.finishOAuth(callbackParams, { expectedState: stateStoredByHost })
}
```

`finishOAuth()`:

- so sánh `state` **trước** khi đổi token;
- truyền toàn bộ query của callback cho protocol SDK để việc kiểm tra `iss` theo
  RFC 9207 vẫn hoạt động;
- **không** hiển thị văn bản lỗi callback do kẻ tấn công kiểm soát;
- đóng thế hệ uỷ quyền;
- kết nối lại trên một tầng truyền tải **mới**.

Host sở hữu trình duyệt/giao diện, định tuyến callback, đăng ký client, và lưu trữ
thông tin xác thực an toàn. Không chính sách Node nào trong số đó bị ép vào điểm
vào client theo chuẩn web.

### Bốn trạng thái, bốn giao diện khác nhau

Coi mọi mã `401` là OAuth là sai lầm kinh điển ở đây.

| Trạng thái | Ý nghĩa | Host cần làm |
| --- | --- | --- |
| `authentication-required` | Chưa cấu hình nhà cung cấp thông tin xác thực nào được nhận diện | Hỏi thông tin xác thực hoặc cấu hình auth |
| `authentication-failed` | Đã cấp bearer/API token nhưng bị từ chối | Thay hoặc làm mới token |
| `oauth-authorization-required` | OAuth cần mã uỷ quyền tương tác | Hoàn tất redirect, rồi `finishOAuth()` |
| `scope-authorization-required` | Server trả về thách thức thiếu phạm vi | Xin đồng ý cho `authorization.requiredScope` |

Khi có nhà cung cấp OAuth, Streamable HTTP mặc định **nâng phạm vi theo từng bước
có chặn trên**. Đặt `transport.onInsufficientScope: 'throw'` để đưa việc xin đồng
ý qua giao diện của bạn; khi đó kết nối phơi ra `scope-authorization-required`.
Nhà cung cấp chỉ-bearer không thể nâng phạm vi qua OAuth và sinh thẳng trạng thái
đó.

## Chính sách endpoint do host chọn

Client trung lập với chính sách triển khai. Hãy chọn ràng buộc cho ranh giới tin
cậy **của bạn**:

```ts
createMcpHttpClient({
  serverName: 'billing',
  url,
  allowedOrigins: ['https://tools.example.com'],
  requireHttps: true,
  allowPrivateNetwork: false,
  closeTimeoutMs: 10_000,
  // cộng chặn trên cho phản hồi / danh mục / kết quả và deadline thao tác
})
```

Client HTTP có thể giới hạn origin, bắt buộc HTTPS, từ chối endpoint riêng
tư/cục bộ dạng literal và các redirect, và chặn số byte truyền tải thô.

## stdio trên Node

```bash
pnpm add @ai-agent-sdk/core @ai-agent-sdk/mcp @ai-agent-sdk/mcp-node
```

```ts
import { connectMcpStdio, createMcpStdioClient } from '@ai-agent-sdk/mcp-node'

const local = await connectMcpStdio({
  serverName: 'filesystem',
  command: process.execPath,
  args: ['path/to/server.js'],
  logger: runtime.logger({ fields: { integration: 'mcp-stdio' } }),
})
```

`createMcpStdioClient()` dựng một client có giám sát **nhưng chưa sinh tiến trình
con**. `connectMcpStdio()` sinh tiến trình, thương lượng, khám phá, và trả về một
client sẵn sàng — còn khi thất bại thì đóng kèm báo cáo và ném
`McpConnectionError` mang theo báo cáo đó.

## Deadline và server bất hợp tác

Thao tác thô nhận tín hiệu deadline của kết nối. Nếu một thao tác **phớt lờ** tín
hiệu đó, thế hệ client đã hết giờ sẽ bị gỡ khỏi danh mục sống, đóng trong
`closeTimeoutMs`, và chỉ kết nối lại theo chính sách đã cấu hình.

Chính sự kiềm chế đó khiến một server bị treo không thể làm nghẽn agent của bạn:
thế hệ đó bị bỏ, không phải chờ mãi.

## Đóng kết nối

```ts
try {
  await runtime.close()
} finally {
  const report = await mcp.closeWithReport()
  if (report.unsettledRequests > 0) console.warn('MCP left work unsettled', report)
}
```

Hãy luôn xem báo cáo đóng. Việc tắt tầng truyền tải và việc tắt runtime là **hai
bằng chứng độc lập**.

## Đọc tiếp

- [Using MCP Tools](/vi/07-mcp/using-mcp-tools)
- [MCP Client](/vi/07-mcp/mcp-client) — danh sách tuỳ chọn đầy đủ
- [Security](/vi/10-advanced/security)
