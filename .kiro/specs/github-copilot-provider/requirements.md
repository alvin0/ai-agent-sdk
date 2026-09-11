# Requirements Document

## Introduction

Tài liệu này mô tả yêu cầu cho việc bổ sung **GitHub Copilot** làm một provider của `ai-agent-sdk`, phủ cả hai năng lực: **generation** (streaming, tool call, structured output) và **embedding**.

Provider này dùng **Copilot subscription API** tại `https://api.githubcopilot.com`, truy cập qua cơ chế đổi token nội bộ `copilot_internal/v2/token` của GitHub. Đây **không** phải GitHub Models REST API — GitHub Models là một bề mặt khác, với cách tính hạn mức khác, và nằm ngoài phạm vi spec này.

Ba đặc điểm của Copilot quyết định hình dạng của spec:

1. **Xác thực hai tầng.** Một GitHub user token dài hạn (tiền tố `ghu_`, lấy qua OAuth device flow) được đổi lấy một Copilot API token ngắn hạn mang `expires_at`. Token dài hạn **không** rotate khi đổi, khác hoàn toàn refresh token dùng-một-lần của Codex, nên `CodexAuthFile` và `shouldRefresh` không thể sao chép nguyên trạng.
2. **Hai wire protocol song song, chọn theo từng model.** Endpoint `/responses` chỉ hoạt động với một tập con model; phần còn lại chỉ hoạt động với `/chat/completions`. Repository hiện có `protocol-responses` nhưng **chưa có** protocol Chat Completions nào, nên spec này tạo package mới `protocol-openai-chat-completions` và thiết kế nó như một protocol dùng lại được cho mọi endpoint tương thích OpenAI, không gắn cứng vào Copilot.
3. **Bắt buộc header của editor client.** Thiếu `Editor-Version` hoặc `Editor-Plugin-Version` thì endpoint trả HTTP 400.

Provider tuân theo precedent kiến trúc của Codex đã được kiểm chứng trong repository: **không** subclass `HttpModelAdapter`, mà cấu hình `createHttpProvider` / `createRuntimeHttpProvider` của `packages/provider-http/src/configurable/` với `auth: { kind: 'dynamic' }`; storage được **inject**, còn quyền sở hữu filesystem, path và environment thuộc `packages/auth-node`.

Phần embedding của spec này **phụ thuộc cứng** vào spec `embedding-support`: Copilot là provider embedding **thứ ba**, đặt cạnh OpenAI và Gemini, và không thay thế provider nào trong hai provider đó.

**Ngoài phạm vi (non-goals) của spec này:** GitHub Models REST API; hỗ trợ token exchange trên tenant data-residency `*.ghe.com`; các bề mặt Copilot khác ngoài generation và embedding (code completion `/v1/engines`, Copilot Chat skills, agent mode); vector store, retrieval và RAG pipeline; cấu hình bằng personal access token (bề mặt endpoint từ chối PAT nên đây là điều bất khả thi, không phải một lựa chọn thiết kế).

## Glossary

