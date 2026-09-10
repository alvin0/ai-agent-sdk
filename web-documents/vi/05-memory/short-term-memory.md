# Short-term Memory

Tác vụ chạy dài có hai bài toán liên tục khác nhau, và SDK giữ chúng tách bạch:

- **Bộ nhớ tác vụ** chứa những sự kiện không bao giờ được biến mất — mục tiêu ban
  đầu, ràng buộc, các quyết định tường minh.
- **Nén ngữ cảnh** thay phần hội thoại cũ mà model nhìn thấy bằng một checkpoint
  có cấu trúc, đồng thời giữ nguyên văn phần bằng chứng gần đây.

Checkpoint có mất mát theo thiết kế. Bộ nhớ đã ghim **không nằm trong khoảng lịch
sử bị nén**.

## Mặc định

Mọi định nghĩa `defineAgent()` đều bật cả hai cơ chế trừ khi cấu hình khác đi:

| Hành vi | Mặc định |
| --- | --- |
| Message user thật đầu tiên trở thành bộ nhớ `original-objective` | bật |
| Bộ nhớ được thêm vào đầu mỗi yêu cầu dưới dạng ngữ cảnh user do app soạn, trong `<task-memory>` | bật |
| Nén tự động kiểm tra áp lực trước mỗi bước model thông thường | bật |
| Ngưỡng áp lực | 80% cửa sổ ngữ cảnh của model |
| Phần đuôi giữ nguyên văn | 20% gần nhất |
| Văn bản kết quả tool quá lớn | cắt còn phần đầu/đuôi bền vững trước khi tóm tắt |
| Lùi áp lực | 4 bước model khi riêng phần giữ lại đã vượt ngưỡng, hoặc checkpoint tiết kiệm quá ít |
| `CONTEXT_WINDOW_EXCEEDED` do nhà cung cấp xác nhận | có thể nén rồi thử lại một lần |
| Lời gọi checkpoint | kế thừa provider, model, và mức nỗ lực của hội thoại |

Bộ nhớ giữ tối đa 1.024 mục, 65.536 ký tự mỗi mục, và 1 MiB nội dung; tối đa
12.000 ký tự được tiêm vào một yêu cầu. Lịch sử mặc định 100.000 mục, 16 MiB mỗi
mục, và 128 MiB tổng.

> Nếu adapter không báo cửa sổ ngữ cảnh, nén theo áp lực tự động là **no-op** trừ
> khi có cấu hình `maxInputTokens`. Việc khôi phục khi tràn và `session.compact()`
> thủ công vẫn có thể ép giảm một cách hữu ích.

## Cấu hình

```ts
const agent = defineAgent({
  id: 'migration-agent',
  instructions: 'Complete the migration and verify every change.',
  memory: {
    seed: [{ kind: 'constraint', content: 'Do not change the public HTTP API.' }],
  },
  compaction: {
    thresholdRatio: 0.8,
    retainRatio: 0.2,
    maxSummaryTokens: 4096,
    maxOverflowRetries: 1,
    maxToolResultChars: 24_000,
  },
})
```

Đặt `compaction: false` để tắt checkpoint. Đặt `memory.autoCaptureObjective:
false` khi ứng dụng tự cung cấp bộ nhớ mục tiêu.

## Bộ nhớ tác vụ tường minh

Bộ nhớ có thể kiểm tra được và do host điều khiển — model không thể âm thầm viết
lại nó.

> **Session nào.** `.memory` nằm trên `AgentSession` của tầng `defineAgent()`.
> `RuntimeAgentSession` ở tầng runtime — thứ `runtime.agent().createSession()`
> trả về — không có accessor `.memory`; hãy gắn store ở đó rồi đọc lại qua một
> session `defineAgent()`, hoặc tự giữ các fact của tác vụ trong state của bạn.

```ts
session.memory.remember({
  kind: 'decision',
  content: 'Use a transactional outbox for event delivery.',
})

session.memory.remember({
  id: 'release-constraint',
  kind: 'constraint',
  content: 'The release must remain backward compatible.',
})

session.memory.forget('release-constraint')
console.log(session.memory.items())
```

Các loại được hỗ trợ: `objective`, `constraint`, `decision`, `fact`, `progress`,
`next-step`. Dùng lại một id sẽ cập nhật mục đó. Việc kết xuất có chặn trên và ưu
tiên mục tiêu, ràng buộc, và quyết định.

**Bộ nhớ cố ý không được nối vào system prompt.** Mục tiêu do người dùng đặt giữ
nguyên thẩm quyền người dùng thay vì bị nâng lên thành chỉ dẫn hệ thống/lập trình
viên.

## Vòng đời nén

