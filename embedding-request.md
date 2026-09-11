> **SDK quản lý việc gọi embedding model. Provider quyết định gọi model ở đâu. Retrieval quản lý tìm kiếm. Vector store quản lý lưu trữ. Agent chỉ sử dụng kết quả tìm kiếm.**

Tôi đã đọc các phần contract, provider, runtime và memory trên nhánh `main`, tại commit `9b909a0` ngày **10/09/2026**. Phần dưới là đề xuất mở rộng dựa trên cấu trúc đó, chưa phải API đã tồn tại trong repository.

## 1. SDK của bạn đang có nền tảng phù hợp, nhưng contract model còn thiên về generation

Các điểm quan trọng tôi thấy trong source:

| Thành phần hiện tại                                                      | Ý nghĩa khi bổ sung embedding                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `ModelAdapter` yêu cầu `stream()` và trả về `StreamChunk`.               | Đây là contract cho generation. Không nên ép vector embedding đi qua contract này.             |
| `AgentRuntime` đang quản lý provider, catalog, agent, team và lifecycle. | Có thể bổ sung embedding ở cùng tầng composition, không cần tạo một hệ runtime hoàn toàn khác. |
| Provider OpenAI sử dụng `protocol-responses` và hạ tầng `provider-http`. | Tái sử dụng phần kết nối, credential và giới hạn HTTP; thêm protocol embedding riêng.          |
| `MemoryStore` có `load()`/`commit()` cho snapshot cùng revision.         | Đây là persistence của hội thoại, không nên đổi thành vector store.                            |

Các ranh giới này thể hiện trực tiếp trong `contract/adapter.ts`, `composition/runtime/types.ts`, provider OpenAI và contract persistence của memory.

**Điểm nên giữ nguyên:** thiết kế streaming-only của generation.

**Điểm nên bổ sung:** một contract `EmbeddingAdapter` độc lập, có kết quả dạng vector và usage, không phải message, tool call hay text delta.

Ví dụ về ranh giới:

```text
GenerationAdapter / ModelAdapter hiện tại
    messages → stream các content block

EmbeddingAdapter mới
    các input độc lập → các vector + usage + metadata
```

Việc embedding dùng `Promise` không phá nguyên tắc streaming-only của generation: đây là **hai loại operation khác nhau**, không phải hai implementation cho cùng một operation.

---

## 2. Hệ sinh thái nên vận hành như thế nào?

Tôi đề xuất nhìn hệ thống theo sơ đồ này:

```text
                         Ứng dụng
                            │
             ┌──────────────┴──────────────┐
             │                             │
        Agent / Workflow              Ingestion worker
             │                             │
      Tool hoặc Retriever           Parse / Clean / Chunk
             │                             │
             └──────────────┬──────────────┘
                            │
                     Embedding API
                 thuộc SDK, dùng độc lập
                            │
              Validation / Batching / Retry
              Cancellation / Usage / Tracing
                            │
                     EmbeddingAdapter
                            │
            ┌───────────────┴────────────────┐
            │                                │
      API của provider                 Model tự host
      OpenAI, Google...              Inference service
            │                                │
            └───────────────┬────────────────┘
                            │
                          Vector
                            │
                 Retrieval / Vector store
                  nằm ngoài agent core
```

### Hai luồng riêng: lập chỉ mục và trả lời

**Luồng lập chỉ mục tài liệu:**

```text
Tài liệu
  → parse
  → chia chunk
  → embedding với mục đích document
  → lưu vector + nội dung + metadata + phiên bản
```

**Luồng trả lời người dùng:**

```text
Câu hỏi
  → embedding với mục đích query
  → tìm kiếm theo index tương thích, có kiểm tra quyền truy cập
  → lấy các đoạn liên quan
  → đưa nội dung vào context của agent
  → generation model trả lời
```

Với cách tổ chức này, tôi sẽ **không buộc chat model và embedding model phải cùng provider**. Chúng chỉ phối hợp thông qua nội dung truy xuất được.

Agent cũng không cần nhìn thấy hàng nghìn số trong vector. Tôi sẽ cho agent gọi tool kiểu `searchKnowledge`, nhận về nội dung, nguồn và metadata cần thiết; vector nằm ở tầng retrieval.

### Không phải mọi ứng dụng dùng SDK đều cần embedding

Tôi muốn SDK cho phép cả ba trường hợp:

| Ứng dụng                                     | Thành phần cần dùng                |
| -------------------------------------------- | ---------------------------------- |
| Agent gọi tool, không có semantic search     | Generation, tools, runtime         |
| Service lập chỉ mục tài liệu, không có agent | Embedding API và storage adapter   |
| Agent có RAG hoặc semantic memory            | Generation + retrieval + embedding |

