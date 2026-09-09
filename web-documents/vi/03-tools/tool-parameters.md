# Tool Parameters

## Schema mà model nhìn thấy

`parameters` là JSON Schema thuần. Nó được gửi tới nhà cung cấp nguyên văn và là
mô tả duy nhất mà model có về hình dạng tham số của bạn.

```ts
parameters: {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Full-text search query.' },
    limit: { type: 'number', description: 'Max rows. Defaults to 20.' },
    mode: { type: 'string', enum: ['read', 'write'] },
  },
  required: ['query'],
}
```

Quy tắc thực dụng:

- **Mô tả mọi thuộc tính.** Một `{ type: 'string' }` trơ không nói gì cho model
  về đơn vị, định dạng, hay phạm vi.
- **Dùng `enum` cho tập đóng.** Nó loại bỏ cả một lớp lời gọi sai.
- **Đánh dấu `required` một cách trung thực.** Tuỳ chọn-có-mặc-định rõ ràng hơn
  bắt-buộc-rồi-bỏ-qua.
- **Giữ cho nông.** Đối tượng lồng sâu mời gọi lời gọi sai định dạng; hãy ưu tiên
  nhiều tool phẳng hơn một tool đa hình.
- **Schema tốn ngữ cảnh.** Schema tool được đo như một phần của mọi yêu cầu. Một
  danh mục lớn là chi phí đầu vào thật.

## `parse` là ranh giới tin cậy

```ts
parse?: (raw: unknown) => Args
```

`parse` kiểm tra và thu hẹp tham số thô **trước khi `execute` nhìn thấy**. Hook
này tồn tại để SDK không cần thư viện schema riêng — bạn cắm thứ mình đang dùng.

```ts
import { z } from 'zod'
const Args = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(100) })

parse: raw => Args.parse(raw),
```

```ts
import * as v from 'valibot'
const Args = v.object({ query: v.pipe(v.string(), v.minLength(1)) })

parse: raw => v.parse(Args, raw),
```

```ts
// Tự viết, không phụ thuộc thư viện
parse: raw => {
  const o = raw as Record<string, unknown>
  if (typeof o.query !== 'string' || o.query.length === 0) throw new TypeError('query required')
  return { query: o.query, limit: typeof o.limit === 'number' ? o.limit : 20 }
},
```

## Ném lỗi trong `parse` là một tính năng

Một cú ném sinh ra **kết quả tool `INVALID_ARGUMENTS`** mà model thấy được và có
thể tự sửa ở bước sau. Đó không phải một cú sập, và nó không kết thúc lượt.

Đó là lý do `parse` tốt hơn việc kiểm tra bên trong `execute`: thất bại được định
hình thành phản hồi mà model sửa được, chứ không thành lỗi ứng dụng.

Hãy viết thông điệp hành động được — model sẽ đọc nó:

```ts
parse: raw => {
  const parsed = Args.safeParse(raw)
  if (!parsed.success) {
    throw new TypeError(`limit must be 1–100; got ${(raw as any)?.limit}`)
  }
  return parsed.data
},
```

## Khi bỏ `parse`

```ts
// execute nhận JSON đã giải mã CHƯA KIỂM TRA, gán kiểu Args theo niềm tin.
execute: (args: { a: number; b: number }) => ({ product: args.a * args.b })
```

Chỉ chấp nhận được khi thân hàm tự kiểm tra đầu vào, hoặc khi kiểu sai là vô
hại. Bất cứ thứ gì chạm tới hệ tệp, cơ sở dữ liệu, shell, hay một lời gọi mạng
đều nên kiểm tra.

## Schema và phần kiểm tra phải khớp nhau

JSON Schema định hình những gì model *cố gửi*; `parse` quyết định những gì *được
chấp nhận*. Sự lệch nhau giữa chúng hiện ra thành các vòng lặp
`INVALID_ARGUMENTS` đáng ra tránh được.

```ts
// Schema nói limit là tuỳ chọn; parse lại bắt buộc → model bị từ chối vì một
// lời gọi mà chính schema đã bảo nó là hợp lệ.
parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
parse: raw => z.object({ limit: z.number() }).parse(raw),   // ✗ lệch
```

Nếu bạn sinh JSON Schema từ chính bộ kiểm tra của mình, cả lớp lỗi này biến mất.

## Lời gọi sai lặp lại đều có chặn trên

Phát hiện lặp y hệt cảnh báo ở `repeatToolWarningAt` và dừng ở `repeatToolLimit`;
lỗi liên tiếp bị cắt bởi `maxConsecutiveToolErrors`. Nên một model không thoả mãn
được schema của bạn sẽ thất bại ồn ào, thay vì lặp cho tới khi cạn trần token.

Nếu bạn thấy điều đó xảy ra, thường schema hoặc description mới là khiếm khuyết.

## Đọc tiếp

- [Error Handling](/vi/03-tools/error-handling) — hình dạng kết quả đầy đủ
- [Structured Output](/vi/02-agents/structured-output) — `parse` như một hợp đồng đầu ra
