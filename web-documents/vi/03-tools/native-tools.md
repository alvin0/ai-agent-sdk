# Native Tools

Tool do nhà cung cấp thực thi được truyền **tách riêng** khỏi hàm của host, nên
bộ lập lịch không bao giờ cố chạy chúng.

## Khai báo native tool

```ts
import { ReasoningEffortId, runAgent } from '@alvin0/ai-agent-sdk-core'

for await (const event of runAgent({
  mode: 'basic',
  registry,
  history,
  config: {
    provider: 'openai',
    model: 'gpt-6-luna',
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
  model: { provider: 'openai', id: 'gpt-6-luna' },
  tools: [readProjectFile],                                     // hàm của host
  nativeTools: [{ type: 'native', name: 'web-search' }],        // nhà cung cấp thực thi
})
```

Tool của host chạy qua bộ lập lịch của SDK. Native tool chạy ở phía nhà cung cấp
và vẫn sinh ra sự kiện có tương quan cho giao diện.

```text
   host của bạn                              phía nhà cung cấp
   ─────────────────────────────             ─────────────────────────
   tools: [readProjectFile]                  nativeTools: [web-search]
        │                                          │
        │  model gọi                               │  model gọi
        ▼                                          ▼
   bộ lập lịch SDK                           nhà cung cấp tự chạy
   parse → execute → render                  (SDK không thấy thân hàm)
        │                                          │
        └────► tool-call / tool-result             └────► assistant-native-tool
                (bạn kiểm soát)                            (chỉ tiến độ + kết quả)
```

## Hỗ trợ của nhà cung cấp được kiểm tra trước khi gửi

Adapter khai báo dung lượng ngữ cảnh tổng hợp, giới hạn output mặc định và cứng,
các mức nỗ lực suy luận, các phương thức, và native tool được hỗ trợ.
`ModelRegistry` chụp lại các năng lực đó và từ chối lựa chọn bất khả thi **trước**
khi có I/O tới nhà cung cấp:

| Lựa chọn | Bị từ chối với |
| --- | --- |
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
| Tài liệu (PDF) qua URL / base64 / `fileId` | ✓ | ✓ |
| Trích dẫn tài liệu (`citations: true`) | ✗ — bỏ qua | ✓ |

Anthropic báo các lựa chọn không hỗ trợ thành lỗi có kiểu, chứ không âm thầm bỏ
qua.

Gemini Interactions chấp nhận tài liệu đầu vào qua base64 và qua URI (URL từ xa
hoặc uri của Files API) trên cùng điều kiện.

## Loại nội dung web search (0.1.12)

```ts
nativeTools: [{
  type: 'native', name: 'web-search', searchContentTypes: ['text', 'image'],
}]
```

Bỏ trống tương đương tìm văn bản. Responses gửi `search_content_types`; Codex
chấp nhận trường này. Anthropic Messages và Gemini Interactions báo
`INVALID_REQUEST` nếu yêu cầu tìm ảnh, không âm thầm chỉ tìm văn bản.

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

## Tài liệu (PDF) đầu vào

PDF là một `DocumentBlock`, không phải ảnh. Nhà cung cấp đọc nó bằng thị giác
thuần: mỗi trang được render thành ảnh kèm phần text trích xuất, nên biểu đồ và
bảng đều được giữ lại. Việc tách trang do nhà cung cấp lo.

```ts
const message = createUserMessage({
  content: [
    { type: 'document',
      source: { kind: 'base64', mediaType: 'application/pdf', data: base64Pdf },
      filename: 'inquiry.pdf',
      pages: 72 },
    { type: 'text', text: 'Tóm tắt các mục còn tồn.' },
  ],
  source: { kind: 'user' },
})
```

### Modality chưa biết và khai báo tường minh

Bỏ trống `inputModalities` nghĩa là chưa biết và vẫn cho phép gửi PDF. Chỉ
project PDF thành văn bản khi cấu hình model, route hoặc agent đã khai báo
modality nhưng không có `document`. Có thể sửa khai báo discovery thiếu:

```ts
codexNodeAdapter({
  authStore,
  models: [{ id: 'gpt-6-luna', inputModalities: ['text', 'image', 'document'] }],
})
```

Gemini không cần khai báo chỉ để cho phép PDF. Dùng `documentPolicy: 'strict'`
để báo `UNSUPPORTED_DOCUMENT_INPUT` khi có khai báo không tương thích, thay vì
project tài liệu thành văn bản.

### `pages` và chi phí token

Nhà cung cấp tính tiền PDF theo trang, nên `pages` là thứ giúp compaction định giá
đúng. Đo trên một PDF 72 trang thật: OpenAI tính 214.019 input token (~2.970/trang)
và Gemini 38.350 (~533/trang). Có `pages`, ước lượng lệch dưới 1%; không có,
estimator giả định 8 trang và tính thiếu nghiêm trọng với tài liệu dài. Đây là
metadata cục bộ — không adapter nào serialize nó.

## Ảnh được sinh ra

Ảnh sinh ra đến hai lần, và đó là chủ ý:

1. **Từng phần** qua sự kiện `image-delta`, để xem trước trực tiếp.
2. **Có thẩm quyền** trong `native-tool-call.content` cuối cùng.

```ts
// Low-level AgentEvent stream; registry/history/config are supplied by the host.
for await (const event of runAgent({
  mode: 'basic', registry, history,
  config: { provider: 'openai', model: 'gpt-6-luna' },
  nativeTools: [{ type: 'native', name: 'image-generation', partialImages: 2 }],
})) {
  if (event.type === 'image-delta') renderPreview(event.data, event.mediaType, event.partialIndex)
  if (event.type === 'assistant-message') storeFinalImages(event.message.content)
}
```

Trong basic mode, câu trả lời chỉ có ảnh vẫn hợp lệ, kể cả final round do hết
budget. Deep mode vẫn cần văn bản để hoàn tất. Lưu bytes ảnh từ sự kiện tầng
thấp `assistant-message`: nếu ảnh base64 vượt giới hạn history, bản ghi sẽ bỏ
ảnh và giữ số lượng trong `omittedImages`; ảnh trực tiếp được thay bằng ghi chú
commentary. Entry vẫn quá lớn vì nội dung khác tiếp tục báo lỗi.
Responses replay ảnh từ `content`, có fallback cho `providerState.result` cũ;
state mới không lưu thêm bản sao base64.

Request image generation mặc định cho phép 12 MiB **ký tự** mỗi SSE event.
`maxSseEventChars` do host đặt được ưu tiên; `maxResponseBytes` vẫn giới hạn toàn
response. Giới hạn transport không thay thế giới hạn history.

## Cấu hình có kiểu được mang xuyên suốt

Cấu hình web search native và sinh ảnh là **có kiểu và mở rộng theo kiểu hợp
nhất**, và nó được mang từ định nghĩa agent trên Edge đi thẳng vào tầng truyền
tải của provider. Mỗi loại phát ra sự kiện tiến độ riêng — bạn không phải tự
tương quan một sự kiện "tool đã bắt đầu" chung chung theo tên.

## Đọc tiếp

- [Tham chiếu API `Types`](/vi/13-api-reference/types) — `ImageBlock`, `StreamChunk`
- [Providers](/vi/09-providers/) — mỗi nhà cung cấp hỗ trợ gì
