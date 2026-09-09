# Native Tools

Tool do nhà cung cấp thực thi được truyền **tách riêng** khỏi hàm của host, nên
bộ lập lịch không bao giờ cố chạy chúng.

## Khai báo native tool

```ts
import { ReasoningEffortId, runAgent } from '@ai-agent-sdk/core'

for await (const event of runAgent({
  mode: 'basic',
  registry,
  history,
  config: {
    provider: 'openai',
    model: 'gpt-5.6',
    reasoningEffort: ReasoningEffortId('medium'),
  },
  nativeTools: [
    { type: 'native', name: 'web-search', allowedDomains: ['openai.com'] },
    { type: 'native', name: 'image-generation', format: 'webp', partialImages: 2 },
  ],
})) {
  if (event.type === 'image-delta') renderPreview(event.data, event.mediaType)
  if (event.type === 'assistant-native-tool') renderTraceNode(event.call.id, event.call.name)
}
```

Trên một định nghĩa hoặc runtime agent, cũng là trường đó:

```ts
runtime.agent({
  id: 'researcher',
  instructions: 'Gather evidence before answering.',
  model: { provider: 'openai', id: 'gpt-5.6' },
  tools: [readProjectFile],                                     // hàm của host
  nativeTools: [{ type: 'native', name: 'web-search' }],        // nhà cung cấp thực thi
})
```

Tool của host chạy qua bộ lập lịch của SDK. Native tool chạy ở phía nhà cung cấp
và vẫn sinh ra sự kiện có tương quan cho giao diện.

## Hỗ trợ của nhà cung cấp được kiểm tra trước khi gửi

Adapter khai báo dung lượng ngữ cảnh tổng hợp, giới hạn output mặc định và cứng,
các mức nỗ lực suy luận, các phương thức, và native tool được hỗ trợ.
`ModelRegistry` chụp lại các năng lực đó và từ chối lựa chọn bất khả thi **trước**
khi có I/O tới nhà cung cấp:

| Lựa chọn | Bị từ chối với |
| --- | --- |
| Mức nỗ lực suy luận không hỗ trợ | `UNSUPPORTED_REASONING_EFFORT` |
| Native tool không hỗ trợ | `UNSUPPORTED_NATIVE_TOOL` |
| `maxTokens` vượt trần cứng | `OUTPUT_TOKEN_LIMIT_EXCEEDED` |

## Mỗi nhà cung cấp hỗ trợ gì

| Năng lực | Responses (`openai`, `codex`) | Anthropic Messages |
| --- | --- | --- |
| Web search native | ✓ | ✓ (giữ trạng thái phát lại kết quả/trích dẫn đã mã hoá) |
| Sinh ảnh native | ✓ | ✗ — lỗi `INVALID_REQUEST` có kiểu |
| Ảnh đầu vào qua URL / base64 | ✓ | ✓ |
| Ảnh đầu vào qua `fileId` | ✓ | ✗ — lỗi `INVALID_REQUEST` có kiểu |
| `detail: 'original'` | ✓ | ✗ |

Anthropic báo các lựa chọn không hỗ trợ thành lỗi có kiểu, chứ không âm thầm bỏ
qua.

## Ảnh đầu vào

Ảnh đầu vào dùng cùng `ImageBlock` trong message của user:

```ts
const message = createUserMessage({
  content: [
    { type: 'text', text: 'Biểu đồ này sai chỗ nào?' },
    { type: 'image', source: { kind: 'url', url: 'https://example.com/chart.png' } },
  ],
  source: { kind: 'user' },
})
```

Nguồn URL và base64 dùng được với mọi nhà cung cấp. Registry chỉ chiếu bỏ ảnh đầu
vào với những model khai báo **tường minh** là không có phương thức thị giác — nó
không đoán.

## Ảnh được sinh ra

Ảnh sinh ra đến hai lần, và đó là chủ ý:

1. **Từng phần** qua sự kiện `image-delta`, để xem trước trực tiếp.
2. **Có thẩm quyền** trong `native-tool-call.content` cuối cùng.

```ts
for await (const event of agent.stream('Vẽ sơ đồ hệ thống.')) {
  if (event.type === 'image-delta') {
    renderPreview(event.data, event.mediaType, event.partialIndex)
  }
}

const response = await handle.result
// response.report / message assistant cuối cùng mang bản ảnh có thẩm quyền.
```

Hãy vẽ bản xem trước từ `image-delta`; lưu trữ thì lấy từ message cuối cùng.
`partialIndex` cho biết bạn đang ở khung thứ mấy khi có cấu hình `partialImages`.

## Cấu hình có kiểu được mang xuyên suốt

Cấu hình web search native và sinh ảnh là **có kiểu và mở rộng theo kiểu hợp
nhất**, và nó được mang từ định nghĩa agent trên Edge đi thẳng vào tầng truyền
tải của provider. Mỗi loại phát ra sự kiện tiến độ riêng — bạn không phải tự
tương quan một sự kiện "tool đã bắt đầu" chung chung theo tên.

## Đọc tiếp

- [Tham chiếu API `Types`](/vi/13-api-reference/types) — `ImageBlock`, `StreamChunk`
- [Providers](/vi/09-providers/) — mỗi nhà cung cấp hỗ trợ gì
