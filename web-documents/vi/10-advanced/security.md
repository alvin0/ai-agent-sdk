# Security

## Mặc định loại trừ những gì

Quan sát vận hành mặc định `content: 'none'`. Bị loại trừ trừ khi bạn bật tường
minh:

- Token OAuth và API key
- Cookie
- Thông tin tài khoản
- Header ngoài danh sách cho phép
- Nội dung prompt và completion

Số token bị thiếu vẫn để là `missing` hoặc `partial` — không bao giờ là số 0 bịa
ra.

## Chính sách nội dung

```ts
observability: {
  content: 'none',              // 'none' | 'metadata'
  includeErrorStacks: false,
  redactors: [myRedactor],
}
```

`content: 'metadata'` thêm metadata cấu trúc — số block, kích thước, kiểu — mà
không kèm phần thân. Thân prompt và completion đòi một đường rủi ro cao được bật
tường minh.

Các hàm `ContentRedactor` tuỳ biến chạy bên trong bus, trước khi bất kỳ exporter
nào nhìn thấy một sự kiện.

## Công cụ chẩn đoán wire chính xác

Đây là một **năng lực rủi ro cao riêng biệt**, không phải một mức độ chi tiết
log. Nó từ chối khởi tạo trừ khi đặt **cả hai** cờ:

```ts
import { createDailyJsonlRequestLogger } from '@alvin0/ai-agent-sdk-observability-node/diagnostic'

registry.registerAdapter(['codex'], codexAdapter({
  requestLogger: createDailyJsonlRequestLogger({
    content: 'full',
    allowWireBodies: true,
  }),
}))
```

| Hành vi | Chi tiết |
| --- | --- |
| Vị trí | Tệp riêng tư, duy nhất, dưới `.providers/<provider>/wire/` |
| Có che | Thông tin xác thực, cookie, id tài khoản |
| **Không** che | Thân yêu cầu — prompt và kết quả tool chính là mục đích |
| Git | `.providers/` đã git-ignore, nhưng vẫn là dữ liệu cục bộ nhạy cảm |

Harness thủ công để tắt tính năng này trừ khi truyền `--logs` tường minh.

Để chẩn đoán production thông thường, hãy dùng bus quan sát có cấu trúc.

## Xử lý thông tin xác thực

Thông tin xác thực luôn được **tiêm vào**. Các package provider Universal không
bao giờ đọc biến môi trường hay tệp.

```ts
openAiPlugin({ apiKey: () => secretStore.get('openai') })              // mọi runtime
openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })              // Node
codexPlugin({ authStore: mySecretManagerStore })                       // mọi runtime
codexNodeProviderPlugin()                                              // kho tệp trên Node
```

Nguồn thông tin xác thực là **lười**, nhận tín hiệu huỷ của thao tác model, và
được **mượn** — core không bao giờ đóng chúng.

### Cô lập token Codex

Token nằm ở `.providers/.codex/auth.json` bên dưới `process.cwd()`, **không** nằm
ở `~/.codex/auth.json` của Codex CLI.

Việc cô lập này là có chủ ý. Refresh token OAuth chỉ dùng một lần và xoay vòng
sau mỗi lần làm mới, nên hai chương trình dùng chung một tệp xác thực rồi sẽ
tranh chấp — chương trình làm mới thứ hai phát lại một token đã tiêu và bạn bị
đăng xuất âm thầm khỏi Codex CLI thật.

Việc ghi dùng compare-and-swap dưới một khoá ghi liên tiến trình, một tệp tạm
riêng tư cùng thư mục, đồng bộ tệp, đổi tên nguyên tử, chế độ `0600`, và đồng bộ
thư mục. **Symlink tới tệp thông tin xác thực bị từ chối.**

## Chính sách endpoint

SDK trung lập với chính sách triển khai và chấp nhận endpoint chuẩn trừ khi host
bật ràng buộc. Hãy chọn theo ranh giới tin cậy của bạn.

**Client MCP HTTP:**

```ts
createMcpHttpClient({
  url,
  allowedOrigins: ['https://tools.example.com'],
  requireHttps: true,
  allowPrivateNetwork: false,
  // chặn trên phản hồi / danh mục / kết quả, deadline thao tác
})
```

**Client A2A:**

```ts
linkA2AAgent(team, {
  baseUrl,
  requireHttps: true,
  allowPrivateNetwork: false,
  allowRedirects: false,
  allowedOrigins: ['https://security-agent.example.com'],
})
```

**Exporter telemetry HTTPS:** bắt buộc HTTPS trừ endpoint test localhost/loopback
được bật tường minh. Redirect và phản hồi khác origin bị từ chối.

## Khi tự host một MCP server

`createSdkMcpHandler()` nhận `authInfo` đã kiểm tra sẵn nhưng **không** xác thực
header của yêu cầu. Hãy kiểm tra thông tin xác thực và quyền truy cập tài nguyên
ở framework host **trước** khi gọi `handler.fetch()`.

Với listener HTTP cục bộ trên Node, hãy đặt `localhostHostValidation()` và
`localhostOriginValidation()` — hoặc danh sách cho phép tường minh — **trước**
handler, để bảo vệ khỏi DNS rebinding và các origin trình duyệt không mong muốn.

Lỗi nội bộ mặc định là dạng chung. Chỉ đặt `exposeInternalErrors: true` cho một
bề mặt chẩn đoán đáng tin cậy.

## Khi tự host một A2A server

Xác thực là chính sách của host. Chỉ đặt `requireAuthenticated: true` khi tầng
truyền tải bao quanh cung cấp một `User` đã xác thực.

`sessionOwner(context)` chọn ranh giới cô lập — người dùng, thiết bị, không gian
làm việc, API client. Mỗi cặp `(chủ sở hữu session, contextId A2A)` giữ một
session, nên một task trong ngữ cảnh thuộc sở hữu này không bao giờ thấy lịch sử
của chủ sở hữu khác.

Lược đồ bảo mật trong Agent Card được truyền qua khi có cấu hình, nhưng SDK này
**không** tự bịa ra và cũng không tự cưỡng chế chúng.

## Lỗi an toàn để gửi hỗ trợ

`SupportSafeError` là một phép chiếu đã làm sạch, dành cho phiếu hỗ trợ và lan
truyền giữa các dịch vụ. Nó mang mã lỗi và danh tính tương quan, nhưng không mang
thông tin xác thực, endpoint, header, hay văn bản thô của nhà cung cấp.

## Phần nào vẫn thuộc về bạn

Package này là một SDK, không phải control plane cho production. Dịch vụ nhúng
vẫn chịu trách nhiệm về:

- middleware xác thực
- kho lưu bền
- giới hạn tần suất
- cưỡng chế mạng/DNS
- quản lý secret
- triển khai
- backend observability

## Đọc tiếp

- [Observability](/vi/10-advanced/observability)
- [Permissions](/vi/03-tools/permissions)
- [Chính sách phụ thuộc](/vi/14-project/dependency-policy)
