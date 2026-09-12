# Implementation Plan: github-copilot-provider

## Overview

Kế hoạch triển khai theo đúng bốn khối phụ thuộc của design, thực hiện tuần tự:

1. **Khối 1 — `Chat_Completions_Protocol`** (`packages/protocol-openai-chat-completions`): wire protocol OpenAI Chat Completions như một package độc lập, không biết Copilot tồn tại. Đi trước vì đây là khối duy nhất có giá trị dùng lại ngoài spec này, và vì nó build/test được hoàn toàn một mình.
2. **Khối 2 — `Copilot_Provider`** (`packages/provider-copilot`): credential contract hai tầng, device flow, `Copilot_Token_Exchange`, `Copilot_Endpoint_Router`, composite protocol, catalog, `Copilot_Adapter`.
3. **Khối 3 — `Copilot_Node_Auth`** (`packages/auth-node`): file store, `Copilot_Login_Cli`, bin entry. Nơi duy nhất trong code Copilot chạm filesystem.
4. **Khối 4 — `Copilot_Embedding_Adapter` + `Conformance_Harness` + `Documentation_Set`**.

**Khối 1, 2 và 3 không phụ thuộc bất kỳ task nào của spec `embedding-support` và triển khai được ngay hôm nay.** Chỉ **khối 4** bị chặn: `Copilot_Embedding_Adapter` cần `embedding-support` task 1.x và 2.x (`Http_Transport` đã tách, `Sse_Pipeline` dựng lại trên nó), 4.x (`Json_Pipeline`), 5.x–6.x (`Embedding_Contract`, `EmbeddingAdapter`, entry point `@alvin0/ai-agent-sdk-core/embedding`). Quan hệ chặn đó được ghi tường minh trên từng task bị ảnh hưởng.

Ngôn ngữ triển khai: **TypeScript** (theo design và toolchain hiện có của repository).

Mọi property test mang tag theo định dạng **Feature: github-copilot-provider, Property {number}: {property text}** và chạy tối thiểu 100 iteration. Toàn bộ 54 property của design đều có task phủ.

## Tasks

- [x] 1. Dựng package `Chat_Completions_Protocol` và đường serialize
  - [x] 1.1 Scaffold package và contract cấu trúc, nối test runner
    - `packages/protocol-openai-chat-completions/package.json`: `exports` chỉ có `"."` và `"./package.json"`, peerDependency **chỉ** `@alvin0/ai-agent-sdk-core`, scripts `build`/`test`/`check:publint`/`check:types`/`test:pack` theo đúng khuôn `protocol-responses` (`test` là `vitest run --config vitest.config.ts`; `test:pack` là `node ../../scripts/test-packed-protocol.mts protocol-openai-chat-completions`), và khối `aiAgentSdk: { runtime: 'universal', coreApi: 1, roles: ['wire-protocol'] }` — khối này là đầu vào của `scripts/check-runtime-boundaries.mts`, thiếu nó thì package không được kiểm biên runtime
    - `tsdown.config.ts`: `libraryBuild({ entry: { index: 'src/index.ts' }, runtime: 'universal' })`; `tsconfig.json` theo khuôn package protocol hiện có
    - **Đăng ký package vào allowlist chuẩn tắc**: thêm entry `protocol-openai-chat-completions` vào `PACKAGE_RULES` của `scripts/package-policy.mts` với `{ runtime: 'universal', workspaceDependencies: [core], externalRuntimeDependencies: [] }`. Không phải bước tùy chọn: `scripts/check-package-graph.mts` báo lỗi `package is absent from the normative allowlist` cho mọi package chưa đăng ký, và báo lỗi `forbidden workspace edge` cho mọi cạnh không có trong `workspaceDependencies`. Thiếu bước này thì `pnpm lint` đỏ ngay khi package vừa được tạo
    - `src/contract.ts`: khai báo `ProtocolDefinition`, `ProtocolRequest`, `ProtocolSseEvent`, `ProtocolStreamChunk` **tại chỗ**, tương thích structurally với `RuntimeWireProtocol`, và **không** import `provider-http` (DD-10)
    - Nối test runner **theo đúng quy ước của repository**: spec file đặt ở `tests/unit/` **ở gốc workspace**, không đặt trong package. Không package nào trong repository có thư mục `tests/` riêng — cả 114 spec hiện có nằm ở `tests/unit/`, và mỗi package có một `vitest.config.ts` `include` ngược lại các đường dẫn `../../tests/unit/*.spec.ts` kèm `resolve.alias` trỏ specifier của chính nó về `./src/index.ts`. Tạo `packages/protocol-openai-chat-completions/vitest.config.ts` theo đúng khuôn `packages/protocol-responses/vitest.config.ts`, liệt kê sáu spec của task 1.5 và 2.4–2.8. Spec ở gốc chạy trong `pnpm test`, và cùng spec đó chạy lại theo package trong `pnpm test:packages`
    - Điều kiện xong: `build` + `publint` + `attw` pass khi `packages/provider-copilot` chưa tồn tại; `pnpm lint` pass
    - _Requirements: 10.1, 10.8, 18.1, 18.5, 18.7_

  - [x] 1.2 Viết `ChatCompletionsDialect` và kiểu wire
    - `src/wire.ts`: `ChatCompletionsDialect` đủ 13 trường theo design, cộng kiểu wire request/response/SSE
    - `maxTokensField` là enum ba giá trị `'max_tokens' | 'max_completion_tokens' | false` chứ không phải boolean: đó chính là chỗ các endpoint tương thích OpenAI chia làm hai họ, và một boolean sẽ buộc provider fork translator
    - `structuredOutputs` ba trạng thái `'json-schema' | 'json-object' | false`; `path` cấu hình được để gateway đặt endpoint ở chỗ khác
    - `DEFAULT_DIALECT` đóng băng, giữ bảo thủ: `parallelToolCalls: false`, `seed: false`, `reasoningEffort: false`
    - _Requirements: 10.7_

  - [x] 1.3 Viết serialize
    - `src/serialize.ts`: `GenerateOptions` → body Chat Completions; `messages` giữ nguyên thứ tự và vai, system prompt ở vai `dialect.systemRole`, `tool_calls` của lượt assistant, message `role: 'tool'` kèm `tool_call_id`
    - `arguments` của tool call lượt trước gửi lại **nguyên văn dạng string** như đã nhận, không parse-rồi-stringify: round-trip đổi thứ tự khoá và định dạng số, và một số model dùng chính chuỗi đó làm ngữ cảnh
    - Mọi cờ dialect ở trạng thái tắt ⇒ trường wire tương ứng **vắng hoàn toàn** khỏi body, không gửi `null`, không gửi giá trị mặc định
    - `tools` + `tool_choice`, `response_format` dạng `json_schema` với `strict: true`, `stream_options.include_usage` theo cờ
    - _Requirements: 10.2, 10.4, 10.5, 10.7_

  - [ ] 1.4 Ghi bảy fixture SSE
    - `fixtures/text-stream.txt`, `tool-call-split-args.txt`, `structured-output.txt`, `truncated-mid-delta.txt`, `truncated-mid-args.txt`, `done-without-finish.txt`, `usage-after-finish.txt`
    - `tool-call-split-args.txt` phải có mảnh cắt giữa một escape sequence JSON **và** mảnh cắt giữa một ký tự UTF-8 nhiều byte — hai vị trí cắt làm parse sớm thất bại
    - `done-without-finish.txt` có `[DONE]` mà không có `finish_reason` nào; `usage-after-finish.txt` có chunk `choices: []` mang `usage` sau terminal finish
    - _Requirements: 16.2_

  - [x] 1.5 Viết property test cho serialize
    - `tests/unit/chat-completions-serialize.spec.ts`
    - **Property 36: Dịch request Chat Completions đầy đủ và đúng vai**
    - **Property 39: Structured output theo trạng thái dialect**
    - **Property 40: Cờ dialect tắt ⇒ trường vắng, một-một**
    - **Validates: Requirements 10.2, 10.5, 10.7**

