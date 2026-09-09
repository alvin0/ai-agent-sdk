# Human Approval

Có hai ranh giới tách bạch cần con người: **phê duyệt** chặn một lời gọi tool,
còn **đầu vào người dùng** dừng model lại ở một quyết định quan trọng.

## Phê duyệt — chặn một lời gọi tool

```ts
import { createApprovalBroker } from '@alvin0/ai-agent-sdk-core'

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
được và có thể phản ứng — nó không âm thầm kết thúc lượt, vì `concludesTurn` có
kiểu `never` khi thất bại.

Với harness không giám sát và test, `fixedApprovalBroker(decision)` trả lời mọi
yêu cầu y hệt nhau.

## Đầu vào người dùng — dừng ở một quyết định

Chế độ `deep-human-in-loop` cho model một tool chặn tên `request_user_input`.

```ts
import { createUserInputBroker } from '@alvin0/ai-agent-sdk-core'

const userInput = createUserInputBroker()

const session = planner.createSession({ registry, userInput })
// Broker là BẮT BUỘC cho chế độ này; thiếu nó sẽ thất bại ngay lúc tạo session,
// không phải giữa chừng một lượt chạy.
```

Có hai hình dạng tích hợp.

**Theo sự kiện, bên trong vòng lặp chạy:**

```ts
for await (const event of session.stream('Lập kế hoạch di trú.')) {
  if (event.type === 'user-input-request') {
    const response = await askInGui(event.request)
    userInput.resolve(event.request.requestId, response)
  }
  if (event.type === 'user-input-response') {
    renderAnswer(event.requestId, event.response)
  }
}
```

**Theo callback, bên ngoài vòng lặp chạy:**

```ts
userInput.onRequest(async request => {
  userInput.resolve(request.requestId, await askInGui(request))
})

const result = await session.run('Lập kế hoạch di trú.')
```

Dạng callback là thứ bạn cần khi giao diện trả lời không nằm cùng đoạn mã tiêu
thụ luồng sự kiện — ví dụ một handler HTTP trả lời từ một socket khác.

## Tiếp tục theo đúng call id

Tiếp tục theo đúng call id do nhà cung cấp cấp. Câu trả lời có thể chọn một
phương án gợi ý **hoặc** chứa phản hồi tự do:

```ts
if (event.type === 'user-input-request') {
  // event.request mang 2-3 phương án gợi ý và luôn cho phép văn bản tự do.
  const response = await askInGui(event.request)
  userInput.resolve(event.request.requestId, response)
}
```

Hình dạng yêu cầu:

```ts
interface UserInputRequest {
  requestId: string
  question: UserInputQuestion
  options?: readonly UserInputOption[]   // 2-3 gợi ý
  // câu trả lời tự do luôn được chấp nhận
}
```

## An toàn cho web ngay từ thiết kế

Chính sách phê duyệt và đầu vào người dùng là Universal — không phụ thuộc Node,
không dùng biến toàn cục của tiến trình, không dùng `AsyncLocalStorage`. Cùng một
broker chạy được trong Edge worker, trình duyệt, và CLI trên Node.

Việc chờ có thể quan sát được: `sdk.user.input.wait` ghi start/end kèm lý do và
trạng thái kết thúc, và **không bao giờ ghi nội dung câu trả lời**.

## Broker tương tác

`createApprovalBroker()` và `createUserInputBroker()` trả về
`InteractiveApprovalBroker` / `InteractiveUserInputBroker`. Cả hai nhận tuỳ chọn
về chặn trên hàng đợi và hành vi mặc định, và cả hai phơi ra
`resolve(requestId, …)` cùng một đăng ký `onRequest`.

Các biến thể cố định — `fixedApprovalBroker()`, `fixedUserInputBroker()` — dành
cho test, benchmark, và các lượt nghiệm thu không giám sát, nơi không có con
người thật nhưng đường mã vẫn phải được chạy qua.

## Đọc tiếp

- [Permissions](/vi/03-tools/permissions) — chặn một lời gọi tool đơn lẻ
- [Conditional Execution](/vi/06-workflows/conditional-execution) — cổng do máy quyết
- [Security](/vi/10-advanced/security) — phần nào vẫn là chính sách của host
