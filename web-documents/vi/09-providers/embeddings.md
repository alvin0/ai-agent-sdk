# Embeddings

Runtime: **Universal** — Edge/Worker, browser, Deno, Bun và Node.
Composition slot: `runtime.providers`.
Lifecycle: `inert-runtime-owned-registration`.

Embedding là **một model capability riêng**, không phải một phép chiếu của
generation. Nó nằm cạnh generation dưới cùng một runtime, với contract riêng,
plugin kind riêng và taxonomy lỗi riêng.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai
```

Contract có entry point riêng:

```ts
import {
  EMBEDDING_ERROR_CODES,
  EmbeddingError,
  type EmbeddingModelHandle,
  type EmbeddingResult,
} from '@alvin0/ai-agent-sdk-core/embedding'
```

## Phạm vi v1 và những gì nằm ngoài

Trong phạm vi:

- **Input dạng text.** Kiểu input được chấp nhận là `'text'`, đọc được ngay từ
  type (`EmbeddingInputType`) chứ không phải từ văn xuôi.
- **Một dense vector cho mỗi item.** Representation là `'dense-float32'`; không
  có output multi-vector hay sparse.
- **Hai entry point**, `embed()` và `embedMany()`.
- **Cancellation** qua `AbortSignal` do bạn sở hữu.
- **Batching có giới hạn** — số items, số tokens ước lượng và số bytes payload.
- **Usage trung thực.** Token provider không báo cáo thì vẫn để trống.

Ngoài phạm vi, một cách có chủ ý. Thêm embedding không kéo theo một nền tảng RAG
vào dependency closure của bạn:

- retrieval và vector store
- semantic memory (`MemoryStore` và `AgentMemorySnapshot` không đổi)
- RAG pipeline
- parser, chunker, OCR, reranker
- công cụ migrate index
- inference engine chạy trong process

Ứng dụng chỉ dùng generation không cấu hình thêm gì và không mang thêm bề mặt
embedding nào.

## Cài đặt một embedding provider

Plugin embedding có kind riêng, `'embedding-provider-plugin'`, nên nó cài **cạnh**
plugin generation thay vì thay thế. Route được namespace theo operation, nên cả
hai plugin dưới đây đều có thể claim `openai`:

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin, openAiEmbeddingPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [
    openAiPlugin({ apiKey }),
    openAiEmbeddingPlugin({
      apiKey,
      models: [{
        id: 'text-embedding-3-small',
        dimensions: [1536, 512],
        defaultDimensions: 1536,
        purposeHandling: 'unsupported',
        compatibilityIdentity: 'openai:text-embedding-3-small',
      }],
    }),
  ],
})
```