- [x] 2. Viết translator, error mapping và bề mặt công khai của `Chat_Completions_Protocol`
  - [x] 2.1 Viết translator
    - `src/translate.ts`: SSE → `ProtocolStreamChunk`
    - Tool-call accumulator khoá theo **`index`**, không theo `id`: `id` và `function.name` chỉ đến một lần ở delta đầu, còn `arguments` đến thành nhiều mảnh và chỉ mang `index`. `args` được **nối chuỗi**, không parse từng mảnh
    - Tool call chỉ được phát khi `finish_reason === 'tool_calls'` xuất hiện; parse `arguments` tại đúng thời điểm đó, parse thất bại là **protocol error** chứ không phải một tool call rỗng
    - `[DONE]` **không** phải terminal finish. Terminal finish là một chunk mang `finish_reason` khác `null`. Stream hết event, gặp `[DONE]`, hay bị cắt giữa đường mà chưa thấy `finish_reason` ⇒ protocol error, vì một stream bị cắt trông giống hệt một câu trả lời ngắn
    - Vẫn nhận chunk sau terminal finish để đọc `usage`, và phát `UsageCounters` **thô** — việc phán xét usage đủ hay không thuộc tầng trên
    - _Requirements: 10.3, 10.4, 10.9_

  - [x] 2.2 Viết error mapping
    - `src/errors.ts`: map `(status, body)` sang `AUTH`, `RATE_LIMIT`, `TIMEOUT`, `TRANSPORT`, `MODEL_NOT_FOUND`, `REQUEST_INVALID`, `CONTENT_FILTERED` — dùng chung tập code với các protocol hiện có, không định nghĩa code riêng
    - Đọc `retry-after` và request id header khi có
    - _Requirements: 10.6, 13.5_

  - [x] 2.3 Viết `openAiChatCompletionsProtocol` và barrel
    - `src/protocol.ts`: marker `kind: 'http-wire-protocol'`, `apiVersion: 1`, `id = OPENAI_CHAT_COMPLETIONS_PROTOCOL_ID`, `defaultDialect` phẳng và hữu hạn để qua được `snapshotJsonObject`
    - `src/index.ts`: export protocol, hằng số id, và type `ChatCompletionsDialect` + bốn type contract
    - _Requirements: 10.1, 10.7, 10.8_

  - [x] 2.4 Viết property test cho stream text
    - `tests/unit/chat-completions-translate-text.spec.ts`
    - **Property 37: Stream SSE dịch thành chuỗi chunk trung thực**
    - Sinh mọi cách phân mảnh, kể cả mảnh cắt giữa một ký tự UTF-8 nhiều byte
    - **Validates: Requirements 10.3**

  - [x] 2.5 Viết property test cho tool call
    - `tests/unit/chat-completions-translate-tools.spec.ts`
    - **Property 38: Tool call tích lũy đúng và chỉ phát khi hoàn tất**
    - **Validates: Requirements 10.4**

  - [x] 2.6 Viết property test cho terminal finish
    - `tests/unit/chat-completions-translate-terminal.spec.ts`
    - **Property 42: Stream thiếu terminal finish là lỗi**
    - Sinh mọi vị trí cắt: trước event đầu, giữa các delta text, giữa các mảnh `arguments`, sau `[DONE]` mà chưa có finish reason
    - **Validates: Requirements 10.9**

  - [x] 2.7 Viết property test cho error mapping phía protocol
    - `tests/unit/chat-completions-errors.spec.ts`
    - **Property 41: Cùng tình huống lỗi cho cùng error code ở mọi provider** — so sánh chéo với một provider hiện có trên cùng cặp `(status, body)`, gồm cả cờ retryable, delay đọc từ `retry-after` và provider request id
    - **Validates: Requirements 10.6, 13.5, 15.5**

  - [x] 2.8 Viết test cấu trúc và grep test không-Copilot
    - `tests/unit/chat-completions-surface.spec.ts`
    - Bề mặt công khai: protocol id, marker, `defaultDialect` đóng băng, entry `.` phân giải được
    - Grep test: package **không** chứa chuỗi `copilot`, `githubcopilot`, `Editor-Version`, `Editor-Plugin-Version` ở bất kỳ file nào trong `src/`. Đây là cách duy nhất Yêu cầu 10.8 được kiểm chứng — review không thay được nó
    - _Requirements: 10.1, 10.8_

- [x] 3. Checkpoint khối 1 — `Chat_Completions_Protocol` độc lập và xanh
  - Barrier: không task nào sau đây được bắt đầu trước khi task 1.x và 2.x hoàn thành.
  - Điều kiện: Property 36–42 pass; grep test không-Copilot pass; `publint` + `attw` + `test:pack` pass; package build và test **không cần** `provider-copilot` tồn tại.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Chốt `Client_Identity_Constants` và dựng nền `Copilot_Provider`
  - [x] 4.1 Chốt ba hằng số danh tính client trên tài khoản thật — **task đầu tiên của khối 2**
    - `COPILOT_OAUTH_CLIENT_ID`, `COPILOT_EDITOR_VERSION`, `COPILOT_EDITOR_PLUGIN_VERSION` là **ba giá trị duy nhất chưa được chốt trong toàn bộ design**. Xác nhận từng giá trị trên một tài khoản Copilot thật rồi ghi vào code kèm **ngày xác nhận** trong comment, không ship dưới dạng placeholder
    - Tiền điều kiện không thay thế được: `copilot_internal/v2/token` chỉ nhận token do một **OAuth App nằm trong allowlist của GitHub** cấp. Một personal access token **không** dùng được ở bề mặt này, nên không có đường nào đi tiếp mà không có một client id trong allowlist. Thiếu `Editor-Version` hoặc `Editor-Plugin-Version` thì endpoint trả HTTP 400 và không request nào chạy
    - Phần còn lại của khối 2 **không kiểm chứng được end-to-end** trước khi task này xong: mọi property test dùng fetch inject vẫn chạy, nhưng không có lượt chạy thật nào xác nhận rằng ba giá trị này được endpoint chấp nhận
    - `packages/provider-copilot/src/oauth.ts`: `COPILOT_OAUTH_CLIENT_ID`, `COPILOT_OAUTH_SCOPE = 'read:user'`, `DEFAULT_COPILOT_OAUTH_ISSUER`
    - `packages/provider-copilot/src/adapter.ts`: `COPILOT_BASE_URL`, `COPILOT_EDITOR_VERSION`, `COPILOT_EDITOR_PLUGIN_VERSION`, `CopilotEditorHeaders`
    - Cả ba là **hằng số exported ghi đè được**, kèm comment nêu rằng giá trị mặc định khiến SDK tự nhận là một editor client, và nêu rằng đó chính là lý do chúng là option có tên thay vì hằng số ẩn — cùng lý do `CODEX_CLIENT_VERSION` là hằng số exported
    - Cùng task: `packages/provider-copilot/package.json` (`exports` chỉ `"."` ở khối này, cộng khối `aiAgentSdk: { runtime: 'universal', coreApi: 1, roles: ['model-provider'] }`), `tsdown.config.ts`, `tsconfig.json`, và `vitest.config.ts` của package `include` các spec ở `tests/unit/` gốc như task 1.1 đã làm cho package protocol
    - **Đăng ký vào allowlist chuẩn tắc**: thêm entry `provider-copilot` vào `PACKAGE_RULES` của `scripts/package-policy.mts` với `{ runtime: 'universal', workspaceDependencies: [core, provider-http, protocol-responses, protocol-openai-chat-completions], externalRuntimeDependencies: [] }`. Cùng lý do task 1.1: `check-package-graph.mts` từ chối package chưa đăng ký và từ chối mọi cạnh workspace ngoài danh sách
    - _Requirements: 2.1, 2.4, 11.1, 11.2, 11.3, 18.1, 18.7_

  - [x] 4.2 Viết tập error code và hai error class của Copilot
    - `src/errors.ts`: `COPILOT_ERROR_CODES` đủ 15 giá trị theo design, `CopilotTokenExchangeError` mang `kind: 'permanent' | 'transient'`, `CopilotDeviceLoginError` mang `reason: 'denied' | 'expired' | 'timeout' | 'aborted' | 'failed'`
    - Ba code **không** được tạo mới vì code sẵn có đã đúng: thiếu credential dùng `MISSING_CREDENTIAL` của `packages/core`, abort dùng code abort sẵn có, lỗi HTTP của endpoint dùng `MODEL_ERROR_CODES` + `HTTP_PROVIDER_ERROR_CODES`. Không định nghĩa `COPILOT_RATE_LIMIT`
    - `credentialFailure(message, cause)` là cửa duy nhất tạo error trong đường credential: lọc `cause` qua `safeProviderFailure`, và **không bao giờ** nội suy giá trị token vào message
    - _Requirements: 13.1, 13.2, 13.3, 13.5, 13.7_

  - [x] 4.3 Viết lớp HTTP dùng chung của Copilot
    - `src/common/no-follow.ts`: `rejectCopilotRedirect` phát hiện **mọi** dạng redirect mà Web fetch phơi ra — status 3xx, `type === 'opaqueredirect'`, `redirected === true`, `response.url` khác URL đã yêu cầu — và giải phóng body
    - `src/common/http.ts`: `copilotFetch` là bản đối ứng `oauthFetch` của Codex — `issuerOf` từ chối issuer có userinfo và từ chối `http:` khi chưa bật `allowInsecureIssuer`; origin được pin và so **trước** khi phát request; `redirect: 'manual'`; body đọc qua reader có giới hạn bytes và số chunk; `raceAbort` để signal của caller thắng ngay; `positiveSafeInteger` kiểm mọi giới hạn cấu hình
    - Ba origin là ba option độc lập, mỗi cái pin riêng: `oauthIssuer`, `githubApiBaseUrl`, `baseUrl`. Không module nào được phát request ra một origin khác origin đã pin của chính nó
    - _Requirements: 2.2, 3.7, 3.8, 4.7, 7.8, 13.6_

  - [x] 4.4 Viết credential contract và capture store
    - `src/common/store-types.ts`: `CopilotGitHubToken`, `CopilotAccountIdentity`, `CopilotAuthFile` (`version: 1`), `CopilotAuthStore` (read/write, deprecated), `CopilotCredentialStore = CredentialStore<CopilotAuthFile>`
    - Bốn điều **không** có trong `CopilotAuthFile`, mỗi cái là một quyết định: không `Copilot_Api_Token` (DD-9), không trường refresh token, không `last_refresh`, không cấu hình API-key-tương-đương. `CopilotAuthFile` không import `CodexAuthFile` và không phải alias của nó
    - `src/common/store-capture.ts`: `captureCopilotStore` là bản đối ứng `captureCodexStore` — đọc marker bằng `Object.getOwnPropertyDescriptor`, **từ chối accessor**, capture method bằng `Reflect.apply`, và không thực hiện I/O nào lúc dựng provider
    - _Requirements: 3.1, 5.1, 6.1, 6.2, 7.3_

  - [x] 4.5 Viết `Copilot_Auth`
    - `src/auth.ts`: `memoryCopilotAuthStore`, `memoryCopilotCredentialStore` (dựng bằng `defineCredentialStore`, `structuredClone` hai chiều, phát `COPILOT_CREDENTIAL_REVISION_CONFLICT` khi `expectedRevision` lệch), `CopilotCredentialSnapshot`, `requireGitHubToken`
    - `COPILOT_TOKEN_EXCHANGE_MARGIN_MS = 5 * 60 * 1_000` và `shouldExchange(api, now, marginMs)` là **hàm thuần trên ba giá trị**, không đọc đồng hồ toàn cục. `undefined` luôn cho `true`. `refresh_in` chỉ được **rút ngắn** thời điểm làm mới, không bao giờ **kéo dài**
    - Không nhánh fallback nào: `Copilot_Api_Token` không phải JWT mà SDK này có quyền đọc, và thời điểm hết hạn đã được endpoint nói thẳng trong body. Một fallback bịa ra vi phạm nguyên tắc không suy diễn
    - `requireGitHubToken` gộp ba dạng "không có credential" — store rỗng, file thiếu `github`, token là chuỗi rỗng — thành **cùng một** code, vì với người dùng chúng là cùng một vấn đề; message chứa câu lệnh chạy `Copilot_Login_Cli`
    - _Requirements: 3.1, 3.3, 3.4, 5.1, 5.2, 5.3, 5.8, 6.2, 6.3, 6.4, 11.5, 13.4_

  - [x] 4.6 Viết property test cho redirect guard
    - `tests/unit/copilot-no-follow.spec.ts`
    - **Property 9: Redirect bị từ chối ở mọi endpoint, trước hop thứ hai**
    - Phủ cả bảy endpoint: device code, device token, token exchange, `/models`, `/responses`, `/chat/completions`, `/embeddings`
    - **Validates: Requirements 3.8, 7.8**

  - [x] 4.7 Viết property test cho store và credential thiếu
    - `tests/unit/copilot-auth-store.spec.ts`
    - **Property 20: Commit đồng thời cho đúng một bên thắng** (phía memory store)
    - **Property 24: Kiểm tra marker store không gọi accessor nào**
    - **Property 49: Thiếu credential cho một code duy nhất kèm câu lệnh khắc phục**
    - **Validates: Requirements 6.3, 7.3, 13.4**