Đây là lý do embedding cần dùng được **ngoài agent loop**, kể cả khi ứng dụng không tạo agent hay session nào.

---

## 3. Model embedding thực sự chạy ở đâu?

Tôi đề xuất hỗ trợ hai cách chính, nhưng giữ nguyên API phía ứng dụng.

### Cách A — SDK gọi API embedding bên ngoài

```text
Ứng dụng Node / Edge
    → SDK embedding adapter
    → API provider
    → nhận vector
```

Đây nên là cách triển khai đầu tiên: package của bạn chứa adapter và contract, **không chứa model weights hoặc inference engine**. API embedding của OpenAI, chẳng hạn, nhận input và trả về vector qua endpoint riêng `/embeddings`. ([OpenAI Platform][1])

### Cách B — SDK gọi inference service do bạn tự host

```text
Ứng dụng Node / Edge
    → SDK embedding adapter
    → inference service trong mạng nội bộ
    → model chạy trên CPU/GPU của service đó
```

Một runtime có thể nghiên cứu cho nhánh này là **Hugging Face Text Embeddings Inference — TEI**. Đây là công cụ phục vụ embedding model, có token-based dynamic batching, tracing và metrics; tài liệu cũng có các hướng dẫn triển khai theo CPU/GPU. ([Hugging Face][2])

**Khuyến nghị của tôi:** đừng bắt đầu bằng việc nhúng inference engine vào SDK Universal. Hãy để model serving là một service riêng, còn SDK gọi qua adapter.

Chỉ bổ sung inference chạy ngay trong process khi có nhu cầu rõ ràng như offline hoặc ứng dụng desktop. Khi đó nên là package tùy chọn, không kéo dependency nặng vào mọi ứng dụng.

Với backend production, tôi cũng sẽ tách **ingestion worker** khỏi **đường query online**. Hai bên dùng cùng cấu hình embedding tương thích, nhưng có quota/concurrency riêng để một đợt nhập tài liệu lớn không làm chậm câu hỏi của người dùng.

---

## 4. Nên mở rộng package hiện tại như thế nào?

**Không cần tách thêm một loạt package ngay.** Trước hết, tách trách nhiệm trong code và public entry point.

| Vị trí đề xuất                                   | Trách nhiệm                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `core/src/embedding/`                            | Contract adapter, input/result, embedding capabilities, lỗi và validation |
| `core/src/composition/embedding/`                | Bind model vào runtime; quản lý operation, cancellation và lifecycle      |
| `provider-http`                                  | HTTP dùng chung; bổ sung đường xử lý JSON có giới hạn nếu cần             |
| `provider-openai`                                | Adapter embedding OpenAI, tách khỏi phần Responses                        |
| `provider-gemini`                                | Adapter embedding Google, tách khỏi phần generation                       |
| Package retrieval/vector store tùy chọn, làm sau | Indexing, search, metadata filters, storage integration                   |

Public entry point mới có thể là:

```ts
@alvin0/ai-agent-sdk-core/embedding
```

### 4.1. Giữ `ModelAdapter` hiện tại, thêm `EmbeddingAdapter`

Tôi không khuyên sửa thành một adapter bắt buộc có cả hai method:

```ts
// Không khuyến nghị
abstract class ModelAdapter {
  abstract stream(...): ...
  abstract embed(...): ...
}
```

Thiết kế đó khiến provider chỉ hỗ trợ một loại operation vẫn phải triển khai contract của loại còn lại.

Thay vào đó:

```text
Provider plugin
    ├── đăng ký generation adapter
    ├── đăng ký embedding adapter
    └── sau này có thể đăng ký reranking adapter
```

Provider là nơi tập hợp năng lực, **không phải lời cam kết rằng mọi model của provider đều có mọi năng lực**.

### 4.2. Mở rộng provider registrar theo operation

Registrar hiện tại có `registerAdapter()` và middleware cho stream. Tôi sẽ thêm một registration path riêng cho embedding, thay vì tái sử dụng `StreamMiddleware`.

Ví dụ thiết kế:

```ts
registrar.registerAdapter(generationAdapter)
registrar.registerEmbeddingAdapter(embeddingAdapter)
```

Một plugin OpenAI có thể đăng ký cả hai trên cùng provider route. Runtime phân giải theo:

```text
provider route + operation + model id
```

Cần giữ setup/rollback có tính nhất quán: nếu đăng ký embedding thất bại, không để plugin ở trạng thái cài đặt một nửa.

