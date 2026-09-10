# Triển khai lên Edge Worker

Chat streaming trong một runtime dạng Fetch — Cloudflare Workers, Deno Deploy,
Bun, hoặc bất kỳ host nào có `Request`/`Response` và `waitUntil`.

## Cài đặt

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-fetch
```

Ba package. Tất cả đều Universal — không builtin Node nào lọt vào bundle.

## Worker

```ts
import { createAgentRuntime, defineTool } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import {
  fetchObservationExporter,
  flushObservabilityWithWaitUntil,
} from '@alvin0/ai-agent-sdk-observability-fetch'

interface Env {
  OPENAI_API_KEY: string
  TELEMETRY_TOKEN: string
  CONVERSATIONS: KVNamespace
}

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order by id.',
  parameters: {
    type: 'object',
    properties: { orderId: { type: 'string' } },
    required: ['orderId'],
  },
  parse: raw => raw as { orderId: string },
  execute: async ({ orderId }, ctx) => {
    const response = await fetch(`https://api.example.com/orders/${orderId}`, {
      signal: ctx.signal,
    })
    if (!response.ok) throw new Error(`order lookup failed: ${response.status}`)
    return await response.json()
  },
  isConcurrencySafe: () => true,
  timeoutMs: 10_000,
})

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { conversationId, message } = await request.json<{
      conversationId: string
      message: string
    }>()

    // env is only in scope here, so the credential source is built per request.
    const apiKey = defineCredentialSource({
      id: 'openai',
      resolve: () => env.OPENAI_API_KEY,
    })

    const runtime = await createAgentRuntime({
      providers: [openAiPlugin({ apiKey })],
      resource: { serviceName: 'support-worker', environment: 'production' },
      observability: {
        mode: 'operational',
        exporters: [{
          exporter: fetchObservationExporter({
            endpoint: 'https://telemetry.example.com/v1/observations',
            headers: { authorization: `Bearer ${env.TELEMETRY_TOKEN}` },
          }),
          ownership: 'owned',
          requirement: 'best-effort',
          boundary: 'remote-acknowledged',
        }],
      },
    })

    const agent = runtime.agent({
      id: 'support',
      name: 'Support',
      instructions: 'Help the customer. Look up orders before answering about them.',
      model: { provider: 'openai', id: 'gpt-5.4' },
      tools: [lookupOrder],
      commentary: 'concise',
      maxTurns: 8,
    })

    // Mở lại hội thoại từ KV, hoặc bắt đầu hội thoại mới.
    const stored = await env.CONVERSATIONS.get(conversationId, 'json')
    const session = stored === null
      ? agent.createSession({ conversationId })
      : agent.resumeSession(stored as never)

    const handle = session.stream(message)

    const body = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        try {
          for await (const event of handle) {
            controller.enqueue(encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ))
          }
        } finally {
          controller.close()
        }
      },
      cancel() {
        handle.abort('client disconnected')
      },
    })

    // Lưu trữ và flush sau khi phản hồi đã stream xong, không chặn phản hồi.
    ctx.waitUntil((async () => {
      try {
        await handle.result
        await env.CONVERSATIONS.put(conversationId, JSON.stringify(session.snapshot()))
      } finally {
        await runtime.close()
      }
    })())

    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    })
  },
}
```

## Từng mảnh làm gì

| Mảnh | Vì sao |
| --- | --- |
| `defineCredentialSource({ resolve: () => env.OPENAI_API_KEY })` | Thông tin xác thực được tiêm vào — provider không bao giờ tự đọc môi trường. |
| `boundary: 'remote-acknowledged'` | Exporter nêu trung thực mức bền vững mà nó thực sự đạt được. |
| `requirement: 'best-effort'` | Telemetry thất bại không được làm hỏng một yêu cầu của khách hàng. |
| `handle.abort(...)` trong `cancel()` | Client ngắt kết nối thì huỷ lượt chạy, không để rò rỉ. |
| `ctx.waitUntil(...)` | Việc lưu trữ và đóng diễn ra sau phản hồi, không giữ phản hồi lại. |
| `session.snapshot()` / `resumeSession()` | Trạng thái hội thoại nằm trong KV, không nằm trong bộ nhớ worker. |

## Flush telemetry tường minh

Nếu bạn đóng runtime trước khi phản hồi kết thúc, hãy đưa việc flush exporter cho
`waitUntil`:

```ts
flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
```

Package không bao giờ giả định có biến toàn cục của nền tảng — bạn truyền
`waitUntil` vào.

## Ràng buộc cần nhớ

- **Không thứ gì chỉ-chạy-Node được lọt vào bundle.** `@alvin0/ai-agent-sdk-auth-node`,
  `mcp-node`, `skill-filesystem`, `observability-node`, và `a2a` đều ở tầng Node.
- **Host Edge không thể trông cậy vào việc tiến trình thoát.** Mọi lần flush phải
  tường minh.
- **Worker không có đĩa cục bộ bền vững.** Snapshot hội thoại thuộc về KV, D1,
  Durable Objects, hoặc kho của chính bạn.

## Đọc tiếp

- [Production Deployment](/vi/10-advanced/production-deployment) — checklist dùng chung
- [Persistent Memory](/vi/05-memory/persistent-memory)
- [Observability](/vi/10-advanced/observability)