- [x] 5. Viết `Copilot_Oauth` device flow
  - [x] 5.1 Viết hai chặng device flow và vòng poll
    - `src/oauth.ts`: `requestCopilotDeviceCode`, `runCopilotDeviceLogin`, `CopilotDeviceCode`, `CopilotLoginProgress`, `CopilotLoginResult`; `sleep(ms, signal)` nhận một `timer` **inject được** để test không chờ thời gian thật
    - `Accept: application/json` là **bắt buộc** ở cả hai chặng: thiếu nó, endpoint token của GitHub trả **form-encoded**, một parser JSON gặp `error=authorization_pending&interval=10` sẽ ném, và nhánh "chưa được duyệt" biến thành nhánh lỗi cứng
    - Kênh lỗi là **HTTP 200 kèm `error` trong body**, khác Codex nơi "chưa duyệt" hiện ra dưới dạng 403/404 — nên phân loại đọc **body trước**, status sau
    - `slow_down` phải **tăng nghiêm ngặt** khoảng chờ: interval hiệu lực là `max(hiện tại, server yêu cầu, hiện tại + 5)`, cộng 5 giây theo RFC 8628 để chuỗi vẫn tăng khi server không gửi giá trị mới
    - `access_denied` và `expired_token` là **hai code khác nhau**: một là "bạn vừa từ chối", một là "mã hết hạn" — hai hướng dẫn khác nhau
    - Biên trên 15 phút **độc lập** với `expires_in`: `expires_in` được tôn trọng khi ngắn hơn, biên 15 phút là chặn trên tuyệt đối
    - `SIGINT`/`AbortSignal` dừng flow ngay thay vì chờ hết vòng poll; prompt mang cảnh báo phishing cùng nội dung Codex đang dùng
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 5.2 Ghi fixture device flow
    - `packages/provider-copilot/fixtures/device-code.json`, `device-pending.json`, `device-slow-down.json`, `device-denied.json`, `device-expired.json`
    - `device-code.json` có biến thể `interval` dạng số, dạng chuỗi số, vắng mặt và không parse được
    - _Requirements: 16.1_

  - [x] 5.3 Viết property test cho device flow
    - `tests/unit/copilot-oauth-device.spec.ts`, dùng clock ảo và fake timer — không test nào chờ thời gian thật
    - **Property 10: Device code luôn cho ra ba giá trị dùng được**
    - **Property 11: Polling dừng ở biên trên tuyệt đối 15 phút**
    - **Property 12: Khoảng chờ không giảm và tăng sau mỗi `slow_down`**
    - **Property 13: `access_denied` và `expired_token` dừng flow bằng hai code phân biệt**
    - **Property 14: Abort dừng device flow ngay lập tức**
    - **Property 16: Kết quả đăng nhập luôn mang vị trí lưu, danh tính chỉ khi được tiết lộ**
    - Kèm unit test happy path: một lần `/login/device/code`, hai lần poll `authorization_pending`, rồi `access_token`
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8**

- [x] 6. Viết `Copilot_Token_Exchange` và `Copilot_Token_Cache`
  - [x] 6.1 Viết `exchangeCopilotToken` theo đúng thứ tự chín bước phân loại
    - `src/exchange.ts`: `DEFAULT_GITHUB_API_BASE_URL`, `COPILOT_TOKEN_EXCHANGE_PATH`, `CopilotExchangeOptions`, `CopilotApiToken`, `exchangeCopilotToken`
    - Thứ tự cứng: `.ghe.com` ⇒ `TENANT_UNSUPPORTED` (trước mọi I/O) → origin lệch ⇒ `ENDPOINT_ORIGIN_INVALID` (trước mọi I/O) → redirect ⇒ `REDIRECT_REJECTED` → 404 ⇒ `TENANT_UNSUPPORTED` → 401 ⇒ `CREDENTIAL_REJECTED` permanent → 403 ⇒ `CREDENTIAL_REJECTED` permanent → 5xx/mạng/timeout ⇒ `TOKEN_EXCHANGE_FAILED` transient → 4xx còn lại ⇒ `TOKEN_EXCHANGE_FAILED` permanent → `expires_at` không đọc được ⇒ `TOKEN_MALFORMED`
    - Phát hiện `.ghe.com` bằng **so khớp suffix nhãn tên miền**, không bằng `includes('ghe.com')`: `ghe.com.evil.tld` và `notghe.com` phải **không** khớp
    - Hàng 403 làm việc nhiều nhất: endpoint trả cùng 403 cho PAT và cho OAuth App ngoài allowlist, và response không phân biệt hai trường hợp — nên message nêu **cả hai** khả năng cùng hướng dẫn duy nhất có tác dụng
    - `expires_at` **bắt buộc** và là số hữu hạn dương; `refresh_in` advisory; `endpoints.api` được đọc và phơi ra cho chẩn đoán nhưng **không bao giờ** dùng làm base URL — một base URL do server chỉ định là một redirect dưới tên khác (DD-6)
    - _Requirements: 3.2, 3.5, 3.6, 3.7, 3.8, 5.6, 5.7, 13.2, 13.3, 13.6_

  - [x] 6.2 Viết `createCopilotTokenCache` với hợp nhất exchange đồng thời
    - `src/exchange.ts`: `CopilotTokenCacheEntry`, `CopilotTokenCache` với `acquire` và `invalidate`
    - Cache khoá theo **giá trị credential**, so bằng `===` trên `sourceToken`, cộng `sourceRevision` làm lớp thứ hai. Không băm: đây không phải so sánh trước một attacker oracle, và thêm `crypto.subtle` vào đường đi bắt buộc của một package Universal chỉ để so một chuỗi với chính nó là chi phí không mua được gì (DD-11)
    - Điểm dễ sai nhất: exchange dùng chung có `AbortController` + timeout **riêng**, **không** nhận signal của một caller cụ thể. Mỗi caller `raceAbort` promise dùng chung với signal của **chính** mình. Caller bị abort thì caller đó thoát, exchange vẫn hoàn thành cho những người còn lại
    - Bọc bằng `observeCredentialOperation(context, provider, 'refresh')` — dùng `'refresh'` chứ **không** mở rộng union đóng `'resolve' | 'refresh' | 'login'`, vì mở rộng đổi một type công khai của `provider-http` và Yêu cầu 18.4 cấm (DD-7)
    - **Không** sao chép đường phục hồi revision-conflict của Codex: nó tồn tại vì refresh token của Codex rotate và dùng một lần, còn `GitHub_User_Token` không rotate nên hai tiến trình đua nhau chỉ dẫn tới hai lần đổi token. Một nhánh không có tình huống nào chạy tới là một nhánh không được kiểm chứng (DD-8)
    - **Không** persist `Copilot_Api_Token` ở bất kỳ đâu (DD-9)
    - Cache thuộc adapter instance, inject được qua option `tokenCache` để nhiều route dùng chung một credential không đổi token n lần
    - _Requirements: 3.3, 5.4, 5.5, 14.2_

  - [x] 6.3 Ghi fixture exchange
    - `packages/provider-copilot/fixtures/exchange-ok.json`, `exchange-no-expires.json`, `exchange-403.json`, `exchange-404.json`
    - `exchange-ok.json` có biến thể mang `refresh_in` và biến thể mang `endpoints.api` lệch với `baseUrl`
    - _Requirements: 16.1_

  - [x] 6.4 Viết property test cho `Copilot_Token_Exchange`
    - `tests/unit/copilot-exchange.spec.ts`
    - **Property 5: Store chỉ mang token dài hạn và không đổi qua mọi lần đổi token**
    - **Property 6: Bảng phân loại thất bại của `Copilot_Token_Exchange`**
    - **Property 7: Phát hiện tenant data-residency chính xác theo nhãn tên miền**
    - **Property 8: Origin được pin và kiểm trước khi phát request**
    - **Property 15: Mọi lần đọc response của Copilot đều bị chặn trên**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.7, 5.6, 5.7, 8.2, 13.2, 13.3, 13.6**

  - [x] 6.5 Viết property test cho `Copilot_Token_Cache`
    - `tests/unit/copilot-token-cache.spec.ts`, dùng clock inject
    - **Property 17: Quyết định đổi token đúng theo biên độ đã cấu hình**
    - **Property 18: Nhiều caller đồng thời cho đúng một exchange, và abort của một caller không hại caller khác**
    - **Property 19: Lỗi xác thực của endpoint không bao giờ được retry**
    - **Property 52: Bản ghi quan sát của việc đổi token bằng số exchange thực sự phát ra**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.8, 14.2**

