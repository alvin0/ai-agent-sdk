# Nâng cấp từ 0.1.6 lên 0.1.7

Workspace đang chuẩn bị **0.1.7**, chưa phát hành. Dùng package đóng gói cục bộ
đến khi workflow Release publish. Các package giữ cùng phiên bản; testkit vẫn
private. Đường import và snapshot session v1 vẫn được hỗ trợ.

## Completion và steering

Dùng `response.completed` để đánh giá hoàn thành mục tiêu; `response.report.status`
chỉ mô tả thực thi. Reply basic rỗng, chỉ có khoảng trắng hoặc reasoning là
incomplete, dù round trước đã có câu trả lời. Tool chủ động kết thúc lượt vẫn giữ
ngữ nghĩa completion của nó.

Input mới từ người dùng hoặc agent được giao việc làm mất hiệu lực self-check deep
đã chấp nhận và cần `submit_result` mới. Submission không được ở cùng model message
với submission khác hoặc tool thực hiện công việc. Notice điều phối và báo cáo worker
tự động của SDK có thể đánh thức lead mà không làm mất self-check; app notice thông
thường không được tính là công việc chờ.

Input đến ở round cuối có thể chưa được trả lời nếu run không thể tiếp tục.
Runtime session bổ sung API khôi phục đã có ở session tầng thấp:

```ts
await session.whenIdle()
if (session.hasUnansweredInput()) {
  const response = await session.runPending({ signal })
  // Kiểm tra response.completed; không thêm lại message của người dùng.
}
```

Dùng một bộ lập lịch cho mỗi conversation, giới hạn recovery bằng cancellation
và budget. Không tự chạy lại công việc người dùng đã Stop. `inject()` kiểm tra
dung lượng history trước khi nhận input vào hàng đợi; xử lý lỗi admission trước
khi báo đã nhận steer.

## Stream khớp với reload

Marker giữ câu trả lời được dành riêng trong mọi mode, cả khi chia qua nhiều text
block hoặc có text xung quanh, và bị loại khỏi câu trả lời công khai. Text còn lại
stream bình thường; câu trả lời được giữ có thể không phát delta lần thứ hai.
`assistant-replacement` mang `fromMessageId` và `message` thay thế khi self-check
đã chấp nhận giữ hoặc sửa draft. Thay message được chỉ định thay vì nối câu trả lời.

Sau thành công, đồng bộ UI theo `response.text`, kể cả khi không có delta. Nếu
`handle.result` reject, gồm Stop, đồng bộ theo transcript session đã lưu sau cleanup.
Delta là tạm thời: `text-end.phase` có thể phân loại lại text trước tool.
Replacement event không bao phủ mọi thay đổi của transcript chuẩn.

SDK không viết lại conversation đã lưu từ 0.1.6. Ứng dụng cần loại marker dành
riêng khỏi text assistant cũ khi reload.

## Stop và human input

Stop trong deep hoặc human-in-loop ghi nhận interruption và đóng event câu hỏi
đang chờ. Render response dismiss/abort để đóng dialog. Câu trả lời HIL của người
dùng làm mất hiệu lực draft cũ. Gửi steer không tự dismiss câu hỏi HIL; cần trả lời,
dismiss hoặc Stop rõ ràng.
