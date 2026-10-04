# Nâng cấp từ 0.1.7 lên 0.1.8

Bản vá sửa recovery khi tool lặp y hệt và chẩn đoán lỗi embedding cuối cùng trong
`@alvin0/ai-agent-sdk-core`. Cả 26 package workspace và metadata root chuyển sang
**0.1.8**; testkit vẫn private. Merge vào `main` kích hoạt workflow Release có các
cổng kiểm tra. Import hiện tại và snapshot session v1 tiếp tục được hỗ trợ.
Cập nhật các package SDK đang dùng và lockfile của ứng dụng.

## Tool call lặp y hệt

Khi chạm `repeatToolLimit`, loop có thể dùng lại kết quả thành công ngay trước đó
trong cùng turn nếu tên tool, raw arguments và định nghĩa tool không đổi. Call mới
vẫn có cặp history/event riêng và notice `duplicate_of` cho model; metadata kết
quả có `recovered: true`, `duplicateOfCallId`, còn execution span có
`sdk.tool.recovered`. Thân tool không được dispatch lần nữa.

Trong batch có call lặp y hệt và call mới, repeat admission áp dụng cho từng call.
Call lặp đủ điều kiện được recover; call lặp không đủ điều kiện bị decline mà
không giữ quota dispatch. Call mới vẫn qua quota, authorization, concurrency và
cancellation thông thường. Batch có call recover và call mới thực sự dispatch có
thể tiếp tục bình thường; call recover không tiêu quota tool. Nếu call mới đứng
trước call từng lặp, streak được reset nên call sau thực thi lại, không dùng kết
quả cũ vượt qua công việc xen giữa.

Recovery không vượt qua call hoặc lỗi xen giữa, không dùng call bị decline hay
kết quả có `additionalContext` hoặc `concludesTurn`. Tool được miễn budget cũng
bị loại. Đây là recovery có giới hạn ở repeat guard, không phải cache tổng quát
hay cơ chế idempotency bền vững.

Round chỉ gồm call được recover có thể chạy thêm một round model thông thường
cho mỗi exact key nếu còn step và budget, với `onExhausted` khác `'stop'`. Lặp lại
exact key lần nữa làm cạn repeat guard. Round vừa recover vừa decline, cycle
limit, thiếu usage bắt buộc, token limit, report reserve, cancellation và
admission stop vẫn giữ hành vi dừng hiện tại. Recovery không tự xác nhận hoàn
thành mục tiêu; tiếp tục kiểm tra `response.completed`.

## Chẩn đoán provider embedding

`EmbeddingError.failure` bổ sung envelope `ModelFailure` đã validate và freeze.
Lỗi provider cuối cùng giữ các trường có sẵn `status`, `providerRetryAfterMs` và
`requestId` qua retry wrapper embedding và `normalizeModelFailure(error)`.
Trường không có thông tin vẫn vắng mặt. Constructor nhận các trường tùy chọn
này qua `EmbeddingErrorOptions`; `EmbeddingError` có sẵn giữ nguyên identity.

Retry policy, số attempt, backoff, input text và vector không đổi. Envelope không
thêm input text thô hay response body thô của provider. Dùng các trường này để
phân loại lỗi authentication, rate limit và server; chúng không chứng minh
provider khả dụng, chất lượng retrieval hay tốc độ thực thi tốt hơn.