- [x] 7. Viết `Copilot_Catalog`
  - [x] 7.1 Viết phát hiện và phân hoạch catalog
    - `src/catalog.ts`: `WireCopilotModel`, `CopilotCatalogSnapshot`, `CopilotOmitReason`, `CopilotGenerationModel`, `CopilotEmbeddingModel`, `discoverCopilotModels`
    - Wire: `GET {baseUrl}/models`, `redirect: 'manual'`, timeout riêng, đọc có biên bytes/chunk, giới hạn số model — cùng khuôn `discoverCodexModels` + `readCatalogJson`
    - Đọc phòng vệ theo thứ tự: redirect → `content-length` vượt giới hạn → bytes/chunks tích lũy vượt giới hạn → JSON không phải object hoặc `data` không phải array ⇒ `CATALOG_MALFORMED` → số entry vượt `maxCatalogModels` ⇒ `CATALOG_MALFORMED` → entry thiếu id ⇒ omitted `'model-id-missing'` → `capabilities.type` không nhận dạng ⇒ omitted `'capability-type-unrecognized'`
    - Sai shape ở **mức cấu trúc** là lỗi; entry lạ ở **mức entry** thì bỏ entry chứ không bỏ cả catalog — một entry lạ không được làm chết mọi model còn dùng được. Liệt kê một model không gọi được là tệ hơn không liệt kê: nó xuất hiện trong selector rồi thất bại lúc chạy
    - Dịch metadata chỉ điền trường endpoint **có** cung cấp. Điểm dễ làm sai nhất: không có tín hiệu vision nào ⇒ `inputModalities` **vắng mặt**, KHÔNG phải `['text']` — một danh sách tường minh thiếu `image` là tuyên bố **phủ định** mà registry sẽ hành động theo và âm thầm cắt ảnh khỏi mọi request
    - `declaredEndpoint` để `undefined` khi catalog không tiết lộ; `undefined` ≠ "không hỗ trợ"
    - `omitted` **không** làm request thất bại: catalog là advisory
    - Option TTL cache, TTL stale, backoff sau khi phát hiện thất bại
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 9.4, 9.5_

  - [x] 7.2 Ghi fixture catalog gồm cả negative fixture
    - `packages/provider-copilot/fixtures/models-ok.json`, `models-mixed-types.json`, `models-unknown-type.json`, `models-not-object.json`, `models-data-not-array.json`, `models-too-many.json`
    - Ba fixture cuối là nhóm negative "catalog sai shape", trả lời một câu hỏi: SDK có phát error thay vì đoán ra một danh sách model? Cố ý **không** gộp vào một file để một nhóm hồi quy không làm mất thông tin của nhóm khác
    - _Requirements: 16.3_

  - [x] 7.3 Viết property test cho `Copilot_Catalog`
    - `tests/unit/copilot-catalog.spec.ts`
    - **Property 27: Truyền `models` thì không phát hiện, không truyền thì phát hiện**
    - **Property 28: Phân hoạch catalog theo `Model_Capability_Type`**
    - **Property 29: Dịch metadata không bịa trường nào endpoint không cung cấp**
    - **Property 30: Catalog là advisory**
    - **Property 31: Catalog sai shape là lỗi, không phải cơ sở suy diễn**
    - **Validates: Requirements 8.1, 8.3, 8.4, 8.5, 8.6, 8.8, 9.4, 9.5**

- [x] 8. Viết `Copilot_Endpoint_Router` và composite protocol
  - [x] 8.1 Viết router memoized append-only
    - `src/router.ts`: `CopilotEndpoint`, `CopilotEndpointDecision`, `CopilotEndpointRouter` với `decide`/`learn`/`snapshot`, `COPILOT_RESPONSES_MODEL_PREFIXES`, `createCopilotEndpointRouter`
    - Thứ tự quyết định: `endpointOverrides` → catalog tiết lộ → allowlist tiền tố → mặc định `/chat/completions`. **Không probe**: một probe là một request thật, tiêu quota thật, cần một prompt, nên nó có side effect quan sát được trên tài khoản người dùng chỉ để trả lời một câu hỏi metadata (DD-4)
    - Mặc định là `/chat/completions` vì hai kiểu đoán sai **không đối xứng**: đoán sai về phía `/chat/completions` cho ra "chạy được, mất một số tính năng riêng của Responses"; đoán sai về phía `/responses` cho ra HTTP 400 và request chết
    - `decisions` là **append-only**: một model id đã có quyết định thì không bao giờ được ghi lại, kể cả khi catalog refresh sau đó trả metadata khác. Đây là cách Yêu cầu 9.7 đúng **theo cấu trúc** — không có đường code nào có thể đổi ý giữa hai lần retry. `learn()` chỉ thêm khoá chưa có quyết định
    - Chi phí đã nhận: một model bị phân loại sai ở lần gọi đầu giữ phân loại đó suốt vòng đời adapter instance; `endpointOverrides` là đường sửa tức thời, `--models` là đường phát hiện, dựng lại runtime là đường reset (DD-5)
    - `responsesModelPrefixes` **cộng thêm** vào allowlist chứ không thay thế, nên override không âm thầm làm mất các tiền tố đã biết
    - `endpointOverrides` ấn định một endpoint không tồn tại ⇒ `ENDPOINT_OVERRIDE_INVALID`
    - _Requirements: 9.1, 9.4, 9.5, 9.6, 9.7_

  - [x] 8.2 Viết composite protocol uỷ quyền theo model id
    - `src/dual-protocol.ts`: `copilotDualProtocol` là một `RuntimeWireProtocol<CopilotDialect>` hợp lệ với `id = 'copilot-dual'`, uỷ quyền `endpointPath`/`serialize`/`translate` cho `openAiResponsesProtocol` hoặc `openAiChatCompletionsProtocol` theo `request.model.id`
    - Điều làm nó chạy được: cả ba method đều nhận `ProtocolRequest`, và `ProtocolRequest.model` là `ResolvedModelInfo` — khoá định tuyến có mặt tại **mọi** điểm quyết định, không cần thêm kênh truyền nào (DD-1)
    - Composite dùng **closure** bắt `router`/`responses`/`chat`, **không dùng `this`**: `captureRuntimeProtocol` gọi method bằng `Reflect.apply(method, source, args)` nên việc rebind receiver phải vô hại
    - `resolvedResponsesDialect`/`resolvedChatDialect` merge projection với `defaultDialect` của **sub-protocol**, không phải của composite
    - `protocolHeaders` trả header của **nhánh đã chọn**, không hợp cả hai
    - `onDecision` gọi đồng bộ tại `endpointPath`, best-effort — lỗi trong observer bị chặn và không ảnh hưởng request; nó mang `{ model, endpoint, protocolId, source }`, không mang prompt và không mang credential. Đây là kênh duy nhất thoả Yêu cầu 9.8, vì `startProviderAttempt` chỉ nhận `origin` và cả hai endpoint cùng origin (DD-3)
    - _Requirements: 9.1, 9.2, 9.3, 9.7, 9.8_

  - [x] 8.3 Viết property test cho router và composite protocol
    - `tests/unit/copilot-router.spec.ts`
    - **Property 32: Composite protocol nhất quán trên cả ba mặt**
    - **Property 33: Override endpoint luôn thắng mọi nguồn khác**
    - **Property 34: Quyết định endpoint bất biến trong một lần gọi** — test phải **đổi metadata catalog giữa hai lần retry** để chứng minh quyết định không đổi
    - **Property 35: Endpoint và protocol đã chọn được báo cáo**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.6, 9.7, 9.8**

