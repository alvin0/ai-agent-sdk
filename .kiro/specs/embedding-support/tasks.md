# Implementation Plan: embedding-support

## Overview

Kế hoạch triển khai theo đúng bốn khối phụ thuộc của design, thực hiện tuần tự:

1. **Khối 1 — `Http_Transport`** (`packages/provider-http`): tách tầng transport dùng chung, dựng lại `Sse_Pipeline` không đổi hành vi, rồi thêm `Json_Pipeline`. Chia thành ba đơn vị kiểm chứng độc lập theo DD-1: (a) thêm `transport/` + golden oracle, chưa ai dùng; (b) chuyển `HttpModelAdapter.run()` sang `transportStream`, chạy oracle + suite hiện có không sửa test nào; (c) thêm `transportJson`. Golden oracle **phải** được ghi trước khi chạm `src/base/http-adapter.ts`.
2. **Khối 2 — `Embedding_Contract`** (`packages/core/src/embedding/`): kiểu dữ liệu, giới hạn batch, `EmbeddingAdapter`, validation, entry point `./embedding`.
3. **Khối 3 — `Embedding_Runtime`** (`packages/core/src/composition/embedding/`): plugin kind riêng, registry, preflight, batching/concurrency/retry/cache/usage, `embeddingModel()`, operation kind mới.
4. **Khối 4 — Hai adapter provider + harness + tài liệu**: OpenAI, Gemini, mở rộng `Conformance_Harness`, cập nhật `Documentation_Set`.

Ngôn ngữ triển khai: **TypeScript** (theo design và toolchain hiện có của repository).

Mọi property test mang tag theo định dạng **Feature: embedding-support, Property {number}: {property text}** và chạy tối thiểu 100 iteration.

## Tasks

- [x] 1. Ghi golden oracle và dựng module `transport/` (đơn vị kiểm chứng a)
  - [x] 1.1 Ghi golden oracle cho đường generation TRƯỚC khi sửa `http-adapter.ts`
    - Viết script ghi oracle replay toàn bộ fixture SSE hiện có của `provider-openai`, `provider-gemini`, `provider-anthropic`, `provider-codex`
    - Lưu kết quả vào `packages/provider-http/tests/fixtures/generation-oracle/`
    - Nội dung mỗi bản ghi: chuỗi `StreamChunk` đã chuẩn hoá, tập error code, `dispatchState` từng attempt, số lần `attempt.end`, tập header đã redact
    - Ràng buộc thứ tự cứng: task này hoàn thành trước mọi thay đổi trong `packages/provider-http/src/base/http-adapter.ts`
    - _Requirements: 13.7, 13.9_

  - [x] 1.2 Tách `HttpTransportConnection` và transport limits
    - `packages/provider-http/src/transport/connection.ts`: `HttpTransportConnection`, `captureTransportConnection`
    - `packages/provider-http/src/transport/limits.ts`: `DEFAULT_*` + `resolveTransportLimits`
    - Sửa `HttpConnection` thành `extends HttpTransportConnection`, giữ `streamIdleTimeoutMs`, `maxSseEvents`, `maxSseEventChars`, `models`, `defaultMaxTokens`, `defaultContextWindow` ở phía generation để cấu hình provider hiện có tiếp tục compile
    - Task này **không** tạo `EmbeddingHttpConnection`: kiểu đó cần vocabulary của `Embedding_Catalog` và entry point `./embedding`, nên nó thuộc task 12.1
    - _Requirements: 13.1, 13.2_

  - [x] 1.3 Viết chuỗi an toàn dùng chung `transport/session.ts` và `transportStream`
    - `withTransportSession`: fuse signal (caller + teardown controller + request timeout), kiểm tra `maxRequestBytes`, `observeRequest` best-effort với `redactHeaders` và `requestLoggerTimeoutMs`, `startProviderAttempt`, `fetch(redirect: 'manual')`, `rejectProviderRedirect`, map non-2xx kèm `retry-after` + request id, `finally` gọi `attempt.end` đúng một lần + `consumer.abort` + `cancelResponseBody`
    - Giữ nguyên thứ tự phân loại lỗi: `timeout.aborted && caller.signal?.aborted !== true` ⇒ `TIMEOUT`; `signal.aborted` ⇒ `ABORTED`; còn lại ⇒ `normalizeHttpBoundaryError`
    - `admissionFailure` từ `startProviderAttempt` được ném nguyên trạng, không bọc qua `normalizeHttpBoundaryError`
    - `transportStream` giữ attempt mở suốt thời gian stream được tiêu thụ
    - _Requirements: 13.1, 13.3, 13.4, 13.5, 13.6_

  - [x] 1.4 Viết property test cho `Http_Transport` session
    - `packages/provider-http/tests/unit/transport/session.spec.ts`
    - **Property 33: Signal hợp nhất bao phủ cả ba nguồn abort**
    - **Property 34: Observer wire-request là best-effort và không rò rỉ credential**
    - **Property 35: Attempt accounting đóng đúng một lần trên mọi đường thoát**
    - **Property 36: Redirect guard, error mapping và teardown luôn được áp dụng**
    - **Validates: Requirements 13.3, 13.4, 13.5, 13.6**

- [x] 2. Chuyển `Sse_Pipeline` sang `Http_Transport` (đơn vị kiểm chứng b)
  - [x] 2.1 Viết lại `HttpModelAdapter.run()` trên `transportStream`
    - `packages/provider-http/src/base/http-adapter.ts`: `run()` (private) trở thành lời gọi `transportStream` với `decode` chứa đúng phần SSE
    - `decodeSse` giữ `accept: text/event-stream`, kiểm tra `STREAM_MEDIA_TYPE_INVALID`, `parseSseBounded` với `maxSseEvents`/`maxSseEventChars`, `createStreamIdleDeadline`, `requireTerminalFinish`, `translate(events, request)`, `validateUsageCounters(chunk.usage, true)` theo từng chunk
    - Giữ nguyên toàn bộ bề mặt mà provider hiện có phụ thuộc, đúng theo visibility hiện tại: `protected abstract` `connect`, `endpointPath`, `buildBody`, `translate`; `protected` có default `baseHeaders`, `observeRequest`, `providerErrorCode`, `modelInfoFor`, `decorateModel`; `public` `providerInfo`, `listModels`, `resolveModel`, `prepareCall`, `stream`
    - `PreparedWireBodyCache` ở lại pipeline, không chuyển vào transport
    - Kiểm tra modality giữ nguyên vị trí, trước mọi hoạt động transport
    - _Requirements: 13.7, 13.10_

  - [x] 2.2 Viết property test tương đương SSE so với golden oracle
    - `packages/provider-http/tests/contract/sse-equivalence.spec.ts`
    - **Property 37: Sse_Pipeline sau refactor tương đương pipeline trước refactor**
    - So khớp từng byte bản chuẩn hoá với fixture ghi ở task 1.1
    - **Validates: Requirements 13.7, 13.9**

  - [x] 2.3 Chạy regression generation cho bốn provider mà không sửa một test nào
    - `pnpm test` của `packages/provider-http`, `provider-openai`, `provider-gemini`, `provider-anthropic`, `provider-codex`
    - Chạy lại 19 check id hiện có của `ProviderConformanceReport` cho bốn provider fixture
    - Bất kỳ test phải sửa để pass là tín hiệu regression, xử lý như bug chứ không như test lỗi thời
    - _Requirements: 13.9_

