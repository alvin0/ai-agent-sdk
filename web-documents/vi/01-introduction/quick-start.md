# Quick Start

Trang này dựng một agent chạy được với một tool, rồi cho thấy cũng agent đó dưới
dạng định nghĩa tái dùng.

## 1. Ghép một runtime

`createAgentRuntime()` là gốc ghép nối được khuyến nghị. Nó sở hữu việc đăng ký
provider, observability, và vòng đời.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})
```

## 2. Định nghĩa một tool

Tool là giá trị có kiểu thông thường. Không có registry thứ hai theo chuỗi id để
phải giữ đồng bộ.

```ts
import { defineTool } from '@alvin0/ai-agent-sdk-core'

const multiply = defineTool({
  name: 'multiply',
  description: 'Multiply two numbers.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  parse: value => value as { a: number; b: number },
  execute: ({ a, b }) => ({ product: a * b }),
})
```

`parse` là ranh giới giữa output không đáng tin của model và mã có kiểu của bạn.
Nó chạy trước `execute`, và khi nó thất bại thì lỗi được báo về model như một lỗi
tool, không phải một cú sập chương trình.

## 3. Gắn và chạy agent

```ts
const agent = runtime.agent({
  id: 'calculator',
  name: 'Calculator',
  instructions: 'Use the available tools and explain the result briefly.',
  model: { provider: 'openai', id: 'gpt-5.4' },
  tools: [multiply],
})

const response = await agent.generate('21 * 2 bằng bao nhiêu?')
console.log(response.text)
console.log(response.usage)
```

## 4. Duy trì hội thoại

`generate()` không giữ trạng thái. Với chat, hãy tạo một session — nó sở hữu lịch
sử và ngăn hai lượt chạy chồng nhau trên cùng một hội thoại.

```ts
const session = agent.createSession()

await session.run('21 * 2 bằng bao nhiêu?')
await session.run('Giờ nhân kết quả đó với 10.')   // nhớ lượt trước

console.log(session.conversationId)
```

## 5. Đóng runtime

```ts
const report = await runtime.close()
console.log(report.state, report.activeRunsAtClose, report.unsettledRuns)
```

`close()` làm lắng các lượt chạy đang hoạt động, đóng các thành phần nó sở hữu,
và trả về bằng chứng có cấu trúc. Đây không phải thủ tục hình thức — báo cáo có
`unsettledRuns > 0` nghĩa là có thứ gì đó đã phớt lờ tín hiệu huỷ.

## Kiểu định nghĩa tái dùng

`defineAgent()` chốt danh tính và chính sách một lần ở phạm vi module, rồi sinh
session cho từng hội thoại. Dùng cách này khi cùng một agent phục vụ nhiều yêu cầu.

```ts
import { defineAgent } from '@alvin0/ai-agent-sdk-core'

export const calculator = defineAgent({
  id: 'calculator',
  name: 'Calculator',
  instructions: 'Use the available tools and explain the result briefly.',
  provider: 'openai',
  model: 'gpt-5.4',
  tools: [multiply],
})

const session = calculator.createSession({ registry })
const response = await session.run('21 * 2 bằng bao nhiêu?')
```

Một định nghĩa được kiểm tra, chuẩn hoá, rồi đóng băng. Nó an toàn để export từ
module và tái dùng qua nhiều yêu cầu. Định nghĩa không bao giờ bị thay đổi tại
chỗ — dùng `.with()` để tạo biến thể cục bộ, hoặc `cloneAgent()` khi agent dẫn
xuất cần một danh tính ổn định mới.

Bỏ trống `provider`, `model`, và `effort` trong một định nghĩa sẽ chọn Codex
`gpt-5.6-luna` ở mức nỗ lực `medium`.

## Tệp hoàn chỉnh chạy được

```ts
import { createAgentRuntime, defineTool } from '@alvin0/ai-agent-sdk-core'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const multiply = defineTool({
  name: 'multiply',
  description: 'Multiply two numbers.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  parse: value => value as { a: number; b: number },
  execute: ({ a, b }) => ({ product: a * b }),
})

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})

try {
  const agent = runtime.agent({
    id: 'calculator',
    instructions: 'Use the available tools and explain the result briefly.',
    model: { provider: 'openai', id: 'gpt-5.4' },
    tools: [multiply],
  })

  const session = agent.createSession()
  console.log((await session.run('21 * 2 bằng bao nhiêu?')).text)
  console.log((await session.run('Giờ nhân kết quả đó với 10.')).text)
} finally {
  await runtime.close()
}
```

## Đọc tiếp

- [Stream một lời gọi model](/vi/02-agents/streaming)
- [Runtime, agent, session](/vi/02-agents/creating-an-agent)
- [Tool](/vi/03-tools/)
