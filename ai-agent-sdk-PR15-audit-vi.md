# Audit PR #15 · ai-agent-sdk

**Ngày audit** 19/11/2026 · **Commit** `b02d2d9` · **Repository** `alvin0/ai-agent-sdk`

## Đề nghị sửa trước khi merge

PR bổ sung OAuth và model provider Antigravity, cùng API và host tool tạo ảnh qua tài khoản Codex. Bản build chạy được. Các lỗi quan trọng xuất hiện khi đóng gói để phát hành, khi đổi tài khoản giữa một request, và khi ảnh đi qua nhiều tầng của agent.

| Hạng mục | Kết quả trên commit được audit |
| --- | --- |
| Phạm vi | 58 file, 1 commit, +3.613 / −10 dòng so với ab30c2f. Đối chiếu thêm core, provider-http, workflow phát hành và manifest npm. |
| GitHub Actions | Baseline qua 329 file, 4.676 test pass và 2 skip. Bước test cấp package thất bại. Job tổng hợp deterministic báo lỗi theo. Supply-chain và boundary-build pass. |
| Kiểm tra cục bộ | Build 29/29 package. 8 file test tập trung chạy tại root đạt 89/89. Suite chạy riêng của provider-antigravity đạt 38/39, auth-node đạt 45/46. Hai suite cùng lỗi đường dẫn CLI. |
| Tarball | Packed fixture Node của auth-node và fixture chuẩn của provider đều pass. CI dừng trước packed matrix. Tại máy audit, Chromium bị chặn khi tạo socket, Wrangler lỗi khi đọc network interface. Browser và Worker còn cần xác nhận. |
| Runtime và upstream | Đã chạy SDK đã build với HTTP và credential giả lập. Báo cáo phân biệt lỗi quan sát được trong SDK, rủi ro suy từ code và hành vi cần tài khoản thật để xác nhận. |

### Những việc cần xử lý trước

1. Sửa test theo working directory và tăng phiên bản đồng bộ trước khi workflow trên main có thể publish.
2. Giữ request gắn với tài khoản ban đầu khi credential đổi giữa chừng. Loại toàn bộ byte ảnh thuộc chính sách xoá khỏi snapshot.
3. Chốt hành vi tool ảnh trong vòng lặp Antigravity và chạy các test hồi quy đa lượt ở trang 6.