- [x] 9. Viết `Copilot_Adapter`, plugin factory và kiểm chứng bề mặt khối 2
  - [x] 9.1 Viết dialect, hai projection, adapter và plugin factory
    - `src/adapter.ts`: `CopilotDialect` **phẳng** đủ 12 trường, `toResponsesDialect`, `toChatCompletionsDialect`, `CopilotProviderOptions`, `copilotAdapter`, `copilotPlugin`
    - Dialect phẳng chủ ý: `resolveDialect` của `provider-http` merge **nông** (`{ ...defaultDialect, ...overrides }`), nên dialect lồng hai sub-dialect sẽ làm một caller ghi đè đúng một cờ của nhánh chat **im lặng** mất toàn bộ default còn lại của nhánh đó. Phẳng làm điều đó bất khả thi (DD-2)
    - Hai hàm projection là **thuần** và **toàn phần**: mỗi cờ có đúng một đích trên mỗi nhánh hoặc không có đích nào. Cờ không có đích (`store` với Chat Completions, `systemRole` với Responses) bị **bỏ**, không dịch sang một cờ gần nghĩa
    - `copilotAdapter` dựng bằng `createRuntimeHttpProvider<CopilotDialect>`, **không** `extends HttpModelAdapter`
    - `auth: { kind: 'dynamic' }` là nơi duy nhất token đi vào request: đọc store → `requireGitHubToken` (chạy **trước** `cache.acquire`, nên thiếu credential cho `MISSING_CREDENTIAL` kèm câu lệnh CLI chứ không phải một lỗi HTTP) → `cache.acquire`. `resolve` được gọi **một lần cho mỗi operation**, không phải mỗi retry
    - Header trả về: `authorization`, `editor-version`, `editor-plugin-version`, `content-type`, `x-request-id` (của client, không phải của server)
    - Phát hiện thiếu `Editor_Headers`: `(status === 400) && body khớp dấu hiệu`, khớp **rộng** vì nội dung message của endpoint không phải hợp đồng; không khớp thì 400 giữ nguyên `REQUEST_INVALID`, không bị gán sai
    - Body của response lỗi đi vào `cause` sau khi đọc có biên, và **trước** khi đi vào, mọi lần xuất hiện của hai token đang giữ trong bộ nhớ bị thay bằng `[REDACTED]` — một endpoint echo lại `Authorization` trong body lỗi là chuyện đã từng xảy ra
    - `router.learn(snapshot.generation)` chỉ **thêm** khoá chưa có quyết định
    - Spread có điều kiện cho mọi option vắng mặt để không tạo khoá mang `undefined`; `retryPolicy`, giới hạn transport, `requestLogger` (best-effort, quá `requestLoggerTimeoutMs` thì request **vẫn** đi)
    - `copilotPlugin`: `id` mặc định `'copilot'`, `family: 'copilot'`, `routes` mặc định `[id]`, `defaultModel` dạng string đòi **đúng một** route; plugin chỉ nhận biến thể CAS còn `copilotAdapter` chấp nhận cả hai qua `captureCopilotStore`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 5.8, 7.1, 7.2, 7.4, 7.5, 7.6, 7.7, 9.6, 13.7, 14.1, 14.3, 14.4, 14.5_

  - [x] 9.2 Viết barrel công khai của `provider-copilot`
    - `src/index.ts`: export `copilotAdapter`, `copilotPlugin`, `COPILOT_ERROR_CODES`, `Client_Identity_Constants`, hai store factory trong bộ nhớ, `createCopilotTokenCache`, `requestCopilotDeviceCode`, `runCopilotDeviceLogin`, `discoverCopilotModels`, `createCopilotEndpointRouter`, và các type liên quan
    - _Requirements: 18.1_

  - [x] 9.3 Viết property test cho header, danh tính client và cấu hình
    - `tests/unit/copilot-adapter-headers.spec.ts`
    - **Property 1: Mọi request nằm trên origin đã cấu hình, cleartext HTTP cần bật tường minh**
    - **Property 2: Ba header bắt buộc trên mọi request tới bề mặt Copilot**
    - **Property 3: Precedence của `Client_Identity_Constants`**
    - **Property 4: HTTP 400 thiếu editor header cho chẩn đoán nêu tên cả hai header**
    - **Property 23: Header được giải quyết một lần cho mỗi operation**
    - **Property 26: Option đi tới đích, option vắng mặt không ghi đè default**
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 7.2, 7.6, 7.7, 8.7, 11.2**

  - [x] 9.4 Viết property test cho attempt accounting
    - `tests/unit/copilot-attempts.spec.ts`
    - **Property 51: Số bản ghi attempt bằng số `Provider_Attempt`**
    - **Validates: Requirements 14.1**

  - [x] 9.5 Viết property test cho redaction và request logger
    - `tests/unit/copilot-redaction.spec.ts`
    - **Property 50: Không token nào rò rỉ vào error** — sinh token ngẫu nhiên, đi qua **mọi** điểm phát lỗi kể cả khi body response lỗi echo lại chính giá trị token, và assert token không xuất hiện trong `message`, `code`, `stack` và toàn bộ chuỗi `cause`. Phải phủ cả đường serialize error từ cache, vì entry cache **giữ** giá trị `sourceToken` (DD-11)
    - **Property 53: Không credential, không danh tính, không nội dung thô trong quan sát**
    - **Property 54: Request logger là best-effort**
    - **Validates: Requirements 13.7, 14.3, 14.4, 14.5**

  - [x] 9.6 Viết test cấu trúc bề mặt của `provider-copilot`
    - `tests/unit/copilot-surface.spec.ts`
    - **Property 25: `defaultModel` dạng string đòi đúng một route**
    - Test cấu trúc: AST/grep assert **không có** `extends HttpModelAdapter` trong `provider-copilot` (R7.1); `COPILOT_BASE_URL` và URL request khi không truyền `baseUrl` (R2.1); hai kiểu token tồn tại và không phải alias, `CopilotAuthFile` không có trường refresh-token và không import `CodexAuthFile` (R3.1, R5.1); bốn factory store và marker biến thể CAS (R6.2, R6.4); `id`/`family`/`routes` mặc định (R7.4); `Client_Identity_Constants` được export và không API nào đọc credential từ CLI nhà cung cấp (R11.1, R11.5); snapshot `COPILOT_ERROR_CODES` (R13.1)
    - **Validates: Requirements 2.1, 3.1, 5.1, 6.2, 6.4, 7.1, 7.4, 7.5, 11.1, 11.5, 13.1**

  - [x] 9.7 Chạy kiểm tra kiến trúc và snapshot bề mặt package hiện có
    - Ràng buộc "không chạm filesystem" **đã** được thực thi sẵn và **không** cần rule mới: `scripts/check-runtime-boundaries.mts` (chạy trong `pnpm lint`) đọc `aiAgentSdk.runtime` của package cộng `PACKAGE_RULES`, rồi cấm **mọi** import builtin của Node và cấm bốn global `Buffer`, `process`, `__dirname`, `__filename` trong mọi package `universal`. Đó là ràng buộc **mạnh hơn** `node:fs`/`node:path`/`process.env`, nên việc cần làm ở đây là xác nhận `provider-copilot` khai báo `runtime: 'universal'` (task 4.1) và chạy `pnpm check:runtime-boundaries` cho ra 0 lỗi — không thêm rule trùng lặp vào `.dependency-cruiser.cjs`
    - `.dependency-cruiser.cjs` hiện chỉ có rule `no-circular`: xác nhận nó vẫn pass với hai package mới, và chạy `pnpm check:graph` để `check-package-graph.mts` xác nhận hai entry `PACKAGE_RULES` của task 1.1 và 4.1 khớp đúng cạnh dependency thực tế
    - API surface snapshot chứng minh bề mặt công khai của `packages/core`, `packages/provider-http`, `protocol-responses`, `protocol-anthropic-messages`, `protocol-gemini-interactions` **không đổi một dòng nào** — đây là điều kiện Yêu cầu 18.4, và cũng là lý do DD-1 và DD-3 chọn giải pháp nằm trong `provider-copilot`
    - Assert dựng adapter thất bại khi thiếu `authStore` (R6.1)
    - `publint` + `attw` + `test:pack` cho `packages/provider-copilot`
    - _Requirements: 6.1, 18.3, 18.4, 18.6_