- **Copilot_Provider**: package Universal mới `packages/provider-copilot`, chứa toàn bộ code Copilot không phụ thuộc filesystem.
- **Copilot_Adapter**: adapter generation của Copilot, tạo ra bằng cách cấu hình `Configurable_Http_Provider`.
- **Copilot_Embedding_Adapter**: `Embedding_Adapter` của Copilot trong `Copilot_Provider`.
- **Configurable_Http_Provider**: đường cấu hình sẵn có tại `packages/provider-http/src/configurable/` gồm `createHttpProvider`, `createRuntimeHttpProvider` và `runtime-types.ts`.
- **Copilot_Auth**: module credential contract và JWT/expiry helper của `Copilot_Provider`, đối ứng với `provider-codex/src/auth.ts`.
- **Copilot_Oauth**: module OAuth device flow của `Copilot_Provider`, đối ứng với `provider-codex/src/oauth.ts`.
- **Copilot_Token_Exchange**: lời gọi đổi `GitHub_User_Token` thành `Copilot_Api_Token` tại `https://api.github.com/copilot_internal/v2/token`.
- **GitHub_User_Token**: token GitHub dài hạn, tiền tố `ghu_`, do OAuth device flow của một OAuth App nằm trong allowlist cấp.
- **Copilot_Api_Token**: token ngắn hạn do `Copilot_Token_Exchange` trả về, mang trường `expires_at` và được dùng làm bearer token cho `https://api.githubcopilot.com`.
- **Copilot_Credential_File**: cấu trúc dữ liệu credential được persist, chứa `GitHub_User_Token` và metadata phiên đăng nhập.
- **Copilot_Credential_Store**: contract storage được inject vào `Copilot_Provider`, gồm biến thể read/write và biến thể compare-and-swap có revision.
- **Copilot_Token_Cache**: bộ nhớ trong tiến trình giữ `Copilot_Api_Token` hiện hành cùng thời điểm hết hạn của nó.
- **Copilot_Node_Auth**: phần Copilot trong `packages/auth-node`, gồm file store, login CLI và bin entry.
- **Copilot_Login_Cli**: giao diện dòng lệnh chạy device-code login và persist kết quả, kèm bin entry `bin/ai-agent-sdk-copilot-login.mjs`.
- **Editor_Headers**: bộ header client bắt buộc của Copilot API gồm `Editor-Version` và `Editor-Plugin-Version`.
- **Client_Identity_Constants**: các hằng số exported có tên mô tả giá trị mặc định của OAuth client id và `Editor_Headers`, đối ứng với `CODEX_CLIENT_ID` và `CODEX_ORIGINATOR`.
- **Copilot_Catalog**: metadata model của Copilot, phát hiện từ `GET /models` của Copilot API.
- **Model_Capability_Type**: trường `capabilities.type` trong một entry của `Copilot_Catalog`.
- **Copilot_Endpoint_Router**: thành phần quyết định một model generation được gọi qua `/responses` hay `/chat/completions`.
- **Chat_Completions_Protocol**: package mới `packages/protocol-openai-chat-completions`, triển khai wire protocol OpenAI Chat Completions.
- **Responses_Protocol**: package sẵn có `packages/protocol-responses` (`openAiResponsesProtocol`).
- **Http_Transport**: tầng transport dùng chung tại `packages/provider-http/src/transport/`, do spec `embedding-support` tạo ra.
- **Json_Pipeline**: pipeline request/response JSON dựng trên `Http_Transport`, do spec `embedding-support` tạo ra.
- **Sse_Pipeline**: pipeline generation SSE dựng trên `Http_Transport`, do spec `embedding-support` tạo ra.
- **Embedding_Contract**: contract embedding tại `packages/core/src/embedding/`, do spec `embedding-support` tạo ra.
- **Embedding_Adapter**: abstract class contract của `Embedding_Contract` mà một provider triển khai để thực hiện **một** physical request embedding.
- **Embedding_Runtime**: tầng composition embedding tại `packages/core/src/composition/embedding/`, do spec `embedding-support` tạo ra.
- **Embedding_Profile**: bản mô tả có phiên bản của một embedding space, định nghĩa bởi `Embedding_Contract`.
- **Logical_Call**: một lần gọi `embed()` hoặc `embedMany()` từ phía ứng dụng.
- **Provider_Attempt**: một lần gọi HTTP tới provider, tính cả các lần retry.
- **Conformance_Harness**: bộ harness conformance provider tại `packages/testkit/src/provider/`.
- **Documentation_Set**: `skills/ai-agent-sdk/references/` và `web-documents/`.

## Requirements

### Requirement 1: Phụ thuộc cứng vào spec embedding-support

**User Story:** Là người bảo trì SDK, tôi muốn phần embedding của Copilot được xây trên contract embedding đã có sẵn, để không có hai định nghĩa embedding song song trong repository.

#### Acceptance Criteria

1. THE Copilot_Provider SHALL triển khai `Copilot_Embedding_Adapter` bằng `Embedding_Adapter` của `Embedding_Contract`, không định nghĩa contract embedding riêng.
2. WHEN `Copilot_Embedding_Adapter` thực hiện một request, THE Copilot_Embedding_Adapter SHALL dùng `Json_Pipeline` trên nền `Http_Transport` thay vì tự viết vòng đời HTTP riêng.
3. THE Copilot_Provider SHALL đăng ký `Copilot_Embedding_Adapter` qua plugin kind embedding của `Embedding_Contract`, giữ nguyên `PROVIDER_PLUGIN_API_VERSION` hiện tại ở giá trị `1`.
4. WHERE `Embedding_Contract`, `Http_Transport` và `Json_Pipeline` chưa tồn tại trong repository, THE Copilot_Provider SHALL hoàn thành phần generation trước và giữ phần embedding ở trạng thái chưa triển khai.
5. THE Copilot_Provider SHALL cộng thêm một provider embedding vào tập provider embedding hiện có, giữ nguyên `OpenAI_Embedding_Adapter` và `Gemini_Embedding_Adapter` của spec `embedding-support`.
6. WHEN một module của `Copilot_Provider` import contract embedding, THE Copilot_Provider SHALL import qua entry point công khai `@alvin0/ai-agent-sdk-core/embedding`.