Vì plugin contract hiện có `apiVersion`, thay đổi registrar cũng cần có chiến lược version/capability negotiation. Plugin mới không nên gọi method embedding trên host cũ rồi lỗi bất ngờ.

### 4.3. Tái sử dụng HTTP, không tái sử dụng protocol Responses

Provider OpenAI hiện khá mỏng: đưa cấu hình vào `createHttpProvider()` và dùng `openAiResponsesProtocol`. Đây là ranh giới tốt để giữ.

Tôi sẽ chia như sau:

```text
Hạ tầng dùng chung
    credentials, fetch, timeout, abort, giới hạn response, observation

Generation protocol
    request generation → SSE → StreamChunk

Embedding protocol
    request embedding → JSON → EmbeddingResult
```

Chỉ tách `protocol-openai-embeddings` thành package riêng khi có nhu cầu tái sử dụng thực sự, chẳng hạn nhiều provider/gateway đã được kiểm thử là tương thích.

**“OpenAI-compatible” nên là một profile được kiểm thử, không phải giả định rằng endpoint nào có `/embeddings` cũng có hành vi giống nhau.**

---

## 5. API người dùng nên đơn giản đến mức nào?

Tôi đề xuất API ở mức này.

**Đây là API minh họa cho phần mở rộng, chưa có trong repository.** `capabilities`, `runtime.embeddingModel()`, `embed()` và `embedMany()` trong ví dụ là các thành phần cần bổ sung.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

export async function demoEmbedding(apiKey: string) {
  const runtime = createAgentRuntime({
    providers: [
      openAiPlugin({
        apiKey,
        capabilities: ['embedding'],
      }),
    ],
  })

  try {
    const model = runtime.embeddingModel({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
    })

    const documents = await model.embedMany({
      values: [
        'Quy trình xử lý sự cố hệ thống.',
        'Hướng dẫn cấu hình PostgreSQL.',
      ],
      purpose: 'retrieval-document',
      signal: AbortSignal.timeout(30_000),
    })

    const query = await model.embed({
      value: 'Cách xử lý khi database bị lỗi?',
      purpose: 'retrieval-query',
      signal: AbortSignal.timeout(10_000),
    })

    console.log({
      documentCount: documents.embeddings.length,
      queryDimensions: query.embedding.length,
      embeddingSpace: documents.space,
      usage: documents.usage,
    })
  } finally {
    await runtime.close()
  }
}
```

Model và dimensions ở đây chỉ là cấu hình minh họa, không phải kết luận model tốt nhất cho dữ liệu của bạn. OpenAI có hỗ trợ cấu hình số chiều trên dòng `text-embedding-3`. ([OpenAI Platform][1])

### Phía dưới API này nên có hai tầng

**Tầng adapter:** thực hiện một request vật lý, chuyển đổi protocol và kiểm tra response.

**Tầng runtime:** chia batch, giới hạn concurrency, retry, cache nếu được cấu hình, tổng hợp usage và khôi phục đúng thứ tự kết quả.

Nhờ vậy, mỗi provider không phải tự viết lại toàn bộ logic điều phối.

Tôi cũng muốn giữ nguyên một đặc tính tốt đang có: `prepareCall()` gắn metadata đã resolve với đúng generation cấu hình dùng để dispatch. Embedding nên có cơ chế tương tự để tránh kiểm tra dimensions ở một cấu hình nhưng gửi request qua cấu hình khác.

---

## 6. Những contract phải làm đúng ngay từ đầu

Đây là phần quan trọng hơn việc gọi được endpoint embedding đầu tiên.

### 6.1. Quản lý “embedding space”, không chỉ quản lý model name

**Không nên coi hai vector có cùng số chiều là tương thích.**

Ví dụ cụ thể: Google ghi rõ vector của `gemini-embedding-001` và `gemini-embedding-2` thuộc các không gian không tương thích; chuyển sang model mới cần embed lại dữ liệu. ([Google AI for Developers][3])

Tôi đề xuất mỗi index có một **embedding profile** được quản lý phiên bản:

```text
Embedding profile
    model identity / revision khi có
    output dimensions
    representation
    normalization / post-processing
    document recipe revision
    query recipe revision
    compatibility / space identity
```

Mỗi kết quả embedding nên mang `spaceId` hoặc metadata đủ để xác định nó thuộc profile nào.

Trước khi search hoặc upsert:

```text
profile của query/vector
        phải tương thích với