`openAiEmbeddingPlugin()` mặc định mang catalog **rỗng**, cùng lý do adapter
generation không kèm danh sách model: một danh sách built-in rồi sẽ nêu tên model
đã bị khai tử. Một entry được khai báo là điều làm `dimensions` tới được wire và
là nơi phát biểu embedding space, nên hãy khai báo các model mà route thực sự
dùng. `compatibilityIdentity` là field bắt buộc duy nhất — xem
[Embedding space](#embedding-space).

Gemini có catalog khai báo sẵn và mặc định plugin id (và do đó cả route) là
`'gemini-embedding'`:

```ts
import { geminiEmbeddingPlugin } from '@alvin0/ai-agent-sdk-provider-gemini'

const runtime = await createAgentRuntime({
  providers: [geminiEmbeddingPlugin({ apiKey })],
})
```

Hai plugin **cùng một** operation claim cùng một route sẽ làm construction thất
bại trước khi bất cứ thứ gì được cài: `PROVIDER_ROUTE_CONFLICT` cho generation,
`PROVIDER_OPERATION_CONFLICT` cho embedding.

## `embeddingModel()`

Không agent, không team, không session. Chỉ cần một handle:

```ts
const embeddings = runtime.embeddingModel({
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
})
```

| Tùy chọn | Ý nghĩa |
| --- | --- |
| `provider` | Route phải sở hữu một embedding adapter |
| `model` | Model id gửi tới provider |
| `dimensions` | Số chiều yêu cầu; bỏ trống là dùng mặc định của model |
| `truncation` | Mặc định của SDK là `'reject'`, kể cả khi provider mặc định cắt bớt |
| `expectedSpace` | `Space_Id` kỳ vọng; resolve ra space không tương thích thì từ chối lời gọi |
| `concurrency` | Số batch chạy đồng thời trong một logical call; mặc định `4` |
| `batchLimits` | Ghi đè `maxItems` / `maxTokens` / `maxBytes` / `estimateTokens` |
| `cache` | Cache tùy chọn; tắt nếu không cấu hình |

Route không có embedding adapter bị từ chối bằng `EMBEDDING_ADAPTER_MISSING`. Số
chiều route không khai báo bị từ chối bằng `EMBEDDING_DIMENSIONS_UNSUPPORTED`,
trước khi request đầu tiên được gửi.

## `embed()` — một input

```ts
const result = await embeddings.embed({
  value: 'Làm sao để rotate một API key?',
  purpose: 'retrieval-query',
  signal: request.signal,
})

result.embedding   // readonly number[]
result.space       // Space_Id mà vector thuộc về
result.profile     // EmbeddingProfile đầy đủ đứng sau space đó
result.usage       // EmbeddingUsageReport
result.warnings    // thông tin không phải lỗi, ví dụ 'usage-unreported'
```

`purpose` là **bắt buộc**, đúng hai giá trị: `'retrieval-query'` và
`'retrieval-document'`. Việc dịch nó thành mechanism trên wire thuộc hoàn toàn về
adapter. Gemini có `taskType` nên purpose trở thành một wire parameter; API
embeddings của OpenAI không có mechanism nào nên text được gửi nguyên văn. Không
adapter nào tự nghĩ ra một prefix chưa được tài liệu hóa.

## `embedMany()` — một corpus

```ts
const { embeddings: vectors, space, usage } = await embeddings.embedMany({
  values: chunks,
  purpose: 'retrieval-document',
  signal: job.signal,
})
```

`vectors` luôn theo **thứ tự input**. Runtime ghi mỗi vector vào đúng chỉ số
input của nó, nên thứ tự batch hoàn thành, các lần retry, hay việc provider trả
về một batch bị đảo thứ tự đều không quan sát được ở output.

Mọi thứ giữa lời gọi và vector thuộc về runtime, không thuộc adapter — batching,
giới hạn đồng thời, retry, cache tùy chọn, tổng hợp usage, khôi phục thứ tự.
Adapter chỉ làm ba việc: phát một physical request, chuyển đổi protocol, kiểm tra
response.

Batching áp dụng ba giới hạn cùng lúc, và một batch được đóng ngay khi bất kỳ
giới hạn nào sẽ bị vượt:

| Giới hạn | Giá trị dự phòng khi catalog không khai báo |
| --- | --- |
| `maxItems` | 96 |
| `maxTokens` (ước lượng, `ceil(utf8Bytes / 4)`) | 100 000 |
| `maxBytes` | 1 MiB |

Thứ tự ưu tiên: override của bạn, rồi capability route khai báo, rồi giá trị dự
phòng. Vì dự phòng là toàn phần, một model id ngoài catalog vẫn batch được thay
vì bị từ chối. Bộ nhớ payload đỉnh giữ ở mức `concurrency × maxBytes` chứ không
tăng theo kích thước corpus.

Cancellation được tôn trọng ở mọi tầng: abort signal của bạn làm lời gọi thất bại
với `EMBEDDING_ABORTED`, và các batch đã thành công không bao giờ được gửi lại
bởi một lần retry sau đó của cùng lời gọi.

## Embedding space

Hai vector cùng số chiều **không** vì thế mà so sánh được với nhau. SDK quản lý
embedding space, không phải tên model.

Mọi kết quả đều mang một `Space_Id` dẫn xuất từ `EmbeddingProfile`: compatibility
identity, dimensions, representation, normalization, post-processing, profile
revision — nối thành một chuỗi canonical, mỗi thành phần được escape nên hai bộ
thành phần khác nhau không thể trùng chuỗi. Đây là một định danh để so sánh,
không phải một digest.

Tương thích được quyết định bởi **compatibility identity đã khai báo**, không bao
giờ bởi so tên model và không bao giờ bởi so số chiều. Cùng số chiều nhưng khác
identity nghĩa là không tương thích.

Lưu `Space_Id` cạnh index của bạn, và truyền lại nó:

```ts
const result = await embeddings.embed({
  value: query,
  purpose: 'retrieval-query',
  expectedSpace: index.space,
})
```

Space không tương thích thất bại bằng `EMBEDDING_SPACE_INCOMPATIBLE` **trước**
request đầu tiên — đó là một sự từ chối, không phải một cảnh báo.

## Usage vẫn trung thực

Embedding không có output token, nên nó không dùng lại shape usage của
generation: shape đó chỉ báo `complete` khi đã có `outputTokens`, điều mà
embedding chỉ có thể thỏa mãn bằng cách bịa ra một số `0`.

```ts
const { usage } = await embeddings.embedMany({ values, purpose: 'retrieval-document' })

usage.status              // 'complete' | 'partial' | 'missing'
usage.tokens              // chỉ có khi status === 'complete'
usage.batches             // số physical batch của logical call này
usage.batchesWithUsage    // bao nhiêu batch trả về usage đọc được
usage.providerAttempts    // số attempt, tính cả retry
usage.inputsFromCache     // báo cáo tách biệt …
usage.inputsFromProvider  // … với phần thực sự đã gửi đi
```

`status` là `'complete'` chỉ khi mọi batch đã gửi tới provider đều trả về usage
đọc được. Một counter sai định dạng bị bỏ chứ không được "sửa", và warning
`usage-unreported` hoặc `usage-malformed` sẽ nói rõ điều đó.

## Cache tùy chọn

Tắt cho tới khi bạn cấu hình. `scope` là bắt buộc và không có mặc định: không có
câu trả lời mặc định nào an toàn cho câu hỏi "hai tenant có được dùng chung một
cache entry không".

```ts
const embeddings = runtime.embeddingModel({
  provider: 'openai',
  model: 'text-embedding-3-small',
  cache: { scope: `tenant:${tenantId}`, store: myStore },
})
```

Cache key gồm năm thành phần: security scope, model/profile revision, purpose
cùng recipe revision của nó, dimensions cùng post-processing, và hash của input
hiệu lực. Một entry có `Space_Id` khác với lời gọi hiện tại bị bỏ qua chứ không
được tin, và vector được yêu cầu lại. Bật cache mà không có scope là
`EMBEDDING_CONFIGURATION_INVALID`.

## Lỗi

Lỗi embedding dùng `EMBEDDING_ERROR_CODES` và class `EmbeddingError`; lỗi
transport vẫn dùng taxonomy của model, nên "đang bị rate limit" vẫn phân biệt
được với "vector sai số chiều". `EmbeddingError` mang theo `itemIndexes`, `limit`,
`provider`, `model` và `space` — không bao giờ mang text input thô hay giá trị
vector.

```ts
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '@alvin0/ai-agent-sdk-core/embedding'

try {
  await embeddings.embedMany({ values: chunks, purpose: 'retrieval-document' })
} catch (error) {
  if (error instanceof EmbeddingError
    && error.code === EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE) {
    return rechunk(error.itemIndexes ?? [], error.limit)
  }
  throw error
}
```

## Đọc tiếp

- [Xử lý lỗi](/vi/10-advanced/error-handling) — taxonomy đầy đủ
- [OpenAI](/vi/09-providers/openai) · [Gemini](/vi/09-providers/gemini)
- [Custom Provider](/vi/09-providers/custom-provider) — tầng transport HTTP dùng
  chung mà cả pipeline SSE và JSON đều dựng trên
