### A. Xử lý CI trước khi coi commit này là nền ổn định để mở rộng

**Mức ưu tiên: điều kiện trước phát hành.**

Ở workflow của commit đang review, bước kiểm tra graph/runtime/type/build và kiểm tra boundary đã thành công. Tuy nhiên, bước **`Supply-chain and production advisory gate` thất bại**, khiến các bước sau bị bỏ qua, gồm baseline/unit tests, package-owned suites và packed-package/runtime matrix. Vì vậy, hiện chưa có cơ sở từ run này để nói toàn bộ kiểm thử đã xanh.

Tôi chưa xác minh được nguyên nhân chi tiết của gate thất bại, nên **không kết luận đây là một lỗ hổng dependency**.

Đề xuất của tôi là sửa nguyên nhân và chạy lại đầy đủ, đồng thời tách các nhóm kiểm tra độc lập thành các job riêng: kiểm thử chức năng, boundary/build và supply-chain. Cả ba vẫn phải thành công trước khi merge hoặc release; không bỏ qua security gate.

Lợi ích của việc tách job là một lỗi supply-chain sẽ không làm mất toàn bộ thông tin về regression của code trong cùng lần chạy.

### B. Approval cần định danh riêng do SDK tạo, không chỉ dùng ID của provider

**Mức ưu tiên: cao với ứng dụng nhiều phiên hoặc nhiều người dùng.**

Trong:

`packages/core/src/agent/tool/approval.ts`

`createApprovalBroker()` lưu các yêu cầu đang chờ trong:

```ts
new Map<ToolCallId, Waiter>()
```

Và API giải quyết yêu cầu là:

```ts
resolve(callId, decision)
```

`callId` được mô tả là ID do provider cấp. Khi đã có một yêu cầu pending cùng ID, yêu cầu mới bị reject. Broker cũng có cấu hình giới hạn yêu cầu pending trên các session đồng thời.

Điều này tạo ra một tình huống cần xử lý rõ khi dùng chung broker:

```text
Session A → tool call "call_1"
Session B → tool call "call_1"
```

Hai lời gọi thuộc hai phiên khác nhau nhưng trùng ID sẽ tranh cùng một khóa. Ngoài ra, nếu host chỉ dùng `callId` để nhận quyết định từ UI, một câu trả lời đến muộn có thể tác động đến yêu cầu mới tái sử dụng ID đó.

**Đây là rủi ro có điều kiện khi dùng chung broker và có ID trùng/tái sử dụng; tôi không khẳng định mọi provider hiện tại đều gây ra tình huống này.**

Tôi đề xuất SDK sinh một **`approvalRequestId` độc lập**, giữ `providerCallId` chỉ để đối chiếu. Yêu cầu approval nên được gắn với run/session, tool và bộ tham số đã validate. Quyết định chỉ được áp dụng một lần cho đúng yêu cầu đó.

Phần xác thực người duyệt và tenant vẫn thuộc ứng dụng host, nhưng SDK nên cung cấp đủ định danh để host kiểm tra chính xác. Với broker dùng chung, cũng nên có thao tác hủy theo run/session thay vì buộc host dựa vào thao tác toàn cục.

**Kiểm thử quan trọng:** hai session trùng provider call ID vẫn xin duyệt độc lập; quyết định đến sau khi yêu cầu bị hủy không được áp dụng sang yêu cầu mới.

### C. API cấp cao cần giữ đầy đủ input, output và event của engine

**Mức ưu tiên: cao nhất để mở rộng loại dự án hỗ trợ.**

Đây là điểm tôi thấy ảnh hưởng lớn nhất tới tính đa dụng.

#### Input/output đang bị thu hẹp

Trong:

`packages/core/src/composition/agent/types.ts`

Các phương thức `generate()`, `run()`, `stream()` và `inject()` ở lớp cấp cao nhận `string`. `RuntimeAgentResponse` có text, trạng thái, usage và report, nhưng không trả lại message đầy đủ như lớp session bên dưới. Trong khi đó, lớp dưới đã có:

```ts
type AgentInput = string | UserMessage
```

Và `AgentResponse` có trường `message`. SDK cũng **đã có `outputFormat`**, nên đây không phải vấn đề thiếu hoàn toàn structured-output support. Vấn đề là cách sử dụng và nhận kết quả ở public API chưa phát huy hết năng lực sẵn có.

Hệ quả là một chatbot text có thể dùng API cấp cao thuận tiện, nhưng dự án phân tích ảnh hoặc cần trả kết quả có cấu trúc sẽ phải đi xuống lớp thấp hơn.