### Requirement 2: Bề mặt API Copilot subscription

**User Story:** Là người phát triển ứng dụng có Copilot subscription, tôi muốn dùng đúng bề mặt API mà subscription đó cấp quyền, để hạn mức và quyền truy cập khớp với gói tôi đang trả tiền.

#### Acceptance Criteria

1. THE Copilot_Adapter SHALL dùng `https://api.githubcopilot.com` làm base URL mặc định cho mọi request generation và embedding.
2. THE Copilot_Provider SHALL cho phép ghi đè base URL bằng một option cấu hình, và SHALL yêu cầu một option riêng được bật tường minh để chấp nhận base URL dùng cleartext HTTP.
3. WHEN Copilot_Adapter phát bất kỳ request nào tới base URL của Copilot, THE Copilot_Adapter SHALL gửi kèm `Authorization: Bearer <Copilot_Api_Token>`, `Editor_Headers` và `Content-Type: application/json`.
4. THE Copilot_Provider SHALL giữ `Editor_Headers` là giá trị cấu hình được, với mặc định lấy từ `Client_Identity_Constants`.
5. IF endpoint trả HTTP 400 kèm dấu hiệu thiếu `Editor_Headers`, THEN THE Copilot_Adapter SHALL phát một structured error nêu tên hai header bắt buộc và cách cấu hình chúng.
6. THE Copilot_Provider SHALL gửi mọi request generation và embedding tới base URL của Copilot đã cấu hình, và SHALL giữ GitHub Models REST API ở ngoài tập endpoint mà provider này gọi.

### Requirement 3: Xác thực hai tầng

**User Story:** Là người phát triển, tôi muốn SDK tự lo việc đổi token GitHub sang token Copilot, để tôi chỉ phải đăng nhập một lần thay vì quản lý hai loại token.

#### Acceptance Criteria

1. THE Copilot_Auth SHALL phân biệt tường minh hai loại credential: `GitHub_User_Token` dài hạn và `Copilot_Api_Token` ngắn hạn.
2. WHEN Copilot_Auth cần một `Copilot_Api_Token`, THE Copilot_Auth SHALL thực hiện `Copilot_Token_Exchange` bằng `GitHub_User_Token` và đọc `expires_at` từ response.
3. THE Copilot_Auth SHALL persist `GitHub_User_Token` qua `Copilot_Credential_Store` và giữ `Copilot_Api_Token` trong `Copilot_Token_Cache` của tiến trình.
4. WHEN Copilot_Token_Exchange thành công, THE Copilot_Auth SHALL giữ nguyên giá trị `GitHub_User_Token` đang được persist.
5. IF Copilot_Token_Exchange trả HTTP 403, THEN THE Copilot_Auth SHALL phát một structured error nêu rằng bề mặt này chỉ nhận token do một OAuth App nằm trong allowlist cấp và hướng người dùng chạy `Copilot_Login_Cli`.
6. IF host của `Copilot_Token_Exchange` thuộc miền `*.ghe.com` hoặc endpoint trả HTTP 404, THEN THE Copilot_Auth SHALL phát một structured error nêu rằng tenant data-residency không cung cấp bề mặt đổi token này.
7. THE Copilot_Auth SHALL pin origin của `Copilot_Token_Exchange` theo issuer đã cấu hình và từ chối một URL khác origin bằng một error trước khi phát request.
8. WHEN Copilot_Token_Exchange nhận một redirect response, THE Copilot_Auth SHALL từ chối redirect đó thay vì đi theo nó.

### Requirement 4: Đăng nhập bằng device flow có giới hạn

**User Story:** Là người phát triển làm việc qua SSH hoặc trong container, tôi muốn đăng nhập bằng device code, để không cần trình duyệt trên máy đang chạy code.

#### Acceptance Criteria

1. THE Copilot_Oauth SHALL triển khai OAuth device flow của GitHub, gồm bước yêu cầu device code và bước polling để đổi lấy `GitHub_User_Token`.
2. WHEN device code sẵn sàng, THE Copilot_Oauth SHALL báo cho caller mã người dùng, URL xác thực và khoảng thời gian giữa hai lần poll.
3. WHILE polling đang chạy, THE Copilot_Oauth SHALL tôn trọng khoảng thời gian do server yêu cầu và SHALL dừng sau tối đa 15 phút bằng một error có code ổn định.
4. WHEN server báo `authorization_pending` hoặc `slow_down`, THE Copilot_Oauth SHALL tiếp tục poll và SHALL tăng khoảng chờ theo giá trị server yêu cầu.
5. IF server báo `access_denied` hoặc `expired_token`, THEN THE Copilot_Oauth SHALL dừng polling và phát một structured error phân biệt hai trường hợp đó.
6. WHEN `AbortSignal` do caller cung cấp bị abort, THE Copilot_Oauth SHALL dừng flow và phát một error mang code abort của SDK.
7. THE Copilot_Oauth SHALL đọc mọi response body của OAuth trong giới hạn bytes và số chunk cấu hình được, với deadline cho từng request.
8. WHEN Copilot_Oauth hoàn thành đăng nhập, THE Copilot_Oauth SHALL trả về vị trí lưu credential và danh tính tài khoản mà endpoint tiết lộ.

