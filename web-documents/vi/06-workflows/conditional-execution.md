# Conditional Execution

Bốn chỗ để đặt một nhánh. Hai chỗ đầu là bảo đảm; hai chỗ cuối là prompt.

## 1. `beforeStep` — chặn cổng bước model kế tiếp

Hook `TurnHooks.beforeStep` chạy trước mỗi bước model và trả về một quyết định.
Đây là nguyên thuỷ thực thi-có-điều-kiện thật sự của SDK.

```ts
type StepDecision =
  | { kind: 'proceed'; prepend?: readonly Message[] }
  | { kind: 'reject'; reason: string }
```

```ts
const session = agent.createSession({
  hooks: {
    beforeStep: async ctx => {
      if (await budget.exhausted(ctx)) {
        return { kind: 'reject', reason: 'cost budget exhausted for this tenant' }
      }

      if (ctx.step === 1) {
        return {
          kind: 'proceed',
          prepend: [createTextMessage(`Current deploy state: ${await deployState()}`)],
        }
      }

      return { kind: 'proceed' }
    },
  },
})
```

| Trả về | Tác dụng |
| --- | --- |
| `{ kind: 'proceed' }` | Bước chạy bình thường |
| `{ kind: 'proceed', prepend }` | Message được thêm vào đầu **riêng yêu cầu đó** |
| `{ kind: 'reject', reason }` | Bước không chạy; lý do được ghi lại |

`prepend` là cách bạn tiêm trạng thái phải **mới tại đúng bước này**, thay vì thứ
đã đúng vào lúc lượt bắt đầu. `reject` là cách bạn dừng công việc theo một điều
kiện mà model không có thẩm quyền đánh giá — quota, quyền lợi, một cửa sổ bảo trì.

Việc gọi hook được quan sát dưới tên `sdk.hook.call`, chỉ mang loại hook đã đóng
và lỗi đã làm sạch, và bị chặn bởi giới hạn thời gian riêng của chúng.

## 2. `onRequestError` — phục hồi có điều kiện

```ts
hooks: {
  onRequestError: ctx => {
    if (ctx.failure.code === 'RATE_LIMIT' && ctx.step < 3) return 'retry'
    return 'fail'
  },
}
```

Hook này quyết cách phục hồi khi một **yêu cầu model** thất bại, dựa trên
`ModelFailure` có kiểu. Nó ghép với decorator thử lại: `withRetry` xử lý các thất
bại thoáng qua ở tầng truyền tải trước chunk đầu tiên, còn hook này xử lý chính
sách ở tầng trên đó.

## 3. Mã của bạn phân nhánh giữa các lượt chạy

Điều kiện rõ ràng nhất là một câu `if`.

```ts
const triage = await triager.generate(incident)
const severity = classify(triage.text)

if (severity === 'sev1') {
  await pager.generate(`Page the on-call: ${triage.text}`)
  const plan = await responder.generate(triage.text)
  return plan.text
}

const ticket = await ticketer.generate(triage.text)
return ticket.text
```

Muốn điều kiện phân nhánh có kiểu và đáng tin, hãy để agent nộp một kết quả có
cấu trúc thay vì phân tích văn xuôi của nó — xem
[Structured Output](/vi/02-agents/structured-output).

```ts
const sink: { value?: Triage } = {}
await triager.createSession({ tools: [submitTriage(sink)] }).run(incident)

switch (sink.value?.severity) {
  case 'sev1': /* … */ break
  case 'sev2': /* … */ break
  default: throw new Error('triage did not submit a verdict')
}
```

## 4. Thu hẹp những gì model được chọn

Điều kiện rẻ nhất là loại bỏ hẳn lựa chọn đó.

```ts
// Năng lực theo từng yêu cầu
const session = agent.createSession({
  tools: currentUser.canDeploy ? [plan, deploy] : [plan],
})

// Bắt buộc, cho phép, hoặc cấm dùng tool với agent này
runtime.agent({ /* … */, toolChoice: 'auto' })

// Thu hẹp một danh mục từ xa
connectMcpHttp({ serverName: 'billing', url, toolFilter: { allow: ['lookup_invoice'] } })

// Thu hẹp skill
runtime.agent({ /* … */, allowedSkillIds: ['release-review'] })
```

Một tool mà model không bao giờ thấy thì không thể bị gọi sai thời điểm. Hãy ưu
tiên cách này hơn là dặn model đừng dùng một thứ.

## 5. Interceptor — chính sách từ chối mặc định

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

Một cú ném trở thành `ToolFailure` mà model đọc được và có thể phản ứng. Dùng
interceptor cho điều kiện máy quyết được trên **từng lời gọi**, và `beforeStep`
cho điều kiện trên **cả một bước**.

## Những điều kiện SDK đã tự đánh giá

Bạn không cần tự dựng những thứ này:

| Điều kiện | Cơ chế |
| --- | --- |
| Ngữ cảnh sắp tràn | Nén tự động ở `thresholdRatio` |
| Nhà cung cấp xác nhận đã tràn | Một lần nén-rồi-thử-lại (`maxOverflowRetries`) |
| Model đang lặp lại chính nó | `repeatToolWarningAt` → cảnh báo, `repeatToolLimit` → dừng |
| Model đang lặp một chu trình ngắn | `toolCycleWarningAt` / `toolCycleLimit` |
| Tool liên tục thất bại | Ngưỡng cắt `maxConsecutiveToolErrors` |
| Ngân sách tool gần cạn | Một cảnh báo do app soạn ở mốc 75% `maxToolCalls` |
| Một lựa chọn model/effort/native-tool bất khả thi | Bị chặn trước khi có I/O tới nhà cung cấp |

## Chọn chỗ đặt điều kiện

```text
Về quyền lợi, quota, hay cửa sổ bảo trì?            → beforeStep reject
Cần trạng thái phải mới tại đúng bước này?          → beforeStep prepend
Là quy tắc máy về một lời gọi cụ thể?               → interceptor
Là nhánh giữa các lượt chạy hoàn chỉnh?             → mã của bạn + structured output
Là "model không nên có lựa chọn này"?               → thu hẹp tool / skill / toolChoice
Cần một con người quyết định?                       → broker phê duyệt hoặc deep-human-in-loop
Là quyết định phục hồi giữa lượt khi nhà cung cấp lỗi? → onRequestError
```

## Đừng dựa vào điều gì

Nêu một điều kiện chỉ trong `instructions` là một **prompt**, không phải bảo đảm.
Nó ổn cho hướng dẫn ("đọc trước khi sửa") và không phù hợp cho chính sách ("không
bao giờ deploy vào thứ Sáu"). Chính sách thuộc về một hook, một interceptor, hoặc
một tập tool đã thu hẹp — nơi nó giữ đúng bất kể model quyết định gì.

## Đọc tiếp

- [Human Approval](/vi/06-workflows/human-approval)
- [Lifecycle](/vi/02-agents/lifecycle) — toàn bộ bề mặt hook
- [Structured Output](/vi/02-agents/structured-output) — điều kiện phân nhánh có kiểu
