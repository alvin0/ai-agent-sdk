# Requirements Document

## Introduction

Tài liệu này mô tả yêu cầu cho việc bổ sung năng lực **embedding** vào `ai-agent-sdk` như một model capability độc lập, đặt cạnh generation dưới cùng một runtime. Nội dung được dẫn xuất từ đề xuất tại `embedding-request.md` (9 mục), giới hạn trong **Bước 1 và Bước 2** của mục 9:

- **Bước 1:** hoàn thiện đường embedding độc lập — contract adapter, kết quả và capabilities, runtime composition, adapter OpenAI, bộ contract test.
- **Bước 2:** kiểm chứng khả năng đa provider bằng adapter thứ hai là **Gemini**, nhằm phát hiện các chỗ abstraction đang vô tình phụ thuộc OpenAI.

Phạm vi v1 của năng lực embedding là: input dạng text, output là một dense vector, hai entry point `embed()` / `embedMany()`, hỗ trợ cancellation, batching có giới hạn, và báo cáo usage trung thực.

Song song với đường embedding, spec này bao gồm một thay đổi hạ tầng đã được chấp nhận: **tách một tầng transport dùng chung trong `packages/provider-http` trước, rồi dựng hai pipeline (SSE cho generation, JSON cho embedding) trên nền tầng đó**. Việc này chạm vào code generation đang chạy production (`HttpModelAdapter`), nên kèm yêu cầu regression bắt buộc cho cả bốn provider hiện có.

Việc mở rộng plugin dùng **một plugin kind riêng cho embedding**, không thêm method vào `ModelProviderRegistrar` hiện tại và không nâng `PROVIDER_PLUGIN_API_VERSION`.

**Ngoài phạm vi (non-goals) của spec này:** retrieval, vector store, semantic memory, RAG pipeline, parser/chunker/OCR/reranker, index migration tooling, và inference engine chạy trong process.

## Glossary

- **Embedding_Contract**: module contract mới tại `packages/core/src/embedding/`, chứa `EmbeddingAdapter`, input/result type, capabilities, error code và validation của embedding.
- **Embedding_Adapter**: abstract class contract mà một provider backend triển khai để thực hiện **một** physical request embedding, dịch protocol và kiểm tra response.
- **Embedding_Runtime**: tầng composition tại `packages/core/src/composition/embedding/`, chịu trách nhiệm batching, giới hạn concurrency, retry, cache tùy chọn, tổng hợp usage, khôi phục thứ tự kết quả và lifecycle của embedding operation.
- **Agent_Runtime**: runtime hiện có, khai báo tại `packages/core/src/composition/runtime/types.ts` (`AgentRuntime extends RuntimeCompositionView`).
- **Embedding_Model_Handle**: đối tượng do `Agent_Runtime.embeddingModel()` trả về, phơi ra `embed()` và `embedMany()`.
- **Prepared_Embedding_Call**: cặp gắn liền giữa metadata model đã resolve và hàm dispatch của **cùng một** generation cấu hình; tương đương `PreparedAdapterCall` của generation.
- **Embedding_Profile**: bản mô tả có phiên bản gồm model identity/revision, output dimensions, representation, normalization/post-processing, document recipe revision, query recipe revision và compatibility identity.
- **Space_Id**: định danh embedding space, dẫn xuất từ `Embedding_Profile`, dùng để kiểm tra tương thích giữa vector và index.
- **Purpose**: mục đích của input, nhận một trong hai giá trị `'retrieval-query'` hoặc `'retrieval-document'`.
- **Logical_Call**: một lần gọi `embed()` hoặc `embedMany()` từ phía ứng dụng.
- **Physical_Batch**: một request embedding được `Embedding_Runtime` phát sinh từ một `Logical_Call` sau khi chia batch.
- **Provider_Attempt**: một lần gọi HTTP tới provider cho một `Physical_Batch`, tính cả các lần retry.
- **Embedding_Cache**: lớp cache tùy chọn của `Embedding_Runtime` cho kết quả embedding.
- **Embedding_Provider_Plugin**: plugin kind mới dùng để đăng ký `Embedding_Adapter` vào `Agent_Runtime`.
- **Embedding_Registrar**: registrar được truyền vào `setup()` của `Embedding_Provider_Plugin`.
- **Startup_Preflight**: bước kiểm tra toàn bộ danh sách `providers` trước khi commit bất kỳ plugin nào vào `Agent_Runtime`.
- **Http_Transport**: tầng transport dùng chung được tách ra trong `packages/provider-http`, sở hữu connection snapshot, transport limits, fusion abort signal, request timeout, observeRequest best-effort, provider-attempt accounting, redirect guard, HTTP error mapping và teardown.
- **Sse_Pipeline**: pipeline generation dựng trên `Http_Transport`, giữ nguyên hành vi SSE hiện tại của `HttpModelAdapter`.
- **Json_Pipeline**: pipeline request/response JSON dựng trên `Http_Transport`, dùng cho embedding.
- **OpenAI_Embedding_Adapter**: `Embedding_Adapter` trong `packages/provider-openai`.
- **Gemini_Embedding_Adapter**: `Embedding_Adapter` trong `packages/provider-gemini`.
- **Embedding_Catalog**: metadata catalog riêng cho embedding model, tách khỏi `ResolvedModelInfo`.
- **Conformance_Harness**: bộ harness conformance provider hiện có trong `packages/testkit/src/provider/`, gồm `ProviderConformanceScenario`, `ProviderConformanceCheckId` và `ProviderConformanceReport`.
- **Documentation_Set**: `skills/ai-agent-sdk/references/` và `web-documents/`.