### Requirement 5: Mô hình credential hai tầng và refresh chủ động

**User Story:** Là người vận hành, tôi muốn token ngắn hạn được làm mới trước khi hết hạn, để không có request nào thất bại vì token chết giữa đường.

#### Acceptance Criteria

1. THE Copilot_Auth SHALL định nghĩa `Copilot_Credential_File` riêng, mang `GitHub_User_Token` không rotate, thay vì tái dùng cấu trúc refresh-token dùng-một-lần của Codex.
2. WHEN Copilot_Adapter giải quyết header cho một operation, THE Copilot_Adapter SHALL kiểm tra thời điểm hết hạn của `Copilot_Api_Token` trong `Copilot_Token_Cache` trước khi phát request.
3. WHERE thời điểm hết hạn còn cách hiện tại ít hơn biên độ cấu hình được với mặc định 5 phút, THE Copilot_Auth SHALL thực hiện `Copilot_Token_Exchange` mới trước khi phát request.
4. WHILE nhiều operation đồng thời cùng cần một `Copilot_Api_Token` mới, THE Copilot_Auth SHALL hợp nhất chúng thành đúng một `Copilot_Token_Exchange` đang bay.
5. WHEN Copilot_Auth thực hiện `Copilot_Token_Exchange` trong quá trình giải quyết header, THE Copilot_Auth SHALL bọc lời gọi đó bằng `observeCredentialOperation` với tên operation mô tả việc đổi token.
6. IF `Copilot_Token_Exchange` thất bại vì lỗi mạng hoặc HTTP 5xx, THEN THE Copilot_Auth SHALL phát một error được phân loại là tạm thời.
7. IF `Copilot_Token_Exchange` thất bại vì HTTP 401 hoặc HTTP 403, THEN THE Copilot_Auth SHALL phát một error được phân loại là vĩnh viễn, kèm hướng dẫn đăng nhập lại.
8. THE Copilot_Auth SHALL giữ lỗi xác thực của Copilot ở trạng thái không retry, bằng cách quyết định refresh trước khi phát request thay vì phản ứng với một response 401.

### Requirement 6: Storage được inject và tách Universal khỏi Node

**User Story:** Là người bảo trì SDK, tôi muốn package Universal không chạm filesystem, để cùng code đó chạy được trong runtime không có filesystem.

#### Acceptance Criteria

1. THE Copilot_Provider SHALL nhận `Copilot_Credential_Store` qua option bắt buộc và SHALL để quyền sở hữu path, filesystem và environment cho `Copilot_Node_Auth`.
2. THE Copilot_Auth SHALL cung cấp hai biến thể store contract: một biến thể read/write, và một biến thể compare-and-swap dựng bằng `defineCredentialStore` với `expectedRevision`.
3. WHEN commit gặp revision khác với giá trị mong đợi, THE Copilot_Credential_Store SHALL phát một error mang code xung đột revision riêng của Copilot.
4. THE Copilot_Auth SHALL cung cấp hai test double trong bộ nhớ, một cho mỗi biến thể store contract.
5. THE Copilot_Node_Auth SHALL cung cấp file store cho cả hai biến thể store contract, một path mặc định, một biến môi trường ghi đè path, và re-export bề mặt Universal.
6. THE Copilot_Node_Auth SHALL cung cấp `Copilot_Login_Cli` cùng bin entry `bin/ai-agent-sdk-copilot-login.mjs`.
7. THE Copilot_Node_Auth SHALL dùng một path credential riêng của SDK, tách khỏi path credential của bất kỳ editor client hoặc CLI nào của nhà cung cấp.
8. WHEN Copilot_Node_Auth ghi file credential, THE Copilot_Node_Auth SHALL đặt quyền file chỉ cho phép chủ sở hữu đọc và ghi.

### Requirement 7: Dùng lại đường cấu hình HTTP provider

**User Story:** Là người bảo trì SDK, tôi muốn Copilot cấu hình `Configurable_Http_Provider` chứ không subclass adapter, để đường cấu hình được kiểm chứng thêm một lần bằng một provider có yêu cầu xác thực phức tạp.