- [x] 3. Checkpoint - đảm bảo đường generation không đổi hành vi
  - Barrier: không task nào sau đây được bắt đầu trước khi task 1.x và 2.x hoàn thành.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Thêm `Json_Pipeline` (đơn vị kiểm chứng c)
  - [x] 4.1 Viết `transport/json.ts` với `transportJson`
    - `JSON_MEDIA_TYPES`, kiểm tra media type JSON, đọc body trong giới hạn `maxResponseBytes`, `JSON.parse` và map lỗi parse thành protocol error
    - Thêm một entry vào `HTTP_PROVIDER_ERROR_CODES` theo convention hiện tại của `common/config.ts`: key `JSON_MEDIA_TYPE_INVALID`, value `'HTTP_JSON_MEDIA_TYPE_INVALID'` — đối xứng với `STREAM_MEDIA_TYPE_INVALID: 'HTTP_STREAM_MEDIA_TYPE_INVALID'` đang có
    - Body vượt giới hạn dùng `MODEL_ERROR_CODES.TRANSPORT`
    - _Requirements: 13.8_

  - [x] 4.2 Viết property test cho `Json_Pipeline`
    - `packages/provider-http/tests/unit/transport/json.spec.ts`
    - **Property 38: Json_Pipeline kiểm tra media type và giới hạn body**
    - **Validates: Requirements 13.8**