## Requirements

### Requirement 1: Contract embedding độc lập

**User Story:** Là người bảo trì SDK, tôi muốn embedding có contract riêng tách khỏi contract generation, để provider chỉ hỗ trợ một loại operation không phải triển khai contract của loại còn lại.

#### Acceptance Criteria

1. THE Embedding_Contract SHALL định nghĩa `Embedding_Adapter` là một abstract class độc lập, không kế thừa `ModelAdapter` và không thêm abstract member nào vào `ModelAdapter`.
2. THE Embedding_Contract SHALL yêu cầu đúng một abstract method trên `Embedding_Adapter`, nhận một tập input đã được chia batch và trả về `Promise` chứa các vector, usage và metadata.
3. THE Embedding_Contract SHALL loại `StreamChunk`, message, tool call và text delta khỏi kiểu kết quả của `Embedding_Adapter`.
4. THE Embedding_Contract SHALL cư trú tại `packages/core/src/embedding/` và được export qua entry point mới `@alvin0/ai-agent-sdk-core/embedding`, khai báo trong `packages/core/package.json` field `exports` và trong `packages/core/tsdown.config.ts`.
5. THE Embedding_Contract SHALL giữ nguyên contract generation streaming-only hiện có, gồm chữ ký `ModelAdapter.stream()` và `PreparedAdapterCall`.
6. WHEN một module trong `packages/core/src/embedding/` import từ `contract/`, `composition/` hoặc `plugin/`, THE Embedding_Contract SHALL giữ đồ thị dependency không có chu trình theo rule `no-circular` của `.dependency-cruiser.cjs`.

### Requirement 2: Snapshot cấu hình cho mỗi lần dispatch

**User Story:** Là người phát triển ứng dụng, tôi muốn dimensions và embedding space được kiểm tra trên đúng cấu hình sẽ dispatch, để không xảy ra trường hợp kiểm tra ở một generation nhưng gửi request qua generation khác.

#### Acceptance Criteria

1. THE Embedding_Adapter SHALL cung cấp một method trả về `Prepared_Embedding_Call` gồm metadata model đã resolve và hàm dispatch thuộc cùng một lần capture cấu hình.
2. WHEN Embedding_Runtime kiểm tra dimensions, purpose handling hoặc giới hạn batch, THE Embedding_Runtime SHALL đọc metadata từ chính `Prepared_Embedding_Call` sẽ được dùng để dispatch.
3. WHILE một `Logical_Call` đang chạy, THE Embedding_Runtime SHALL dispatch mọi `Physical_Batch` của `Logical_Call` đó qua cùng một `Prepared_Embedding_Call`.
4. IF cấu hình provider thay đổi sau khi `Prepared_Embedding_Call` được tạo, THEN THE Embedding_Runtime SHALL tiếp tục dùng snapshot đã capture cho `Logical_Call` đang chạy và báo cáo `Space_Id` tương ứng với snapshot đó.

### Requirement 3: Gọi embedding trực tiếp từ runtime

**User Story:** Là người phát triển một service lập chỉ mục tài liệu, tôi muốn gọi embedding trực tiếp từ runtime mà không cần tạo agent hay session, để ứng dụng không có agent vẫn dùng được SDK.

#### Acceptance Criteria

