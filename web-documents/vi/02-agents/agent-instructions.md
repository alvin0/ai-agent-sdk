# Agent Instructions

## Chỉ dẫn nằm ở đâu

`instructions` là phần hướng dẫn ổn định do lập trình viên soạn cho agent. Nó
thuộc định nghĩa đã đóng băng, không phải dữ liệu theo từng yêu cầu.

```ts
const agent = runtime.agent({
  id: 'reviewer',
  model,
  instructions: [
    'Review the release candidate.',
    'Inspect evidence before concluding.',
    'Report concrete risks, not general advice.',
  ].join(' '),
})
```

## Mô hình thẩm quyền

SDK phân biệt **ai đã soạn** một mẩu ngữ cảnh, và không bao giờ nâng thẩm quyền
này thành thẩm quyền khác.

| Nguồn | Thẩm quyền | Tới model dưới dạng |
| --- | --- | --- |
| `instructions` | Lập trình viên | System prompt |
| Bộ nhớ tác vụ | Người dùng | Ngữ cảnh user do app soạn, trong `<task-memory>` |
| `session.inject(text)` | Quy cho người dùng | Một message lịch sử vai user |
| `ctx.addContext()` từ một tool | App | Một message user ở yêu cầu kế tiếp |
| `additionalInstructions` theo lượt | Lập trình viên | Hướng dẫn bổ sung cho lượt chạy đó |

**Bộ nhớ tác vụ cố ý không được nối vào system prompt.** Mục tiêu do người dùng
đặt giữ nguyên thẩm quyền người dùng, thay vì bị âm thầm nâng lên thành chỉ dẫn
hệ thống/lập trình viên. Sự phân biệt đó quan trọng khi model phải cân giữa một
ràng buộc của người dùng và một quy tắc của lập trình viên.

## Bổ sung theo từng lượt

```ts
await agent.generate('Review abc123.', {
  additionalInstructions: 'The customer is on the legacy plan; avoid v2-only advice.',
})
```

Dùng cho hướng dẫn theo phạm vi một yêu cầu, thứ không thuộc danh tính ổn định
của agent. Nó không làm thay đổi định nghĩa — định nghĩa đã đóng băng.

## `mode` làm đổi cách prompt model

`mode` không chỉ là chính sách vòng lặp; nó đổi cả hợp đồng cấu trúc mà model bị
buộc phải tuân theo.

| Mode | Phần prompt thêm |
| --- | --- |
| `basic` | Dùng tool trong ngân sách lượt rồi trả lời. |
| `deep` | Bài tự kiểm cấu trúc `submit_result` phải được chấp nhận trước khi lượt kết thúc. |
| `deep-human-in-loop` | Thêm ranh giới chặn `request_user_input` cho các quyết định quan trọng của người dùng. |

```ts
const planner = runtime.agent({ id: 'planner', model, instructions: '…', mode: 'deep' })
```

`deep-human-in-loop` đòi một broker `userInput` ngay khi tạo session, nên thiếu
tích hợp giao diện sẽ thất bại sớm thay vì kẹt cứng giữa lượt chạy.

## Commentary tách bạch với suy luận

```ts
runtime.agent({ /* … */, commentary: 'concise' })
```

| Giá trị | Hành vi |
| --- | --- |
| `concise` | Yêu cầu tường thuật tiến độ ngắn, hiển thị cho người dùng, trước khi gọi tool và sau khi có kết quả. |
| `auto` | Để model tự quyết. |
| `off` | Chỉ yêu cầu câu trả lời cuối. |

Phần này cố ý **không phải** suy luận. Sự kiện `assistant-reasoning` chỉ chứa tóm
tắt hoặc nội dung suy luận mà nhà cung cấp thực sự phát ra; `assistant-text` là
văn bản công khai, được phân loại thành `commentary` hoặc `final-answer`.

Sự kiện commentary còn mang `timing` — `before-tools`, `after-tools`,
`between-tools`, `standalone` — cùng mảng id lời gọi tool, nên giao diện liên kết
một dòng tường thuật với đúng các lời gọi tool mà nó mô tả, không cần đoán mò.

## Chỉ dẫn mà SDK tự tiêm hộ bạn

Có hai lần tiêm tự động, đáng biết vì chúng sẽ xuất hiện trong bản ghi hội thoại
của bạn:

**Cảnh báo ngân sách.** Ở mốc 75% của `maxToolCalls`, vòng lặp chèn một cảnh báo
do app soạn trước bước model kế tiếp. Điều này cho một agent lập trình dài hơi cơ
hội dừng thăm dò rộng và để dành lượt gọi cho việc sửa và kiểm chứng, thay vì
phát hiện giới hạn chỉ sau lần điều phối cuối.

**Checkpoint nén ngữ cảnh.** Khi gần giới hạn ngữ cảnh, phần hội thoại cũ được
thay bằng một checkpoint bàn giao có cấu trúc, dưới dạng message vai user. Xem
[Memory](/vi/05-memory/).

Cả hai đều được ghi vào lịch sử dưới dạng mục vòng đời, nên `history.entries()`
cho thấy chính xác model đã được nói gì và vào lúc nào.

## Đọc tiếp

- [Agent Context](/vi/02-agents/agent-context) — mọi thứ khác tới được model
- [Workflows](/vi/06-workflows/) — `mode` hàm ý gì cho việc điều phối
