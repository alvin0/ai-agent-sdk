# Nâng cấp từ 0.1.4 lên 0.1.5

Trang này mô tả thay đổi được bổ sung trong **0.1.5**. Workspace hiện chuẩn bị
0.1.8; xem [nâng cấp từ 0.1.7](/vi/01-introduction/upgrading-from-0-1-7)
cho thay đổi mới về recovery khi tool lặp và chẩn đoán embedding.

Các đường import, cấu hình provider/model/effort, tool thông thường,
`run`/`stream` và snapshot/resume vẫn giữ. Thiết kế effort được ghi trong
changelog 0.1.4 đã thuộc bản nền. API tối ưu context và program tool mới đều
tùy chọn; ứng dụng cũ không bắt buộc dùng chúng.

## Thay đổi hành vi ứng dụng

| Phần | Hành vi mới | Cần kiểm tra |
| --- | --- | --- |
| `commentary` | Mặc định `auto`, trước đây là `concise` | Đặt `concise` rõ ràng nếu cần progress update ngắn. |
| `session.inject()` | Input giữa model round đợi sau output đang chạy | Receipt là tạm thời, không phải sequence bền vững. Snapshot giữ input đang đợi. Từ 0.1.6, input của người dùng gửi trong lúc model viết câu trả lời cuối được trả lời ngay trong cùng run. |
| Chiến lược managed team | Prompt giải thích lifecycle thay vì áp một kế hoạch | Đưa yêu cầu lập kế hoạch, phân công và tổng hợp vào instructions của host. |
| Text của worker | Hoàn tất sạch với text rỗng được chấp nhận | Đặt `requireWorkerText: true` nếu bắt buộc có báo cáo text. |
| `writes` | Chỉ nhận scope tương đối trong workspace, không thoát ra ngoài | Dùng `src/file.ts`; bỏ scope khi chỉ đọc. Scope phục vụ scheduling, không cấp quyền file. |
| Preview dependency | `maxDependencyReportBytes` phải từ 4 trở lên | Mặc định 8 KiB giữ nguyên; báo cáo đầy đủ vẫn truy xuất được. |
| Timeout worker | `workerTimeoutMs` tính thời gian thực thi chủ động | Thêm deadline ở host nếu cần chặn cả setup và thời gian đợi dependency. |
| Signal của hook | Bao gồm hủy do timeout | Truyền tiếp signal được cung cấp; không dựa vào object identity. |

Tự điều phối lead vẫn bật mặc định. `autoLeadCoordination: false` chuyển việc
lên lịch lượt chạy cho host; `workerTeamTools` mặc định `reporting`, cũng nhận
`full` hoặc false.

```ts
const lead = defineAgent({
  id: 'lead', provider, model,
  instructions: 'Plan, delegate independent work, then synthesize verified results.',
  commentary: 'concise',
})
const team = createManagedAgentTeam({ registry, lead, requireWorkerText: true })
```

Cấu hình này giữ những rule cụ thể đó, không bảo đảm model trả lời giống hệt.
Identity của dependency, write claim khi đóng có giới hạn và outcome A2A chưa
hoàn tất đã được sửa; hãy xem trạng thái completed/failed thay vì chỉ xem
Promise resolve.

## History và câu trả lời cuối

Input được inject khi model request đã cố định sẽ được giao sau output của
request đó, trước khi chuẩn bị request tiếp theo. Live history ở lớp thấp có
thể chưa chứa input, nhưng `snapshot()` giữ input đang đợi trong format v1 cũ.
Checkpoint thất bại sẽ drain input trước recovery/retry hook.

Task memory giữ objective gốc làm bối cảnh. User request mới ghi đè objective
hoặc constraint cũ khi có mâu thuẫn. Lượt bị ngắt ghi nhận bối cảnh để request
tiếp theo có thể đổi hướng công việc.

Sau self-check được chấp nhận ở deep mode, SDK có thể giữ nguyên câu trả lời
trước đó. Marker điều khiển bị lọc và terminal response chứa text đã khôi phục.
Đồng bộ UI streaming theo response này; không bảo đảm có thêm một chuỗi delta
đầy đủ lặp lại câu trả lời.

`StepDecision.messages` chỉ chiếu một model request, không viết lại raw history
hay checkpoint snapshot. `AgentTeam.messageByteLimit` là getter mới; mock tự
dựng theo kiểu concrete class này có thể cần bổ sung getter.

## Phần mới tùy chọn

- [Tối ưu context](/vi/05-memory/context-optimization): observation lặp lại,
  milestone đã lưu trữ và rút gọn evidence theo dòng chính xác.
- [Program tool](/vi/12-experimental/programmatic-tools): grant rõ ràng, child
  call, kiểm tra output và action fusion.
- [Lifecycle](/vi/02-agents/lifecycle): steering và projection của request.
- [Streaming](/vi/02-agents/streaming): text cuối và bằng chứng hoàn tất.
