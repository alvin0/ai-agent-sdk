# Triển khai lên trình duyệt

Một agent chạy trong trình duyệt mà sự kiện quan sát của nó sống sót qua tab sập,
tải lại trang, hoặc gập máy — được dàn dựng trong IndexedDB và chỉ được xác nhận
sau khi sink từ xa của chính bạn báo đã nhận.

## Cài đặt

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai \
  @alvin0/ai-agent-sdk-observability-browser
```

## Thiết lập

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import {
  indexedDbObservationExporter,
  installBrowserObservabilityLifecycle,
} from '@alvin0/ai-agent-sdk-observability-browser'

const queue = indexedDbObservationExporter()

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: () => sessionToken.get() })],
  resource: { serviceName: 'studio-web', runtime: 'browser' },
  observability: {
    mode: 'reliable',
    exporters: [{
      exporter: queue,
      ownership: 'owned',
      requirement: 'required',
      boundary: 'local-durable',
    }],
  },
})

// Phải bật tường minh: flush khi trang ẩn và khi pagehide.
installBrowserObservabilityLifecycle(runtime)
```

Exporter dàn dựng các sự kiện đã xử lý quyền riêng tư vào IndexedDB trong lúc
**thu thập đồng bộ**, và chỉ xác nhận `local-durable` sau khi giao dịch commit ở
thời điểm flush hoặc checkpoint.

Mặc định cơ sở dữ liệu: `ai-agent-sdk-observability`, schema phiên bản 1, các
store `events`, `batches`, `meta`.

## Khôi phục lúc khởi động

```ts
const pending = await queue.recoverEvents()

if (pending.length > 0) {
  const response = await fetch('/api/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pending),
  })

  if (response.ok) {
    // Tới lúc này mới an toàn để bỏ chúng đi.
    await queue.acknowledgeBatch(pending.map(event => event.eventId))
  }
}
```

**Sự kiện đã lưu vẫn ở trạng thái chưa xác nhận cho tới khi bạn xác nhận chúng.**
Đó chính là điểm mấu chốt: một sự kiện bị bỏ đi vì trình duyệt cho rằng nó "đã
gửi" là một sự kiện bạn không thể kiểm toán.

`recoverEvents()` phơi ra khả năng khôi phục sau sập/mở lại **mà không cần import
một exporter mạng** — bạn sở hữu tầng truyền tải tới backend của chính mình.

## Lưu cả hội thoại

Tính bền vững của quan sát tách bạch với tính bền vững của hội thoại. Hãy tự chụp
snapshot session:

```ts
const session = agent.createSession({ conversationId })

await session.run(input)

localStorage.setItem(
  `conversation:${session.conversationId}`,
  JSON.stringify(session.snapshot()),
)
```

```ts
const stored = localStorage.getItem(`conversation:${conversationId}`)
const session = stored === null
  ? agent.createSession({ conversationId })
  : agent.resumeSession(JSON.parse(stored))
```

Snapshot an toàn JSON. Phần thân và tài nguyên của skill không bao giờ được lưu —
khi khôi phục, hệ thống khám phá lại và nạp lại, và thất bại trước khi gửi yêu
cầu model nếu một nguồn đã trôi lệch.

## Quy tắc trung thực

`installBrowserObservabilityLifecycle()` flush khi trang ẩn và khi `pagehide`. Nó
**không tuyên bố bền vững lúc unload**, vì không API trình duyệt nào bảo đảm được
điều đó.

Nếu yêu cầu kiểm toán của bạn mạnh hơn mức "thường thì được", exporter HTTPS có
xác nhận (`@alvin0/ai-agent-sdk-observability-fetch`) mới là câu trả lời trung thực — nó
gửi lại đúng lô đã tuần tự hoá kèm khoá idempotency cho tới khi server chấp nhận.

Bạn có thể đăng ký cả hai: IndexedDB ở mức `required`/`local-durable` để sống sót
qua cú sập, và HTTPS ở mức `best-effort`/`remote-acknowledged` cho đường trực
tiếp.

## Ràng buộc

- Thông tin xác thực dù sao cũng phải tới được trình duyệt. Hãy ưu tiên một token
  ngắn hạn do backend của bạn phát hành, thay vì đẩy API key của nhà cung cấp
  xuống client.
- Kho lưu của trình duyệt theo từng origin và người dùng có thể xoá.
- `@alvin0/ai-agent-sdk-observability-browser` ở tầng Browser — nó cần IndexedDB và các
  API vòng đời trang tuỳ chọn.

## Đọc tiếp

- [Production Deployment](/vi/10-advanced/production-deployment) — checklist dùng chung
- [Observability](/vi/10-advanced/observability)
- [Persistent Memory](/vi/05-memory/persistent-memory)
