# Error Handling

Một hệ phân loại định tuyến theo `code`, được gán tại ranh giới wire và được
chính sách thử lại tiêu thụ. Mã lỗi là chuỗi ổn định, không phải enum TypeScript,
nên adapter bên thứ ba có thể phát mã riêng mà kiểu hợp không cần biết tới nó.

## Hai hình dạng lỗi

**`AgentSdkError`** là lớp được ném ra, có `code`, `message`, và `cause`.

**`ModelFailure`** là bản song sinh tuần tự hoá được của nó, mang kèm trong chunk
`finish` kết thúc thay vì bị ném:

```ts
type FinishReason =
  | { kind: 'aborted'; failure: ModelFailure }
  | { kind: 'error'; failure: ModelFailure }
  // …
```

Một luồng thất bại vẫn phải **kết thúc**. Ném ngoại lệ giữa chừng vòng lặp sẽ bỏ
mắc kẹt phần văn bản đã lắp ráp được, nên registry chuẩn hoá việc adapter ném lỗi
thành một `finish` kết thúc dạng `error` hoặc `aborted` trước khi bên tiêu thụ
nhìn thấy.

## Xử lý lỗi

```ts
import { AgentSdkError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'

try {
  const response = await agent.generate(input)
} catch (error) {
  if (error instanceof AgentSdkError) {
    switch (error.code) {
      case MODEL_ERROR_CODES.AUTH:            return promptForCredentials()
      case MODEL_ERROR_CODES.RATE_LIMIT:      return backOffAndQueue()
      case MODEL_ERROR_CODES.INVALID_REQUEST: return reportBug(error)
      default:                                return surfaceGenericFailure(error)
    }
  }
  throw error
}
```

Trong một luồng, hãy đọc sự kiện kết thúc thay vì bắt ngoại lệ:

```ts
for await (const event of agent.stream(input)) {
  if (event.type === 'error') {
    console.error(event.error.code, event.error.message)
    console.error(event.report.usage)   // usage tính tới lúc thất bại vẫn là số thật
  }
}
```

## Lỗi an toàn để gửi hỗ trợ

`SupportSafeError` là một phép chiếu đã làm sạch, dành cho phiếu hỗ trợ và việc
lan truyền giữa các dịch vụ. Nó mang mã lỗi và danh tính tương quan, nhưng không
mang thông tin xác thực, endpoint, header, hay văn bản thô của nhà cung cấp.

Bề mặt server MCP và A2A mặc định trả lỗi nội bộ dạng chung. Chỉ đặt
`exposeInternalErrors: true` cho một bề mặt chẩn đoán đáng tin cậy.

## Xung đột danh tính năng lực

`CapabilityIdentityConflict` phát sinh khi hai năng lực cùng giành một danh tính
— hai plugin provider trên một tuyến, hai tool source công bố cùng một tên tool
đã gắn tiền tố, hoặc một đăng ký exporter trùng lặp. Xung đột runtime thông
thường thất bại **trước khi hoàn tất thiết lập**, không phải tới lúc dùng lần đầu.

---

## Toàn bộ mã lỗi

## Lỗi model — gán tại ranh giới wire

| Mã | Nguồn kiểu HTTP | Ý nghĩa | Thử lại mặc định | Cách xử lý thường gặp |
| --- | --- | --- | --- | --- |
| `AUTH` | 401 / 403 | Thông tin xác thực bị từ chối. | ✗ | Làm mới hoặc thay thông tin xác thực. |
| `RATE_LIMIT` | 429 | Giới hạn tần suất tạm thời. | ✓ | Lùi lại; tăng `maxRetries` hoặc xếp hàng đợi. |
| `SERVER` | 5xx | Lỗi phía nhà cung cấp. | ✓ | Thử lại; báo nhà cung cấp nếu kéo dài. |
| `TIMEOUT` | — | Không có output lâu hơn chặn trên khi rảnh. | ✓ | Tăng chặn trên, hoặc kiểm tra sức khoẻ nhà cung cấp. |
| `TRANSPORT` | — | Yêu cầu không bao giờ hoàn tất ở tầng mạng. | ✓ | Kiểm tra đường ra, DNS, proxy, TLS. |
| `ABORTED` | — | Tín hiệu của caller đã huỷ yêu cầu. | ✗ | Bình thường khi chủ động huỷ. |
| `MODEL_TEARDOWN_TIMEOUT` | — | Một adapter phớt lờ tín hiệu huỷ và có thể vẫn giữ công việc sống. | ✗ | **Khiếm khuyết của adapter.** Sửa việc chuyển tiếp signal. |
| `INVALID_REQUEST` | 400 / 413 | Nhà cung cấp từ chối vì yêu cầu sai định dạng. | ✗ | Sửa yêu cầu; thường do payload quá lớn. |
| `MALFORMED_RESPONSE` | — | Phản hồi đúng định dạng nhưng không phân tích được. | ✓ | Giao thức trôi lệch — xem changelog của nhà cung cấp. |
| `STREAM_CLOSED` | — | Thân phản hồi kết thúc trước dấu hiệu kết thúc. | ✓ | Thường do mạng đứt giữa chừng luồng. |
| `UNSUPPORTED_CONTENT` | — | Nội dung mà model đã chọn không nhận. | ✗ | Chọn model có phương thức tương ứng. |
| `UNSUPPORTED_OPTION` | — | Một tuỳ chọn mà nhà cung cấp này không có tương đương. | ✗ | Bỏ tuỳ chọn hoặc đổi nhà cung cấp. |
| `UNKNOWN` | — | Không phân loại được. Coi là không thử lại. | ✗ | Xem `cause`; báo lỗi nếu tái hiện được. |