1. THE Agent_Runtime SHALL phơi ra method `embeddingModel(options)` nhận `provider`, `model` và `dimensions` tùy chọn, trả về `Embedding_Model_Handle`.
2. THE Embedding_Model_Handle SHALL phơi ra `embed({ value, purpose, signal })` trả về một vector kèm usage và `Space_Id`.
3. THE Embedding_Model_Handle SHALL phơi ra `embedMany({ values, purpose, signal })` trả về danh sách vector kèm usage tổng hợp và `Space_Id`.
4. WHEN ứng dụng gọi `embeddingModel()`, THE Agent_Runtime SHALL cấp `Embedding_Model_Handle` mà không khởi tạo agent, team hoặc session nào.
5. IF route được yêu cầu không có `Embedding_Adapter` đã đăng ký, THEN THE Agent_Runtime SHALL từ chối lời gọi bằng một error có code ổn định thuộc `Embedding_Contract`.
6. WHERE `dimensions` được truyền, THE Embedding_Runtime SHALL kiểm tra giá trị đó với `Embedding_Catalog` metadata của model trước khi phát sinh `Physical_Batch` đầu tiên.

### Requirement 4: Điều phối ở runtime, adapter tối giản

**User Story:** Là người viết provider adapter, tôi muốn logic điều phối nằm ở runtime, để mỗi provider không phải tự viết lại batching, concurrency và retry.

#### Acceptance Criteria

1. THE Embedding_Adapter SHALL chịu trách nhiệm đúng ba việc: thực hiện một physical request, chuyển đổi protocol, và kiểm tra response.
2. THE Embedding_Runtime SHALL chịu trách nhiệm chia batch, giới hạn concurrency, retry, cache tùy chọn, tổng hợp usage và khôi phục thứ tự kết quả.
3. THE Embedding_Runtime SHALL là tầng duy nhất sở hữu retry cho embedding, và THE Embedding_Adapter SHALL thực hiện đúng một `Provider_Attempt` cho mỗi lần được gọi.
4. WHEN Embedding_Runtime chia một `Logical_Call` thành các `Physical_Batch`, THE Embedding_Runtime SHALL áp dụng đồng thời ba giới hạn: số items, số tokens ước lượng và số bytes của payload.
5. WHILE một `Logical_Call` có nhiều input hơn giới hạn một `Physical_Batch`, THE Embedding_Runtime SHALL giới hạn số `Physical_Batch` đang chạy đồng thời theo giá trị concurrency được cấu hình.
6. WHEN Embedding_Runtime trả kết quả của `embedMany()`, THE Embedding_Runtime SHALL sắp xếp vector theo đúng chỉ số của input gốc, độc lập với thứ tự các `Physical_Batch` hoàn thành.
7. IF một `Physical_Batch` đã thành công, THEN THE Embedding_Runtime SHALL loại `Physical_Batch` đó khỏi mọi lần retry tiếp theo của cùng `Logical_Call`.
8. IF một `Physical_Batch` kết thúc bằng timeout, THEN THE Embedding_Runtime SHALL ghi trạng thái dispatch là `unknown` thay vì kết luận request chưa được provider tính phí.

### Requirement 5: Cache embedding có khóa đầy đủ ngữ cảnh

**User Story:** Là người vận hành hệ thống, tôi muốn cache embedding có khóa đầy đủ ngữ cảnh, để một kết quả không bị dùng lại sai tenant, sai model hoặc sai mục đích.

#### Acceptance Criteria

1. THE Embedding_Cache SHALL ở trạng thái tắt khi ứng dụng không cấu hình cache.
2. WHERE Embedding_Cache được bật, THE Embedding_Runtime SHALL tạo cache key từ năm thành phần: security scope, model/profile revision, purpose và recipe, dimensions cùng post-processing, và hash của input hiệu lực.
3. WHERE Embedding_Cache được bật, WHEN `Space_Id` của entry trong cache khác `Space_Id` của `Prepared_Embedding_Call` hiện tại, THE Embedding_Runtime SHALL bỏ qua entry đó và phát sinh `Physical_Batch` mới.
4. WHERE Embedding_Cache được bật, THE Embedding_Runtime SHALL báo cáo số input lấy từ cache và số input gửi tới provider tách biệt trong usage metadata.

### Requirement 6: Quản lý embedding space thay vì tên model

**User Story:** Là người vận hành index, tôi muốn SDK quản lý embedding space chứ không chỉ tên model, để không xảy ra việc query một index bằng vector thuộc không gian không tương thích.

#### Acceptance Criteria