#### Acceptance Criteria

1. THE Copilot_Adapter SHALL được tạo bằng `createHttpProvider` hoặc `createRuntimeHttpProvider` của `Configurable_Http_Provider`, không kế thừa `HttpModelAdapter`.
2. THE Copilot_Adapter SHALL biểu đạt xác thực bằng `auth: { kind: 'dynamic' }` và giải quyết header một lần cho mỗi operation.
3. THE Copilot_Provider SHALL cung cấp hai đường tạo adapter tương ứng hai biến thể store contract, và SHALL chọn đường phù hợp bằng cách kiểm tra marker của store được truyền vào.
4. THE Copilot_Provider SHALL cung cấp một plugin factory trả về composable model provider plugin, nhận `routes` với mặc định là một route tên `copilot`, và `defaultModel` tùy chọn.
5. WHERE `defaultModel` được truyền dưới dạng string, THE Copilot_Provider SHALL yêu cầu đúng một route để suy ra provider của model target đó.
6. THE Copilot_Provider SHALL phơi ra option cho các giới hạn transport gồm request timeout, kích thước request tối đa, kích thước response tối đa, số chunk tối đa, giới hạn SSE và deadline của request logger.
7. THE Copilot_Provider SHALL phơi ra option retry policy riêng cho route Copilot.
8. WHEN Copilot_Adapter nhận một redirect response ở bất kỳ endpoint nào, THE Copilot_Adapter SHALL từ chối redirect đó bằng một structured error.

### Requirement 8: Phát hiện catalog model từ endpoint

**User Story:** Là người phát triển, tôi muốn danh sách model phản ánh đúng những gì tài khoản của tôi được dùng, để không phải bảo trì một danh sách hardcode luôn lệch.

#### Acceptance Criteria

1. WHEN option models không được truyền, THE Copilot_Catalog SHALL phát hiện model bằng `GET /models` trên base URL của Copilot.
2. THE Copilot_Catalog SHALL đọc response trong giới hạn bytes, số model và số chunk cấu hình được, với một deadline riêng cho request catalog.
3. THE Copilot_Catalog SHALL phân loại model theo `Model_Capability_Type`, dùng giá trị `chat` để nhận model generation và giá trị embedding tương ứng để nhận model embedding.
4. THE Copilot_Catalog SHALL dịch metadata endpoint sang catalog model của SDK gồm id, tên hiển thị, mô tả, input/output modalities và context window khi endpoint cung cấp các trường đó.
5. WHERE option models được truyền, THE Copilot_Catalog SHALL dùng danh sách đó và bỏ qua bước phát hiện.
6. THE Copilot_Catalog SHALL coi metadata phát hiện được là advisory, và SHALL để lỗi thật của endpoint là nguồn quyết định cuối cùng khi metadata mâu thuẫn với hành vi endpoint.
7. THE Copilot_Catalog SHALL phơi ra option cho TTL cache catalog, TTL stale và backoff sau khi phát hiện thất bại.
8. IF response catalog có shape ngoài dự kiến, THEN THE Copilot_Catalog SHALL phát một structured error thay vì suy diễn danh sách model từ dữ liệu không đọc được.

### Requirement 9: Chọn endpoint theo từng model

**User Story:** Là người phát triển, tôi muốn chọn model mà không cần biết model đó chạy trên endpoint nào, để việc đổi model không kéo theo đổi cấu hình.

#### Acceptance Criteria

1. THE Copilot_Endpoint_Router SHALL quyết định endpoint của mỗi model generation dựa trên metadata của `Copilot_Catalog`, chọn giữa `/responses` và `/chat/completions`.
2. WHEN một model được `Copilot_Catalog` đánh dấu hỗ trợ `/responses`, THE Copilot_Adapter SHALL dùng `Responses_Protocol` cho model đó.
3. WHEN một model được `Copilot_Catalog` đánh dấu chỉ hỗ trợ `/chat/completions`, THE Copilot_Adapter SHALL dùng `Chat_Completions_Protocol` cho model đó.
4. IF một model không hoạt động trên `/responses` và cũng không hoạt động trên `/chat/completions`, THEN THE Copilot_Catalog SHALL bỏ model đó khỏi catalog.
5. THE Copilot_Catalog SHALL liệt kê đúng tập model gọi được trên ít nhất một trong hai endpoint, thay vì liệt kê model không dùng được kèm dấu hiệu capability không hỗ trợ.
6. THE Copilot_Provider SHALL phơi ra option cho phép ứng dụng ấn định endpoint của một model cụ thể, ghi đè quyết định của `Copilot_Endpoint_Router`.
7. WHILE một `Logical_Call` generation đang chạy, THE Copilot_Adapter SHALL giữ nguyên quyết định endpoint đã chọn cho lần gọi đó, gồm cả các lần retry.
8. THE Copilot_Endpoint_Router SHALL báo cáo endpoint và protocol đã chọn trong dữ liệu quan sát của operation.