Tôi đề xuất thay đổi theo hướng tương thích ngược: giữ `string` làm cách gọi ngắn, đồng thời cho phép dùng `AgentInput` hiện có; trả `message` hoặc content đầy đủ, giữ `.text` làm thuộc tính tiện dụng. Với structured output, bổ sung kết quả đã parse và validate theo schema, thay vì để từng ứng dụng tự xử lý chuỗi.

Codex là một tham chiếu hữu ích ở đây: TypeScript SDK nhận `string | UserInput[]`, và kết quả trả về có cả `items` lẫn `finalResponse`. **Text tiện dụng không thay thế toàn bộ kết quả có cấu trúc.** Không nhất thiết sao chép kiểu `local_image` của Codex, vì SDK của bạn cần trung lập hơn với môi trường chạy.

#### Event cấp cao cũng đang làm mất thông tin

Trong:

`packages/core/src/composition/agent/session.ts`

`projectEvent()` chỉ chuyển tiếp một số event rồi `return undefined` cho các loại còn lại. Lớp engine có `text-end`, `image-delta`, `assistant-message`, `compaction-start/end` và thông tin block; các thông tin này không được bảo toàn đầy đủ qua lớp event cấp cao.

Điều này làm ứng dụng UI khó hiển thị ảnh đang sinh, phân biệt các block, xử lý text cuối cùng có cờ incomplete, hoặc hiển thị trạng thái compaction mà không phụ thuộc vào API nội bộ.

Bạn **đã có `runId`, `traceId` và `sequence`**, nên không cần xây lại định danh event từ đầu. Tôi đề xuất mở rộng hợp đồng đó bằng lifecycle/content event cần thiết, block/item identity và version của schema.

Nguyên tắc nên là: **không làm mất dữ liệu công khai đã được phép xuất**, nhưng cũng không chuyển tiếp mù quáng mọi trace hoặc raw provider payload ra UI. Bộ lọc dữ liệu nhạy cảm vẫn phải được giữ.

### D. Làm rõ hợp đồng validate tool và sửa thứ tự xử lý approval

**Mức ưu tiên: cao; có một thay đổi logic cụ thể nên làm.**

Trong:

`packages/core/src/agent/tool/pipeline.ts`

`prepareToolCall()` parse JSON và chỉ validate thêm khi tool có `parse`. Khi không có `parse`, giá trị JSON được truyền tiếp. `ToolDefinition` đã ghi rõ đây là lựa chọn có chủ đích để không buộc SDK phụ thuộc một thư viện schema, và tool có thể tự kiểm tra input trong body.

Vì vậy, tôi không xem việc `parse` là tùy chọn tự nó là bug. Nhưng SDK cần làm cho cách dùng an toàn trở thành cách dùng thuận tiện nhất: từ một schema, người dùng nên lấy được kiểu TypeScript, schema gửi model và runtime validator, thay vì tự giữ ba phần đồng bộ.

**Điểm logic cần sửa:** `authorizeToolCall()` xử lý interceptor và có thể chờ approval **trước khi trả `prepared.argumentFailure`**. Nghĩa là một lời gọi đã được xác định có lỗi tham số vẫn có thể đi vào luồng xin duyệt.

Tôi đề xuất quy định rõ thứ tự:

```text
Tìm tool → parse → validate → policy/approval → execute → post-policy
```

Nếu vẫn cần interceptor chạy cho lời gọi không hợp lệ để audit hoặc che giấu thông tin, hãy phân biệt observer đó với bước xin phê duyệt. **Lời gọi chắc chắn không thể thực thi không nên chờ người dùng duyệt.**

Kiểm thử cần chứng minh rằng input sai không gọi broker, không gọi `execute`, và trả đúng lỗi để model có thể sửa tham số.

### E. Không nên luôn chuyển ảnh thành placeholder mà thiếu chính sách theo tác vụ

**Mức ưu tiên: cao với ứng dụng đa phương thức.**

Trong:

`packages/core/src/runtime/model-stream.ts`

Khi metadata xác định model không nhận ảnh, nhưng message chứa ảnh, runtime gọi `projectImagesForTextModel()`. Hàm này thay ảnh bằng text dạng “image omitted”, kể cả ảnh nằm trong tool result.

Lý do thiết kế này hợp lý: hội thoại có thể chứa ảnh cũ rồi chuyển sang model text-only, hoặc cần tóm tắt lại lịch sử. Nhưng có sự khác biệt lớn giữa:

> “Tóm tắt hội thoại có một ảnh cũ không còn quan trọng.”