1. THE Embedding_Contract SHALL định nghĩa `Embedding_Profile` gồm model identity và revision khi có, output dimensions, representation, normalization/post-processing, document recipe revision, query recipe revision và compatibility identity.
2. THE Embedding_Runtime SHALL gắn `Space_Id` dẫn xuất từ `Embedding_Profile` vào mọi kết quả của `embed()` và `embedMany()`.
3. THE Embedding_Contract SHALL định nghĩa tương thích embedding space là một khái niệm riêng, quyết định bởi compatibility identity đã khai báo, độc lập với việc so sánh tên model và độc lập với việc so sánh số chiều.
4. IF hai kết quả có cùng số chiều nhưng compatibility identity khác nhau, THEN THE Embedding_Runtime SHALL coi hai kết quả đó là không tương thích.
5. WHEN ứng dụng cung cấp một `Space_Id` kỳ vọng cho `embed()` hoặc `embedMany()`, THE Embedding_Runtime SHALL từ chối lời gọi bằng một structured error nếu `Space_Id` của `Prepared_Embedding_Call` không tương thích với giá trị kỳ vọng đó.
6. IF model embedding chính trả về lỗi, THEN THE Embedding_Runtime SHALL truyền lỗi ra ngoài thay vì chuyển sang một model embedding khác.
7. WHERE nhà cung cấp khai báo một nhóm model dùng chung embedding space và khai báo đó được biểu diễn bằng compatibility identity giống nhau, THE Embedding_Runtime SHALL cho phép cấu hình fallback trong nhóm đó.

### Requirement 7: Purpose khai báo một lần ở API chung

**User Story:** Là người phát triển ứng dụng RAG, tôi muốn khai báo mục đích của input một lần ở API chung, để không phải rải prefix riêng của từng model khắp ứng dụng.

#### Acceptance Criteria

1. THE Embedding_Contract SHALL định nghĩa `Purpose` với đúng hai giá trị `'retrieval-query'` và `'retrieval-document'`.
2. THE Embedding_Model_Handle SHALL yêu cầu `Purpose` cho mọi lời gọi `embed()` và `embedMany()`.
3. WHEN một `Physical_Batch` được dựng, THE Embedding_Adapter SHALL dịch `Purpose` sang cơ chế của provider tương ứng, ví dụ tham số wire chuyên dụng hoặc prefix do adapter chèn.
4. THE Embedding_Runtime SHALL giữ nguyên một `Space_Id` cho cả `'retrieval-query'` và `'retrieval-document'` khi hai recipe thuộc cùng một retrieval profile tương thích.
5. IF một provider không phơi ra cơ chế phân biệt `Purpose`, THEN THE Embedding_Catalog SHALL khai báo purpose handling của route đó là `unknown` hoặc `unsupported`, và THE Embedding_Adapter SHALL không tự thêm prefix không được tài liệu provider mô tả.
6. THE Embedding_Contract SHALL đặt trách nhiệm chèn prefix theo model ở tầng adapter, không ở phía ứng dụng gọi SDK.

### Requirement 8: N input độc lập cho N vector đúng thứ tự

**User Story:** Là người lập chỉ mục tài liệu, tôi muốn N input độc lập luôn tạo ra N vector đúng thứ tự, để mapping giữa chunk và vector không bị lệch.

#### Acceptance Criteria

1. WHEN một `Physical_Batch` gồm N input độc lập thành công, THE Embedding_Adapter SHALL trả về đúng N vector, mỗi vector mang chỉ số của input gốc.
2. IF response của provider chứa số vector khác số input, THEN THE Embedding_Adapter SHALL phát sinh một protocol error có code ổn định.
3. IF response của provider chứa chỉ số trùng lặp, thiếu hoặc ngoài khoảng, THEN THE Embedding_Adapter SHALL phát sinh một protocol error có code ổn định.
4. WHEN response của provider trả về các vector đảo thứ tự so với thứ tự input, THE Embedding_Adapter SHALL khôi phục mapping theo chỉ số do provider cung cấp.
5. THE Embedding_Contract SHALL phân tách hai tầng input: `items[]` cho các đối tượng cần embed độc lập, và `item.contentParts[]` cho các thành phần của cùng một đối tượng.
6. THE Embedding_Contract SHALL khai báo phạm vi v1 trong capabilities là input text và output một dense vector cho mỗi item.
7. IF một provider tổng hợp nhiều `contentParts` của một item thành một vector, THEN THE Embedding_Adapter SHALL giữ đúng một vector cho item đó và mapping tới item gốc.
8. THE Embedding_Contract SHALL biểu diễn output representation như một capability được khai báo, thay vì mô tả `number[]` là contract bao trùm mọi loại sparse hoặc multi-vector embedding.

### Requirement 9: Báo lỗi thay vì tự sửa dữ liệu

**User Story:** Là người vận hành, tôi muốn SDK báo lỗi thay vì tự sửa dữ liệu, để không có vector nào lặng lẽ được tạo từ nội dung bị cắt hoặc bị biến dạng.

#### Acceptance Criteria

