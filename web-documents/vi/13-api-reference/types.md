# Types

## Content block

Trường `content` của một message là mảng các block có kiểu. Có bảy loại block:

| Block | Mục đích |
| --- | --- |
| `TextBlock` | Văn bản hiển thị. Text của assistant còn mang `AssistantTextPhase`. |
| `ReasoningBlock` | Tóm tắt hoặc nội dung suy luận mà nhà cung cấp thực sự phát ra. |
| `ImageBlock` | Ảnh đầu vào hoặc ảnh được sinh ra. |
| `DocumentBlock` | PDF đầu vào, được nhà cung cấp đọc bằng thị giác thuần. |
| `ToolCallBlock` | Một tool của host mà bộ lập lịch phải thực thi. |
| `ToolResultBlock` | Kết quả của một lời gọi tool host, liên kết theo call id. |
| `NativeToolCallBlock` | Tool do nhà cung cấp thực thi. Bộ lập lịch không bao giờ chạy nó. |

### Nguồn ảnh

```ts
{ kind: 'base64', mediaType: ImageMediaType, data: string }   // đa nền tảng
{ kind: 'url', url: string }                                   // đa nền tảng
{ kind: 'file', fileId: string }                               // chỉ Responses
```

`base64` và `url` dùng được với mọi nhà cung cấp. `{ kind: 'file', fileId }` và
`detail: 'original'` chỉ được Responses API chấp nhận; Anthropic báo chúng thành
lỗi `INVALID_REQUEST` có kiểu, chứ không âm thầm bỏ qua.

### Nguồn tài liệu

```ts
interface DocumentBlock {
  type: 'document'
  source:
    | { kind: 'base64'; mediaType: 'application/pdf'; data: string }
    | { kind: 'url'; url: string }
    | { kind: 'file'; fileId: string }
  filename?: string   // Responses suy ra loại file từ đây
  title?: string      // Anthropic gán trích dẫn vào đây
  context?: string
  citations?: boolean
  pages?: number      // metadata cục bộ để ước lượng token; không bao giờ được serialize
}
```

Cả ba loại nguồn đều dùng được với mọi nhà cung cấp — khác với ảnh, Anthropic
chấp nhận `fileId` của Files API cho tài liệu, và đó là đường được khuyến nghị
cho PDF đủ lớn để chạm trần request 32 MB của họ.

Media type chỉ có PDF, và đây là chủ ý. Cả ba họ nhà cung cấp đều ghi rõ PDF là
đầu vào thị giác thuần; các loại file khác thì mỗi nhà cung cấp chấp nhận một tập
khác nhau, nên mở rộng ra sẽ cho phép một request pass typecheck với nhà cung cấp
sẽ từ chối nó. Caller có DOCX thì tự trích text rồi gửi text.

Xem [TÃ i liá»u Äáº§u vÃ o](/vi/03-tools/native-tools#tai-lieu-pdf-đau-vao) Äá» biáº¿t
model cần khai báo năng lực gì trước khi PDF đến được nó.

## Message là bất biến

```ts
import { createTextMessage } from '@alvin0/ai-agent-sdk-core'

const message = createTextMessage('21 * 2 bằng bao nhiêu?')
```

Mỗi message mang một `source` ghi lại xuất xứ của nó:

| Loại source | Ý nghĩa |
| --- | --- |
| `user` | Một lượt của người dùng thật. |
| `model` | Một message assistant, kèm xuất xứ provider/model. |
| `tool` | Kết quả tool, liên kết theo `callId`. |
| `app` | Ngữ cảnh do host soạn, gắn nhãn `producer`. |
| `agent-message` | Một agent cục bộ khác trong `AgentTeam`. |
| `a2a-message` | Một peer A2A từ xa, kèm `contextId` / `messageId` / `taskId` của giao thức. |

Source quyết định thẩm quyền. Bộ nhớ tác vụ được tiêm vào dưới dạng **ngữ cảnh
user do app soạn**, không phải chỉ dẫn hệ thống, nên mục tiêu do người dùng đặt
vẫn giữ thẩm quyền người dùng thay vì bị nâng lên thẩm quyền lập trình viên.

## Các pha của text assistant

Text của assistant được phân loại, không phải đoán:

| Pha | Ý nghĩa |
| --- | --- |
| `commentary` | Lời tường thuật tiến độ ngắn, hiển thị cho người dùng, quanh việc dùng tool. |
| `final-answer` | Chính câu trả lời. |

Phần này tách bạch với suy luận. `assistant-reasoning` chỉ chứa tóm tắt hoặc nội
dung suy luận mà nhà cung cấp thực sự phát ra; `assistant-text` là văn bản công
khai. Sự kiện commentary còn mang `timing` — một trong `before-tools`,
`after-tools`, `between-tools`, `standalone` — và mảng id lời gọi tool, nên giao
diện liên kết trực tiếp chứ không phải đoán mò.

Điều khiển bằng `commentary`:

```ts
runtime.agent({ /* … */, commentary: 'concise' })  // yêu cầu tường thuật tiến độ ngắn
runtime.agent({ /* … */, commentary: 'auto' })     // để model tự quyết
runtime.agent({ /* … */, commentary: 'off' })      // chỉ câu trả lời cuối
```

## Lắp ráp một luồng

`BlockAssembler` tiêu thụ giao thức chunk và sinh ra một message cùng thông tin
usage và trạng thái kết thúc.

```ts
const assembler = new BlockAssembler()
for await (const chunk of registry.stream(call)) assembler.push(chunk)

const message = assembler.message({ kind: 'model', provider: 'openai', model: 'gpt-5.4' })
assembler.usage     // TokenUsage | undefined
assembler.finish    // FinishReason
```

## Trạng thái phát lại

Chunk `finish` kết thúc có thể mang một `ReplayEnvelope` — trạng thái JSON không
mất mát, riêng tư với adapter, cần để phát lại một phản hồi thành công ở yêu cầu
kế tiếp. Anthropic dùng nó để giữ kết quả web-search native đã mã hoá và các
trích dẫn.

```ts
interface ReplayEnvelope {
  response: unknown           // metadata mức phản hồi (id, lý do dừng native)
  blocks?: readonly unknown[] // một mục cho mỗi block phát ra, theo thứ tự luồng
}
```

Cả hai nửa đều mờ đục với tầng trên adapter; chỉ có **cách chia đôi** là từ vựng
dùng chung. Chính điều đó cho phép bộ lắp ráp giữ metadata khớp với nội dung mà
không cần hiểu nửa nào. Khi bộ lắp ráp bỏ một block, nó bỏ luôn mục ở cùng vị
trí; một envelope có độ dài không khớp số block đã phát sẽ bị bỏ toàn bộ, vì một
ánh xạ lệch còn tệ hơn không có ánh xạ.

## Đọc tiếp

- [Provider và registry](/vi/09-providers/)
- [Native tool, hình ảnh và tài liệu](/vi/03-tools/native-tools)