[Pull request](https://github.com/alvin0/ai-agent-sdk/pull/15) · [Diff theo commit](https://github.com/alvin0/ai-agent-sdk/compare/ab30c2f...b02d2d9cacba005b0db5587062ee29642e2711f0) · [Log CI](https://github.com/alvin0/ai-agent-sdk/actions/runs/44536755832/job/135604099369)

## Bốn vấn đề cần chặn merge

### P1 · CI chạy sai đường dẫn khi test bên trong package

Test resolve đường dẫn CLI từ thư mục làm việc hiện tại. Tại root, đường dẫn đúng. Trong suite provider-antigravity, Node tìm packages/provider-antigravity/packages/auth-node/bin/... và trả MODULE_NOT_FOUND. Cùng test cũng thất bại khi chạy từ auth-node.

**Tiêu chí sửa.** Dựng đường dẫn fixture theo import.meta.url. Chạy lại cả hai suite từ package. Đưa test CLI về suite auth-node và chạy các test ảnh mới trong suite sở hữu chúng.

[Test dòng 69](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/tests/unit/antigravity-auth-node.spec.ts#L67-L76) · [Glob của provider](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/vitest.config.ts#L3) · [Job thất bại](https://github.com/alvin0/ai-agent-sdk/actions/runs/44536755832/job/135604099369)

### P1 · Workflow có thể phát hành một bộ package lệch phiên bản

PR giữ 0.1.17. npm đã có auth-node và provider-codex ở phiên bản này. Manifest auth-node đã phát hành thiếu subpath /antigravity và CLI mới. Provider Antigravity còn trả 404 khi kiểm tra. Workflow bỏ qua bản đã có, có thể publish riêng provider mới, rồi báo xung đột vì tag v0.1.17 trỏ về ab30c2f.

**Tiêu chí sửa.** Tăng đồng bộ lên phiên bản chưa phát hành. Chạy dry-run và cài tarball trong project trống để kiểm tra CLI, subpath và export ảnh trước khi publish.

[Manifest](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/package.json#L7) · [Điều kiện publish](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/.github/workflows/release.yml#L136-L146) · [Kiểm tra tag](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/scripts/create-release-tag.mts#L73-L80)

### P1 · Request đang chạy có thể đổi sang account và project khác

Khi refresh của A thua một lần đăng nhập B vào cùng store, resolver đọc bản thắng và chấp nhận khi token còn hạn, client ID đáp ứng cấu hình. Cùng OAuth client có thể phục vụ nhiều account. Test hiện tại chủ động kỳ vọng resolver trả new-login-project. Adapter lấy cả token và project từ bản này.

**Tiêu chí sửa.** Giữ B trong store, hủy request gắn với A nếu danh tính thay đổi. Phân biệt đổi tài khoản với refresh cùng phiên. Kiểm tra cả trường hợp thiếu email.

[Xử lý xung đột](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/auth.ts#L66-L77) · [Test account switch](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/tests/unit/antigravity.spec.ts#L121-L131) · [Dựng request](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/adapter.ts#L122-L132)

### P1 · Xoá ảnh khỏi history vẫn để lại nguyên base64 trong snapshot

Với keepLatest=0 và persist=drop-pruned, runtime đã tạo ảnh PNG, hoàn thành hai lượt và báo imagesRetained=0. Request sau đã bỏ ảnh. Snapshot vẫn chứa đủ bytes trong event.result.value.data[0].b64_json vì tool giữ một bản sao JSON ngoài các image block mà core xử lý.

**Tiêu chí sửa.** Lưu ảnh ở dữ liệu chịu chính sách retention hoặc dùng tham chiếu artifact. Sau prune và restore, quét cả snapshot để xác nhận bytes đã biến mất, đồng thời giữ được ảnh trên event ban đầu.

[Giá trị của tool](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-codex/src/image-tool.ts#L35-L42) · [Prune của core](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/core/src/agent/history/image-retention.ts#L193-L207)

## Tool ảnh và giới hạn tài khoản

### P2 · Antigravity gọi tool tạo ảnh xong rồi hỏng ở lượt kế tiếp

Trong runtime dùng cả hai tính năng mới, model gọi codex_generate_image, Images trả PNG, SDK phát tool-result dạng image. Khi chuẩn bị request thứ hai, Antigravity chỉ nhận tool-result dạng text và trả INVALID_REQUEST. Có đúng một lần gọi Images, một lần gọi model. Ảnh đầu vào thông thường và PDF inline đều qua được ở test đối chứng.

**Tiêu chí sửa.** Hỗ trợ đúng biểu diễn kết quả đa phương thức mà endpoint chấp nhận, hoặc chặn tổ hợp này trước khi tool chạy. Kiểm tra một lần tạo ảnh và một lượt follow-up hoàn chỉnh khi được hỗ trợ.

[Tool result serializer](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/serialize.ts#L58-L66) · [Tool tạo ảnh](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-codex/src/image-tool.ts#L28-L42)

### P2 · Header do agent cấp được gộp vào lớp xác thực

Đọc code cho thấy adapter gộp providerOptions.headers với header OAuth. Lớp HTTP kế tiếp coi toàn bộ tập header là auth. Nếu một ứng dụng dùng lại cấu hình chứa header credential của dịch vụ khác, tầng kiểm tra tên dành riêng có thể cho header đó đi cùng request tới Antigravity. Đây là rủi ro có điều kiện, chưa ghi nhận sự cố lộ dữ liệu.

**Tiêu chí sửa.** Áp dụng kiểm tra ownership của lớp endpoint cho header của agent, để provider tự tạo lớp auth. Header tracing hợp lệ phải tiếp tục hoạt động.

[Điểm gộp](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/adapter.ts#L122-L133) · [Quy tắc header](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-http/src/common/header-layers.ts#L114-L121) · [Phân lớp HTTP](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-http/src/transport/connection.ts#L76-L84)

### P2 · Lỗi nội bộ của credential store có thể đi vào ngữ cảnh model

Host tool chỉ chuyển CodexImageError thành lỗi đã chuẩn hoá. Khi store hoặc OAuth ném Error khác, core dùng nguyên error.message trong tool failure. Một lỗi host có thể chứa đường dẫn, nhãn account hoặc chi tiết backend và còn mất mã lỗi gốc. Kết luận dựa trên đường đi của code.

**Tiêu chí sửa.** Ánh xạ lỗi credential/store ở ranh giới tool thành thông báo và mã an toàn cho model. Giữ chẩn đoán chi tiết ở phía host. Kiểm thử message thường, lỗi refresh và cancellation.

[Phân loại của tool](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-codex/src/image-tool.ts#L29-L35) · [Core dựng failure](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/core/src/agent/tool/pipeline-execution.ts#L69-L75)

### P2 · Hai lần refresh đồng thời có thể bắt đăng nhập lại nhầm

Với issuer giả lập xoay refresh token, hai lệnh Codex Images trên cùng store gửi hai refresh. Một lệnh thành công, lệnh kia nhận CODEX_REAUTH_REQUIRED dù store đã có token mới. Hai resolver Antigravity độc lập trên cùng store cũng gặp HTTP 400 và, trong fixture, retry ngay thành công.

**Tiêu chí sửa.** Phối hợp refresh theo credential hoặc đọc lại revision sau khi issuer từ chối token cũ. Chỉ dùng credential mới nếu vẫn đúng phiên. Kiểm tra riêng trường hợp thực sự bị thu hồi.

[Codex Images](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-codex/src/image.ts#L135-L141) · [Trình refresh dùng chung](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-codex/src/oauth-refresh.ts#L19-L41) · [Antigravity](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/auth.ts#L53-L77)

## Các lỗi chỉ xuất hiện qua nhiều lượt

### P2 · Mất thoughtSignature khi phần cuối có text rỗng

Fixture runtime nhận ảnh và một phần text rỗng mang chữ ký. Ở lượt người dùng yêu cầu chỉnh ảnh, lịch sử gửi lại chỉ còn ảnh. Google mô tả chữ ký có thể xuất hiện trong phần text rỗng của stream. Đã xác nhận SDK làm mất chữ ký. Phản ứng của route Antigravity thật cần kiểm tra theo model.

**Tiêu chí sửa.** Giữ chữ ký tại đúng phần gốc theo giao thức của model. Test riêng text rỗng có chữ ký, text rỗng không có chữ ký trên Claude bridge, và hai lượt chỉnh ảnh.

[Cắt text rỗng](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/serialize.ts#L32-L35) · [Ghép replay metadata](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/serialize.ts#L73-L79) · [Google về thought signatures](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures)

### P2 · Mất số token upstream đã báo khi stream bị đứt

Fixture gửi một phần text cùng metadata 50 input + 1 output token, sau đó EOF trước finish. SDK báo STREAM_CLOSED đúng, nhưng RunReport có usage.reported={} và đánh dấu một attempt có thể tính phí mà thiếu usage. Translator chỉ phát usage khi hoàn tất thành công.

**Tiêu chí sửa.** Phát usage-progress khi đọc metadata, rồi chốt usage một lần nếu có terminal. Kiểm tra EOF giữa stream, metadata tích luỹ lặp và stream thành công để tránh cộng hai lần.

[Nhận metadata](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/translate.ts#L47-L54) · [Chốt usage](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/translate.ts#L145-L156) · [Core nhận progress](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-http/src/base/sse-decode.ts#L90-L104)

### P2 · Prompt bị chặn được phân loại thành mất kết nối

Với candidates=[] và promptFeedback.blockReason=SAFETY cùng xuất hiện, translator chỉ đi vào nhánh candidates. Mảng rỗng không sinh finish nên lỗi cuối thành STREAM_CLOSED. Với caller retry lỗi stream, cùng prompt có thể bị gửi lại.

**Tiêu chí sửa.** Ưu tiên xử lý blockReason kể cả khi danh sách candidate rỗng. Phân biệt prompt bị chặn với EOF thật và kiểm tra mã lỗi tới caller.

[Chọn nhánh của event](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/translate.ts#L47-L68) · [EOF](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/translate.ts#L145-L151)

### P2 · providerOptions.body bị bỏ qua không có thông báo

Core quy định body của agent được deep-merge vào request. Hai phiên chạy qua runtime có cấu hình body chứa labels, nhưng cả hai request bắt được đều thiếu labels. Adapter dựng envelope riêng và không đọc providerOptionsBody do lớp HTTP truyền xuống.

**Tiêu chí sửa.** Áp dụng quy tắc merge cho trường được phép và định nghĩa rõ trường envelope thuộc provider. Kiểm tra thêm ghi đè lồng nhau, xoá trường bằng null và cô lập cấu hình giữa hai agent.

[Hợp đồng của core](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/core/src/agent/define/definition.ts#L34-L43) · [Envelope thực tế](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/adapter.ts#L168-L174)

## Đăng nhập, huỷ tác vụ và dữ liệu

### P2 · Credential file hỏng khiến --force cũng không đăng nhập lại được

CLI đọc và validate auth.json trước khi xét --force. Với một file tạm có JSON bị cắt, CLI thoát mã 1, yêu cầu đăng nhập lại và không hiển thị URL. Hàm hoàn tất OAuth cũng đọc bản cũ trước khi commit.

**Tiêu chí sửa.** Cho phép force khôi phục theo revision của byte gốc, thay thế nguyên tử sau khi login thành công. Luồng thông thường vẫn phải báo file hỏng, và một login mới hợp lệ phải được bảo toàn khi xảy ra race.

[CLI](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/auth-node/src/antigravity-cli.ts#L61-L73) · [File store](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/auth-node/src/antigravity-store.ts#L31-L45) · [OAuth commit](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/oauth.ts#L166-L183)

| Case biên | Quan sát và tiêu chí hồi quy |
| --- | --- |
| UserInfo trả 503 | Token và project đều thành công nhưng store vẫn rỗng, code một lần đã dùng. Nếu email chỉ dùng hiển thị, cho phép login với account thiếu email. Nếu identity bắt buộc, cần quy định rõ và có cách phục hồi. [OAuth L175](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/oauth.ts#L175-L184) |
| Signal cấu hình bị bỏ | Antigravity provider đã nhận signal bị hủy nhưng adapter.stream() không có signal riêng vẫn dispatch. Với Codex Images, oauth.signal bị hủy nhưng helper vẫn refresh và tạo ảnh trong fixture. Kết hợp các signal liên quan hoặc thu hẹp kiểu public theo phạm vi được hỗ trợ. [Adapter L122](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/adapter.ts#L119-L128) · [Images L139](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-codex/src/image.ts#L132-L145) |
| Huỷ khi store bị treo | Public resolver Antigravity đang xếp hàng chờ tác vụ trước. Universal login chờ trực tiếp read/commit của custom store. Helper có thể chưa settle khi signal bị hủy. Luồng thông thường qua adapter có lớp hủy bổ sung. [Auth L53](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/auth.ts#L49-L57) · [Login L170](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/oauth.ts#L166-L171) |
| Hai session độc lập | Hai createSession() trên một adapter phát cùng sessionId lên upstream vì UUID thuộc adapter. Đã xác nhận việc trùng mã trên wire. Chưa có bằng chứng hai hội thoại đọc được dữ liệu của nhau. Xác nhận scope upstream trước khi dùng ID này để phân tách session. [Adapter L110](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/adapter.ts#L106-L112) |
| Bộ nhớ khi stream ảnh | Theo code, adapter override observeResponse kể cả khi không có responseLogger. Lớp HTTP vì vậy vẫn giữ các frame SSE tới cuối stream, gồm cả JSON ảnh base64. Cần tắt capture khi không có logger và đo bộ nhớ ở nhiều stream đồng thời. [Adapter L185](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-antigravity/src/adapter.ts#L185-L187) · [HTTP L353](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-http/src/base/http-adapter.ts#L350-L354) |
| Ảnh bị cắt | Codex Images chấp nhận dữ liệu chỉ có 8 byte chữ ký PNG và trả image/png. Bổ sung PNG, JPEG, WebP hợp lệ và fixture thiếu nội dung; thống nhất API chỉ nhận diện MIME hay cần bảo đảm ảnh có thể mở. [Parser L28](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/packages/provider-codex/src/image-response.ts#L28-L35) |

## Điều kiện để review lại

Các tình huống dưới đây kiểm tra luồng qua public SDK, tarball và tài khoản thật. Với case live, lưu mã HTTP, loại model và kết quả hiển thị để có thể phân biệt lỗi adapter với quyền của tài khoản.

| Luồng | Kết quả cần quan sát |
| --- | --- |
| Cài SDK từ tarball | Project trống import được auth-node/antigravity và hai helper Codex Images. CLI --help, --status làm việc đúng sau khi đổi working directory. Pipeline cấp package và packed matrix đều pass. |
| Account và refresh | Hai lời gọi đồng thời cùng account khi token sát hạn đều thành công với token hợp lệ. Khi thay bằng account khác cùng OAuth client, request cũ dừng. Store vẫn chứa bản login mới. |
| Ảnh trong tool loop | Host tool tạo đúng một ảnh. Ứng dụng nhận image event và agent hoàn thành follow-up. Khi bật drop-pruned, ảnh biến mất khỏi toàn bộ snapshot sau prune và restore. |
| Luồng SSE | Stream text, tool call và ảnh có chữ ký, có/thiếu finish, cùng usage tích luỹ. Báo cáo giữ số token đã quan sát, prompt bị chặn có đúng mã và người dùng hủy thì không dispatch tiếp. |
| Tương thích schema | Thử tool và structured output với schema lồng nhau, additionalProperties, $defs/$ref. PR gửi nguyên schema vào parameters/responseSchema. Endpoint này chưa được xác nhận chấp nhận mọi keyword; chuẩn hoá hoặc từ chối rõ ràng nếu cần. |
| Google Antigravity thật | Account đã có project và account cần onboarding. Kiểm tra consent → project → refresh → catalog → chat → tool → follow-up → tạo/chỉnh ảnh. Với operation đang pending, xác định route thực tế yêu cầu poll operation.name hay gọi lại onboardUser. |
| Codex Images thật | Dùng account có quyền và model ảnh phù hợp. Xác nhận HTTP 2xx, giải mã được bytes và mở được ảnh. Tài liệu PR ghi lần thử ngày 17/11/2026 trả 403. Giữ nhãn experimental cho tới khi có bằng chứng thành công. |

### Những phần đã có test bảo vệ

Bộ test tại root đã bao phủ PKCE/state, ghi credential theo revision, redirect, timeout, giới hạn dữ liệu, stream bị cắt, tool call có chữ ký, ảnh-only và phân biệt lỗi 401/403. Các case trên bổ sung phần giao nhau giữa các tính năng và tình huống lỗi giữa chừng.

[Bộ test Antigravity](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/tests/unit/antigravity.spec.ts) · [Bộ test Codex Images](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/tests/unit/codex-image.spec.ts) · [Ghi nhận live của PR](https://github.com/alvin0/ai-agent-sdk/blob/b02d2d9cacba005b0db5587062ee29642e2711f0/web-documents/en/09-providers/codex.md#L115-L120)