1. IF độ dài input vượt giới hạn của model, THEN THE Embedding_Runtime SHALL phát sinh một structured error nêu chỉ số input và giới hạn áp dụng.
2. IF `dimensions` được yêu cầu không nằm trong danh sách dimensions mà route hỗ trợ, THEN THE Embedding_Runtime SHALL phát sinh một structured error trước khi gửi request.
3. IF response của provider thiếu vector cho một input đã gửi, THEN THE Embedding_Adapter SHALL phát sinh một protocol error.
4. IF một vector trong response chứa `NaN` hoặc `Infinity`, THEN THE Embedding_Adapter SHALL phát sinh một protocol error.
5. IF số chiều của vector trong response khác `dimensions` đã yêu cầu, THEN THE Embedding_Adapter SHALL phát sinh một protocol error thay vì cắt hoặc chèn thêm phần tử.
6. WHERE người gọi bật truncation một cách chủ động, WHEN input bị provider cắt bớt, THE Embedding_Runtime SHALL trả về kết quả kèm warning metadata nêu chỉ số input bị ảnh hưởng.
7. THE Embedding_Adapter SHALL đặt tham số truncation của provider theo giá trị người gọi khai báo, và mặc định của SDK SHALL là tắt truncation kể cả khi mặc định của provider là bật.
8. THE Embedding_Runtime SHALL đạt số chiều mong muốn bằng cơ chế do model hỗ trợ hoặc bằng một post-processing được ghi trong `Embedding_Profile`, thay vì slice hoặc pad vector.

### Requirement 10: Catalog metadata riêng cho embedding

**User Story:** Là người phát triển ứng dụng, tôi muốn metadata embedding tách khỏi metadata generation, để không phải đọc các trường vô nghĩa và không bị đoán sai năng lực.

#### Acceptance Criteria

1. THE Embedding_Catalog SHALL định nghĩa cấu trúc metadata riêng cho embedding model, và THE Embedding_Contract SHALL giữ `ResolvedModelInfo` không thêm trường dành riêng cho embedding.
2. THE Embedding_Catalog SHALL mô tả các thông tin: supported input types, output representation, supported dimensions, default dimensions, max input tokens, max batch items, max batch tokens, max batch bytes, purpose handling và normalization behavior.
3. THE Embedding_Catalog SHALL giữ tính advisory, và THE Embedding_Runtime SHALL chấp nhận một model id không xuất hiện trong catalog.
4. IF một capability không được provider hoặc cấu hình khai báo, THEN THE Embedding_Catalog SHALL biểu diễn capability đó là `unknown`.
5. THE Embedding_Catalog SHALL biểu diễn giá trị `supported` chỉ khi capability được khai báo tường minh bởi cấu hình adapter hoặc metadata provider.

### Requirement 11: Plugin kind riêng cho embedding

**User Story:** Là người bảo trì SDK, tôi muốn embedding được đăng ký bằng một plugin kind riêng, để plugin generation hiện có chạy không đổi và không phải nâng version contract.

#### Acceptance Criteria

1. THE Embedding_Provider_Plugin SHALL dùng một giá trị `kind` mới, khác `'model-provider-plugin'`.
2. THE Embedding_Contract SHALL giữ `ModelProviderRegistrar` với đúng hai method hiện có `registerAdapter()` và `use()`, và SHALL giữ `PROVIDER_PLUGIN_API_VERSION` ở giá trị `1`.
3. THE Embedding_Contract SHALL cung cấp `Embedding_Registrar`, một helper-only registrar view tương ứng, và một hàm định nghĩa plugin tương đương `defineModelProviderPlugin` cho embedding.
4. THE Agent_Runtime SHALL nhận `RuntimeOwnerOptions.providers` là một union gồm plugin generation và `Embedding_Provider_Plugin`.
5. THE Embedding_Registrar SHALL từ chối đăng ký adapter cho route không nằm trong danh sách route mà plugin đã khai báo trước.
6. WHEN Agent_Runtime khởi động, THE Startup_Preflight SHALL kiểm tra toàn bộ danh sách `providers`, thu thập mọi lỗi marker kind, lỗi apiVersion và trùng lặp cặp route–operation, trước khi commit bất kỳ plugin nào.
7. IF Startup_Preflight phát hiện một lỗi bất kỳ, THEN THE Agent_Runtime SHALL rollback mọi plugin đã setup trong lần khởi động đó và báo lỗi tổng hợp gồm các plugin id liên quan.
8. WHEN một plugin generation chỉ đăng ký `ModelAdapter` được truyền vào, THE Agent_Runtime SHALL khởi động, phục vụ generation và đóng thành công mà không cần embedding adapter.
9. WHEN danh sách `providers` chỉ chứa `Embedding_Provider_Plugin`, THE Agent_Runtime SHALL khởi động thành công, phục vụ `embeddingModel()` và đóng thành công.
10. WHERE một route có cả plugin generation và `Embedding_Provider_Plugin`, THE Agent_Runtime SHALL phân giải adapter theo bộ ba route, operation và model id.

