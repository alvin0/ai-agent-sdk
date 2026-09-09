# Memory — Tổng quan

Tác vụ chạy dài có **hai bài toán liên tục khác nhau**, và SDK giữ chúng tách
bạch:

| Vấn đề | Cơ chế | Có mất mát? |
| --- | --- | --- |
| Sự kiện không bao giờ được biến mất — mục tiêu, ràng buộc, quyết định | **Bộ nhớ tác vụ** | Không — được ghim ngoài phần bị nén |
| Hội thoại cũ không còn vừa cửa sổ ngữ cảnh | **Nén ngữ cảnh** | Có, theo thiết kế |

Checkpoint có mất mát. Bộ nhớ đã ghim **không nằm trong khoảng lịch sử bị nén**.
Gộp hai thứ này lại chính là cách các agent dài hơi mất mục tiêu giữa đường.

## Bốn tầng trạng thái

```text
┌─ Bộ nhớ tác vụ ──────────────── được ghim, có chặn trên, host điều khiển
│    objective · constraint · decision · fact · progress · next-step
│    → tiêm dưới dạng ngữ cảnh USER do app soạn, trong <task-memory>
│
├─ Lịch sử (entries) ──────────── bản ghi bền, chỉ-thêm, không bao giờ xoá
│    mọi message + mọi bản ghi vòng đời, kể cả các lần nén thất bại
│
├─ Lịch sử (messages) ─────────── phép chiếu hiện tại mà model nhìn thấy
│    các lượt gần đây nguyên văn + checkpoint thay cho các khoảng cũ
│
└─ Snapshot ──────────────────── an toàn JSON, có phiên bản, chuyển được giữa tiến trình
     conversationId · danh tính agent · lịch sử · bộ nhớ · danh tính skill
```

## Mặc định

Mọi định nghĩa `defineAgent()` đều bật cả hai cơ chế trừ khi cấu hình khác đi:

| Hành vi | Mặc định |
| --- | --- |
| Message user thật đầu tiên trở thành bộ nhớ `original-objective` | bật |
| Bộ nhớ được thêm vào đầu mỗi yêu cầu, trong `<task-memory>` | bật |
| Nén tự động kiểm tra áp lực trước mỗi bước model | bật |
| Ngưỡng áp lực | 80% cửa sổ ngữ cảnh **dùng được** |
| Phần đuôi giữ nguyên văn | 20% gần nhất |
| Văn bản kết quả tool quá lớn | cắt còn phần đầu/đuôi bền vững |
| Lùi áp lực | 4 bước model khi `unreachable-threshold` hoặc `low-savings` |
| `CONTEXT_WINDOW_EXCEEDED` do nhà cung cấp xác nhận | có thể nén rồi thử lại một lần |
| Lời gọi checkpoint | kế thừa provider, model, và mức nỗ lực của hội thoại |

```text
cửa sổ đầu vào dùng được = model.contextWindow − phần dự trữ output hiệu dụng
```

Một model có cửa sổ tổng hợp 128k với ngân sách output 32k do đó không bao giờ
được coi là có 128k cho đầu vào.

> Nếu adapter không báo cửa sổ ngữ cảnh, nén theo áp lực tự động là **no-op** trừ
> khi có cấu hình `maxInputTokens`. `session.compact()` thủ công và việc khôi phục
> khi tràn vẫn hoạt động.

## Các chặn trên

| Giới hạn | Mặc định |
| --- | --- |
| Số mục bộ nhớ giữ lại | 1.024 |
| Ký tự mỗi mục bộ nhớ | 65.536 |
| Tổng nội dung bộ nhớ | 1 MiB |
| Ký tự tiêm vào mỗi yêu cầu | 12.000 |
| Số mục lịch sử | 100.000 |
| Byte mỗi mục lịch sử | 16 MiB |
| Tổng byte lịch sử | 128 MiB |

Các đường khôi phục kiểm tra giới hạn **trước khi công bố** và chỉ chuẩn hoá các
trường đã ghi tài liệu.

## Bộ nhớ do người dùng soạn, một cách có chủ ý

Bộ nhớ **không** được nối vào system prompt. Nó đến dưới dạng ngữ cảnh **user** do
app soạn, nên mục tiêu do người dùng đặt giữ nguyên thẩm quyền người dùng, thay vì
bị âm thầm nâng lên thành chỉ dẫn hệ thống/lập trình viên.

Model cũng không thể viết lại nó: bộ nhớ có thể kiểm tra được và do host điều
khiển.

```ts
session.memory.remember({ kind: 'decision', content: 'Use the incremental path.' })
session.memory.forget('release-constraint')
session.memory.items()
```

## Trong chương này

| Trang | Trả lời |
| --- | --- |
| [Short-term Memory](/vi/05-memory/short-term-memory) | Lịch sử, bộ nhớ tác vụ, và việc nén thực sự chạy thế nào |
| [Persistent Memory](/vi/05-memory/persistent-memory) | Snapshot, lưu/khôi phục, và những gì bị loại trừ có chủ ý |
| [Custom Memory Provider](/vi/05-memory/custom-memory-provider) | `defineMemoryStore()` và quy tắc phạm vi/sở hữu |