### Requirement 10: Package protocol Chat Completions dùng lại được

**User Story:** Là người bảo trì SDK, tôi muốn protocol Chat Completions là một package độc lập, để mọi endpoint tương thích OpenAI dùng lại được mà không phụ thuộc Copilot.

#### Acceptance Criteria

1. THE Chat_Completions_Protocol SHALL cư trú tại package mới `packages/protocol-openai-chat-completions`, đặt cạnh `protocol-responses`, `protocol-anthropic-messages` và `protocol-gemini-interactions`.
2. THE Chat_Completions_Protocol SHALL dịch request của SDK sang body Chat Completions gồm messages, system prompt, sampling parameters và giới hạn output token.
3. THE Chat_Completions_Protocol SHALL dịch SSE stream của Chat Completions sang `StreamChunk`, gồm text delta, finish reason và usage khi endpoint cung cấp.
4. THE Chat_Completions_Protocol SHALL hỗ trợ tool call, gồm khai báo tool trong request, tích lũy tool call arguments dạng delta trong stream, và message kết quả tool trong lượt tiếp theo.
5. THE Chat_Completions_Protocol SHALL hỗ trợ structured output theo JSON schema.
6. THE Chat_Completions_Protocol SHALL map lỗi wire của Chat Completions sang error code của SDK, dùng chung tập code với các protocol hiện có.
7. THE Chat_Completions_Protocol SHALL phơi ra một dialect cho phép provider tắt từng tính năng mà endpoint của họ không nhận, theo cùng cách `Responses_Protocol` phơi ra dialect của nó.
8. THE Chat_Completions_Protocol SHALL giữ mọi giá trị đặc thù Copilot ở phía `Copilot_Provider`, và SHALL nhận base URL, header và dialect qua tham số.
9. IF stream kết thúc mà không có event terminal finish, THEN THE Chat_Completions_Protocol SHALL phát một protocol error thay vì trả một kết quả xem như hoàn tất.

### Requirement 11: Danh tính client và tính minh bạch

**User Story:** Là người dùng SDK, tôi muốn biết SDK tự nhận là client nào khi gọi Copilot, để tôi tự quyết định việc dùng bề mặt này có phù hợp với mình.

#### Acceptance Criteria

1. THE Copilot_Provider SHALL export `Client_Identity_Constants` có tên mô tả, gồm OAuth client id mặc định và giá trị mặc định của `Editor_Headers`.
2. THE Copilot_Provider SHALL cho phép ghi đè từng giá trị trong `Client_Identity_Constants` bằng option cấu hình.
3. THE Copilot_Provider SHALL ghi trong comment của module rằng các giá trị mặc định đó khiến SDK tự nhận là một editor client, và nêu rõ đây là lý do chúng là option có tên thay vì hằng số ẩn.
4. THE Documentation_Set SHALL nêu tradeoff của việc dùng bề mặt Copilot subscription và khuyến nghị dùng provider chính thức của nhà cung cấp cho môi trường production.
5. THE Copilot_Provider SHALL dùng đúng một bề mặt xác thực là OAuth device flow, và SHALL để việc lấy token từ CLI của nhà cung cấp cho ứng dụng tự inject qua `Copilot_Credential_Store`.

### Requirement 12: Adapter embedding của Copilot

**User Story:** Là người phát triển một service lập chỉ mục, tôi muốn dùng Copilot làm provider embedding, để dùng chung một credential cho cả generation và embedding.

#### Acceptance Criteria