### Requirement 12: Abort và close bao phủ embedding

**User Story:** Là người vận hành, tôi muốn abort và `close()` bao phủ cả embedding, để không có batch nào tiếp tục chạy sau khi runtime đã đóng.

#### Acceptance Criteria

1. THE Embedding_Runtime SHALL bổ sung một operation kind mới cho embedding vào `RUNTIME_OPERATION_KINDS`.
2. WHEN Agent_Runtime tạo `RuntimeCloseReport`, THE Agent_Runtime SHALL bao gồm một `RuntimeOperationCloseSummary` cho operation kind embedding, với các số `activeAtClose`, `aborted`, `settled` và `unsettled`.
3. WHEN `signal` truyền vào `embed()` hoặc `embedMany()` bị abort, THE Embedding_Runtime SHALL huỷ các `Physical_Batch` chưa gửi và dừng phát sinh `Physical_Batch` mới.
4. WHEN `signal` bị abort trong khi một `Provider_Attempt` đang chạy, THE Embedding_Runtime SHALL phát sinh một error có code abort ổn định và giải phóng response body của attempt đó.
5. WHEN `Agent_Runtime.close()` được gọi trong khi một `Logical_Call` embedding đang chạy, THE Agent_Runtime SHALL abort `Logical_Call` đó và phản ánh kết quả trong `RuntimeCloseReport`.
6. WHILE Agent_Runtime đang ở trạng thái đóng, THE Agent_Runtime SHALL từ chối lời gọi `embeddingModel()` mới bằng một error có code ổn định.

### Requirement 13: Tầng transport dùng chung trong provider-http

**User Story:** Là người bảo trì `provider-http`, tôi muốn transport được tách thành tầng dùng chung trước khi thêm pipeline JSON, để logic an toàn của HTTP không bị nhân bản giữa generation và embedding.

#### Acceptance Criteria

1. THE Http_Transport SHALL sở hữu connection snapshot một lần cho mỗi operation, gồm base URL, headers và các tham số giới hạn.
2. THE Http_Transport SHALL sở hữu các transport limit: max request bytes, max response bytes, max response chunks, max error body bytes và request logger timeout.
3. THE Http_Transport SHALL hợp signal của caller với controller teardown nội bộ và request timeout thành một signal duy nhất cho mỗi request.
4. THE Http_Transport SHALL gọi observer wire-request ở chế độ best-effort, với headers đã redact credential, và SHALL tiếp tục dispatch khi observer phát sinh lỗi hoặc quá thời hạn.
5. THE Http_Transport SHALL sở hữu provider-attempt accounting, gồm mở attempt trước khi gửi, ghi `dispatchState` với ba giá trị `'not-sent'`, `'sent'` và `'unknown'`, và kết thúc attempt trong khối `finally`.
6. THE Http_Transport SHALL sở hữu redirect guard, mapping lỗi HTTP kèm `retry-after` và request id, và teardown response body trong khối `finally`.
7. THE Sse_Pipeline SHALL dựng trên Http_Transport và giữ nguyên hành vi quan sát được của generation hiện tại, gồm bộ error code, thứ tự chunk, kiểm tra media type `text/event-stream` và quy tắc terminal finish.
8. THE Json_Pipeline SHALL dựng trên Http_Transport, kiểm tra media type response là JSON, và đọc body trong giới hạn bytes đã cấu hình.
9. WHEN thay đổi tại `packages/provider-http/src/base/http-adapter.ts` được hoàn tất, THE Sse_Pipeline SHALL vượt qua regression test generation cho cả bốn provider `provider-openai`, `provider-gemini`, `provider-anthropic` và `provider-codex`.
10. THE Sse_Pipeline SHALL giữ cơ chế usage honesty hiện tại, trong đó usage không đầy đủ vẫn là bằng chứng của `Provider_Attempt` nhưng không thoát ra ngoài dưới dạng `TokenUsage`.

### Requirement 14: Hai adapter provider trên cùng một API

**User Story:** Là người phát triển ứng dụng, tôi muốn hai provider embedding với semantics khác nhau chạy trên cùng một API, để biết abstraction không bị bó vào một nhà cung cấp.

#### Acceptance Criteria