- [x] 10. Checkpoint khối 2 — generation của Copilot chạy được không cần credential thật
  - Barrier: không task nào sau đây được bắt đầu trước khi task 4.x đến 9.x hoàn thành.
  - Điều kiện: Property 1–20 (trừ 21, 22 thuộc khối 3), 23–35, 49–54 pass; `dependency-cruiser` pass; API surface snapshot của `core`/`provider-http`/các package protocol **không đổi**.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Viết `Copilot_Node_Auth`
  - [x] 11.1 Viết file store và phân giải path
    - `packages/auth-node/src/copilot-store.ts`: `DEFAULT_COPILOT_AUTH_PATH = '.providers/.copilot/auth.json'`, `COPILOT_AUTH_PATH_ENV = 'AI_AGENT_SDK_COPILOT_AUTH'`, `resolveCopilotAuthPath`, `fileCopilotAuthStore`, `fileCopilotCredentialStore`
    - Precedence path đúng khuôn `resolveCodexAuthPath`: `explicitPath` → biến môi trường → mặc định; chuỗi rỗng hoặc toàn khoảng trắng coi như vắng mặt; chuỗi chứa `\0` bị từ chối bằng `TypeError`; path tương đối resolve theo `cwd`
    - Path mặc định là **của SDK này**, đặt cạnh `.providers/.codex/auth.json` và tách hẳn khỏi vị trí credential của mọi editor client hay CLI nhà cung cấp. Lý do khác Codex: Copilot không có hazard rotate token, nhưng SDK vẫn không có quyền ghi vào file của một chương trình khác, và một file do SDK sở hữu là điều kiện để `--status` nói được sự thật về trạng thái của **SDK**
    - `fileCopilotCredentialStore` dựng bằng `defineCredentialStore`, `revisionOf(raw) = sha256(nội dung file thô)`, `validateExpectedRevision` chặn revision rỗng/quá dài, commit chạy trong `withCredentialFileLock` với vòng read-compare-replace; dùng lại nguyên `readCredentialText`/`replaceCredentialText`/`credentialFileError` từ `./common/credential-file.ts`
    - Quyền `0o600` do `replaceCredentialText` đã thực thi cho Codex nên Copilot được nó miễn phí — vẫn phải có test để một thay đổi ở helper dùng chung không âm thầm nới quyền
    - _Requirements: 6.5, 6.7, 6.8_

  - [x] 11.2 Viết wrapper Node và re-export bề mặt Universal
    - `packages/auth-node/src/copilot.ts`: `copilotNodeProviderPlugin` inject `fileCopilotCredentialStore()` mặc định, re-export bề mặt Universal, **không thêm logic nào** — wrapper mỏng theo đúng khuôn `codex.ts`
    - _Requirements: 6.5, 18.2_

  - [x] 11.3 Viết `Copilot_Login_Cli`, bin entry và script
    - `packages/auth-node/src/copilot-cli.ts` theo khuôn `cli.ts` của Codex: không flag ⇒ đăng nhập device flow (in `user_code` + URL, mở browser best-effort, persist); `--status` in trạng thái đăng nhập, `login`, path file và **trạng thái đổi token thử một lần** (không in token); `--models` gọi `/models` và in `router.snapshot()`; `--force`; `--path <file>`; `--issuer <url>`; `--github-api <url>`
    - `--models` là bề mặt chẩn đoán quan trọng nhất của spec: khi một model chạy sai endpoint, nó trả lời cả "endpoint nào" và "vì sao" (`source`) trong một lệnh
    - `SIGINT` abort `AbortController` để Ctrl-C trong một vòng poll 15 phút thoát ngay
    - `packages/auth-node/bin/ai-agent-sdk-copilot-login.mjs`
    - `packages/auth-node/package.json`: thêm `"./copilot"` vào `exports` (dùng đuôi `.mjs`/`.d.mts` như ba entry hiện có của package này, **không** phải `.js`/`.d.ts` của các package universal) và `ai-agent-sdk-copilot-login` vào `bin`; `packages/auth-node/tsdown.config.ts`: thêm hai entry `copilot: 'src/copilot.ts'` và `copilot-cli: 'src/copilot-cli.ts'` — `cli.ts` của Codex đã là một entry riêng nên bản Copilot cũng phải có, thiếu nó thì bin entry không có file dist để nạp
    - `packages/auth-node/vitest.config.ts`: thêm alias `@alvin0/ai-agent-sdk-auth-node/copilot` → `./src/copilot.ts` và thêm ba spec của task 11.4–11.6 vào `include`
    - **Mở rộng allowlist cho cạnh mới**: entry `auth-node` trong `PACKAGE_RULES` của `scripts/package-policy.mts` hiện là `workspaceDependencies: [core, provider-codex]`. Thêm `provider-copilot` vào đó, nếu không `check-package-graph.mts` báo `forbidden workspace edge to @alvin0/ai-agent-sdk-provider-copilot`
    - `package.json` gốc: `provider:copilot:login-device`, `provider:copilot:status`, `provider:copilot:models`. Codex hiện chỉ có **hai** script (`provider:codex:login-device`, `provider:codex:status`) nên hai script đầu theo đúng khuôn đó; `provider:copilot:models` là script **mới không có bản đối ứng Codex**, vì `--models` là flag riêng của Copilot CLI (Codex CLI chỉ có `--force`, `--issuer`, `--path`, `--status`)
    - _Requirements: 6.6, 18.2, 18.7_

  - [x] 11.4 Viết property test cho phân giải path
    - `tests/unit/copilot-auth-path.spec.ts`
    - **Property 21: Phân giải path credential đúng precedence**
    - **Validates: Requirements 6.5**

  - [x] 11.5 Viết property test cho file store
    - `tests/unit/copilot-auth-file-store.spec.ts`
    - **Property 20: Commit đồng thời cho đúng một bên thắng** (phía file store)
    - **Property 22: File credential luôn chỉ chủ sở hữu đọc và ghi** — kể cả khi file đích đã tồn tại với quyền rộng hơn
    - **Validates: Requirements 6.3, 6.8, 16.6**

  - [x] 11.6 Viết test cho `Copilot_Login_Cli`
    - `tests/unit/copilot-login-cli.spec.ts`: `--status`, `--models`, `--force` chạy đúng; không lệnh nào in giá trị token
    - Tùy chọn vì mọi SHALL mà file này chạm tới đã có task **bắt buộc** phủ: Yêu cầu 6.6 do task 11.3 phủ bằng test cấu hình bin entry, Yêu cầu 9.8 do Property 35 (task 8.3) phủ, Yêu cầu 13.7 do Property 50 (task 9.5) phủ. Đây là lớp kiểm chứng bổ trợ cho bề mặt CLI, không phải đường duy nhất tới một SHALL
    - _Requirements: 6.6_

- [x] 12. Checkpoint khối 3 — đăng nhập và credential trên Node hoạt động
  - Barrier: không task nào sau đây được bắt đầu trước khi task 11.x hoàn thành.
  - Điều kiện: Property 21, 22 pass; `--status`/`--models`/`--force` pass; bin entry chạy được từ package đã đóng gói.
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Viết `Copilot_Embedding_Adapter` — **CHẶN trên spec `embedding-support`**
  - **Quan hệ chặn, áp dụng cho toàn bộ task 13.x:** task này không thể bắt đầu trước khi `embedding-support` task 1.x và 2.x (`Http_Transport` đã tách, `Sse_Pipeline` dựng lại trên nó), 4.x (`Json_Pipeline`), 5.x–6.x (`Embedding_Contract`, `EmbeddingAdapter`, entry point `@alvin0/ai-agent-sdk-core/embedding`) hạ cánh. Trước đó, `packages/provider-copilot/src/embedding.ts` không tồn tại và entry `./embedding` không được khai báo.
  - [~] 13.1 Mở entry point `./embedding`
    - `packages/provider-copilot/package.json`: thêm `"./embedding"` vào `exports`; `tsdown.config.ts`: thêm entry `embedding: 'src/embedding.ts'`
    - `./embedding` là entry riêng chủ ý: nó là entry **duy nhất** import `@alvin0/ai-agent-sdk-core/embedding`, nên ứng dụng chỉ dùng generation không kéo contract embedding vào bundle, và khối 4 lắp vào được mà không sửa entry `.`
    - Điều kiện xong: entry `.` build và pass **không đổi** so với trạng thái cuối khối 2 (R1.4, R1.6)
    - _Requirements: 1.4, 1.6, 18.7_

  - [~] 13.2 Viết adapter, plugin factory và `Embedding_Profile`
    - `packages/provider-copilot/src/embedding.ts`: `CopilotEmbeddingProviderOptions`, `copilotEmbeddingAdapter`, `copilotEmbeddingPlugin`, `COPILOT_EMBEDDING_COMPATIBILITY_PREFIX`, `copilotCompatibilityIdentity`
    - Triển khai bằng `EmbeddingAdapter` của `Embedding_Contract`, **không** định nghĩa contract embedding riêng; đăng ký qua plugin kind embedding, giữ `PROVIDER_PLUGIN_API_VERSION` ở `1`; cộng thêm provider thứ ba mà không đổi OpenAI và Gemini
    - Vòng đời HTTP dùng `Json_Pipeline` trên `Http_Transport`, **không** tự viết và không gọi `fetch` trực tiếp
    - Wire `POST {baseUrl}/embeddings` với `Authorization`, `Editor_Headers`, `Content-Type`; `dimensions` **chỉ** lên wire khi route khai báo hỗ trợ, ngược lại tham số bị bỏ hẳn khỏi body
    - Đúng **một** `Provider_Attempt` cho mỗi lần `Embedding_Runtime` gọi `embedBatch` — retry thuộc runtime, không thuộc adapter
    - Validate response theo thứ tự cố định: `data.length` ⇒ `EMBEDDING_VECTOR_COUNT_MISMATCH` → tập `data[i].index` là permutation `0..N-1` ⇒ `EMBEDDING_VECTOR_INDEX_INVALID` → mọi phần tử là số hữu hạn ⇒ `EMBEDDING_VECTOR_VALUE_INVALID` → số chiều khớp yêu cầu ⇒ `EMBEDDING_VECTOR_DIMENSIONS_MISMATCH` → shape ngoài dự kiến ⇒ `EMBEDDING_RESPONSE_MALFORMED`. Không bước nào cắt, pad, sắp lại hay thay giá trị
    - Chỉ số gắn lên vector là `items[data[i].index].index` — chỉ số trong `Logical_Call`, không phải trong `Physical_Batch`
    - Usage: `prompt_tokens → inputTokens`, `total_tokens → totalTokens`; vắng mặt hoặc sai kiểu ⇒ `status: 'missing'` cộng warning `usage-unreported`/`usage-malformed`, và **không trường số nào** được gán `0`
    - `compatibilityIdentity` theo **dòng model** với prefix `'github-copilot'`, tách hẳn khỏi OpenAI và Gemini: Copilot proxy tới model phía sau nhưng tiền xử lý, phiên bản model và chính sách chuẩn hoá của proxy đều không được tài liệu hoá và có thể đổi mà không thông báo. Tuyên bố tương thích là một cam kết, và ở đây không ai cam kết cả
    - Credential dùng **chung** `CopilotTokenCache` với generation khi ứng dụng truyền cùng một cache
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9_

  - [~] 13.3 Ghi fixture embedding gồm hai nhóm negative fixture
    - `packages/provider-copilot/fixtures/embeddings-ok.json`, `embeddings-count-mismatch.json`, `embeddings-index-duplicate.json`, `embeddings-nan.json`, `embeddings-wrong-dimensions.json`, `embeddings-no-usage.json`
    - Nhóm "sai mapping" (`count-mismatch`, `index-duplicate`) trả lời: SDK có phát hiện trước khi trả vector sai người? Nhóm "vector không hợp lệ" (`nan`, `wrong-dimensions`) trả lời: SDK có từ chối thay vì cắt/pad? Hai nhóm cố ý **không** gộp vào một file
    - _Requirements: 16.3_

  - [~] 13.4 Viết property test cho request embedding
    - `tests/unit/copilot-embedding-request.spec.ts`
    - **Property 48: Tham số số chiều chỉ lên wire khi model nhận nó**
    - Kèm transport spy: `embedBatch` đi qua `Json_Pipeline`, không gọi `fetch` trực tiếp (R1.2)
    - **Validates: Requirements 1.2, 12.9**

  - [~] 13.5 Viết property test cho response embedding
    - `tests/unit/copilot-embedding-response.spec.ts`
    - **Property 43: Một `Provider_Attempt` cho mỗi lần adapter embedding được gọi**
    - **Property 45: Validate response embedding theo thứ tự, không sửa dữ liệu**
    - **Property 46: Usage embedding trung thực**
    - **Property 47: Chỉ số input gốc được giữ qua mọi permutation**
    - **Validates: Requirements 12.2, 12.4, 12.5, 12.6, 12.7, 12.8**

  - [~] 13.6 Viết property test cho `Embedding_Profile` của Copilot
    - `tests/unit/copilot-embedding-profile.spec.ts`
    - **Property 44: Embedding space của Copilot tách khỏi OpenAI và Gemini** — hai profile **cùng số chiều** và cùng tên model phía sau vẫn phải cho `isSpaceCompatible === false`
    - Kèm test cấu trúc: `instanceof EmbeddingAdapter`, `PROVIDER_PLUGIN_API_VERSION === 1` (R1.1, R1.3)
    - **Validates: Requirements 1.1, 1.3, 12.3**

