# Persistent Memory

Session cố ý giữ trạng thái. Tạo một session cho mỗi cuộc chat, luồng người dùng,
hoặc công việc.

## Danh tính hội thoại

```ts
const session = agent.createSession({ conversationId: 'thread-42' })
```

`createSession({ conversationId })` nhận id do ứng dụng sở hữu; nếu không, hệ
thống sinh ra một id. Id này được giữ qua các snapshot và phát ra dưới dạng
`gen_ai.conversation.id` trên span gốc.

`session.reset()` cố ý bắt đầu một conversation id **mới** và xoá trạng thái kích
hoạt skill trong phạm vi hội thoại, đồng thời giữ nguyên agent, provider, và tool.

```ts
const chat = agent.createSession()

await chat.run('Dự án của tôi dùng SQLite.')
await chat.run('Tôi vừa nhắc tới cơ sở dữ liệu nào?')   // thấy lượt trước

chat.reset()   // cùng agent/provider/tool, hội thoại mới
```

## Lưu và mở lại

Lưu và mở lại một hội thoại qua API snapshot ở mức session. Bạn không cần import
hay khôi phục `History` và `AgentMemory` riêng lẻ.

```ts
const chat = agent.createSession()
await chat.run('Review this API shape.')

await conversationStore.save(chat.conversationId, chat.snapshot())

// Sau này, có thể ở một tiến trình khác:
const snapshot = await conversationStore.load(conversationId)
const resumed = agent.resumeSession(snapshot)
await resumed.run('Giờ đề xuất một lộ trình di trú.')
```

Với kiểu `defineAgent()` thì hình dạng cũng vậy:

```ts
const resumed = ada.resumeSession({ registry, snapshot })
```

## Snapshot chứa gì

Snapshot **an toàn JSON** và bao gồm:

- phiên bản schema của nó;
- `conversationId`;
- danh tính agent;
- lịch sử chỉ-thêm;
- bộ nhớ bền vững;
- **danh tính** của các skill đã kích hoạt.

## Snapshot cố ý loại trừ gì

**Phần thân và tài nguyên của skill không bao giờ được lưu.** Khi khôi phục, hệ
thống khám phá lại và nạp lại từ các provider hiện tại, và thất bại **trước** khi
gửi yêu cầu model nếu provider, nguồn, hoặc vị trí tài nguyên đã trôi lệch.

Số lượng kích hoạt được khôi phục và kích thước chuỗi danh tính/vị trí bị chặn
bởi chính sách skill của định nghĩa, còn các trường lạ trong snapshot bị loại bỏ.

## Quy tắc khôi phục

| Tình huống | Hành vi |
| --- | --- |
| Snapshot v1 cũ không có trạng thái skill | Hợp lệ — được chấp nhận. |
| Id agent khác | Thất bại sớm. |
| Provider/nguồn/vị trí skill đã trôi lệch | Thất bại trước khi gửi yêu cầu model. |
| Có trường lạ | Bị loại bỏ. |

Session được khôi phục dùng **định nghĩa agent hiện tại trong mã nguồn** và các
phụ thuộc runtime được cấp mới — registry, tool, phê duyệt, broker giao diện.
Snapshot khôi phục trạng thái hội thoại, không khôi phục mã.

## History và memory ở tầng thấp

Người gọi ở mức nâng cao vẫn có thể truyền một đối tượng `History` hoặc memory sẵn
có vào `createSession()`. Các tool ở mức ứng dụng cấp lúc tạo session được **gộp**
với tool do định nghĩa sở hữu.

Ứng dụng nào cố ý quản lý hai kho này độc lập có thể dùng
`History.fromSnapshot()` và `AgentMemory.fromSnapshot()`. Phần lớn ứng dụng không
nên — snapshot ở mức session tồn tại chính để bạn khỏi phải giữ hai kho đồng bộ.

## Đồng thời

Một session ngăn hai lượt chạy chồng nhau trên cùng hội thoại.
`session.compact()` chiếm cùng khoá loại trừ theo session như một lượt model, nên
việc nén và thực thi bình thường không thể cùng lúc ghi đè một lịch sử.

```ts
session.isRunning              // boolean
await session.whenIdle(signal) // chờ lượt chạy hiện tại lắng xuống
```

Việc huỷ theo từng lượt chạy đi qua `{ signal }`:

```ts
await session.run('Tác vụ dài…', { signal: abortController.signal })
```

## Đọc tiếp

- [Custom Memory Provider](/vi/05-memory/custom-memory-provider) — `defineMemoryStore()`
- [Skill Lifecycle](/vi/04-skills/skill-lifecycle) — vì sao phần thân skill không được lưu