1. THE OpenAI_Embedding_Adapter SHALL cư trú trong `packages/provider-openai`, tách khỏi phần protocol generation của package đó.
2. THE Gemini_Embedding_Adapter SHALL cư trú trong `packages/provider-gemini`, tách khỏi phần protocol generation của package đó.
3. THE OpenAI_Embedding_Adapter và THE Gemini_Embedding_Adapter SHALL dùng chung Http_Transport và Json_Pipeline của `packages/provider-http`.
4. THE OpenAI_Embedding_Adapter SHALL dịch `dimensions` sang tham số cấu hình số chiều của dòng model tương ứng khi route khai báo hỗ trợ tham số đó.
5. THE Gemini_Embedding_Adapter SHALL dịch `Purpose` sang tham số phân loại task của Gemini embedding API.
6. THE Gemini_Embedding_Adapter SHALL khai báo compatibility identity riêng cho từng thế hệ model, sao cho vector của hai thế hệ không tương thích được `Embedding_Runtime` phát hiện.
7. WHEN một `Physical_Batch` được gửi tới provider, THE OpenAI_Embedding_Adapter và THE Gemini_Embedding_Adapter SHALL bao gồm attribution headers của SDK trên mọi request.
8. THE OpenAI_Embedding_Adapter và THE Gemini_Embedding_Adapter SHALL đáp ứng cùng một bộ contract test embedding, với cùng bộ error code cho các trường hợp mapping, dimensions và vector không hợp lệ.

### Requirement 15: Endpoint embedding tự host

**User Story:** Là người vận hành nội bộ, tôi muốn trỏ SDK tới endpoint embedding tự host, để dùng model riêng mà không phải nhúng inference engine vào ứng dụng.

#### Acceptance Criteria

1. THE OpenAI_Embedding_Adapter SHALL nhận `baseUrl` cấu hình được, cho phép trỏ tới endpoint tương thích OpenAI do người dùng tự host.
2. THE Embedding_Contract SHALL không chứa model weights và không chứa inference engine chạy trong process.
3. THE Embedding_Contract SHALL biểu diễn khả năng tương thích của một endpoint tự host như một profile đã được kiểm thử, khai báo tường minh trong cấu hình route.
4. IF một endpoint tự host trả về response không thoả contract embedding, THEN THE Embedding_Adapter SHALL phát sinh protocol error thay vì suy diễn hành vi từ đường dẫn endpoint.
5. WHERE endpoint tự host dùng cleartext HTTP, THE Http_Transport SHALL yêu cầu người gọi bật tường minh tuỳ chọn cho phép HTTP không mã hoá.

### Requirement 16: Quan sát chi phí và lỗi không lộ nội dung

**User Story:** Là người vận hành, tôi muốn quan sát được chi phí và lỗi của embedding mà không để lộ nội dung tài liệu, để vừa kiểm soát ngân sách vừa giữ dữ liệu riêng tư.

#### Acceptance Criteria

1. THE Embedding_Runtime SHALL phân biệt ba mức trong dữ liệu quan sát: `Logical_Call`, `Physical_Batch` và `Provider_Attempt`.
2. IF provider không trả về usage cho một `Physical_Batch`, THEN THE Embedding_Runtime SHALL báo cáo usage của `Logical_Call` là missing hoặc partial thay vì gán giá trị không.
3. IF usage do provider trả về không đủ trường hoặc sai định dạng, THEN THE Embedding_Runtime SHALL giữ dữ liệu đó làm bằng chứng của `Provider_Attempt` và không phát ra dưới dạng `TokenUsage`.
4. THE Embedding_Runtime SHALL loại nội dung input thô và giá trị vector thô khỏi dữ liệu trace ở cấu hình mặc định.
5. THE Embedding_Runtime SHALL loại credential và header nhạy cảm khỏi mọi error record và trace record.
6. THE Embedding_Runtime SHALL báo cáo số `Provider_Attempt` của mỗi `Logical_Call`, để chi phí retry quan sát được.

### Requirement 17: Contract test mở rộng harness conformance

**User Story:** Là người bảo trì SDK, tôi muốn contract test embedding mở rộng harness conformance hiện có, để mọi provider embedding mới được kiểm tra bằng cùng một bộ tiêu chí.

#### Acceptance Criteria

