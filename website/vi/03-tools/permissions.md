# Permissions

Ranh giới quyền của SDK là **broker phê duyệt**. Nó chặn một lời gọi tool trước
khi `execute` chạy, và một lời từ chối trở thành kết quả mà model có thể phản ứng.

## Chặn một lời gọi

```ts
import { createApprovalBroker } from '@ai-agent-sdk/core'

const approvals = createApprovalBroker()
const session = agent.createSession({ approvals })

for await (const event of session.stream('Xoá các nhánh đã cũ.')) {
  if (event.type === 'approval-request') {
    const decision = await confirmInGui(event.request)
    approvals.resolve(event.request.requestId, decision)
  }
}
```

Lời gọi bị từ chối trở thành `ToolFailure` với `status: 'rejected'`. Model thấy
lời từ chối và có thể phản ứng — nó **không** âm thầm kết thúc lượt, vì
`concludesTurn` có kiểu `never` khi thất bại.

## Trả lời ngoài vòng lặp luồng

Khi giao diện trả lời không phải đoạn mã tiêu thụ sự kiện:

```ts
approvals.onRequest(async request => {
  approvals.resolve(request.requestId, await confirmInGui(request))
})

const result = await session.run('Xoá các nhánh đã cũ.')
```

## Lượt chạy không giám sát

```ts
import { fixedApprovalBroker } from '@ai-agent-sdk/core'

// Test, benchmark, nghiệm thu CI:
const approvals = fixedApprovalBroker({ decision: 'approve' })
```

`fixedApprovalBroker` trả lời mọi yêu cầu y hệt nhau. Nó tồn tại để đường mã phê
duyệt vẫn được chạy qua khi không có con người — không phải để tắt ranh giới đó
trên production.

## Việc chờ là quan sát được

`sdk.tool.call` ghi thời gian chờ phê duyệt và quyết định, còn
`sdk.user.input.wait` ghi các lần chờ chặn kèm lý do và trạng thái kết thúc —
**không bao giờ ghi nội dung câu trả lời**.

Nghĩa là "lượt chạy đứng 40 giây chờ con người" hiện rõ trong telemetry, thay vì
trông giống một model chậm.

## Những gì SDK không làm

SDK **không có mô hình quyền riêng** — không role, scope, ACL, hay chính sách
theo tenant. Đó là có chủ ý: chúng là khái niệm sản phẩm, và SDK giữ tính trung
lập với triển khai.

Thay vào đó bạn nhận được:

| SDK cung cấp | Bạn cung cấp |
| --- | --- |
| Một ranh giới phê duyệt chặn, theo từng lời gọi tool | Ai được phép phê duyệt |
| Danh tính yêu cầu và sự tương quan | Chính sách quyết định |
| Một lời từ chối đã làm sạch để model đọc | Giao diện hoặc quy tắc tự động |
| Interceptor quanh mọi lần điều phối | Role, scope, tenancy |

## Hiện thực chính sách bằng interceptor

Interceptor chạy quanh việc điều phối, nên đó là chỗ tự nhiên cho các quy tắc
từ-chối-mặc-định mà không bao giờ cần tới con người:

```ts
const session = agent.createSession({
  interceptors: [async (call, next) => {
    if (!policy.allows(currentUser, call.name, call.input)) {
      throw new Error(`not permitted: ${call.name}`)
    }
    return next(call)
  }],
})
```

Một cú ném ở đây trở thành `ToolFailure` mà model đọc được. Dùng interceptor cho
chính sách máy quyết được, và dùng broker phê duyệt cho quyết định mà một con
người phải đưa ra.

## Thu hẹp ngay từ những gì tồn tại

Quyền rẻ nhất là một tool mà model không bao giờ thấy:

```ts
// Năng lực theo từng yêu cầu, không phải toàn cục.
const session = agent.createSession({
  tools: currentUser.canWrite ? [readFile, writeFile] : [readFile],
})
```

Điều đó cũng áp dụng cho danh mục từ xa và skill:

```ts
connectMcpHttp({ serverName: 'billing', url, toolFilter: { allow: ['lookup_invoice'] } })

runtime.agent({ /* … */, allowedSkillIds: ['release-review'] })
```

`allowedSkillIds` là **ranh giới uỷ quyền và định tuyến**, không phải danh sách
kích hoạt: danh mục chỉ phơi metadata cho những id đó, và một session khai báo id
không khả dụng sẽ thất bại **trước** khi gửi yêu cầu model, thay vì chạy với một
năng lực khác.

## Tool phá huỷ: ba quy tắc

**Không bao giờ an toàn khi chạy đồng thời.** Trả `false` từ
`isConcurrencySafe` cho bất cứ thứ gì ghi, xoá, hoặc chạy lệnh.

**Luôn chuyển tiếp `ctx.signal`.** Một tool phá huỷ mà phớt lờ tín hiệu huỷ sẽ
tiếp tục sửa trạng thái sau khi lượt chạy đã bị huỷ.

**Làm cho yêu cầu dễ đọc.** Hộp thoại phê duyệt hiện tên tool và đầu vào; một
cái tên mơ hồ với payload mờ đục khiến con người phê duyệt một cách mù quáng.

## Human-in-the-loop là ranh giới riêng

Phê duyệt chặn một **lời gọi tool**. `mode: 'deep-human-in-loop'` dừng model lại
ở một **quyết định quan trọng** thông qua tool chặn `request_user_input`, và đòi
một broker `userInput` ngay khi tạo session.

Xem [Human Approval](/vi/06-workflows/human-approval) cho luồng đó.

## Đọc tiếp

- [Human Approval](/vi/06-workflows/human-approval)
- [Security](/vi/10-advanced/security) — thông tin xác thực, chính sách endpoint, quyền riêng tư