- [x] 5. Định nghĩa kiểu dữ liệu `Embedding_Contract`
  - [x] 5.1 Viết request, result và purpose type
    - `packages/core/src/embedding/request.ts`: `EmbeddingContentPart`, `EmbeddingItem` (index là chỉ số trong `Logical_Call`), `EmbeddingTruncation`, `EmbeddingBatchRequest` với mặc định `truncation: 'reject'`
    - `packages/core/src/embedding/result.ts`: `EmbeddingVector`, `EmbeddingBatchResult`, `EmbeddingWarning`, `EmbeddingResult`, `EmbeddingManyResult` — không tham chiếu `StreamChunk`, message, tool call hay text delta
    - `packages/core/src/embedding/purpose.ts`: `EmbeddingPurpose` đúng hai giá trị, `EmbeddingPurposeHandling` ba dạng `wire-parameter` / `adapter-prefix` / `none`
    - _Requirements: 1.3, 7.1, 8.5, 8.8, 9.7_

  - [x] 5.2 Viết `Embedding_Profile`, dẫn xuất `Space_Id` và profile default
    - `packages/core/src/embedding/profile.ts`: `EmbeddingRepresentation`, `EmbeddingNormalization`, `EmbeddingPostProcessing`, `EmbeddingProfile`, `EmbeddingSpaceId` (branded type)
    - `deriveSpaceId` là hàm **đồng bộ** trả về canonical string, KHÔNG dùng `crypto.subtle` và không băm (DD-11): ghép `compatibilityIdentity`, `dimensions`, `representation`, `normalization`, `postProcessing` (kind + revision), `profileRevision` theo thứ tự cố định, mỗi thành phần escape ký tự `|` và `\` trước khi ghép
    - **Loại** `documentRecipeRevision` và `queryRecipeRevision` khỏi dẫn xuất (DD-7)
    - `isSpaceCompatible` so cùng bộ đó, độc lập với so sánh tên model và độc lập với so sánh số chiều
    - `defaultEmbeddingProfile(model, request)`: default dùng được cho `EmbeddingAdapter.embeddingProfile()` — `compatibilityIdentity` dẫn xuất từ `${route}:${modelId}` khi catalog không khai báo, normalization `'unknown'`, không post-processing (DD-13)
    - _Requirements: 1.2, 6.1, 6.3, 6.4, 7.4_

  - [x] 5.3 Viết property test cho `Embedding_Profile`
    - `packages/core/tests/unit/embedding/profile.spec.ts`
    - **Property 14: Tương thích space quyết định bởi compatibility identity**
    - **Property 17: Space_Id bất biến khi chỉ purpose thay đổi**
    - Kèm unit test: `deriveSpaceId` đồng bộ (giá trị trả về không phải `Promise`), và hai bộ thành phần khác nhau không cho cùng một canonical string
    - Property 22 **không** ở file này: nó so vector provider trả về với vector trả ra ngoài, nên cần một adapter và một response — xem task 6.7, 12.4, 13.3
    - **Validates: Requirements 6.3, 6.4, 7.4, 14.6**

  - [x] 5.4 Viết `Embedding_Catalog` và giới hạn batch
    - `packages/core/src/embedding/catalog.ts`: `EmbeddingCapability<T>` ba state, `EmbeddingInputType` (đúng `'text'`), `EmbeddingModelInfo`, `ResolvedEmbeddingModelInfo`, `unknownEmbeddingModel`
    - Phạm vi v1 khai báo bằng kiểu: `EmbeddingInputType` chỉ có `'text'` và `EmbeddingRepresentation` chỉ có `'dense-float32'` — một dense vector cho mỗi item, không sparse, không multi-vector, không multimodal
    - `packages/core/src/embedding/limits.ts`: `EMBEDDING_BATCH_DEFAULTS` (`maxItems: 96`, `maxTokens: 100_000`, `maxBytes: 1MiB`), `ResolvedEmbeddingBatchLimits`, `resolveBatchLimits`, `estimateTokens` mặc định `ceil(utf8Bytes / 4)`
    - Ba kiểu/hàm giới hạn nằm ở `embedding/`, KHÔNG ở `composition/embedding/planner.ts` (DD-12): `PreparedEmbeddingCall.limits` và `EmbeddingModelOptions.batchLimits` tiêu thụ chúng, nên đặt ở composition sẽ tạo chiều phụ thuộc ngược mà Yêu cầu 1.6 và 19.6 cấm
    - `estimateTokens` có **một** chủ sở hữu duy nhất ở đây, dùng chung cho batching và cho kiểm tra độ dài input
    - Default dùng cho batching khi capability là `unknown`; capability `unknown` không bao giờ là lý do từ chối request (DD-6)
    - Giữ `ResolvedModelInfo` trong `contract/model-info.ts` không thêm trường embedding nào
    - _Requirements: 8.6, 10.1, 10.2, 10.4, 10.5_

  - [x] 5.5 Viết property test cho `Embedding_Catalog`
    - `packages/core/tests/unit/embedding/catalog.spec.ts`
    - **Property 24: Capability không khai báo là `unknown`, `supported` cần khai báo tường minh**
    - **Property 25: Catalog là advisory**
    - Kèm test cấu trúc cho phạm vi v1: `EmbeddingInputType` và `EmbeddingRepresentation` không nhận giá trị nào ngoài `'text'` và `'dense-float32'`
    - **Validates: Requirements 8.6, 10.3, 10.4, 10.5**

  - [x] 5.6 Viết kiểu usage riêng cho embedding
    - `packages/core/src/embedding/usage.ts`: `EmbeddingTokenUsage` (`inputTokens` bắt buộc, `totalTokens` tùy chọn — không có `outputTokens`), `EmbeddingUsageReport` với `status`/`batches`/`batchesWithUsage`/`providerAttempts`/`inputsFromCache`/`inputsFromProvider`
    - `validateEmbeddingUsage` là bản đối ứng của `validateUsageCounters`; không nhánh nào gán giá trị 0 (DD-5)
    - _Requirements: 16.2, 16.3_

  - [x] 5.7 Viết error code và error class embedding
    - `packages/core/src/embedding/errors.ts`: `EMBEDDING_ERROR_CODES` đủ 15 giá trị theo design, `EmbeddingError extends AgentSdkError` với `itemIndexes`, `limit`, `provider`, `model`, `space`
    - _Requirements: 3.5, 8.2, 8.3, 9.1, 9.2_

- [x] 6. Viết `EmbeddingAdapter`, validation và entry point `./embedding`
  - [x] 6.1 Viết `EmbeddingAdapter` và `PreparedEmbeddingCall`
    - `packages/core/src/embedding/adapter.ts`: abstract class độc lập, **không** kế thừa `ModelAdapter`, **đúng một** abstract method `embedBatch()`
    - Default hoạt động được cho `providerInfo`, `providerRetryPolicy`, `listEmbeddingModels`, `resolveEmbeddingModel`, `prepareEmbeddingCall`, và cho `embeddingProfile()` — `embeddingProfile()` gọi `defaultEmbeddingProfile()` của task 5.2, KHÔNG phải abstract member thứ hai (DD-13)
    - `prepareEmbeddingCall` gắn metadata, profile, `spaceId` và `limits` với hàm dispatch trong **cùng một lần capture**, trả object đã `freeze`; gọi `deriveSpaceId` đồng bộ và `resolveBatchLimits` của `embedding/limits.ts`
    - Giữ nguyên `ModelAdapter.stream()` và `PreparedAdapterCall`, giữ `PROVIDER_PLUGIN_API_VERSION` ở `1`
    - _Requirements: 1.1, 1.2, 1.5, 2.1, 4.1_

  - [x] 6.2 Viết validation tiền-dispatch và validation response
    - `packages/core/src/embedding/validation.ts`: `validatePreDispatch` (purpose, values/contentParts rỗng, dimensions, max input tokens, `expectedSpace`, truncation) và `validateBatchResult`
    - `estimateTokens` **không** định nghĩa ở file này; validation import nó qua `limits.estimateTokens` của `PreparedEmbeddingCall`, cùng hàm mà planner dùng
    - Chỉ từ chối khi capability tương ứng là `supported` và giá trị vi phạm; capability `unknown` không được biến thành lý do từ chối (DD-6)
    - Mọi lỗi tiền-dispatch xảy ra với 0 `Provider_Attempt`, kèm `itemIndexes` và `limit`
    - _Requirements: 3.6, 9.1, 9.2, 10.3_

  - [x] 6.3 Viết property test cho validation tiền-dispatch
    - `packages/core/tests/unit/embedding/validation.spec.ts`
    - **Property 2: Vi phạm khai báo bị từ chối trước khi có bất kỳ Provider_Attempt**
    - **Validates: Requirements 3.6, 7.2, 9.1, 9.2, 9.7**

  - [x] 6.4 Khai báo bề mặt công khai và entry point mới
    - `packages/core/src/embedding/handle.ts`: `EmbeddingModelOptions`, `EmbedOneInput`, `EmbedManyInput`, `EmbeddingModelHandle` — type-only, không phụ thuộc `composition/`; `batchLimits?: Partial<ResolvedEmbeddingBatchLimits>` lấy kiểu từ `embedding/limits.ts`
    - `packages/core/src/embedding/index.ts`: barrel công khai của entry point `./embedding`, export cả `EMBEDDING_BATCH_DEFAULTS`, `ResolvedEmbeddingBatchLimits`, `resolveBatchLimits`, `estimateTokens`, `defaultEmbeddingProfile`
    - `packages/core/package.json`: thêm `"./embedding"` vào `exports`
    - `packages/core/tsdown.config.ts`: thêm entry `embedding: 'src/embedding/index.ts'`
    - Root entry `.` re-export chỉ type của bề mặt runtime: `EmbeddingModelHandle`, `EmbeddingModelOptions`, `EmbeddingResult`, `EmbeddingManyResult`, `EmbeddingUsageReport`
    - _Requirements: 1.4, 19.5_

  - [x] 6.5 Viết test cấu trúc cho bề mặt embedding
    - `packages/core/tests/unit/embedding/surface.spec.ts`
    - Type test và API surface snapshot: `EmbeddingAdapter` không kế thừa `ModelAdapter`, **đúng một** abstract method (`embedBatch`, và `embeddingProfile` có default nên không tính), kết quả không chứa `StreamChunk`, `ResolvedModelInfo` không thêm trường embedding, `ModelProviderRegistrar` giữ đúng hai method, `PROVIDER_PLUGIN_API_VERSION === 1`
    - Smoke test: entry `./embedding` phân giải được, phần generation của entry `.` không đổi
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 6.1, 8.5, 8.6, 8.8, 10.1, 10.2, 11.1, 11.2, 11.3, 11.4, 12.1, 19.4_

  - [x] 6.6 Viết fixture và negative fixture cho embedding
    - `packages/core/tests/fixtures/embedding/fake-adapter.ts`: adapter điều khiển được lỗi, delay, permutation thứ tự vector, usage vắng mặt/sai định dạng, và vector do "provider" trả về để so sánh trung thực
    - `packages/core/tests/negative-fixtures/embedding/`: `bad-mapping.ts`, `bad-vector.ts`, `bad-usage.ts`, `bad-plugin.ts`
    - _Requirements: 17.11_

  - [x] 6.7 Viết bộ contract test cho `Embedding_Adapter`
    - `packages/core/tests/contract/embedding/adapter-contract.spec.ts`
    - Bộ tiêu chí mà mọi `Embedding_Adapter` phải đạt: đúng một `Provider_Attempt` mỗi lần gọi, tôn trọng `batch.signal`, gắn chỉ số input gốc, phát protocol error thay vì suy diễn
    - **Property 22: Vector trả ra trung thực với vector provider trả về** — dùng fake adapter của task 6.6: không post-processing thì vector khớp từng phần tử, có post-processing thì biến đổi đúng bằng bước ghi trong profile
    - **Validates: Requirements 4.1, 4.3, 9.8, 14.8, 17.11**

- [x] 7. Checkpoint - `Json_Pipeline` và `Embedding_Contract` hoàn chỉnh, độc lập
  - Barrier: không task nào sau đây được bắt đầu trước khi task 4.x, 5.x và 6.x hoàn thành.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Dựng plugin kind riêng, registry và startup preflight
  - [x] 8.1 Viết plugin type và `defineEmbeddingProviderPlugin`
    - `packages/core/src/composition/embedding/plugin-types.ts`: `EMBEDDING_PROVIDER_PLUGIN_API_VERSION = 1`, `EmbeddingProviderRegistrar`, `ComposableEmbeddingProviderPlugin` với `kind: 'embedding-provider-plugin'`, `ComposableEmbeddingProviderRegistrar`, union `ComposableRuntimeProviderPlugin`
    - `packages/core/src/composition/embedding/definition.ts`: `defineEmbeddingProviderPlugin` đóng marker `kind` + `apiVersion`, trao registrar view chỉ đăng ký trong phạm vi `routes` đã khai báo
    - Export qua entry point `./provider` cạnh `defineModelProviderPlugin`
    - _Requirements: 11.1, 11.2, 11.3, 11.5_

  - [x] 8.2 Viết `EmbeddingRegistry` phân giải theo route + operation + model id
    - `packages/core/src/composition/embedding/registry.ts`: khớp entry theo `models[]` trước, rồi entry route-wide, hết thì `EMBEDDING_ADAPTER_MISSING`
    - Registry tách biệt hoàn toàn với `ModelRegistry`, cùng khoá route nhưng khác operation
    - _Requirements: 3.5, 11.10_

  - [x] 8.3 Mở rộng `Startup_Preflight` để thu mọi lỗi
    - `packages/core/src/composition/embedding/preflight.ts` hợp nhất vào `composition/preflight.ts`: quét toàn bộ `providers` không throw, phân hoạch theo kind, validate identity + marker, bảng route–operation phát hiện trùng
    - `ProviderPreflightFailure` với `index`, `code`, `pluginId`, `conflictsWithIndex`; `RuntimeProviderPlan` gồm `generation` + `embedding`
    - **`packages/core/src/composition/common/errors.ts`**: thêm `'PROVIDER_OPERATION_CONFLICT'` vào union đóng `RuntimeConstructionFailureCode` (hiện 9 giá trị), và thêm trường `aggregate` vào `ConstructionFailure` cùng `AgentRuntimeConstructionError`. `failureCode` lấy kiểu từ union này nên không sửa file này thì `failureCode = failures[0].code` không compile
    - Giữ `failureCode` bằng code của failure **đầu tiên**, `aggregate` liệt kê mọi failure (DD-3)
    - Preflight xảy ra trước `captureProviderMethods`; số plugin đã `setup()` khi có lỗi phải bằng 0
    - _Requirements: 11.6_

  - [x] 8.4 Mở rộng activation và rollback dùng chung hai plugin kind
    - `packages/core/src/composition/embedding/activation.ts` + cập nhật `activateProviders`: một danh sách `installed[]` dùng chung, activate generation trước rồi embedding, lỗi ở bất kỳ bước nào thì rollback toàn bộ danh sách chung theo thứ tự ngược
    - `AgentRuntimeConstructionError` mang `cleanup` rows và plugin id liên quan
    - Hai kịch bản biên phải chạy: chỉ plugin generation, và chỉ `Embedding_Provider_Plugin`
    - _Requirements: 11.7, 11.8, 11.9_

  - [x] 8.5 Viết property test cho plugin registrar và preflight
    - `packages/core/tests/unit/embedding/plugin-preflight.spec.ts`
    - **Property 26: Registrar không cho đăng ký ra ngoài route đã khai báo**
    - **Property 27: Preflight thu mọi lỗi và không commit plugin nào**
    - **Property 28: Phân giải adapter theo bộ ba route, operation và model id**
    - **Validates: Requirements 11.5, 11.6, 11.7, 11.10**

- [x] 9. Dựng tầng điều phối: planner, limiter, retry, cache, usage
  - [x] 9.1 Viết batch planner lười
    - `packages/core/src/composition/embedding/planner.ts`: generator `planEmbeddingBatches` đóng batch khi thêm item tiếp theo vượt bất kỳ một trong ba giới hạn items/tokens/bytes
    - Planner **import** `ResolvedEmbeddingBatchLimits` từ `embedding/limits.ts` và không định nghĩa kiểu giới hạn nào của riêng nó (DD-12)
    - Bất biến: mỗi batch ≤ mọi giới hạn, mỗi item xuất hiện đúng một lần trong đúng một batch
    - Ngoại lệ có chủ ý: item đơn lẻ tự vượt giới hạn thành batch một-item, không cắt nội dung
    - Dùng `EMBEDDING_BATCH_DEFAULTS` khi capability là `unknown`
    - _Requirements: 4.4, 17.4_

  - [x] 9.2 Viết property test cho batch planner và limiter
    - `packages/core/tests/unit/embedding/planner.spec.ts`
    - **Property 5: Batch tôn trọng ba giới hạn và bộ nhớ bị chặn trên**
    - **Property 6: Số batch chạy đồng thời không vượt cấu hình**
    - **Validates: Requirements 4.4, 4.5, 17.4**

  - [x] 9.3 Viết concurrency limiter
    - `packages/core/src/composition/embedding/limiter.ts`: giới hạn số `Physical_Batch` đang bay theo giá trị concurrency cấu hình, bộ nhớ payload đỉnh bị chặn bởi `concurrency × maxBytes`
    - _Requirements: 4.5, 17.4_

  - [x] 9.4 Viết tầng retry duy nhất
    - `packages/core/src/composition/embedding/retry.ts`: `BatchState` bốn phase, retry chỉ batch chưa thành công, batch `succeeded` bị loại khỏi mọi lượt retry tiếp theo
    - Timeout ghi `dispatch: 'unknown'`, lấy `dispatchState` từ transport chứ không suy diễn lại
    - Không có fallback model; lỗi của model chính được truyền ra ngoài
    - _Requirements: 4.2, 4.3, 4.7, 4.8, 6.6_

  - [x] 9.5 Viết property test cho retry và chi phí
    - `packages/core/tests/unit/embedding/retry.spec.ts`
    - **Property 8: Số Provider_Attempt bằng số lần adapter được gọi và được báo cáo đúng**
    - **Property 9: Batch đã thành công không bao giờ được gửi lại**
    - **Property 10: Timeout được ghi là dispatch không xác định**
    - **Validates: Requirements 4.3, 4.7, 4.8, 16.6**

  - [x] 9.6 Viết `Embedding_Cache` tùy chọn
    - `packages/core/src/composition/embedding/cache.ts`: `EmbeddingCacheOptions` với `scope` **bắt buộc, không có default** — thiếu `scope` là `EMBEDDING_CONFIGURATION_INVALID` (DD-8)
    - `embeddingCacheKey` là hàm **async** và là chỗ duy nhất trong spec cần digest: băm năm thành phần bằng `crypto.subtle.digest('SHA-256')` — security scope, model/profile revision, purpose + recipe revision, dimensions + post-processing, hash input hiệu lực. Nó nén nội dung input không bị chặn thành khoá độ dài cố định, khác `deriveSpaceId` vốn đồng bộ và không băm (DD-11)
    - Cache mặc định tắt, nên `crypto.subtle` không nằm trên đường đi bắt buộc của `packages/core`
    - Cửa thứ hai: entry có `Space_Id` khác `Space_Id` của prepared call bị bỏ qua và phát sinh batch mới
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 9.7 Viết property test cho cache key và space guard của cache
    - `packages/core/tests/unit/embedding/cache-key.spec.ts`
    - **Property 11: Cache key phản ánh đúng năm thành phần**
    - **Property 12: Entry cache khác embedding space bị bỏ qua**
    - **Property 13: Số liệu cache và provider cộng đủ tổng input**
    - **Validates: Requirements 5.2, 5.3, 5.4**

  - [x] 9.8 Viết tổng hợp usage giữ tính trung thực
    - `packages/core/src/composition/embedding/usage.ts`: `complete` khi mọi batch gửi provider trả usage đọc được, `partial` khi một phần, `missing` khi không batch nào; usage sai định dạng sinh warning `usage-malformed`
    - Tách `inputsFromCache` và `inputsFromProvider`, tổng hai số bằng số input của `Logical_Call`
    - `providerAttempts` bằng tổng attempt của `Logical_Call`; không nhánh nào gán giá trị 0
    - _Requirements: 5.4, 16.2, 16.3, 16.6_

  - [x] 9.9 Viết property test cho usage honesty
    - `packages/core/tests/unit/embedding/usage.spec.ts`
    - **Property 39: Usage không đầy đủ không bao giờ thoát ra dưới dạng số liệu công bố**
    - **Validates: Requirements 13.10, 16.2, 16.3**

- [x] 10. Nối bề mặt runtime và lifecycle
  - [x] 10.1 Thêm operation kind embedding và tích hợp `close()`
    - `packages/core/src/composition/lifecycle/types.ts`: **append** `'embedding-call'` vào cuối `RUNTIME_OPERATION_KINDS`, không prepend (DD-4)
    - Thêm assertion tường minh `RUNTIME_OPERATION_KINDS[0] === 'agent-run'` để giữ nguồn của `activeRunsAtClose`/`abortedRuns`/`unsettledRuns`
    - Xác nhận `RuntimeCloseReport.operations` tự có `RuntimeOperationCloseSummary` cho embedding qua `beginClose()`; lease signal fuse root controller + caller signal
    - Task này đứng **trước** task 10.2: `embed()`/`embedMany()` gọi `operations.execute('embedding-call')`, nên operation kind phải tồn tại trước
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 10.2 Triển khai `embed()` và `embedMany()`
    - `packages/core/src/composition/embedding/handle.ts`: gọi `prepareEmbeddingCall` một lần cho mỗi `Logical_Call`, `validatePreDispatch`, cache lookup (`await embeddingCacheKey`), plan batch, dispatch qua limiter + retry
    - Khôi phục thứ tự bằng ghi vào `results[item.index]` của mảng cấp phát trước, độc lập thứ tự batch settle
    - Gắn `space`, `profile`, `usage`, `warnings` vào kết quả; từ chối `expectedSpace` không tương thích bằng `EMBEDDING_SPACE_INCOMPATIBLE`; từ chối cấu hình fallback ngoài nhóm cùng `compatibilityIdentity`
    - _Requirements: 2.2, 2.3, 2.4, 3.2, 3.3, 4.6, 6.2, 6.5, 6.7_

  - [x] 10.3 Viết property test cho khôi phục thứ tự
    - `packages/core/tests/unit/embedding/order.spec.ts`
    - **Property 7: Thứ tự kết quả theo chỉ số input, độc lập thứ tự hoàn thành**
    - **Validates: Requirements 4.6, 8.4**

  - [x] 10.4 Viết `RuntimeEmbedding` manager
    - `packages/core/src/composition/embedding/manager.ts` + `index.ts` barrel nội bộ: manager do `RuntimeCompositionOwner` sở hữu, cấp `EmbeddingModelHandle`, giữ registry và cache theo runtime
    - _Requirements: 3.1, 3.4_

  - [x] 10.5 Thêm `embeddingModel()` vào bề mặt `Agent_Runtime`
    - `packages/core/src/composition/runtime/types.ts`: thêm `embeddingModel(options): EmbeddingModelHandle` vào `RuntimeCompositionView`, mở `RuntimeOwnerOptions.providers` thành `readonly ComposableRuntimeProviderPlugin[]`
    - `embeddingModel()` đồng bộ, gọi `operations.assertActive()` rồi phân giải adapter ngay, không khởi tạo agent/team/session
    - _Requirements: 3.1, 3.4, 11.4, 12.6, 19.4_

  - [x] 10.6 Phát dữ liệu quan sát ba mức
    - Span `sdk.embedding.call` (route, model, purpose, itemCount, spaceId, cacheHits, providerAttempts), span con `sdk.embedding.batch` (itemCount, byteCount, estimatedTokens, dimensions), attempt qua `context.startProviderAttempt` / `attempt.end`
    - Loại nội dung input thô và giá trị vector thô khỏi trace ở cấu hình mặc định; mọi record đi qua `redactHeaders` + `safeProviderFailure`
    - _Requirements: 16.1, 16.4, 16.5_

  - [x] 10.7 Viết property test cho `Embedding_Model_Handle`
    - `packages/core/tests/unit/embedding/handle.spec.ts`
    - **Property 3: Route không có adapter bị từ chối bằng code ổn định**
    - **Property 4: Mọi kết quả mang vector, usage và Space_Id**
    - **Property 15: Space_Id kỳ vọng không tương thích thì lời gọi bị từ chối**
    - **Property 16: Không có fallback ra ngoài nhóm đã khai báo tương thích**
    - **Property 31: Runtime đang đóng từ chối handle mới**
    - Kèm unit test kịch bản: `embeddingModel()` không tạo agent/team/session, runtime chỉ có generation và runtime chỉ có embedding
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 6.2, 6.5, 6.6, 6.7, 11.8, 11.9, 12.6**

  - [x] 10.8 Viết property test cho cancellation và close
    - `packages/core/tests/unit/embedding/lifecycle.spec.ts`
    - **Property 29: Close report cân bằng số học cho operation embedding**
    - **Property 30: Abort dừng batch chưa gửi và giải phóng body**
    - **Validates: Requirements 12.2, 12.3, 12.4, 12.5**

  - [x] 10.9 Viết property test cho snapshot cấu hình
    - `packages/core/tests/unit/embedding/snapshot.spec.ts`
    - **Property 1: Snapshot cấu hình bất biến trong một Logical_Call**
    - **Property 32: Connection snapshot đúng một lần cho mỗi operation**
    - **Validates: Requirements 2.2, 2.3, 2.4, 13.1**

  - [x] 10.10 Viết property test cho quan sát và privacy
    - `packages/core/tests/unit/embedding/observation.spec.ts`
    - **Property 44: Dữ liệu quan sát phân biệt đủ ba mức**
    - **Property 45: Trace và error không chứa nội dung thô, vector thô hay credential**
    - **Validates: Requirements 16.1, 16.4, 16.5**

- [x] 11. Checkpoint - `Embedding_Runtime` chạy được với fake adapter
  - Barrier: không task nào sau đây được bắt đầu trước khi task 8.x, 9.x và 10.x hoàn thành.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Viết `OpenAI_Embedding_Adapter`
  - [x] 12.1 Định nghĩa cấu hình route embedding dùng chung trong `provider-http`
    - `packages/provider-http/src/transport/embedding-connection.ts`: `EmbeddingCatalogModel` (id, name, description, dimensions, defaultDimensions, maxInputTokens, maxBatch*, purposeHandling, normalization, `compatibilityIdentity` bắt buộc) và `EmbeddingHttpConnection extends HttpTransportConnection`
    - Trường vắng mặt dịch thành capability `unknown`, trường có mặt dịch thành `supported`; `compatibilityIdentity` là tuyên bố tường minh về embedding space, kể cả cho endpoint tự host
    - Task này đứng ở đây chứ không ở 1.2 vì nó tham chiếu vocabulary của `Embedding_Catalog` và cần entry point `./embedding` đã tồn tại
    - Cả `OpenAI_Embedding_Adapter` và `Gemini_Embedding_Adapter` dùng chung kiểu này
    - _Requirements: 10.5, 14.3, 15.3_

  - [x] 12.2 Viết adapter và plugin factory
    - `packages/provider-openai/src/embedding.ts`: `OpenAiEmbeddingProviderOptions`, `openAiEmbeddingAdapter()`, `openAiEmbeddingPlugin()`, tách hoàn toàn khỏi `openAiResponsesProtocol`
    - Wire `POST {baseUrl}/embeddings` với `model`, `input[]`, `encoding_format: 'float'`, `dimensions` chỉ khi `model.dimensions.state === 'supported'`
    - Override `embeddingProfile()` để khai báo `compatibilityIdentity` thật của dòng model, thay vì nhận `defaultEmbeddingProfile()`
    - Route khai báo `purposeHandling: { state: 'unsupported' }`, adapter gửi text nguyên văn, không tự thêm prefix; `truncation: 'allow'` ⇒ `EMBEDDING_TRUNCATION_UNSUPPORTED`
    - Nhiều `contentParts` nối theo quy tắc ghi trong `documentRecipeRevision` thành một phần tử `input`, trả đúng một vector cho item
    - Dùng `Http_Transport` + `Json_Pipeline`; attribution headers do transport merge
    - `baseUrl` cấu hình được cho endpoint tương thích OpenAI tự host; cleartext HTTP cần `allowInsecureHttp`
    - _Requirements: 14.1, 14.3, 14.4, 14.7, 15.1, 15.2, 15.3, 15.5, 7.5, 9.7_

  - [x] 12.3 Viết validation response OpenAI theo đúng năm bước
    - Thứ tự: đếm số vector ⇒ `VECTOR_COUNT_MISMATCH`; tập `data[i].index` là permutation `0..N-1` ⇒ `VECTOR_INDEX_INVALID`; giá trị hữu hạn ⇒ `VECTOR_VALUE_INVALID`; số chiều khớp yêu cầu ⇒ `VECTOR_DIMENSIONS_MISMATCH`; shape ngoài dự kiến ⇒ `RESPONSE_MALFORMED`
    - Không cắt, không pad, không sắp xếp lại giá trị; vector gắn `index` bằng `items[data[i].index].index`
    - Map `prompt_tokens → inputTokens`, `total_tokens → totalTokens`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.7, 9.3, 9.4, 9.5, 15.4_

  - [x] 12.4 Viết property test cho `OpenAI_Embedding_Adapter`
    - `packages/provider-openai/tests/unit/embedding.spec.ts`
    - **Property 18: Purpose được dịch ở adapter, không rò rỉ prefix không tài liệu**
    - **Property 19: N input độc lập cho đúng N vector mang chỉ số gốc**
    - **Property 20: Tập chỉ số response phải là một permutation hợp lệ**
    - **Property 21: Vector không hợp lệ là lỗi, không phải dữ liệu để sửa**
    - **Property 22: Vector trả ra trung thực với vector provider trả về**
    - **Property 23: Truncation chỉ khi được bật, và luôn có warning**
    - **Property 40: Dimensions chỉ lên wire khi route khai báo hỗ trợ**
    - **Property 41: Attribution headers trên mọi request embedding**
    - **Property 42: baseUrl được tôn trọng và cleartext HTTP cần bật tường minh**
    - **Property 43: Response không thoả contract là protocol error, không phải cơ sở suy diễn**
    - **Validates: Requirements 7.3, 7.5, 7.6, 8.1, 8.2, 8.3, 8.4, 8.7, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 14.4, 14.7, 15.1, 15.4, 15.5**

  - [x] 12.5 Dựng integration test embedding OpenAI
    - `packages/provider-openai/tests/integration/embedding.spec.ts` + fixture, chạy bằng `vitest.integration.config.ts`
    - Phần **bắt buộc**: file test, fixture, và guard bỏ qua khi thiếu credential — đây là phần thoả Yêu cầu 17.12 về vị trí và runner của test gọi provider thật
    - Phần **tùy chọn**: lượt chạy thật với credential OpenAI, vì nó cần bí mật mà CI công khai không có
    - _Requirements: 17.12_

- [x] 13. Viết `Gemini_Embedding_Adapter`
  - [x] 13.1 Viết adapter và plugin factory
    - `packages/provider-gemini/src/embedding.ts`: `geminiEmbeddingAdapter()`, `geminiEmbeddingPlugin()`, tách khỏi `geminiInteractionsProtocol`
    - Wire `POST {baseUrl}/models/{model}:batchEmbedContents` với `requests[]` gồm `model`, `content.parts[]`, `taskType`, `outputDimensionality`
    - `purpose` → `taskType`: `retrieval-query → RETRIEVAL_QUERY`, `retrieval-document → RETRIEVAL_DOCUMENT`; route khai báo `purposeHandling: { state: 'supported', value: { kind: 'wire-parameter', parameter: 'taskType' } }`
    - Số chiều nhỏ hơn gốc: profile khai báo `postProcessing: { kind: 'l2-renormalize', revision: '1' }` và adapter thực hiện đúng bước đó, không slice/pad
    - Override `embeddingProfile()`, dùng `EmbeddingHttpConnection` của task 12.1, `Http_Transport` + `Json_Pipeline`, attribution headers từ transport
    - _Requirements: 14.2, 14.3, 14.5, 14.7, 7.3, 9.8_

  - [x] 13.2 Xử lý mapping theo vị trí và usage vắng mặt của Gemini
    - Response `{ embeddings: [{ values }] }` không có index: adapter gán `index` theo thứ tự và **bắt buộc** `embeddings.length === requests.length`, lệch là `EMBEDDING_VECTOR_COUNT_MISMATCH`; không nhánh nào giả định thứ tự đúng mà bỏ kiểm tra độ dài
    - `batchEmbedContents` không trả usage ⇒ `EmbeddingUsageReport.status = 'missing'` + warning `usage-unreported`, không sinh giá trị 0
    - Khai báo `compatibilityIdentity` riêng cho từng thế hệ model (ví dụ `google:gemini-embedding-001` vs `google:gemini-embedding-2`)
    - Dùng cùng bộ `EMBEDDING_ERROR_CODES` với OpenAI cho mapping, dimensions và vector không hợp lệ
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.3, 9.4, 9.5, 14.6, 14.8, 16.2_

  - [x] 13.3 Viết property test cho `Gemini_Embedding_Adapter`
    - `packages/provider-gemini/tests/unit/embedding.spec.ts`
    - Cùng bộ **Property 18, 19, 20, 21, 22, 23, 40, 41, 42, 43** như OpenAI, với semantics Gemini — Property 22 ở đây bao phủ bước `l2-renormalize` khi `outputDimensionality` nhỏ hơn số chiều gốc
    - Bổ sung: **Property 14** cho compatibility identity theo thế hệ, **Property 39** cho usage `missing`
    - **Validates: Requirements 6.4, 7.3, 8.1, 8.2, 8.3, 8.4, 9.3, 9.4, 9.5, 9.8, 14.5, 14.6, 14.7, 14.8, 16.2**

  - [x] 13.4 Dựng integration test embedding Gemini
    - `packages/provider-gemini/tests/integration/embedding.spec.ts` + fixture, chạy bằng `vitest.integration.config.ts`
    - Phần **bắt buộc**: file test, fixture, guard bỏ qua khi thiếu credential
    - Phần **tùy chọn**: lượt chạy thật với credential Gemini
    - _Requirements: 17.12_

- [x] 14. Mở rộng `Conformance_Harness`
  - [x] 14.1 Thêm scenario và check id embedding
    - `packages/testkit/src/provider/embedding/`: thêm 12 scenario và 16 check id theo design, giữ nguyên 10 scenario và 19 check id hiện có
    - `ProviderConformanceReport` giữ `schemaVersion: 1` và cấu trúc không đổi, kết quả embedding nằm cùng mảng `checks`
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10_

  - [x] 14.2 Chạy hai fixture OpenAI và Gemini qua cùng bộ check
    - Xác nhận cùng bộ error code phát sinh ở các trường hợp mapping, dimensions và vector không hợp lệ
    - Phủ đủ chín nhóm: mapping/validation, batching, cancellation/close, retry/chi phí, cache, compatibility, plugin compatibility, privacy, usage honesty
    - _Requirements: 14.8, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10_

  - [x] 14.3 Viết meta-test cho harness
    - `packages/testkit/tests/unit/embedding-harness.spec.ts`: harness phát hiện đúng vi phạm khi chạy với negative fixture
    - Tùy chọn vì Yêu cầu 17.1 và 17.2 đã được task 14.1 và task 6.5 phủ; đây là lớp kiểm chứng bổ trợ cho chính harness
    - _Requirements: 17.1, 17.2_

- [x] 15. Kiểm tra kiến trúc và cập nhật tài liệu
  - [x] 15.1 Chạy kiểm tra kiến trúc và snapshot bề mặt API
    - Sử dụng provider github copilot đã được đăng nhập sẵn để sử dụng model text-embedding-3-small test hệ thống, có thể xây dựng thử một hệ thống RAG bằng cách sử dụng text-embedding-3-small bằng github copilot làm model embedding và sử dụng model gpt-5.6-luna của providex codex để làm LLM trả lời câu hỏi. 
    - `dependency-cruiser`: không chu trình mới giữa `embedding/`, `contract/`, `composition/`, `plugin/`; mọi import mới phân giải qua field `exports`
    - Xác nhận cụ thể chiều một hướng `composition/embedding/` → `embedding/`: không file nào trong `packages/core/src/embedding/` import từ `composition/`
    - API surface snapshot của entry `.` (phần generation không đổi) và của `contract/model-info.ts`
    - Xác nhận `packages/core` không thêm dependency runtime tới PostgreSQL, Redis, MinIO; `MemoryStore` và `AgentMemorySnapshot` giữ nguyên ngữ nghĩa `load()`/`commit()`
    - _Requirements: 1.6, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6_

  - [x] 15.2 Cập nhật tài liệu bắt buộc
    - `skills/ai-agent-sdk/references/errors.md`: `EMBEDDING_ERROR_CODES`, `HTTP_JSON_MEDIA_TYPE_INVALID`, `PROVIDER_OPERATION_CONFLICT`
    - `skills/ai-agent-sdk/references/packages.md`: entry point `@alvin0/ai-agent-sdk-core/embedding`, vị trí `core/src/embedding/`, `core/src/composition/embedding/`, `provider-http/src/transport/`
    - `web-documents/`: hướng dẫn `embeddingModel()`/`embed()`/`embedMany()`, phạm vi v1 và các hạng mục ngoài phạm vi
    - Ba mục này bắt buộc vì Yêu cầu 18.1, 18.4, 18.6, 18.7 là SHALL và người dùng không thể suy ra mã lỗi mới, entry point mới hay ranh giới phạm vi từ code
    - _Requirements: 18.1, 18.4, 18.6, 18.7_

  - [x] 15.3 Cập nhật các hướng dẫn mở rộng
    - `skills/ai-agent-sdk/references/providers.md`: `Embedding_Provider_Plugin`, `openAiEmbeddingPlugin`, `geminiEmbeddingPlugin`, bảng khác biệt semantics hai provider
    - `skills/ai-agent-sdk/references/budgets-and-usage.md`: ba mức `Logical_Call`/`Physical_Batch`/`Provider_Attempt`, bảng trạng thái usage, `EmbeddingTokenUsage` khác `TokenUsage`
    - `skills/ai-agent-sdk/references/testing.md`: scenario và check id embedding, bảng ánh xạ chín nhóm contract test
    - Bắt buộc như 15.2: Yêu cầu 18.2, 18.3 và 18.5 cũng là SHALL, nên không task nào phủ chúng được phép bỏ. Khác biệt với 15.2 chỉ là thứ tự ưu tiên khi viết
    - _Requirements: 18.2, 18.3, 18.5_

- [x] 16. Final checkpoint - toàn bộ suite và conformance pass
  - Barrier: chạy sau khi task 12.x, 13.x, 14.x và 15.x hoàn thành.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Chỉ đúng **một** task tùy chọn (`*`): **14.3**, meta-test của harness. Nó được phép bỏ vì Yêu cầu 17.1 và 17.2 đã có task bắt buộc phủ (14.1 và 6.5), nên nó là lớp kiểm chứng bổ trợ chứ không phải đường duy nhất tới một SHALL.
- Mọi acceptance criteria dạng SHALL đều có ít nhất một task **bắt buộc** phủ nó. Hai chỗ trước đây vi phạm điều này đã được sửa: Yêu cầu 18 (bảy criteria) giờ do task 15.2 và 15.3 phủ, cả hai bắt buộc; Yêu cầu 17.12 do task 12.5 và 13.4 phủ, cả hai bắt buộc ở phần file test, fixture và guard — chỉ lượt chạy thật với credential provider là tùy chọn *bên trong* hai task đó, vì nó cần bí mật mà CI công khai không có.
- Property test mang tag **Feature: embedding-support, Property {number}: {property text}** và chạy tối thiểu 100 iteration vì input được sinh ngẫu nhiên.
- Ràng buộc thứ tự cứng: task 1.1 (golden oracle) hoàn thành trước task 2.1 (sửa `http-adapter.ts`). Không có oracle thì không có cách kiểm chứng "không đổi hành vi" sau khi pipeline cũ bị thay.
- Ba chi tiết dễ mất khi refactor SSE là điều kiện nghiệm thu của task 1.3 và 2.1: thứ tự phân loại lỗi, `admissionFailure` passthrough, và `wireBody` cache thuộc pipeline chứ không thuộc transport.
- Task 2.3 pass nghĩa là suite hiện có của bốn provider chạy **không sửa một test nào**. Test phải sửa là tín hiệu regression.
- Ba nhóm không dùng property test theo design: cấu hình build/exports/layout (smoke test), tài liệu (docs lint), kiến trúc dependency (`dependency-cruiser`).
- Checkpoint ở task 3, 7, 11, 16 là **barrier thật**: dependency graph không cho task nào sau một checkpoint chạy song song với task nào trước checkpoint đó. Bốn khối kiểm chứng độc lập là: {1.x, 2.x} đường generation không đổi; {4.x, 5.x, 6.x} `Json_Pipeline` + `Embedding_Contract`; {8.x, 9.x, 10.x} `Embedding_Runtime`; {12.x, 13.x, 14.x, 15.x} adapter, harness và tài liệu.
- Ba phụ thuộc thứ tự khác được graph ràng buộc tường minh: task 10.1 (operation kind) trước 10.2 (`embed()` gọi `operations.execute('embedding-call')`); task 5.4 (`embedding/limits.ts`) trước 6.1 và 9.1 (cả hai dùng `ResolvedEmbeddingBatchLimits`); task 12.1 (`EmbeddingHttpConnection`) trước 12.2 và 13.1.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["1.4", "2.1"] },
    { "id": 4, "tasks": ["2.2"] },
    { "id": 5, "tasks": ["2.3"] },
    { "id": 6, "tasks": ["3"] },
    { "id": 7, "tasks": ["4.1", "5.1", "5.7"] },
    { "id": 8, "tasks": ["4.2", "5.2", "5.4", "5.6"] },
    { "id": 9, "tasks": ["5.3", "5.5", "6.1"] },
    { "id": 10, "tasks": ["6.2", "6.4"] },
    { "id": 11, "tasks": ["6.3", "6.5", "6.6"] },
    { "id": 12, "tasks": ["6.7"] },
    { "id": 13, "tasks": ["7"] },
    { "id": 14, "tasks": ["8.1", "9.1", "9.3", "9.6", "9.8", "10.1"] },
    { "id": 15, "tasks": ["8.2", "8.3", "9.2", "9.4", "9.7", "9.9"] },
    { "id": 16, "tasks": ["8.4", "9.5", "10.2"] },
    { "id": 17, "tasks": ["8.5", "10.3", "10.4", "10.6"] },
    { "id": 18, "tasks": ["10.5"] },
    { "id": 19, "tasks": ["10.7", "10.8", "10.9", "10.10"] },
    { "id": 20, "tasks": ["11"] },
    { "id": 21, "tasks": ["12.1"] },
    { "id": 22, "tasks": ["12.2", "13.1"] },
    { "id": 23, "tasks": ["12.3", "13.2"] },
    { "id": 24, "tasks": ["12.4", "13.3", "14.1"] },
    { "id": 25, "tasks": ["12.5", "13.4", "14.2"] },
    { "id": 26, "tasks": ["14.3", "15.1", "15.2", "15.3"] },
    { "id": 27, "tasks": ["16"] }
  ]
}
```