1. THE Copilot_Embedding_Adapter SHALL gọi `POST /embeddings` trên base URL của Copilot, mang `Authorization`, `Editor_Headers` và `Content-Type`.
2. THE Copilot_Embedding_Adapter SHALL thực hiện đúng một `Provider_Attempt` cho mỗi lần được `Embedding_Runtime` gọi.
3. THE Copilot_Embedding_Adapter SHALL khai báo `Embedding_Profile` với một compatibility identity riêng cho từng dòng model embedding của Copilot, tách biệt với compatibility identity của OpenAI và của Gemini.
4. WHEN response trả về các vector, THE Copilot_Embedding_Adapter SHALL kiểm tra số lượng vector, tính hợp lệ của tập chỉ số, tính hữu hạn của từng giá trị và số chiều của mỗi vector trước khi trả kết quả.
5. IF response không thỏa contract ở bất kỳ bước kiểm tra nào, THEN THE Copilot_Embedding_Adapter SHALL phát một structured error thuộc tập error code embedding thay vì sửa dữ liệu.
6. WHEN response cung cấp số liệu token đọc được, THE Copilot_Embedding_Adapter SHALL map chúng sang kiểu usage embedding của `Embedding_Contract`.
7. IF response không cung cấp số liệu token, THEN THE Copilot_Embedding_Adapter SHALL báo trạng thái usage là thiếu kèm warning, và SHALL giữ các trường số ở trạng thái không có giá trị.
8. THE Copilot_Embedding_Adapter SHALL gắn chỉ số input gốc vào mỗi vector, để `Embedding_Runtime` khôi phục thứ tự theo `Logical_Call`.
9. WHERE model embedding của Copilot không nhận tham số số chiều, THE Copilot_Embedding_Adapter SHALL bỏ tham số đó khỏi request body.

### Requirement 13: Bảng lỗi có hành động được

**User Story:** Là người phát triển gặp lỗi xác thực, tôi muốn thông báo lỗi nói rõ phải làm gì, để không phải đọc code SDK mới hiểu vấn đề.

#### Acceptance Criteria

1. THE Copilot_Provider SHALL định nghĩa một tập error code ổn định cho các trường hợp thất bại đặc thù Copilot, gồm thiếu credential, credential không được endpoint chấp nhận, tenant không có bề mặt đổi token, thiếu `Editor_Headers`, và đăng nhập device flow thất bại.
2. WHEN Copilot_Token_Exchange bị từ chối vì loại credential không được chấp nhận, THE Copilot_Provider SHALL phát error nêu rằng personal access token không dùng được ở bề mặt này và nêu cách đăng nhập đúng.
3. WHEN Copilot_Provider phát hiện tenant data-residency, THE Copilot_Provider SHALL phát error nêu tên miền phát hiện được và nêu rằng bề mặt đổi token không tồn tại ở đó.
4. IF `Copilot_Credential_Store` không có credential, THEN THE Copilot_Provider SHALL phát error mang code missing-credential của SDK kèm câu lệnh chạy `Copilot_Login_Cli`.
5. THE Copilot_Provider SHALL map lỗi HTTP của endpoint sang error code của SDK theo cùng quy ước phân loại retryable mà các provider hiện có dùng, gồm cả việc đọc `retry-after` và request id khi có.
6. THE Copilot_Provider SHALL đọc body của response lỗi trong giới hạn bytes cấu hình được.
7. WHEN Copilot_Provider phát bất kỳ error nào, THE Copilot_Provider SHALL loại giá trị `GitHub_User_Token` và `Copilot_Api_Token` khỏi message và khỏi mọi trường của error.

### Requirement 14: Quan sát và redaction

**User Story:** Là người vận hành, tôi muốn thấy được vòng đời request và việc đổi token trong trace, mà không có credential nào lọt vào log.

#### Acceptance Criteria

1. THE Copilot_Provider SHALL phát dữ liệu quan sát cho mỗi `Provider_Attempt` qua cơ chế provider attempt sẵn có của SDK.
2. THE Copilot_Provider SHALL phát dữ liệu quan sát cho mỗi `Copilot_Token_Exchange` qua `observeCredentialOperation`.
3. WHEN Copilot_Provider ghi header của một wire request qua request logger, THE Copilot_Provider SHALL redact `Authorization` và mọi trường mang danh tính tài khoản.
4. THE Copilot_Provider SHALL loại nội dung prompt thô, nội dung input embedding thô và giá trị vector thô khỏi trace ở cấu hình mặc định.
5. WHEN request logger của ứng dụng chạy quá deadline cấu hình được, THE Copilot_Provider SHALL tiếp tục request và giữ lỗi của logger tách khỏi kết quả của operation.

### Requirement 15: Phủ conformance harness

**User Story:** Là người bảo trì SDK, tôi muốn Copilot chạy qua cùng bộ conformance như các provider khác, để hành vi lệch chuẩn bị phát hiện tự động.

#### Acceptance Criteria