1. Đo toàn bộ yêu cầu kế tiếp — bộ nhớ hệ thống, message, và tool.
2. Chọn một khoảng đầu cũ, đồng thời giữ lại phần đuôi gần đây.
3. Cắt bền vững phần văn bản kết quả tool quá lớn, giữ đầu/đuôi an toàn Unicode.
4. Dịch ranh giới sao cho một lời gọi tool host và kết quả của nó không bao giờ
   bị tách rời.
5. Ghi thêm một bản ghi log bền vững `compaction-start`.
6. Chạy một yêu cầu tóm tắt **đã tắt tool**, dùng prompt bàn giao có cấu trúc.
7. Từ chối bản tóm tắt rỗng, bị cắt cụt, có gọi tool, hoặc không làm ngắn đi.
8. Ghi thêm `compaction-summary`, một checkpoint user thay thế, rồi
   `compaction-end`.

Phần thay thế dùng đúng các seq bề mặt. Điều này quan trọng sau nhiều lần nén:
seq thay thế là danh tính log chỉ-thêm và **không** nhất thiết là một dải số liền
mạch.

**Bản ghi cho người đọc không bao giờ bị xoá.** `history.entries()` giữ message
gốc và các bản ghi vòng đời; `history.messages()` chỉ trả về phép chiếu hiện tại
mà model nhìn thấy.

## Bàn giao có cấu trúc

Bộ tóm tắt được yêu cầu giữ lại:

- yêu cầu chính và ý định đang tiến triển;
- công việc đã hoàn thành và bằng chứng;
- quyết định và lý do;
- ràng buộc và các đính chính của người dùng;
- tệp, ký hiệu, lệnh, và lỗi quan trọng;
- công việc đang chờ/đang làm và một bước kế tiếp cụ thể.

Phần về tệp phân biệt tệp đã xem và tệp đã sửa, đồng thời giữ đúng những khai báo
cần dùng tiếp. `Current Work` ghi hành động tool thành công gần nhất và kết quả
kiểm chứng; `Next Step` phải là một thao tác sửa hoặc một lệnh trực tiếp, chứ
không phải yêu cầu đọc lại những tệp chưa đổi.

Nhờ vậy model sau khi nén nhận được **trạng thái làm việc thực thi được**, không
chỉ một lời nhắc bằng văn xuôi về mục tiêu. Các checkpoint `<compacted-summary>`
trước đó được hợp nhất chứ không chép nguyên văn, ngăn bản tóm tắt phình ra qua
mỗi thế hệ.

## Nén thủ công và sự kiện cho giao diện

```ts
const result = await session.compact({ signal })
if (result !== null) {
  console.log(result.shadowedSeqs, result.estimatedTokensAfter)
}
```

Nén tự động phát ra sự kiện `compaction-start` và `compaction-end` có gắn vết qua
`session.stream()`, bao bởi một span con loại `compact`. Giao diện có thể vẽ
chúng thành các nút bảo trì bên cạnh span model và tool.

Sự kiện hoàn tất phơi ra `thresholdTokens`, `estimatedNonCompactableTokens`, và
`backoffReason` tuỳ chọn — `unreachable-threshold` hoặc `low-savings`. Các trường
này làm một ngưỡng tuyệt đối cấu hình sai trở nên **nhìn thấy được**, thay vì gây
ra vòng lặp nén âm thầm.

Nén theo áp lực là **fail-open**: bộ tóm tắt thất bại không giết một yêu cầu đang
khoẻ. Việc khôi phục khi tràn thì nghiêm hơn và chỉ trả `retry` khi thế hệ thay
thế lịch sử thực sự đã tiến lên.

## Ước lượng token

SDK trung lập không thể đóng gói mọi tokenizer của nhà cung cấp, nên bộ đo mặc
định là một bộ ước lượng tất định, thiên về an toàn, tính trên văn bản, schema
tool, trạng thái phát lại, và chi phí ảnh cố định.

Chính sách dùng `contextWindow` có thẩm quyền của adapter khi có, và **trừ đi
phần dự trữ output hiệu dụng của model** trước khi chọn ngưỡng áp lực. Một model
có cửa sổ tổng hợp 128k và ngân sách output 32k do đó không bao giờ bị coi là có
128k cho đầu vào. Yêu cầu checkpoint cũng bị chặn theo trần output cứng mà model
tóm tắt khai báo.

Ứng dụng cần tính giá chính xác có thể đặt `maxInputTokens` tuyệt đối. Các
tokenizer backend trong tương lai có thể thay bộ đo mà không đổi hợp đồng lịch sử
hay session.

## Đọc tiếp

- [Persistent Memory](/vi/05-memory/persistent-memory) — snapshot và khôi phục
- [Performance](/vi/10-advanced/performance) — mọi chặn trên và ngân sách
