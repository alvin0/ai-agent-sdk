# Agent Context

"Ngữ cảnh" ở đây nghĩa là **chính xác những gì tới được model trong một yêu cầu**.
SDK lắp nó từ năm nguồn, và mỗi nguồn đều được đo trước khi gửi đi.

## Một yêu cầu chứa gì

```text
┌─ system prompt ──────────────────────────────────────────┐
│  instructions              (thẩm quyền lập trình viên)   │
│  + hợp đồng của mode       (quy tắc cấu trúc deep / HIL) │
│  + metadata danh mục skill (chỉ id, tên, mô tả)          │
└──────────────────────────────────────────────────────────┘
┌─ messages ───────────────────────────────────────────────┐
│  khối <task-memory>        (ngữ cảnh user do app soạn)   │
│  phép chiếu lịch sử        (history.messages())          │
│    · các lượt gần đây, nguyên văn                        │
│    · checkpoint nén thay cho các khoảng cũ               │
│  additionalInstructions    (chỉ lượt chạy này)           │
└──────────────────────────────────────────────────────────┘
┌─ tools ──────────────────────────────────────────────────┐
│  schema tool của host + tool skill được sinh ra          │
│  schema native tool       (nhà cung cấp thực thi)        │
└──────────────────────────────────────────────────────────┘
```

Mọi thứ khác — phần thân skill, tệp tài nguyên, giá trị kết quả tool giữ cho
giao diện của bạn — đều nằm ngoài ngữ cảnh cho tới khi có thứ gì đó chủ động đặt
nó vào.

## Lịch sử có hai khung nhìn

```ts
history.entries()    // bản ghi bền cho người đọc: mọi message + bản ghi vòng đời
history.messages()   // phép chiếu hiện tại mà model nhìn thấy
```

`entries()` là chỉ-thêm và **không bao giờ bị xoá**, kể cả các lần nén thất bại.
`messages()` là những gì model thấy lúc này — các khoảng cũ có thể đã bị một
checkpoint che đi.

Chính cách chia đó cho phép bạn kiểm toán đúng những gì model đã được nói, mà vẫn
nén ngữ cảnh mạnh tay.

## Thêm ngữ cảnh mà không tạo lượt model

```ts
const seq = session.inject('The candidate commit is abc123.')
```

`inject()` ghi thêm một message vai user có quy kết và trả về số thứ tự của nó.
Không có yêu cầu model nào xảy ra. Dùng khi ứng dụng của bạn biết được điều gì mà
model sẽ cần ở lượt sau.

Trong một team, `team.sendMessage({ delivery: 'quiet' })` làm đúng việc đó nhưng
xuyên session — ngữ cảnh cục bộ bền vững mà không đánh thức một agent đang rảnh.

## Thêm ngữ cảnh từ bên trong một tool

```ts
execute: async (args, ctx) => {
  if (fileChangedUnderneath) {
    ctx.addContext('The file changed since you last read it; re-read before editing.')
  }
  return result
}
```

Các block đó trở thành một message user mà model thấy ở yêu cầu **kế tiếp**. Dùng
cho thông tin model cần nhưng không hỏi — nhắc rằng nó đang lặp lại chính mình,
cảnh báo rằng trạng thái đã đổi.

Nó xuất hiện trong kết quả dưới trường `additionalContext`, nên có thể kiểm toán
chứ không vô hình.

## Ngữ cảnh tính lại: section

**Context section** là một callback mà vòng lặp chạy lại trước mỗi vòng gọi
model. Nó sở hữu một node trên bề mặt model và chỉ thay node đó khi `revision`
đổi — nên ngữ cảnh không đổi thì không tốn gì.

```ts
const branch = defineContextSection({
  id: 'git-branch',
  resolve: () => ({ revision: head.sha, text: `Branch: ${head.ref}` }),
})
```

Dùng nó cho ngữ cảnh luôn bật và **luôn động** — thư mục làm việc, nhánh đang
dùng, các tệp `AGENTS.md` đổi ngay dưới chân agent. Khác `inject()`, nó thu hồi
được; khác `instructions`, nó không ghi lại tiền tố cache của prompt.

Xem [Context Sections](/vi/02-agents/context-sections).

## Bộ nhớ tác vụ là phần được ghim

Message user thật đầu tiên tự động trở thành bộ nhớ `original-objective`, nằm
ngoài phần bản ghi bị nén.

```ts
session.memory.remember({ kind: 'decision', content: 'Use the incremental migration path.' })
session.memory.forget('release-constraint')
console.log(session.memory.items())
```

Việc kết xuất bộ nhớ có chặn trên — tối đa 12.000 ký tự tiêm vào mỗi yêu cầu — và
ưu tiên mục tiêu, ràng buộc, quyết định. Xem [Memory](/vi/05-memory/) để có mô
hình đầy đủ.

## Skill góp metadata, không góp phần thân

Một danh mục skill chỉ góp `id`, tên, mô tả, và ranh giới lựa chọn vào system
prompt, giới hạn bởi `maxCatalogChars` (mặc định 8.000).

Phần thân chỉ vào ngữ cảnh sau khi model gọi `load_skill`; một tài nguyên chỉ sau
`read_skill_resource`. Việc đọc đĩa và vùng nhớ JavaScript tự thân không tiêu
token của model — văn bản chỉ bắt đầu tiêu ngữ cảnh khi được đặt vào system
prompt, một message, hoặc một kết quả tool.

## Ngữ cảnh được đo, không đoán

Trước mỗi bước model thông thường, SDK đo **toàn bộ yêu cầu kế tiếp** — bộ nhớ hệ
thống, message, và schema tool — so với cửa sổ dùng được của model:

```text
cửa sổ đầu vào dùng được = model.contextWindow − phần dự trữ output hiệu dụng
```

Một model có cửa sổ tổng hợp 128k với ngân sách output 32k do đó không bao giờ
được coi là có 128k cho đầu vào.

Nếu phép đo vượt `compaction.thresholdRatio` (mặc định 80%), phần ngữ cảnh cũ sẽ
được checkpoint trước khi yêu cầu được gửi. Nếu adapter không báo cửa sổ ngữ
cảnh, nén theo áp lực tự động là **no-op** trừ khi có cấu hình `maxInputTokens`.

Bộ đo mặc định là bộ ước lượng tất định, thiên về an toàn, tính trên văn bản,
schema tool, trạng thái phát lại, và chi phí ảnh cố định — SDK trung lập không
thể đóng gói mọi tokenizer của nhà cung cấp.

## Đọc tiếp

- [Context Sections](/vi/02-agents/context-sections) — ngữ cảnh tính lại, thu hồi được
- [Memory](/vi/05-memory/) — sự kiện được ghim và việc nén ngữ cảnh
- [Skills](/vi/04-skills/) — tiết lộ dần theo ba pha
- [Performance](/vi/10-advanced/performance) — mọi chặn trên và ngân sách