1. THE Conformance_Harness SHALL chạy toàn bộ scenario generation hiện có với fixture của `Copilot_Adapter` trên cả hai protocol.
2. WHERE `Embedding_Contract` đã tồn tại, THE Conformance_Harness SHALL chạy toàn bộ scenario embedding với fixture của `Copilot_Embedding_Adapter`.
3. THE Conformance_Harness SHALL giữ nguyên `schemaVersion` và cấu trúc báo cáo hiện có khi bổ sung fixture Copilot.
4. THE Conformance_Harness SHALL phủ các nhóm hành vi đặc thù Copilot gồm chọn endpoint theo model, thiếu `Editor_Headers`, từ chối credential ở `Copilot_Token_Exchange`, và refresh chủ động trước khi token hết hạn.
5. WHEN cùng một tình huống mapping lỗi xảy ra ở Copilot và ở một provider hiện có, THE Conformance_Harness SHALL xác nhận hai provider phát cùng error code.

### Requirement 16: Chiến lược kiểm chứng

**User Story:** Là người bảo trì SDK, tôi muốn phần xác thực và chọn endpoint có test chạy được mà không cần credential thật, để CI công khai vẫn kiểm chứng được chúng.

#### Acceptance Criteria

1. THE Copilot_Provider SHALL có unit test dùng test double trong bộ nhớ cho `Copilot_Credential_Store` và một fetch được inject, phủ device flow, `Copilot_Token_Exchange`, refresh chủ động và hợp nhất refresh đồng thời.
2. THE Copilot_Provider SHALL có fixture cho cả hai protocol generation, gồm stream có tool call, stream có structured output, và stream kết thúc thiếu event terminal.
3. THE Copilot_Provider SHALL có negative fixture cho response catalog sai shape, response embedding sai mapping, và vector không hợp lệ.
4. THE Copilot_Provider SHALL đặt test gọi endpoint thật trong thư mục integration test và chạy chúng bằng cấu hình integration riêng.
5. WHEN credential không có mặt, THE integration test của Copilot SHALL bỏ qua chính nó thay vì thất bại.
6. THE Copilot_Node_Auth SHALL có test cho path mặc định, biến môi trường ghi đè path, quyền file, và xung đột revision khi commit.

### Requirement 17: Tài liệu

**User Story:** Là người dùng mới, tôi muốn tài liệu nói rõ cách đăng nhập và giới hạn của provider này, để tôi không mất thời gian thử một cấu hình bất khả thi.

#### Acceptance Criteria

1. THE Documentation_Set SHALL mô tả các bước thiết lập Copilot gồm chạy `Copilot_Login_Cli`, vị trí file credential, và biến môi trường ghi đè path.
2. THE Documentation_Set SHALL nêu rằng personal access token không dùng được ở bề mặt này và nêu lý do.
3. THE Documentation_Set SHALL nêu rằng tenant data-residency `*.ghe.com` nằm ngoài phạm vi hỗ trợ.
4. THE Documentation_Set SHALL mô tả cơ chế chọn endpoint theo model và cách ghi đè quyết định đó.
5. THE Documentation_Set SHALL ghi package mới `protocol-openai-chat-completions` cùng cách dùng nó cho một endpoint tương thích OpenAI khác.
6. THE Documentation_Set SHALL ghi tập error code mới của Copilot cùng hành động tương ứng cho từng code.
7. WHERE `Copilot_Embedding_Adapter` đã được triển khai, THE Documentation_Set SHALL ghi cách đăng ký nó và nêu khác biệt về usage so với các provider embedding khác.

### Requirement 18: Ràng buộc kiến trúc

**User Story:** Là người bảo trì SDK, tôi muốn provider mới không làm xáo trộn cấu trúc package hiện có, để đồ thị dependency vẫn đọc được và build vẫn ổn định.

#### Acceptance Criteria

1. THE Copilot_Provider SHALL cư trú tại package mới `packages/provider-copilot` và SHALL export bề mặt công khai qua field `exports` của `package.json`.
2. THE Copilot_Node_Auth SHALL cư trú trong `packages/auth-node` và SHALL là nơi duy nhất trong Copilot code chạm filesystem, path và environment.
3. THE Copilot_Provider SHALL giữ đồ thị dependency không có chu trình theo rule `no-circular` của `.dependency-cruiser.cjs`.
4. THE Copilot_Provider SHALL giữ bề mặt công khai của các package hiện có không thay đổi, gồm `packages/core`, `packages/provider-http` và các package protocol hiện có.
5. THE Chat_Completions_Protocol SHALL giới hạn dependency của nó trong `packages/core` và `packages/provider-http`, giữ `packages/provider-copilot` ở ngoài tập dependency đó.
6. THE Copilot_Provider SHALL giới hạn dependency runtime của nó trong các package đã có trong workspace và các API tiêu chuẩn của runtime.
7. WHEN một entry point mới được thêm, THE Copilot_Provider SHALL khai báo entry point đó trong cả `package.json` và cấu hình build của package.
