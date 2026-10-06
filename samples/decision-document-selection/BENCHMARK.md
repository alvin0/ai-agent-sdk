# Kết quả chọn tài liệu với API thật

Đo ngày 2026-10-04, run `2026-10-04T06-25-11.605Z`, dùng API key trong root
`.env`. OpenAI selector/writer là `gpt-6-luna`; TypeSafe request `jev-latest`,
model trả về `jev-1.13.0`. Hai cấu hình dùng cùng catalog, rubric, cutoff 2 và
writer. Có năm ca, mỗi ca một lần cho mỗi provider, không retry hay fallback.
Thứ tự provider đảo theo ca, concurrency đánh giá tài liệu là 2.

| Ca | OpenAI decision + writer | TypeSafe decision + OpenAI writer |
| --- | --- | --- |
| Chính sách hiện hành | Pass, 10.604 ms | Review do lỗi response, 1.748 ms |
| Chính sách lịch sử | Pass, 6.855 ms | Pass, 2.971 ms |
| Thiếu thủ tục claim | Pass: review vì thiếu bằng chứng, 9.077 ms | Review do lỗi response, 1.796 ms |
| Ngoại lệ bảo trì | Pass, 17.864 ms | Review do lỗi response, 1.343 ms |
| Câu hỏi tiếng Việt và quyền tenant | Pass, 16.473 ms | Review do lỗi response, 1.273 ms |

OpenAI đạt **5/5** ca, 21/21 ứng viên có kết quả hợp lệ. TypeSafe đạt **1/5** ca,
6/21 ứng viên có kết quả hợp lệ. 15 ứng viên bị từ chối với
`MALFORMED_RESPONSE`, static validation issue
`Score does not match its probability distribution`. SDK kiểm tra score phải
khớp kỳ vọng tính từ phân phối theo các mức rubric, trong sai số cho phép.
Kết quả này cho thấy cấu hình hiện tại gặp lỗi contract; chưa đủ để kết luận
nguyên nhân nằm ở API hay cách diễn giải contract của adapter.

Thời gian trên là **toàn ca**: đánh giá các ứng viên và sinh câu trả lời nếu đủ
nguồn. Ca lỗi TypeSafe dừng trước writer; không dùng các thời gian này để tuyên
bố provider nào nhanh hơn ở cùng một workflow thành công. Khi có ứng viên lỗi,
sample không bỏ qua lỗi để lấy phần còn lại, không chuẩn hóa lại xác suất, không
chấm review đó như một lần từ chối trả lời đúng.

Ví dụ đầu ra OpenAI hiện hành chọn `eu-sla-current` + `eu-claims-current`, credit
10%, hạn 30 ngày sau cuối tháng và ba hồ sơ. Ca lịch sử chọn hai tài liệu cũ,
credit 5%, hạn 90 ngày và hai hồ sơ. Ca bảo trì chọn `eu-maintenance`, credit 0%.
Các quote được kiểm tra nguyên văn; câu trả lời thực tế nằm trong
[results-summary.json](./results-summary.json).

## Các lần thử trước khi chốt rubric

Hai lần thử phát triển đều ghi nhận OpenAI 4/5, TypeSafe 0/5:

- Lần đầu: OpenAI loại nhầm tài liệu có nhãn archived khi câu hỏi cần chính sách
  quá khứ. Bổ sung ngày hiệu lực vào state và làm rõ phải đánh giá theo `asOf`.
- Lần thứ hai: OpenAI trả false cho tài liệu phủ nhận quyền nhận credit dù đó
  là bằng chứng trả lời trực tiếp. Làm rõ boolean là **có bằng chứng trả lời
  phần câu hỏi**, gồm cả quy tắc loại trừ; không phải **người dùng được credit**.

Những lượt này là dữ liệu điều chỉnh rubric, không phải lượt độc lập để xác
nhận chất lượng cuối. Raw artifacts được giữ tại
`artifacts/decision-documents/selection-v1`, `selection-v2`, `selection-v3` trong
workspace. File summary trong sample ghi kết quả cuối và lỗi từng ứng viên;
runner có thể tạo lại report với câu trả lời, usage và đánh giá đầy đủ.

## Phạm vi kết luận

Đây là kiểm tra nhỏ trên fixture giả lập đã dùng khi chỉnh rubric. Grader đo
bộ nguồn, các facts có cấu trúc và quote có trong nguồn; không đánh giá mọi
khẳng định trong prose hay chứng minh quote kéo theo câu trả lời. Host loại
nguồn sai quyền/phạm vi/ngày trước model, nên các ca đó kiểm tra toàn pipeline,
không chứng minh model tự thực thi quyền truy cập. Chưa có tập held-out, nhiều
lần lặp, thử tải hoặc tài liệu thực. Không quy đổi USD từ usage chưa có bảng giá
được xác minh.

Kiểm tra offline: 149 test liên quan decision/provider và hai sample đã qua;
sau kiểm tra cuối về output, 10 test riêng cho document sample chạy lại đã qua.
Typecheck root/sample, lint kiến trúc và release docs đều qua.
