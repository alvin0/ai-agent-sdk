# Skill Lifecycle

## Khám phá lại ở mỗi lượt

Danh mục được khám phá lại ở **đầu mỗi lượt session**. Một CLI có thể thêm hoặc
cập nhật thư mục giữa phiên mà không phải dựng lại định nghĩa agent, và thư mục
mới xuất hiện dưới dạng metadata ở vòng kế tiếp.

```text
lượt N     → khám phá danh mục → model có thể load_skill → chỉ dẫn vào lịch sử
lượt N+1   → khám phá danh mục LẠI (thư mục mới giờ đã thấy được)
```

Provider **không** nạp trước phần thân của mọi `SKILL.md` vào ngữ cảnh model. Chỉ
metadata được làm mới.

## Revision làm mất hiệu lực manifest

Sửa một `SKILL.md` ở cùng đường dẫn sẽ đổi **revision nông của tệp**, làm mất
hiệu lực manifest tài nguyên cũ và buộc skill phải được nạp lại.

Đó là lý do đôi khi một lần sửa trông như không có tác dụng: model vẫn đang giữ
chỉ dẫn từ revision trước, đã nằm trong lịch sử. Nó sẽ nhận phần thân mới ở lần
gọi `load_skill` kế tiếp.

| Thay đổi | Hệ quả |
| --- | --- |
| Sửa `SKILL.md` tại chỗ | Revision đổi; manifest cũ mất hiệu lực; phải nạp lại |
| Thêm thư mục skill mới | Xuất hiện dưới dạng metadata ở lượt sau |
| Xoá thư mục skill | Biến khỏi danh mục ở lượt sau |
| Sửa một tệp tài nguyên | Đọc lại qua `read_skill_resource` |

## Việc giữ trong lịch sử

Chỉ dẫn đã chọn và các khối tài nguyên trả về **vẫn nằm trong lịch sử hội thoại
cho tới khi nén**. Sau một lần nén, model có thể gọi `load_skill` lại.

Điều này quan trọng về chi phí: nạp một skill lớn không phải chi phí của một yêu
cầu, nó nằm trong phần đầu vào của **mọi** yêu cầu tiếp theo trong khoảng đó. Nếu
một skill lớn và ít khi cần tới hai lần, hãy ưu tiên vài lần đọc tài nguyên thay
vì một phần thân khổng lồ.

## Kích hoạt có phạm vi theo hội thoại

```ts
session.reset()   // xoá trạng thái kích hoạt skill trong phạm vi hội thoại
```

`reset()` bắt đầu một conversation id mới và xoá trạng thái kích hoạt, đồng thời
phục hồi các mầm bộ nhớ ở mức định nghĩa. Agent, provider, và tool giữ nguyên.

## Snapshot lưu danh tính, không lưu nội dung

**Phần thân và tài nguyên của skill không bao giờ được lưu** trong snapshot của
session. Thứ được lưu là **danh tính** của các skill đã kích hoạt.

```ts
const snapshot = session.snapshot()   // an toàn JSON; chỉ danh tính skill
await store.save(session.conversationId, snapshot)

const resumed = agent.resumeSession(await store.load(conversationId))
```

Khi khôi phục, SDK **khám phá lại và nạp lại** chúng từ các provider hiện tại.

## Khôi phục thất bại sớm, có chủ ý

| Tình huống | Hành vi |
| --- | --- |
| Provider, nguồn, hoặc vị trí tài nguyên đã trôi lệch | Thất bại **trước** khi gửi yêu cầu model |
| Một mục trong `allowedSkillIds` đã khai báo không khả dụng | Thất bại trước khi gửi yêu cầu model |
| Snapshot v1 cũ không có trạng thái skill | Hợp lệ — được chấp nhận |
| Trường lạ trong snapshot | Bị loại bỏ |
| Id agent khác | Thất bại sớm |

Thất bại trước khi gửi yêu cầu chính là điểm mấu chốt: phương án còn lại là âm
thầm chạy với **một tập năng lực khác** so với snapshot đã ghi, và điều đó sinh ra
kết quả mà sau này không ai giải thích được.

Số lượng kích hoạt được khôi phục và kích thước chuỗi danh tính/vị trí bị chặn bởi
chính sách skill của định nghĩa, nên một snapshot bị can thiệp không thể mở rộng
bề mặt.

## Các chặn trên xuyên vòng đời

| Chặn trên | Mặc định | Áp dụng cho |
| --- | --- | --- |
| `maxCatalogChars` | 8.000 | Metadata khám phá trong system prompt |
| `maxSearchResources` | 32 | `search_skill_resources` |
| `maxSearchInputChars` | 200.000 | `search_skill_resources` |
| Văn bản tài nguyên trả về | Chặn cứng | `read_skill_resource`; tài nguyên lớn chia khối |
| Số lượng kích hoạt khôi phục | Chính sách của định nghĩa | Khi khôi phục |

## Quan sát vận hành

`sdk.skill.operation` ghi start/end kèm **số lần** khám phá, kích hoạt, và đọc
tài nguyên — và **không bao giờ** kèm đường dẫn hay nội dung. Chi tiết ở mức hệ
tệp có sẵn riêng qua bộ quan sát `onIo` của chính provider, nơi báo pha, thao tác,
đường dẫn, và số byte mà không đọc lại nội dung.

Cách chia đó là có chủ ý: telemetry vẫn an toàn để xuất ra, trong khi việc gỡ lỗi
cục bộ vẫn thấy được đường dẫn.

## Đọc tiếp

- [Session và lưu trữ](/vi/05-memory/persistent-memory)
- [Loading Skills](/vi/04-skills/loading-skills)