- [ ] 14. Dựng integration test và mở rộng `Conformance_Harness`
  - [x] 14.1 Dựng integration test gọi endpoint thật
    - `tests/integration/copilot-generation.spec.ts` và `tests/integration/copilot-embedding.spec.ts`, chạy bằng `vitest.integration.config.ts` sẵn có, **không** chạy trong suite mặc định
    - Phần **bắt buộc**: hai file test, và guard đọc `Copilot_Credential_Store` mặc định của Node để suite tự **skip** khi không có credential thay vì fail — đây là phần thoả Yêu cầu 16.4 và 16.5, và là điều kiện để CI công khai xanh mà không cần secret nào
    - Ba scenario đáng gọi endpoint thật, vì mock không kiểm chứng được: `GET /models` trả gì cho tài khoản này và `capabilities.type` có những giá trị nào (nguồn duy nhất xác nhận bảng phân loại của Property 28 còn khớp thực tế); một model qua `/responses` và một model qua `/chat/completions`, mỗi cái một lượt stream ngắn; một lần `Copilot_Token_Exchange` thật chỉ để xác nhận `expires_at` vẫn có mặt và đọc được
    - Phần **tùy chọn**: lượt chạy thật với credential Copilot, vì nó cần bí mật mà CI công khai không có. Không scenario nào chạy 100 iteration — chi phí quota là thật và biến thiên input không mua thêm thông tin gì ở đây
    - _Requirements: 16.4, 16.5_

  - [x] 14.2 Chạy scenario generation hiện có với fixture Copilot trên cả hai protocol
    - `packages/testkit/src/provider/copilot/`: fixture và scenario module cho generation, cộng phần nối vào registry của `packages/testkit/src/provider/`
    - Chạy toàn bộ scenario generation hiện có **hai lần**: một lần với `endpointOverrides` buộc router chọn `/responses`, một lần buộc chọn `/chat/completions`. Hai lượt dùng **chung mọi assertion**; chỉ fixture và override khác nhau
    - `schemaVersion` và cấu trúc báo cáo của harness **không đổi** — fixture Copilot là dữ liệu thêm vào, không phải một hình dạng báo cáo mới
    - _Requirements: 15.1, 15.3_

  - [~] 14.3 Thêm scenario embedding và bốn nhóm scenario đặc thù Copilot
    - `packages/testkit/src/provider/copilot/`: scenario module cho embedding và cho bốn nhóm đặc thù, cộng phần nối chúng vào registry
    - Bốn nhóm: chọn endpoint theo model (cùng một request logic, hai model, hai endpoint, cùng một kết quả logic); thiếu `Editor_Headers` (400 ⇒ `COPILOT_EDITOR_HEADERS_MISSING` với message nêu tên cả hai header); từ chối credential ở exchange (403 ⇒ `COPILOT_CREDENTIAL_REJECTED` permanent kèm hướng dẫn); refresh chủ động trước hết hạn (token còn 4 phút ⇒ đúng một exchange **trước** khi request đi; còn 30 phút ⇒ 0 exchange)
    - _Requirements: 15.2, 15.4_

  - [x] 14.4 Viết assertion so sánh chéo error code ở tầng harness
    - `tests/unit/copilot-cross-provider-errors.spec.ts`, cộng phần nối vào `packages/testkit/vitest.config.ts`
    - **Property 41: Cùng tình huống lỗi cho cùng error code ở mọi provider** — cùng `(status, body)` đưa qua `Copilot_Adapter` và qua một provider hiện có phải cho **cùng** error code, cùng cờ retryable, cùng delay đọc từ `retry-after` và cùng provider request id
    - Đây là lượt chạy **thứ hai** của Property 41, ở tầng harness với `Copilot_Adapter` đã lắp đủ; lượt thứ nhất ở task 2.7 chạy tại tầng protocol trên `Chat_Completions_Protocol` đứng một mình. Hai lượt cùng một property, hai chủ thể khác nhau
    - **Validates: Requirements 10.6, 13.5, 15.5**

- [ ] 15. Kiểm tra kiến trúc cuối và cập nhật `Documentation_Set`
  - [x] 15.1 Chạy kiểm tra kiến trúc và snapshot bề mặt cho khối 4
    - API surface snapshot của `packages/provider-openai` và `packages/provider-gemini` **không đổi** — Copilot cộng thêm một provider embedding, không thay provider nào (R1.5)
    - `pnpm lint` pass toàn bộ bốn kiểm tra: `check-package-graph` (hai package mới đã đăng ký trong `PACKAGE_RULES`, cạnh dependency khớp), `check-dependency-cruiser` (`no-circular`, không chu trình mới), `check-agent-boundaries`, và `check-runtime-boundaries` (`provider-copilot` là `universal` nên không builtin Node và không global `process`/`Buffer` nào — kể cả trong `src/embedding.ts` mới)
    - Mọi import contract embedding đi qua entry point công khai `@alvin0/ai-agent-sdk-core/embedding` chứ không import sâu vào `core/src/embedding`; `PACKAGE_RULES` của `provider-copilot` vẫn không cần cạnh mới nào vì `core` đã có trong `workspaceDependencies` (R1.6)
    - Build smoke: hai entry `.` và `./embedding` của `provider-copilot` cùng phân giải, `publint` + `attw` + `test:pack` pass cho `provider-copilot`, `protocol-openai-chat-completions` và `auth-node`
    - Đối chiếu khoá `exports` của `package.json` với `entry` của `tsdown.config.ts` cho cả ba package (R18.7)
    - _Requirements: 1.5, 1.6, 18.3, 18.4, 18.6, 18.7_

  - [x] 15.2 Cập nhật tài liệu provider và bảng error code
    - `skills/ai-agent-sdk/references/providers.md`: các bước thiết lập gồm chạy `Copilot_Login_Cli`, vị trí file credential và biến môi trường ghi đè path; lý do personal access token không dùng được ở bề mặt này; tenant data-residency `*.ghe.com` nằm ngoài phạm vi; cơ chế chọn endpoint theo model và cách ghi đè bằng `endpointOverrides` + `responsesModelPrefixes`; `copilotPlugin` và `copilotNodeProviderPlugin`
    - `skills/ai-agent-sdk/references/errors.md`: 15 giá trị của `COPILOT_ERROR_CODES` kèm **hành động tương ứng** cho từng code, và ghi rõ ba tình huống dùng code sẵn có của SDK (`MISSING_CREDENTIAL`, code abort, `MODEL_ERROR_CODES`/`HTTP_PROVIDER_ERROR_CODES`)
    - Bắt buộc vì Yêu cầu 17.1, 17.2, 17.3, 17.4, 17.6 đều là SHALL, và người dùng không thể suy ra mã lỗi mới, cơ chế chọn endpoint hay ranh giới `*.ghe.com` từ code
    - _Requirements: 13.1, 17.1, 17.2, 17.3, 17.4, 17.6_

  - [x] 15.3 Cập nhật tài liệu package, embedding và tradeoff danh tính client
    - `skills/ai-agent-sdk/references/packages.md`: hai package mới `protocol-openai-chat-completions` và `provider-copilot`, entry point `@alvin0/ai-agent-sdk-provider-copilot/embedding`, entry `@alvin0/ai-agent-sdk-auth-node/copilot`, cùng cách dùng package protocol mới cho **một endpoint tương thích OpenAI khác** (không phải Copilot)
    - `skills/ai-agent-sdk/references/testing.md`: fixture và bốn nhóm scenario đặc thù Copilot trong `Conformance_Harness`, cộng ghi chú rằng scenario generation chạy hai lượt cho hai protocol
    - `web-documents/`: hướng dẫn đăng ký `copilotEmbeddingPlugin` và khác biệt usage so với các provider embedding khác; mục tradeoff của việc dùng bề mặt Copilot subscription cùng khuyến nghị dùng provider chính thức của nhà cung cấp cho môi trường production
    - Bắt buộc như 15.2: Yêu cầu 11.4, 17.5 và 17.7 cũng là SHALL. Khác biệt với 15.2 chỉ là tập file, nên hai task này chạy song song được
    - _Requirements: 11.4, 17.5, 17.7_
  - [x] 15.4 Thực hiện test thực tế với GITHUB_ACCESS_TOKEN người dùng đã cung cấp ở .env
    - Người không cần thay đổi code đề phù hợp với GITHUB_ACCESS_TOKEN chỉ cần lấy giá trị token của GITHUB_ACCESS_TOKEN và thực hiện việc kiểm thử gọi model LLM và model embedding `text-embedding-3-small`