Còn hai mã nữa bị loại khỏi thử lại theo mặc định vì chúng thất bại y hệt ở mọi
lần thử: `QUOTA` và `CONTEXT_WINDOW_EXCEEDED`.

> `CONTEXT_WINDOW_EXCEEDED` là trường hợp đặc biệt: khi nhà cung cấp **xác nhận**
> nó, cơ chế nén tự động có thể nén rồi thử lại một lần (`maxOverflowRetries`).

## Lỗi registry — phát sinh trước mọi I/O tới nhà cung cấp

Đây là lỗi ghép nối và kiểm tra hợp lệ. Không lỗi nào trong số này đã chạm tới
mạng.

| Mã | Ý nghĩa | Cách xử lý thường gặp |
| --- | --- | --- |
| `NO_ADAPTER` | Không có adapter nào đăng ký cho tuyến được yêu cầu. | Đăng ký provider, hoặc sửa `model.provider`. |
| `DUPLICATE_ADAPTER` | Hai đăng ký cùng giành một tuyến. | Cho một cái id/tuyến thực thể riêng, tường minh. |
| `INVALID_ADAPTER` | Adapter không qua được kiểm tra hợp đồng. | Chạy bộ conformance của testkit. |
| `INVALID_CATALOG` | Ảnh chụp danh mục model không hợp lệ. | Sửa output của `listModels` trong adapter. |
| `INVALID_MODEL_INFO` | Năng lực model khai báo không nhất quán. | Kiểm tra cửa sổ ngữ cảnh so với giới hạn output. |
| `UNSUPPORTED_REASONING_EFFORT` | Model không khai báo mức nỗ lực được yêu cầu. | Dùng mức đã khai báo, hoặc sửa khai báo. |
| `UNSUPPORTED_NATIVE_TOOL` | Model không khai báo native tool được yêu cầu. | Bỏ native tool, hoặc đổi model. |
| `OUTPUT_TOKEN_LIMIT_EXCEEDED` | `maxTokens` vượt trần output cứng của model. | Giảm `maxTokens`. |
| `INVALID_PREPARED_CALL` | Một prepared call bị sửa hoặc dùng lại qua các thế hệ. | Đừng cache một prepared call. |
| `REGISTRATION_DISPOSED` | Đăng ký provider bị gỡ trong lúc đang dùng. | Một lượt chạy sống lâu hơn `runtime.close()`. |

## Lỗi tool

Tool thất bại không ném ngoại lệ vào mã của bạn — chúng trở thành một
`ToolFailure` mà model nhìn thấy:

| Mã | Nguyên nhân |
| --- | --- |
| `INVALID_ARGUMENTS` | `parse` ném lỗi. Model có thể tự sửa. |
| — (`status: 'rejected'`) | Broker phê duyệt đã từ chối lời gọi. |
| — (`status: 'aborted'`) | Lượt chạy bị huỷ trong lúc gọi. |
| — (`status: 'failed'`) | `execute` ném lỗi. |

`concludesTurn` có kiểu `never` khi thất bại là chủ ý: một tool bị từ chối hoặc
bị sập không được phép âm thầm dừng công việc mà người dùng đã yêu cầu.

## Các kiểu lỗi khác

| Kiểu | Mục đích |
| --- | --- |
| `AgentSdkError` | Lớp được ném ra — `code`, `message`, `cause`. |
| `ModelFailure` | Bản song sinh tuần tự hoá được, mang kèm trong `finish` kết thúc. |
| `SupportSafeError` | Phép chiếu đã làm sạch, dành cho phiếu hỗ trợ và lan truyền giữa dịch vụ. |
| `CapabilityIdentityConflict` | Hai năng lực cùng giành một danh tính. Thất bại trước khi hoàn tất thiết lập. |
| `McpConnectionError` | Mang giai đoạn kết nối và một báo cáo đóng có chặn trên. |
| `ProviderConformanceError` | Mang báo cáo conformance đã đóng băng. |
| `CodexRefreshError` | Mang một `RefreshFailureKind`. |
| `BrowserObservationError` / `NodeObservationError` | Riêng cho từng exporter, có enum mã riêng. |
| `OpenTelemetryBridgeError` | Lỗi cấu hình hoặc ánh xạ của cầu nối. |

## Đọc tiếp

- [Troubleshooting](/vi/10-advanced/troubleshooting) — triệu chứng tới nguyên nhân
- [Tool Error Handling](/vi/03-tools/error-handling) — hợp đồng ở mức tool
- [Providers](/vi/09-providers/)