profile của index
```

**Đặc biệt: không tự fallback sang model embedding khác chỉ vì model chính lỗi.** Chỉ cho phép khi có bảo đảm tương thích được khai báo và kiểm chứng.

Cũng không nên cấm tuyệt đối mọi trường hợp khác model: có các nhóm model được nhà cung cấp thiết kế dùng chung embedding space, như Voyage 4 series. Vì vậy, compatibility cần là khái niệm riêng, không đơn giản là so sánh tên model. ([Voyage AI][4])

### 6.2. Tách rõ mục đích query và document

Tôi sẽ đưa `purpose` vào API chung:

```ts
purpose: 'retrieval-query' | 'retrieval-document'
```

Rồi để adapter chuyển đổi theo model. Chẳng hạn Voyage có `input_type: "query" | "document"` và khuyến nghị phân biệt hai loại input cho retrieval. ([Voyage AI][4])

Không nên yêu cầu người dùng SDK tự thêm prefix của từng model ở khắp nơi trong ứng dụng.

Một chi tiết dễ làm sai: **query recipe và document recipe có thể khác nhau nhưng vẫn thuộc cùng một retrieval profile tương thích**. Không tạo hai `spaceId` không tương thích chỉ vì `purpose` khác nhau.

### 6.3. Phân biệt batch input và các thành phần của một input

Contract v1 nên quy định:

> **N input độc lập thành công phải tạo N vector, giữ đúng mapping với input gốc.**

Đừng chỉ truyền một mảng vào provider rồi giả định response luôn là nhiều vector. Ví dụ, Gemini Embedding 2 có thể tổng hợp nhiều thành phần trong một request thành một embedding. ([ai.google.dev][3])

Khi mở rộng multimodal, nên có hai tầng rõ ràng:

```text
items[]                    ← nhiều đối tượng cần embed độc lập
    item.contentParts[]    ← nhiều thành phần của cùng một đối tượng
```

Đối với bản đầu tiên, tôi sẽ hỗ trợ **text → một dense vector**, nhưng ghi rõ phạm vi này trong capability. Không quảng bá `number[]` như contract bao trùm mọi loại sparse hoặc multi-vector embedding.

### 6.4. Không tự cắt nội dung hoặc sửa vector trong im lặng

Tôi đề xuất mặc định:

```text
Input quá dài                  → lỗi có cấu trúc
Dimensions không được hỗ trợ   → lỗi
Response thiếu vector          → lỗi protocol
Vector chứa NaN/Infinity        → lỗi protocol
```

Chỉ cho phép truncation khi người gọi chủ động bật, và phải có warning/metadata tương ứng.

Lý do cần chuẩn hóa rõ: hành vi mặc định của provider không giống nhau. Voyage, chẳng hạn, có tùy chọn truncation và mặc định của API này là bật. ([Voyage AI][4])

Cũng không tự slice/pad vector cho vừa database. Cấu hình dimensions phải được xử lý bằng cơ chế model hỗ trợ hoặc một transformation được quản lý phiên bản rõ ràng.

### 6.5. Catalog phải phân biệt loại operation

`ResolvedModelInfo` hiện có các thông tin như context window, max output tokens và reasoning — phù hợp với generation. Tôi không khuyên nhét các thông số embedding vào cùng cấu trúc đó một cách tùy tiện.

Embedding metadata nên mô tả riêng:

```text
supported input types
output representation
supported/default dimensions
max input tokens
max batch items / tokens / bytes
purpose handling
normalization behavior
```

Giữ nguyên tinh thần **catalog là advisory** đang có trong SDK: không thấy model trong catalog không đồng nghĩa model không tồn tại. Nhưng capability không biết phải thể hiện là `unknown`, không được tự đoán thành `supported`.

---

## 7. Embedding nên kết nối với RAG và memory ở ranh giới nào?

Tôi đề xuất tách ba interface:

```text
EmbeddingModel
    Nội dung → vector

VectorStore
    Upsert / delete / query vector và metadata

Retriever
    Câu hỏi + access context → các evidence liên quan
```

**Agent nên phụ thuộc vào `Retriever`, không phụ thuộc trực tiếp vào vector database.**

Cách này cho phép thay đổi phương pháp tìm kiếm mà không sửa agent:

```text
Agent
  → Retriever
      → vector search
      → hoặc hybrid search
      → hoặc dịch vụ knowledge bên ngoài
```

Với hướng PostgreSQL/pgvector của bạn, adapter lưu trữ có thể nằm ở package tùy chọn. Tôi sẽ không đưa PostgreSQL, Redis hay MinIO thành dependency bắt buộc của embedding core.

### Memory hiện tại nên giữ nguyên

`MemoryStore` của repo đang lưu `AgentMemorySnapshot` cùng `expectedRevision`. Nó phục vụ load/commit trạng thái hội thoại.

Tôi sẽ giữ:

```text
Conversation persistence
    → load / commit snapshot

