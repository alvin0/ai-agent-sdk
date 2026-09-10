# Custom Provider

Có ba mức công sức, và phần lớn endpoint chỉ cần mức đầu tiên.

## Mức 1 — Chỉ cấu hình

Với bất kỳ endpoint nào nói một giao thức mà package này đã hiện thực, việc thêm
vào chỉ là **cấu hình**. Không tệp mới, không thư mục mới, không sửa SDK.

```ts
import { openAiResponsesProtocol } from '@alvin0/ai-agent-sdk-protocol-responses'
import { createHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node/env'

registry.registerAdapter(['openrouter'], createHttpProvider({
  displayName: 'OpenRouter',
  protocol: openAiResponsesProtocol,
  baseUrl: 'https://openrouter.ai/api/v1',
  auth: { kind: 'bearer', token: envCredential('OPENROUTER_API_KEY') },
}))
```

Hiện có sẵn ba giao thức:

| Giao thức | Package |
| --- | --- |
| OpenAI Responses / Codex | `@alvin0/ai-agent-sdk-protocol-responses` |
| Anthropic Messages | `@alvin0/ai-agent-sdk-protocol-anthropic-messages` |
| Gemini Interactions | `@alvin0/ai-agent-sdk-protocol-gemini-interactions` |

Cả ba đều Universal, không sở hữu endpoint hay thông tin xác thực, và chỉ phụ
thuộc `@alvin0/ai-agent-sdk-core`.

### OAuth không cần kế thừa lớp

`auth: { kind: 'dynamic' }` bao trọn các thông tin xác thực tự làm mới. Provider
`codex` dựng sẵn bản thân nó cũng chỉ là cấu hình đặt trên giao thức Responses.

## Mức 2 — Plugin provider cho runtime

Với một package bạn định phát hành, hãy bọc adapter trong một plugin có giao dịch
để runtime kích hoạt và gỡ đăng ký được:

```ts
import { createRuntimeHttpProvider } from '@alvin0/ai-agent-sdk-provider-http'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'

export const myProviderPlugin = defineModelProviderPlugin({
  id: 'my-provider',
  displayName: 'My Provider',
  routes: ['my-provider'],
  setup(registrar) {
    // Registrar nhận adapter TRƯỚC, rồi mới tới routes — ngược thứ tự với
    // ModelRegistry.registerAdapter().
    registrar.registerAdapter(createRuntimeHttpProvider({
      displayName: 'My Provider',
      protocol: openAiResponsesProtocol,
      baseUrl: 'https://api.example.com/v1',
      auth: { kind: 'bearer', token: options.apiKey },
    }), ['my-provider'])
    return undefined
  },
})
```

Hai overload `registerAdapter` nhận tham số theo **thứ tự ngược nhau**, và không
gì ngoài type checker sẽ nhắc bạn:

```ts
registry.registerAdapter(routes, adapter)     // ModelRegistry: routes trước
registrar.registerAdapter(adapter, routes?)   // registrar của plugin: adapter trước
```

Plugin khai báo yêu sách tuyến của nó ngay từ đầu, nên xung đột runtime thông
thường thất bại **trước khi hoàn tất thiết lập**, không phải tới lúc dùng lần
đầu. Handle của registrar có phạm vi theo lần kích hoạt: middleware hay hành động
dọn dẹp đăng ký trong lúc setup sẽ bị gỡ cùng với đăng ký đó.

Các factory provider là hoàn chỉnh và **trơ** — tạo ra một cái không gây I/O nào.
Id tuỳ biến đồng thời là tuyến mặc định, nhờ đó giấu được phần hỗ trợ HTTP/giao
thức bắc cầu mà không mất các tuỳ chọn của provider.

## Mức 3 — Kế thừa `HttpModelAdapter`

Chỉ kế thừa khi các sự kiện về kết nối **không thể biểu diễn bằng dữ liệu** — ví
dụ ký yêu cầu trên phần thân, như AWS SigV4.

Ngay cả khi đó, bạn cung cấp bốn thứ và kế thừa mọi thứ còn lại:

| Bạn hiện thực | Lớp cơ sở sở hữu |
| --- | --- |
| `connect` | `stream()` |
| `endpointPath` | Header quy kết |
| `buildBody` | Xử lý abort |
| `translate` | Gán mã lỗi |

Chính cách chia đó khiến một provider không thể vô tình tự viết vòng lặp fetch
riêng rồi quên header quy kết, xử lý sai abort, hoặc bịa mã lỗi.

Với provider hoàn toàn không dùng HTTP, bề mặt tác giả `ModelAdapter` trực tiếp
vẫn công khai, kèm handle registrar theo phạm vi kích hoạt và middleware.

## Khai báo năng lực model

Một adapter có thể khai báo dung lượng ngữ cảnh tổng hợp, giới hạn output mặc
định và cứng, các mức nỗ lực suy luận, các phương thức, và native tool được hỗ
trợ. `ModelRegistry` kiểm tra và chụp lại chúng, rồi từ chối lựa chọn bất khả thi
trước khi gửi đi.

Khai báo chính xác chính là điều khiến việc nén ngữ cảnh tự động dành đúng khoảng
output, và biến một lựa chọn không hỗ trợ thành lỗi `UNSUPPORTED_*` rõ ràng thay
vì một mã 400 từ nhà cung cấp.

## Viết một giao thức mới

Package giao thức sở hữu lược đồ wire, bộ tuần tự hoá yêu cầu, bộ dịch luồng, và
bản ghi phương ngữ. Nó **không** sở hữu endpoint, thông tin xác thực, hiện thực
fetch, truy cập hệ tệp, hay API của Node.

Hai ràng buộc đáng biết:

- **Tuần tự hoá là đồng bộ và chỉ dùng đối tượng JSON**, có kiểm tra và tách rời
  trước khi gửi với chặn trên, và một thân yêu cầu đã mã hoá được dùng lại qua
  các lần thử lại.
- **Phân tích SSE là cục bộ theo provider và ghim chính xác**, có kiểm tra
  media-type, chặn trên theo byte/chunk/sự kiện, nhịp sống bằng comment-heartbeat,
  rút cạn tuyến tính, và bắt buộc đúng một sự kiện kết thúc.

## Kiểm chứng bằng bộ conformance

`@alvin0/ai-agent-sdk-testkit` đưa một fixture provider mới qua kiểm tra marker, xung đột
tuyến, rollback, streaming, usage, thử lại, huỷ, hành vi danh mục, thất bại luồng
có chặn trên, quyền riêng tư/tương quan của quan sát, kiềm chế lỗi khi dọn dẹp,
và tính bất biến khi dọn dẹp lặp lại.

```ts
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'

const report = await runProviderConformanceSuite(fixture)
```

Nó trả về một báo cáo có cấu trúc đã đóng băng, và ném `ProviderConformanceError`
mang chính báo cáo đó khi có kiểm tra nào thất bại — nhờ vậy Vitest, `node:test`,
hoặc harness khác dùng được mà không cần phụ thuộc adapter.

Thông tin xác thực, endpoint, và lỗi thô của nhà cung cấp không được đưa vào ảnh
chụp điều khiển hay báo cáo.

## Đọc tiếp

- [Protocols](/vi/09-providers/protocols) — các giao thức wire có sẵn
- [Gemini](/vi/09-providers/gemini) — provider chỉ dùng Interactions
- [Đường ống adapter](/vi/11-internals/adapter-pipeline)
