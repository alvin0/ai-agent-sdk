# Agent SDK là gì?

AI Agent SDK là SDK TypeScript để xây dựng AI agent, trung lập với nhà cung cấp
model. Nó cho bạn một mô hình message, một giao thức streaming, và một hệ phân
loại lỗi dùng chung cho Anthropic Messages API, OpenAI Responses API, và endpoint
Codex chạy nền ChatGPT.

```ts
import { createAgentRuntime } from '@ai-agent-sdk/core'
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

const runtime = await createAgentRuntime({ providers: [openAiPlugin({ apiKey })] })
const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'gpt-5.4' },
})

console.log((await agent.generate('Giải thích cây Merkle trong một câu.')).text)
await runtime.close()
```

## Nó cho bạn cái gì

**Một bộ từ vựng trung lập.** Message, content block, stream chunk, số token,
lý do kết thúc, và mã lỗi được định nghĩa một lần trong `@ai-agent-sdk/core`.
Adapter là tầng duy nhất biết định dạng wire; mọi thứ phía trên nói bằng từ vựng
trung lập.

**Một vòng lặp agent thật.** Lịch sử bất biến, điều phối tool theo giai đoạn,
lập lịch song song có chặn trên, phê duyệt, checkpoint bền vững, câu trả lời cuối
bắt buộc, và luồng sự kiện có backpressure — không phải một vòng `while` bọc
quanh lời gọi chat completion.

**Package theo năng lực, không phải khối nguyên.** Hai mươi mốt package, mỗi package
khai báo một tầng runtime. Một Edge worker cài ba package; một harness lập trình
trên Node cài sáu. Import một năng lực Node chỉ nâng tầng đồ thị mà ứng dụng đó
chạm tới — không đánh tráo sang một harness khác.

**Chỉ streaming, theo thiết kế.** Không có đường không-streaming riêng để có thể
trôi lệch khỏi đường streaming. Khi bạn cần một giá trị duy nhất, bạn `await`
message đã lắp ráp xong.

## Nó cố ý không phải cái gì

- **Không phải control plane.** Nó cung cấp trạng thái có chặn trên, TTL, huỷ,
  làm sạch lỗi, và hook chính sách. Middleware xác thực, kho lưu bền, giới hạn
  tần suất, secret, triển khai, và backend telemetry vẫn thuộc về dịch vụ nhúng.
- **Không phải hệ thống tenancy hay tính tiền.** Mọi giới hạn là hàng rào tài
  nguyên trung lập với triển khai, không phải khái niệm sản phẩm.
- **Không áp đặt model.** `model` là bắt buộc và không có giá trị mặc định. Danh
  mục model của nhà cung cấp thay đổi nhanh hơn nhịp phát hành của package này,
  nên bất kỳ mặc định dựng sẵn nào rồi cũng sẽ trỏ vào một model đã ngừng phục vụ.
- **Không phải container plugin.** Không có mảng `plugins` bắt-tất, không có
  facade Node toàn cục. Năng lực là các slot có kiểu trên phép ghép nối tường minh.
- **Không phải workflow engine khai báo.** Không có `defineWorkflow()`. Agent,
  tool, team, và hook chính là các nguyên thuỷ điều phối — xem
  [Workflows](/vi/06-workflows/).

## Hình dạng của mọi chương trình

```ts
// 1. Ghép runtime từ các package năng lực tường minh.
const runtime = await createAgentRuntime({ providers: [/* … */] })

// 2. Gắn agent: danh tính, chỉ dẫn, tuyến model, năng lực.
const agent = runtime.agent({ id: 'assistant', instructions: '…', model })

// 3. Chạy — một phát, hoặc dưới dạng luồng sự kiện trực tiếp.
const response = await agent.generate('…')

// 4. Đóng và đọc bằng chứng.
const report = await runtime.close()
```

Mọi thứ còn lại trong tài liệu này là biến thể của bốn bước đó.

## Đọc tiếp

- [Getting Started](/vi/01-introduction/getting-started) — SDK phân tầng thế nào,
  và bạn nên dùng tầng nào.
- [Cài đặt](/vi/01-introduction/installation) — chọn tập runtime nhỏ nhất mà môi
  trường triển khai của bạn cần.
- [Quick Start](/vi/01-introduction/quick-start) — một agent chạy được với một tool.
