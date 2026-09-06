# Tool Error Handling

Tool thất bại **không phải** một ngoại lệ của ứng dụng. Nó trở thành một kết quả
mà model thấy được và có thể phản ứng.

## Hai hình dạng kết quả

```ts
type ToolExecutionResult = ToolSuccess | ToolFailure
```

| Trường | `ToolSuccess` | `ToolFailure` |
| --- | --- | --- |
| `isError` | `false` | `true` |
| `value` | giá trị thô trả về | — |
| `error` | — | `{ message, code }` |
| `content` | phần model đọc | mô tả thất bại, diễn đạt cho model |
| `meta` | metadata giao diện | metadata giao diện |
| `additionalContext` | từ `ctx.addContext()` | từ `ctx.addContext()` |
| `concludesTurn` | `true` nếu được yêu cầu | kiểu **`never`** |

## Thất bại không bao giờ kết thúc được lượt

`concludesTurn` có kiểu `never` trên `ToolFailure` **theo thiết kế**. Nếu không,
một tool bị từ chối hoặc bị sập có thể âm thầm dừng công việc mà người dùng đã
yêu cầu — trái ngược với điều một thất bại nên làm.

## Các trạng thái thất bại

Sự kiện `tool-result` của lượt chạy mang một trạng thái:

| Trạng thái | Nguyên nhân | Model thấy |
| --- | --- | --- |
| `completed` | `execute` đã trả về | Giá trị đã kết xuất |
| `failed` | `execute` ném lỗi | Mô tả thất bại, diễn đạt cho model |
| `rejected` | Policy, catalog, tham số hoặc budget từ chối lời gọi | Một lời từ chối để nó phản ứng |
| `aborted` | Lượt chạy bị huỷ trước hoặc trong lúc gọi | Thông báo bị huỷ |

```ts
for await (const event of agent.stream(input)) {
  if (event.type === 'tool-result' && event.status !== 'completed') {
    renderToolFailure(event.callId, event.status, event.output)
  }
}
```

## Lỗi tham số là thứ model sửa được

Ném lỗi bên trong `parse` sinh ra `INVALID_ARGUMENTS`. Model đọc thông điệp của
bạn rồi thử lại với tham số đã sửa.

```ts
parse: raw => {
  const parsed = Args.safeParse(raw)
  if (!parsed.success) throw new TypeError(`limit must be 1–100; got ${(raw as any)?.limit}`)
  return parsed.data
},
```

Hãy viết thông điệp cho **model**, không viết cho log của bạn: nêu rõ ràng buộc
và giá trị đã nhận được.

## Lỗi trong thân hàm

Một cú ném từ `execute` trở thành `ToolFailure`. Phần model đọc là mô tả thất bại
được diễn đạt cho nó — không phải stack trace.

```ts
execute: async ({ path }, ctx) => {
  const resolved = resolveInsideProject(path)
  if (resolved === null) {
    // Thất bại có chủ ý, hành động được.
    throw new Error(`path must stay inside the project; got ${path}`)
  }
  return { text: await readFile(resolved, { encoding: 'utf8', signal: ctx.signal }) }
}
```

Hai thứ phải giữ ngoài thông điệp lỗi: thông tin xác thực và văn bản lỗi thô từ
thượng nguồn. Hãy làm sạch trước khi ném — thông điệp đó tới model và tới bản ghi
hội thoại của bạn.

## Phân biệt "dự kiến" với "hỏng"

Không phải mọi nhánh không như ý đều đáng ném lỗi. Một tool trả về "không tìm
thấy" dưới dạng có kiểu cho model nhiều thứ để làm việc hơn là một lỗi:

```ts
// Tốt hơn: model có thể phân nhánh theo cái này.
execute: async ({ id }) => {
  const row = await db.find(id)
  return row === null ? { found: false } : { found: true, row }
}
```

Hãy dành việc ném lỗi cho **vi phạm hợp đồng** — tham số không hợp lệ, phạm vi bị
từ chối, phụ thuộc không với tới được — và dùng giá trị trả về cho **kết quả
nghiệp vụ**.

## Các chặn trên chặn vòng lặp thất bại

| Chặn trên | Hành vi |
| --- | --- |
| `maxConsecutiveToolErrors` | Cắt sau N lỗi liên tiếp |
| `repeatToolWarningAt` / `repeatToolLimit` | Cảnh báo, rồi dừng khi lặp y hệt |
| `toolCycleWarningAt` / `toolCycleLimit` / `maxToolCycleLength` | Phát hiện chu trình đa bước ngắn |
| `maxToolCalls` | 64 tool được điều phối mỗi lượt chạy |

Nên một model không thoả mãn được tool của bạn sẽ thất bại ồn ào, thay vì lặp cho
tới khi cạn trần token. Khi bạn chạm các mức này, thường schema hoặc description
mới là khiếm khuyết thật.

## Timeout và tháo dỡ

Một tool khai báo `timeoutMs` là đang cam kết rằng nó chuyển tiếp `ctx.signal`.
Khi hết giờ, đường ống abort tín hiệu rồi **chờ** tối đa
`toolTeardownTimeoutMs`.

Nếu tool phớt lờ tín hiệu huỷ, bạn nhận `MODEL_TEARDOWN_TIMEOUT` và
`unsettledRuns > 0` trong báo cáo đóng của runtime. Hãy coi đó là khiếm khuyết
của tool, không phải lỗi thoáng qua.

## Lỗi của bộ quan sát được kiềm chế

Interceptor, hook, và bộ quan sát `onEvent` bị chặn bởi `observerTimeoutMs`, và
lỗi của chúng **không bao giờ làm đổi hành vi của lượt chạy**. Bộ quan sát `onIo`
của một skill provider cũng vậy. Việc đo đạc không thể làm vỡ việc thực thi.

## Những gì tới log của bạn

Lỗi được ghi thành các mục `SafeErrorRecord` có tương quan và đã làm sạch, trên
báo cáo của lượt chạy:

```ts
const response = await agent.generate(input)
for (const error of response.report.errors) {
  console.error(error.code, error.message)   // không thông tin xác thực, không văn bản thô của nhà cung cấp
}
```

`SupportSafeError` là phép chiếu nên dùng cho phiếu hỗ trợ và việc lan truyền
giữa các dịch vụ.

## Đọc tiếp

- [Permissions](/vi/03-tools/permissions) — đường đi của `rejected`
- [Advanced Error Handling](/vi/10-advanced/error-handling) — hệ phân loại toàn SDK