và:

> “Đọc số tiền trên ảnh hóa đơn vừa gửi.”

Trong trường hợp thứ hai, request vẫn chạy được không đồng nghĩa với việc yêu cầu được đáp ứng đúng.

Tôi đề xuất bổ sung chính sách theo invocation: input nào là bắt buộc đối với tác vụ hiện tại; khi capability không phù hợp thì báo lỗi, cho phép chuyển đổi có mất dữ liệu, hay sử dụng tuyến model khác đã được host cấu hình.

Quan trọng là **không tự đổi provider ngoài ý muốn của host**, vì đó còn là quyết định về dữ liệu và chi phí.

Không cần bỏ cơ chế projection hiện tại. Hãy giữ nó cho những trường hợp phù hợp, nhưng cho phép ứng dụng yêu cầu chế độ strict. Kiểm thử cần xác nhận rằng một tác vụ bắt buộc đọc ảnh không gửi request sinh nội dung tới model đã được xác định là text-only.

### F. Chuẩn hóa ranh giới giữa policy, approval và môi trường thực thi

**Mức ưu tiên: mở rộng kiến trúc, đặc biệt cho coding/ops agent.**

Pipeline hiện đã có các giai đoạn prepare, authorize, dispatch, finalize và interceptor `before`/`around`/`after`. Đây là điểm gắn mở rộng tốt. Nhưng trong đường thực thi đang xem, body cuối cùng vẫn là lời gọi `tool.execute(...)` trong tiến trình host. Tài liệu tool cũng nói rõ timeout là cooperative và không thể ngắt code phớt lờ cancellation.

Do đó, cần giữ ba khái niệm tách biệt:

| Thành phần        | Câu hỏi nó trả lời                                      |
| ----------------- | ------------------------------------------------------- |
| Policy            | Trong ngữ cảnh này, thao tác có được phép không?        |
| Approval          | Ai đã đồng ý cho thao tác cụ thể này?                   |
| Execution backend | Thao tác thực sự chạy ở đâu, với quyền và giới hạn nào? |

Codex có `ToolOrchestrator` tập trung xử lý approval, chọn sandbox và semantics của lần thử thực thi. **Đó là nguyên tắc nên học, không phải yêu cầu đưa toàn bộ sandbox của Codex vào core.**

Tôi đề xuất dùng pipeline/interceptor đang có làm điểm gắn, rồi chuẩn hóa adapter thực thi cho local, process/container hoặc remote worker. Mỗi backend cần công bố khả năng thực tế: hỗ trợ hủy hợp tác hay cưỡng bức, giới hạn filesystem/network ở đâu, và cleanup được bảo đảm đến mức nào.

Đối với SaaS, context thực thi nên nhận identity và quyền từ host đã xác thực. Model chỉ đề xuất thao tác; không được trở thành nguồn xác định tenant hoặc tự cấp quyền.

### G. Phân biệt lưu hội thoại với phục hồi công việc sau crash

**Mức ưu tiên: cần khi mở rộng sang workflow dài hoặc thao tác nghiệp vụ.**

Phần memory tôi kiểm tra đã có snapshot, revision và optimistic concurrency. Session snapshot cũng chứa history, memory và thông tin để resume conversation. Đây là nền tốt cho việc tiếp tục hội thoại.

Tuy nhiên, các hợp đồng đó **chưa tự chứng minh được bảo đảm phục hồi một thao tác bên ngoài**. Ví dụ cần định nghĩa rõ:

```text
Tool tạo một bản ghi trên hệ thống bên ngoài.
Hệ thống bên ngoài đã xử lý thành công.
Tiến trình agent chết trước khi lưu kết quả.
```

Khi resume, host sẽ xác minh trạng thái, thử lại hay yêu cầu người xử lý? Đây là tình huống cần một hợp đồng riêng; tôi không khẳng định SDK hiện tại chắc chắn sẽ thực hiện trùng.

Đề xuất là có adapter cho trạng thái thực thi, tách khỏi `MemoryStore`: operation ID ổn định, trạng thái step, kết quả đã lưu, approval đang chờ và cách xử lý kết quả chưa xác định. Những thao tác có side effect cần chính sách retry và idempotency phù hợp với hệ thống đích.

**Không nên quảng bá một bảo đảm “exactly once” chung cho mọi external tool.** Khi kết quả không rõ, đôi khi hành vi đúng là đối soát hoặc dừng để xử lý, không phải tự động thử lại.

Phần này nên là tùy chọn. Một chatbot đơn giản không cần bị buộc triển khai thêm một workflow engine.
