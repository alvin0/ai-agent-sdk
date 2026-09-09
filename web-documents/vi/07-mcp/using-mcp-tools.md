# Using MCP Tools

## Gắn kết nối làm một tool source

```ts
const agent = runtime.agent({
  id: 'support',
  model,
  instructions: 'Use the connected tools when needed.',
  toolSources: [mcp],       // không phải `tools` — cả một danh mục, không phải một hàm
  tools: [localTool],       // các hàm host của bạn vẫn dùng song song được
})
```

`toolSources` và `tools` là hai slot riêng. Tool của host là giá trị bạn sở hữu;
một tool source là **danh mục có phiên bản**, có thể đổi revision bên dưới bạn.

## Tên được gắn tiền tố

Tool từ xa xuất hiện dưới dạng `mcp__<serverName>__<tool>`:

```text
serverName: 'billing'  +  lookup_invoice  →  mcp__billing__lookup_invoice
```

Tiền tố ngăn va chạm khi nhiều server công bố cùng một tên thô — hai server đều
có `search` thì nếu không có tiền tố, model không phân biệt được.

```ts
prefixToolNames: false
```

**Chỉ** dùng khi host đã tự bảo đảm không gian tên là duy nhất. Nếu bạn tắt nó mà
hai danh mục va chạm, bạn nhận `CapabilityIdentityConflict` chứ không phải một cú
che tên âm thầm.

## Lọc những gì model thấy

```ts
connectMcpHttp({
  serverName: 'billing',
  url,
  toolFilter: { allow: ['lookup_invoice', 'refund_preview'] },
})
```

Danh sách cho phép là ranh giới quyền rẻ nhất có thể: một tool mà model không bao
giờ thấy thì không thể bị gọi. Hãy ưu tiên cách này hơn là dặn model tránh một
thứ.

Nó ghép được với phần còn lại của bề mặt thu hẹp:

```ts
// Năng lực theo từng yêu cầu
agent.createSession({ toolSources: currentUser.canRefund ? [mcp] : [] })
```

## Ảnh chụp danh mục là nguyên tử

```text
tools/list thành công → công bố ảnh chụp revision N
list_changed phát ra  → lấy xong hoàn toàn → công bố revision N+1
lấy thất bại          → giữ revision N (tốt gần nhất)
```

Ảnh chụp là **đồng bộ và nguyên tử**: một revision gắn cả schema lẫn đường thực
thi. Do đó một danh mục thay đổi giữa chừng không thể khiến model gọi một tool có
schema mà nó chưa từng thấy.

Bằng chứng kết thúc chỉ mang **nguồn và revision** — không mang cả danh mục — nên
báo cáo của lượt chạy vẫn nhỏ mà vẫn cho bạn biết chính xác revision nào đã chạy.

## Xem sức khoẻ kết nối

```ts
mcp.state.status      // connecting | ready | authentication-required | …
mcp.state.protocol    // { era, version, transport, fallback }
```

```ts
createMcpHttpClient({
  serverName: 'billing',
  url,
  onStateChange: state => healthUi.update('billing', state),
})
```

Hãy hiển thị `state.protocol` trong giao diện sức khoẻ của bạn. Một server âm
thầm lùi về tầng truyền tải SSE đã lỗi thời là điều bạn muốn biết **trước** khi nó
bị gỡ ở thượng nguồn.

## Tài nguyên và prompt

Tài nguyên và prompt của MCP vẫn khả dụng mà **không** bị ép vào trừu tượng tool.
Hãy với tới chúng bằng `withClient()`:

```ts
const resources = await mcp.withClient((client, signal) =>
  client.listResources(undefined, { signal }))

const prompt = await mcp.withClient((client, signal) => client.getPrompt({
  name: 'release-check',
  arguments: { version: '1.2.0' },
}, { signal }))
```

Callback nhận protocol client sống **và tín hiệu deadline của kết nối**. Hãy
chuyển tiếp tín hiệu đó — một thao tác phớt lờ nó sẽ khiến thế hệ client của nó bị
gỡ khỏi danh mục sống, đóng trong `closeTimeoutMs`, và chỉ kết nối lại theo chính
sách.

Cầu nối tự động chỉ ánh xạ **tool của MCP** sang `ToolCatalog`, vì đó mới là trừu
tượng mà vòng lặp tool của agent tiêu thụ. Tài nguyên và prompt là của bạn, để
bạn chủ động đặt vào ngữ cảnh, chẳng hạn qua `session.inject()`.

## Kết quả trở thành structured content

Một giá trị tool của SDK trở thành `structuredContent` của MCP; văn bản và ảnh
nội tuyến vẫn là nội dung kết quả hạng nhất. Theo chiều ngược lại, kết quả của
một tool MCP đến qua sự kiện `tool-result` thông thường:

```ts
for await (const event of agent.stream(input)) {
  if (event.type === 'tool-result' && event.name.startsWith('mcp__billing__')) {
    renderBillingResult(event.output, event.status)
  }
}
```

## Các chặn trên áp dụng cho tool từ xa

Tool từ xa đi qua **cùng** đường ống với tool của host, nên cùng các chặn trên áp
dụng — cộng thêm trần ở tầng truyền tải:

| Chặn trên | Phạm vi |
| --- | --- |
| `maxToolCalls` (64) | Số tool điều phối mỗi lượt chạy |
| `maxToolDurationMs` | Một lời gọi, đầu tới cuối |
| `maxToolResultBytes` | Kết quả đã tuần tự hoá được giữ |
| Trần phản hồi / danh mục / kết quả | Số byte truyền tải MCP thô |
| Deadline thao tác | Theo từng yêu cầu MCP |

Một MCP server không thể lách ngân sách lượt chạy của bạn bằng cách trả về payload
khổng lồ — nó bị chặn ở tầng truyền tải và bị chặn lần nữa ở kết quả.

## Nhiều server

```ts
const [billing, search] = await Promise.all([
  connectMcpHttp({ serverName: 'billing', url: billingUrl, logger }),
  connectMcpHttp({ serverName: 'search', url: searchUrl, logger }),
])

const agent = runtime.agent({ id: 'ops', model, instructions: '…', toolSources: [billing, search] })

try {
  await runtime.close()
} finally {
  await Promise.allSettled([billing.closeWithReport(), search.closeWithReport()])
}
```

Các giá trị `serverName` khác nhau giữ cho tên đã gắn tiền tố không nhập nhằng.
Hãy đóng mọi kết nối bạn đã mở và xem từng báo cáo.

## Đọc tiếp

- [Connecting Servers](/vi/07-mcp/connecting-servers)
- [Tool Execution](/vi/03-tools/tool-execution) — đường ống điều phối dùng chung
- [MCP Server](/vi/07-mcp/mcp-server)