1. THE Conformance_Harness SHALL được mở rộng bằng các scenario và check id mới cho embedding, giữ nguyên các giá trị hiện có của `ProviderConformanceScenario` và `ProviderConformanceCheckId`.
2. THE Conformance_Harness SHALL trả về kết quả embedding trong cùng cấu trúc `ProviderConformanceReport`.
3. THE Conformance_Harness SHALL kiểm tra mapping và validation, gồm response đảo thứ tự, chỉ số thiếu hoặc trùng, sai dimensions và vector chứa giá trị không hợp lệ.
4. THE Conformance_Harness SHALL kiểm tra batching theo ba giới hạn items, tokens và bytes, và kiểm tra rằng bộ nhớ dùng cho một `Logical_Call` bị chặn trên thay vì tỉ lệ thuận với toàn bộ corpus.
5. THE Conformance_Harness SHALL kiểm tra cancellation, gồm abort dừng các `Physical_Batch` chưa gửi và `Agent_Runtime.close()` bao phủ embedding operation đang chạy.
6. THE Conformance_Harness SHALL kiểm tra an toàn chi phí của retry, gồm việc không chạy lại một `Physical_Batch` đã thành công và việc timeout được ghi là trạng thái dispatch `unknown`.
7. THE Conformance_Harness SHALL kiểm tra thành phần cache key, gồm security scope, model/profile revision, purpose và recipe, dimensions cùng post-processing, và hash của input hiệu lực.
8. THE Conformance_Harness SHALL kiểm tra chặn truy vấn sai embedding space và kiểm tra rằng không có fallback sang model embedding khác khi thiếu compatibility identity tương thích.
9. THE Conformance_Harness SHALL kiểm tra tương thích plugin, gồm một plugin generation-only vẫn chạy và một runtime chỉ có embedding khởi động rồi đóng thành công.
10. THE Conformance_Harness SHALL kiểm tra privacy, gồm trace mặc định không chứa nội dung tài liệu thô và không chứa vector thô.
11. THE Embedding_Contract SHALL có unit test tại `tests/unit/` với hậu tố `*.spec.ts`, contract test tại `tests/contract/`, và fixture tại `tests/fixtures/` cùng `tests/negative-fixtures/` theo layout hiện tại của repository.
12. WHERE test cần gọi provider thật, THE Embedding_Contract SHALL đặt test đó tại `tests/integration/` chạy bằng `vitest.integration.config.ts`.

### Requirement 18: Tài liệu phản ánh năng lực embedding

**User Story:** Là người dùng SDK, tôi muốn tài liệu phản ánh năng lực embedding mới, để biết cách cấu hình và giới hạn thực tế của phạm vi v1.

#### Acceptance Criteria

1. THE Documentation_Set SHALL mô tả entry point `@alvin0/ai-agent-sdk-core/embedding` và cách gọi `embeddingModel()`, `embed()`, `embedMany()`.
2. THE Documentation_Set SHALL cập nhật `skills/ai-agent-sdk/references/providers.md` với `Embedding_Provider_Plugin` và hai adapter OpenAI cùng Gemini.
3. THE Documentation_Set SHALL cập nhật `skills/ai-agent-sdk/references/budgets-and-usage.md` với quy tắc usage của `Logical_Call`, `Physical_Batch` và `Provider_Attempt`.
4. THE Documentation_Set SHALL cập nhật `skills/ai-agent-sdk/references/errors.md` với các error code mới của embedding.
5. THE Documentation_Set SHALL cập nhật `skills/ai-agent-sdk/references/testing.md` với các scenario và check id embedding của Conformance_Harness.
6. THE Documentation_Set SHALL cập nhật `skills/ai-agent-sdk/references/packages.md` với entry point mới và vị trí module embedding.
7. THE Documentation_Set SHALL nêu phạm vi v1 là text và một dense vector cho mỗi item, cùng các hạng mục ngoài phạm vi gồm retrieval, vector store và semantic memory.

### Requirement 19: Không kéo theo nền tảng RAG

**User Story:** Là người dùng chỉ cần một agent đơn giản, tôi muốn việc bổ sung embedding không kéo theo nền tảng RAG, để ứng dụng không mang thêm dependency và tầng trừu tượng không dùng tới.

#### Acceptance Criteria

1. THE Embedding_Contract SHALL không chứa retrieval, vector store, semantic memory, chunker, parser, OCR hoặc reranker.
2. THE Embedding_Contract SHALL giữ `MemoryStore` và `AgentMemorySnapshot` hiện có không thay đổi ngữ nghĩa `load()` và `commit()`.
3. THE Embedding_Contract SHALL không thêm dependency runtime tới PostgreSQL, Redis hoặc MinIO vào `packages/core`.
4. WHEN một ứng dụng chỉ dùng generation, THE Agent_Runtime SHALL giữ nguyên kích thước bề mặt API generation và không yêu cầu cấu hình embedding nào.
5. THE Embedding_Contract SHALL để mọi import mới phân giải qua field `exports` của package theo rule của `.dependency-cruiser.cjs`.
6. WHEN kiểm tra kiến trúc được chạy, THE Embedding_Contract SHALL không tạo chu trình dependency mới giữa `embedding/`, `contract/`, `composition/` và `plugin/`.