Semantic memory
    → chọn thông tin cần nhớ
    → embed / index
    → retrieve khi cần
```

Semantic memory nên là tầng tùy chọn được xây trên embedding và retrieval, không thay thế persistence.

Tương tự, parser PDF, chunker, OCR, reranker và pipeline ingestion nên phát triển ở tầng knowledge/RAG. **Bổ sung embedding provider không nên đồng nghĩa phải viết lại toàn bộ các tầng này trong SDK.**

---

## 8. Vận hành và test: các điểm không nên để đến sau

Tôi sẽ giữ một nguyên tắc của observability hiện tại: **usage không được provider trả về thì vẫn là missing/partial, không tự ghi thành zero**. README của SDK đã nêu rõ quy tắc này.

Với embedding, cần phân biệt logical call, physical batch và từng provider attempt. Chỉ một tầng sở hữu retry; không để adapter và runtime cùng retry độc lập làm số request nhân lên.

Bộ contract test đầu tiên nên có:

| Nhóm test             | Điều kiện cần bảo đảm                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Mapping và validation | Batch bị đảo thứ tự, thiếu/trùng index, sai dimensions hoặc vector không hợp lệ phải được phát hiện |
| Batching              | Giới hạn theo items, tokens và bytes; không gom vô hạn toàn bộ corpus vào RAM                       |
| Cancellation và close | Abort dừng batch chưa gửi; `runtime.close()` quản lý cả embedding operation đang chạy               |
| Retry và chi phí      | Không chạy lại batch đã thành công; timeout không được suy diễn thành “chắc chắn chưa bị tính phí”  |
| Cache                 | Key có tenant/security scope, model/profile, purpose và nội dung thực tế được encode                |
| Compatibility         | Query sai embedding space phải bị chặn; không fallback model tùy tiện                               |
| Plugin compatibility  | Plugin generation cũ vẫn chạy; runtime chỉ có embedding vẫn khởi động và đóng được                  |
| Privacy               | Trace mặc định không chứa raw document hoặc raw vector; quyền truy cập được kiểm tra tại retrieval  |

Với cache, tôi đề xuất công thức khái niệm:

```text
cache key =
    security scope
    + model / profile revision
    + purpose / recipe
    + dimensions / post-processing
    + hash của input hiệu lực
```

Khi nâng model không tương thích, quy trình nên là:

```text
Tạo index phiên bản mới
    → embed / backfill
    → đánh giá retrieval
    → chuyển traffic
    → giữ khả năng rollback
```

Không chỉ sửa một biến `EMBEDDING_MODEL` rồi tiếp tục query index cũ.

---

## 9. Thứ tự triển khai tôi chọn cho repo này

**Bước đầu — hoàn thiện đường embedding độc lập.** Thêm `EmbeddingAdapter`, embedding result/capabilities, runtime composition, provider OpenAI và contract tests. Phạm vi v1 là text, dense vector, `embed()`/`embedMany()`, cancellation, bounded batching và usage. Chưa đưa RAG vào core.

**Bước tiếp theo — kiểm chứng khả năng đa provider.** Thêm một provider có semantics khác, chẳng hạn Google hoặc Voyage, cùng một endpoint self-host được kiểm thử. Mục tiêu không chỉ là tăng danh sách hỗ trợ, mà là tìm chỗ abstraction đang vô tình phụ thuộc OpenAI.

**Sau đó — xây các tầng sử dụng embedding.** Bổ sung retrieval, vector-store adapter, semantic memory và index migration. Việc chọn model cho dữ liệu VN/JP/EN cần một bộ đánh giá trên corpus của bạn, tách khỏi contract test của SDK.

**Quyết định kiến trúc tôi chốt là: giữ agent core hiện tại, thêm embedding như một model capability độc lập dưới cùng runtime; provider và hạ tầng HTTP được tái sử dụng, còn model serving, retrieval và vector storage giữ ranh giới riêng.** Đây là hướng vừa mở rộng được hệ sinh thái, vừa tránh khiến người dùng chỉ cần một agent đơn giản phải mang theo cả nền tảng RAG.

[1]: https://platform.openai.com/docs/api-reference/embeddings/create?utm_source=chatgpt.com "How to change OpenAI embedding dimensions to 256? ..."
[2]: https://huggingface.co/docs/text-embeddings-inference/index "Text Embeddings Inference · Hugging Face"
[3]: https://ai.google.dev/gemini-api/docs/embeddings "Embeddings  |  Gemini API  |  Google AI for Developers"
[4]: https://docs.voyageai.com/docs/embeddings "Text Embeddings"
