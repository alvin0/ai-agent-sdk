# Creating a Tool

## Một tool hoàn chỉnh

```ts
import { defineTool } from '@ai-agent-sdk/core'
import { z } from 'zod'

const Args = z.object({ path: z.string().min(1) })

const readProjectFile = defineTool({
  name: 'read_project_file',
  description: 'Read a UTF-8 text file inside the project.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Project-relative path.' } },
    required: ['path'],
  },

  parse: raw => Args.parse(raw),

  execute: async ({ path }, ctx) => {
    ctx.logger?.info('reading file', { path })
    const text = await readFile(resolveInsideProject(path), {
      encoding: 'utf8',
      signal: ctx.signal,
    })
    return { path, bytes: Buffer.byteLength(text), text }
  },

  render: value => [{ type: 'text', text: value.text }],
  meta: value => ({ bytes: value.bytes }),

  timeoutMs: 30_000,
  isConcurrencySafe: () => true,
})
```

## Phân công công việc

```text
JSON thô từ model
      │
      ▼  parse()          không đáng tin → có kiểu. Ném lỗi = INVALID_ARGUMENTS, model tự sửa.
   Args
      │
      ▼  execute()        làm việc. Trả về JSON không mất mát, hoặc không trả gì.
 JsonValue
      ├──▶ render()       → ContentBlock[]   phần MODEL đọc
      └──▶ meta()         → JsonObject      phần giao diện của bạn đọc (model không thấy)
```

Ba bên tiêu thụ, ba hình dạng, từ một lời gọi. Đó là lý do giá trị thô đáng giữ:
nó là thứ bạn ghi log, phát lại, và kiểm tra trong test.

## `name` và `description` là prompt engineering

Cả hai đi vào schema tool mà model nhìn thấy. Chúng là thứ duy nhất cho model
biết *khi nào* nên gọi tool của bạn.

```ts
// Yếu: model không biết khi nào áp dụng.
description: 'Gets data.'

// Mạnh: nêu rõ mục đích, phạm vi, và thứ tự.
description: 'Read a UTF-8 text file inside the project. Use before editing a file.'
```

Tên phải ổn định — chúng xuất hiện trong lịch sử, vết, hộp thoại phê duyệt, và
snapshot. Đổi tên một tool không làm vỡ gì lúc chạy nhưng khiến bản ghi hội thoại
cũ khó đọc hơn.

## `execute` — thân hàm

```ts
execute: async (args, ctx) => { /* … */ }
```

Trả về một giá trị **JSON không mất mát**, hoặc không trả gì. Thứ gì không an
toàn JSON thì không thể lưu kèm kết quả, không phát lại được, và không hiện được
trên giao diện.

`ctx` mang danh tính lời gọi, tín hiệu huỷ, và hai kênh phụ:

```ts
interface ToolRunContext {
  readonly callId: ToolCallId    // id lời gọi do nhà cung cấp cấp
  readonly toolName: string      // để các hàm trợ giúp dùng chung biết ai gọi mình
  readonly turn: number          // số lượt trong hội thoại, đếm từ 1
  readonly step: number          // số bước trong lượt, đếm từ 1
  readonly signal: AbortSignal   // tín hiệu huỷ cho lời gọi này
  readonly logger?: SdkLogger    // luôn có trên các đường chạy AgentRuntime

  concludeTurn(): void
  addContext(content: string | readonly ContentBlock[]): void
}
```

**Luôn chuyển tiếp `ctx.signal`** cho mọi thứ async — `fetch`, `readFile`, driver
cơ sở dữ liệu. Khai báo `timeoutMs` mà không chuyển tiếp tín hiệu là một lời hứa
bị phá: đường ống abort rồi chờ, và một tool bất hợp tác sẽ hiện ra thành
`MODEL_TEARDOWN_TIMEOUT`.

## `render` — phần model đọc

Mặc định: chuỗi được truyền nguyên văn, thứ khác thì in JSON định dạng đẹp. Ghi
đè nó để đưa cho model văn xuôi, hoặc để trả về một ảnh.

```ts
// Văn xuôi thay vì JSON
render: value => [{ type: 'text', text: `Found ${value.count} matches in ${value.file}.` }],

// Kết quả là ảnh
render: value => [{
  type: 'image',
  source: { kind: 'base64', mediaType: 'image/png', data: value.png },
}],
```

Giữ `render` tách riêng là điều cho phép bạn đổi cách diễn đạt hướng model mà
không làm vỡ bất kỳ test nào đang kiểm tra giá trị.

## `meta` — phần chỉ giao diện của bạn đọc

```ts
meta: value => ({ bytes: value.bytes, cached: value.cached }),
```

Phải là JSON không mất mát — nó được lưu kèm kết quả. Model **không bao giờ** thấy
nó. Dùng cho thời gian, cờ cache, số dòng, và mọi thứ khác mà giao diện của bạn
muốn hiện bên cạnh nút tool.

## `concludeTurn()` — một tool mà chính nó là câu trả lời

```ts
execute: (args, ctx) => {
  saveResult(args)
  ctx.concludeTurn()
  return { accepted: true }
}
```

Kết thúc lượt **sau khi lô lời gọi tool hiện tại đã commit**, nên công việc của
một lời gọi song song không bao giờ bị vứt bỏ. Dùng khi nộp kết quả cuối cùng hoặc
bàn giao cho con người. Xem
[Structured Output](/vi/02-agents/structured-output).

## `addContext()` — nói với model điều nó không hỏi

```ts
execute: async (args, ctx) => {
  const result = await run(args, ctx.signal)
  if (result.staleRead) {
    ctx.addContext('The file changed since your last read; re-read before editing.')
  }
  return result
}
```

Các block đó trở thành một message user ở yêu cầu **kế tiếp**, và xuất hiện trong
kết quả dưới trường `additionalContext` nên vẫn kiểm toán được.

## Tool được khai báo ở đâu

```ts
// Trên agent — mọi session đều dùng được
runtime.agent({ id: 'a', model, instructions: '…', tools: [readProjectFile] })

// Trên một session — gộp với tool do định nghĩa sở hữu
agent.createSession({ tools: [requestScopedTool] })
```

Tool ở mức session được **gộp**, không thay thế. Nhờ vậy một định nghĩa agent dùng
chung có thêm được năng lực theo từng yêu cầu.

## Ergonomics không cần marker

`defineTool` nắm bắt schema và phương thức theo kiểu tách rời được: nó **không**
sửa đối tượng bạn truyền vào, và nó không thể chuyển hướng việc thực thi sau khi
đã gắn. Một phương thức lấy ra khỏi đối tượng vẫn giữ receiver gốc, nên
`execute: service.lookup` vẫn có `this` và trạng thái vận hành sống của nó.

## Đọc tiếp

- [Tool Parameters](/vi/03-tools/tool-parameters) — thiết kế schema và `parse`
- [Tool Execution](/vi/03-tools/tool-execution) — lập lịch và đồng thời
- [Tham chiếu API `Tool`](/vi/13-api-reference/tool)
