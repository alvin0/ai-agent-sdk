# Skills — Tổng quan

Skill là một **gói năng lực** — chỉ dẫn cộng với tài nguyên có thể địa chỉ hoá —
và nó **nằm ngoài ngữ cảnh model cho tới khi model chọn nó**.

Skill giải đúng một bài toán: có năm mươi năng lực sẵn sàng nhưng không phải trả
ngữ cảnh cho cái nào.

## Ba pha tiết lộ

```text
1. Khám phá           YAML front matter có chặn trên + tệp chính sách gọi
                      → system prompt nhận id, tên, mô tả, ranh giới lựa chọn
                      → giới hạn bởi maxCatalogChars (mặc định 8.000)

2. load_skill         đọc toàn bộ SKILL.md CHỈ của skill được chọn
                      → vào ngữ cảnh model, công bố manifest đường dẫn/kích thước có chặn trên
                      → nội dung tài nguyên vẫn chưa đọc

3. read_skill_resource   đọc MỘT tài nguyên được chọn
   search_skill_resources đòi skill đã nạp, chỉ tìm trong skill đó
                      → văn bản trả về bị chặn cứng; tài nguyên lớn phơi ra theo khối
                      → tìm kiếm dừng ở 32 tài nguyên / 200.000 ký tự đã duyệt
```

> Việc đọc đĩa và vùng nhớ JavaScript tự thân không tiêu token của model. Văn bản
> chỉ bắt đầu tiêu ngữ cảnh khi được đặt vào system prompt, một message, hoặc một
> kết quả tool.

Các tool skill được sinh ra là **rào chắn của bộ lập lịch**. Điều này giữ đúng
thứ tự model cho một lô như `load_skill` rồi `read_skill_resource`, và không giả
định rằng một provider từ xa an toàn khi truy cập đồng thời.

## Hai cách cấp skill

| Cách | Dùng khi | Điểm vào |
| --- | --- | --- |
| **Định nghĩa trong bộ nhớ** | Trình duyệt, edge worker, nội dung đóng gói kèm | `defineSkill()` |
| **Hợp đồng provider** | Cơ sở dữ liệu, API, I/O lười, kho từ xa | `defineSkillProvider()` |
| **Khám phá qua hệ tệp** | CLI trên Node với các thư mục `SKILL.md` | `@alvin0/ai-agent-sdk-skill-filesystem` |

Cả ba đều thoả cùng một hợp đồng trung lập với môi trường. Cả điểm vào chính của
SDK lẫn hợp đồng provider đều không import module hệ tệp của Node.

## Khai báo trên một agent

```ts
const agent = runtime.agent({
  id: 'operator',
  model,
  instructions: 'Help the operator resolve incidents.',
  skills: [incidentTriage],             // các nguồn
  allowedSkillIds: ['incident-triage'], // ranh giới uỷ quyền
})
```

`allowedSkillIds` là **ranh giới uỷ quyền và định tuyến, không phải danh sách
kích hoạt**. Danh mục chỉ phơi metadata cho những id đó; phần thân vẫn chỉ được
lấy sau `load_skill`. Một lượt không liên quan thực hiện **không** kích hoạt skill
nào.

| Giá trị | Hành vi |
| --- | --- |
| `['a', 'b']` | Chỉ các id này hiện diện trong danh mục |
| `[]` | Tắt các skill được tiêm ở mức session |
| bỏ trống | Khám phá mở — hữu ích cho CLI mà thư mục cấu hình chính là ranh giới |

Nếu một id đã khai báo không khả dụng, session thất bại **trước** khi gửi yêu cầu
model, thay vì âm thầm chạy với một năng lực khác.

## Skill so với tool

| | Tool | Skill |
| --- | --- | --- |
| Nó là gì | Một hàm model gọi được | Chỉ dẫn + tài nguyên model đọc được |
| Chi phí ngữ cảnh khi không dùng | Schema của nó, ở mọi yêu cầu | Chỉ id, tên, mô tả |
| Được chọn bởi | Model gọi nó | Model gọi `load_skill` |
| Thực thi | Mã của bạn | Không gì — nó là kiến thức, không phải hành vi |

Dùng tool để *làm* một việc. Dùng skill để *biết* một điều.

## Trong chương này

| Trang | Trả lời |
| --- | --- |
| [Creating Skills](/vi/04-skills/creating-skills) | `defineSkill()`, `defineSkillProvider()`, và bố cục `SKILL.md` |
| [Loading Skills](/vi/04-skills/loading-skills) | Khám phá qua hệ tệp, kích hoạt do host điều khiển, chặn trên khi tìm |
| [Skill Lifecycle](/vi/04-skills/skill-lifecycle) | Khám phá lại, revision, snapshot, và quy tắc khôi phục |