- [~] 16. Final checkpoint — toàn bộ suite và conformance pass
  - Barrier: chạy sau khi task 13.x, 14.x và 15.x hoàn thành.
  - Điều kiện: cả 54 property pass; harness generation hai protocol và harness embedding pass; docs lint pass; API surface snapshot của `core`, `provider-http`, các package protocol hiện có, `provider-openai` và `provider-gemini` **không đổi**.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- **Khối 1, 2 và 3 hoàn toàn khả thi hôm nay.** Chúng không phụ thuộc task nào của spec `embedding-support`. Chỉ khối 4 (task 13.x, và phần embedding của 14.x/15.x) bị chặn trên `embedding-support` task 1.x, 2.x, 4.x, 5.x–6.x; quan hệ chặn đó được ghi tường minh ở đầu task 13.
- **Task 4.1 là điều kiện tiên quyết của cả khối 2.** `COPILOT_OAUTH_CLIENT_ID`, `COPILOT_EDITOR_VERSION` và `COPILOT_EDITOR_PLUGIN_VERSION` là ba giá trị duy nhất chưa được chốt trong toàn bộ design. Một client id của OAuth App nằm trong allowlist là tiền điều kiện để `copilot_internal/v2/token` hoạt động; personal access token không thay thế được. Trước khi 4.1 xong, property test vẫn chạy bằng fetch inject nhưng không có gì xác nhận endpoint chấp nhận ba giá trị này.
- Chỉ đúng **một** task tùy chọn (`*`): **11.6**, test của `Copilot_Login_Cli`. Nó được phép bỏ vì mọi SHALL nó chạm tới đã có task bắt buộc phủ — 6.6 bởi 11.3, 9.8 bởi Property 35 ở task 8.3, 13.7 bởi Property 50 ở task 9.5.
- Mọi acceptance criteria dạng SHALL có ít nhất một task **bắt buộc** phủ nó. Hai chỗ đáng nêu: Yêu cầu 17 (bảy criteria tài liệu) do task 15.2 và 15.3 phủ, **cả hai bắt buộc**; Yêu cầu 16.4 và 16.5 do task 14.1 phủ ở phần file test cộng guard tự-skip, **bắt buộc** — chỉ lượt chạy thật với credential là tùy chọn *bên trong* task đó, vì nó cần bí mật mà CI công khai không có.
- Property test mang tag **Feature: github-copilot-provider, Property {number}: {property text}** và chạy tối thiểu 100 iteration vì input được sinh ngẫu nhiên. Cả 54 property đều có task: 1–4 và 23, 26 ở 9.3; 5–8, 15 ở 6.4; 9 ở 4.6; 10–14, 16 ở 5.3; 17–19, 52 ở 6.5; 20, 24, 49 ở 4.7; 20, 22 ở 11.5; 21 ở 11.4; 25 ở 9.6; 27–31 ở 7.3; 32–35 ở 8.3; 36, 39, 40 ở 1.5; 37 ở 2.4; 38 ở 2.5; 41 ở 2.7 (tầng protocol) và 14.4 (tầng harness); 42 ở 2.6; 43, 45–47 ở 13.5; 44 ở 13.6; 48 ở 13.4; 50, 53, 54 ở 9.5; 51 ở 9.4.
- **Clock ảo cho mọi test thời gian.** Property 11, 12, 17, 18 phụ thuộc thời gian và đều dùng clock inject: `shouldExchange(api, now, marginMs)` nhận `now` làm tham số, `sleep(ms, signal)` nhận `timer` inject được, và đường polling dùng fake timer. Không test nào chờ thời gian thật — một suite chờ 15 phút để kiểm biên 15 phút là một suite sẽ bị ai đó vô hiệu hoá.
- **Spec file nằm ở `tests/unit/` gốc, không nằm trong package.** Đây là quy ước sẵn có của repository, không phải một lựa chọn của spec này: không package nào có thư mục `tests/` riêng, cả 114 spec hiện có nằm ở `tests/unit/` gốc, `vitest.config.ts` gốc `include` `tests/**/*.spec.ts`, và mỗi package có một `vitest.config.ts` `include` ngược lại các đường dẫn `../../tests/unit/*.spec.ts` kèm `resolve.alias` trỏ specifier của chính nó về `./src/*.ts` (xem `packages/protocol-responses/vitest.config.ts` và `packages/provider-codex/vitest.config.ts`). Nhờ vậy mỗi spec chạy hai lần: một lần ở `pnpm test` từ gốc, một lần theo package ở `pnpm test:packages`. Integration spec nằm ở `tests/integration/` gốc, vì `vitest.integration.config.ts` chỉ `include` `tests/integration/**/*.spec.ts` và `vitest.config.ts` gốc `exclude` đúng thư mục đó. Tên file mang tiền tố `copilot-` / `chat-completions-` để không đụng 114 spec đang có trong cùng một thư mục phẳng.
- **`fixtures/` thì ngược lại: nằm trong package.** `packages/provider-codex/fixtures/` và `packages/protocol-responses/fixtures/` đều tồn tại, nên đường dẫn fixture của spec này giữ nguyên trong package.
- Ba nhóm **không** dùng property test, theo đúng design: cấu hình build/`exports`/layout/bin entry (smoke test + `publint` + `attw`); tài liệu (docs lint); kiến trúc dependency và ràng buộc không-chạm-filesystem (`dependency-cruiser`).
- Ba ràng buộc kỹ thuật dễ mất khi triển khai, đều là điều kiện nghiệm thu tường minh: composite protocol phải dùng **closure** chứ không `this` vì `captureRuntimeProtocol` gọi `Reflect.apply`; `CopilotDialect` phải **phẳng** vì `resolveDialect` merge nông; single-flight exchange phải có **AbortController riêng** chứ không nhận signal của caller.
- Checkpoint ở task 3, 10, 12, 16 là **barrier thật**: dependency graph không cho task nào sau một checkpoint chạy song song với task nào trước checkpoint đó. Bốn khối kiểm chứng độc lập là {1.x, 2.x} `Chat_Completions_Protocol`; {4.x–9.x} generation của Copilot; {11.x} `Copilot_Node_Auth`; {13.x–15.x} embedding, harness và tài liệu.
- Ba phụ thuộc thứ tự bên trong khối được graph ràng buộc tường minh: 4.1 trước mọi task còn lại của khối 2 (nó tạo `package.json`, `src/oauth.ts` và `src/adapter.ts`); 6.1 trước 6.2 (cùng file `src/exchange.ts`); 14.2 trước 14.3 (cùng registry của `packages/testkit/src/provider/`).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["1.5", "2.1", "2.2"] },
    { "id": 4, "tasks": ["2.3", "2.4", "2.5", "2.6", "2.7"] },
    { "id": 5, "tasks": ["2.8"] },
    { "id": 6, "tasks": ["3"] },
    { "id": 7, "tasks": ["4.1"] },
    { "id": 8, "tasks": ["4.2", "4.4"] },
    { "id": 9, "tasks": ["4.3", "4.5", "5.2", "6.3", "7.2"] },
    { "id": 10, "tasks": ["4.6", "4.7", "5.1", "6.1", "7.1"] },
    { "id": 11, "tasks": ["5.3", "6.2", "6.4", "7.3", "8.1"] },
    { "id": 12, "tasks": ["6.5", "8.2"] },
    { "id": 13, "tasks": ["8.3", "9.1"] },
    { "id": 14, "tasks": ["9.2", "9.3", "9.4", "9.5", "9.6"] },
    { "id": 15, "tasks": ["9.7"] },
    { "id": 16, "tasks": ["10"] },
    { "id": 17, "tasks": ["11.1"] },
    { "id": 18, "tasks": ["11.2", "11.4", "11.5"] },
    { "id": 19, "tasks": ["11.3"] },
    { "id": 20, "tasks": ["11.6"] },
    { "id": 21, "tasks": ["12"] },
    { "id": 22, "tasks": ["13.1", "13.3"] },
    { "id": 23, "tasks": ["13.2"] },
    { "id": 24, "tasks": ["13.4", "13.5", "13.6", "14.1", "14.2"] },
    { "id": 25, "tasks": ["14.3"] },
    { "id": 26, "tasks": ["14.4", "15.2", "15.3", "15.4"] },
    { "id": 27, "tasks": ["15.1"] },
    { "id": 28, "tasks": ["16"] }
  ]
}
```
