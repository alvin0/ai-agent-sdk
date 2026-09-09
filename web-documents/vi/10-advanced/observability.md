# Observability

SDK có một bus quan sát có cấu trúc duy nhất. Nó ghi lại lời gọi model, lượt thử
vật lý tới nhà cung cấp, độ phủ usage, các lần thử lại, thao tác xác
thực/danh mục, lỗi đã làm sạch, và log ứng dụng có tương quan — với
`content: 'none'` làm mặc định.

## Cách ghép

```ts
import { createObservability, MemoryObservationExporter } from '@alvin0/ai-agent-sdk-core/observability'

const exporter = new MemoryObservationExporter()  // chỉ để kiểm tra cục bộ / trong test
const observation = createObservability({
  exporters: [{ exporter, requirement: 'best-effort', boundary: 'none' }],
})

const runtime = await createAgentRuntime({ providers, observability: { exporters: [...] } })

runtime.logger({ fields: { component: 'checkout-agent' } }).info('agent initialized')
```

## Ba núm vặn trực giao

**Chế độ giao nhận** — bus cố gắng tới mức nào:

```ts
type DeliveryMode = 'operational' | 'reliable' | 'audit'
```

**Yêu cầu** — một exporter cụ thể có được phép thất bại hay không:

```ts
requirement: 'required' | 'best-effort'
```

**Ranh giới** — mức bền vững mà exporter đang tuyên bố một cách trung thực:

```ts
type ObservationBoundary = 'none' | 'local-durable' | 'remote-acknowledged'
```

Giao nhận trong bộ nhớ không bao giờ tuyên bố tính bền vững. Chế độ `reliable` và
`audit` đòi một package exporter bền vững.

## Phong bì sự kiện

Mọi sự kiện đều có phiên bản và an toàn JSON:

```ts
interface ObservationEnvelope<TName extends string, TData> {
  schemaVersion: 1
  eventId: string          // khử trùng lặp khi exporter thử lại
  sequence: number         // tăng đơn điệu; có khoảng trống nghĩa là mất sự kiện
  name: TName
  occurredAt: string       // thời điểm phát sinh, không phải lúc exporter nhận
  severity: 'debug' | 'info' | 'warn' | 'error'
  priority: 'critical' | 'normal' | 'verbose'
  trace: { traceId: string; spanId: string; parentSpanId: string | null }
  resource: { sdkName: string; sdkVersion: string; serviceName?: string
              runtime?: 'edge' | 'browser' | 'node' | 'other' }
  correlation: CorrelationContext
  data: TData
}
```

`priority` điều khiển việc lấy mẫu, đệm, và backpressure. **Sự kiện critical
không bao giờ bị lấy mẫu**, và mỗi sự kiện bắt đầu có đúng một sự kiện kết thúc.

## Các id tương quan có vòng đời riêng

| Định danh | Vòng đời |
| --- | --- |
| `traceId` | Một vết phân tán |
| `runId` | Một lần gọi agent |
| `conversationId` | Nhiều lần gọi trong cùng một hội thoại |
| `turnId` | Một lượt user/agent |
| `modelCallId` | Một thao tác model **logic**, bao gồm cả các lần thử lại tự động |
| `attemptId` | Một lượt thử **vật lý** tới nhà cung cấp |
| `toolCallId` | Một lần thực thi tool được yêu cầu |
| `providerRequestId` | Id yêu cầu do nhà cung cấp gán, khi có |
| `sessionId` | Phiên sản phẩm do host định nghĩa |
| `sequence` | Vị trí có thứ tự trong một sổ ghi của lượt chạy |

Đừng dùng `toolCallId` kiêm luôn cho lời gọi model hay lượt thử HTTP.

## Sự kiện critical

| Thao tác | Tên sự kiện | Pha |
| --- | --- | --- |
| Lượt chạy agent | `sdk.agent.run` | start/end |
| Lượt agent | `sdk.agent.turn` | start/end |
| Lời gọi model | `sdk.model.call` | start/end |
| Lượt thử tới nhà cung cấp | `sdk.provider.attempt` | start/end |
| Lên lịch thử lại | `sdk.provider.retry.scheduled` | điểm |
| Thực thi tool | `sdk.tool.call` | start/end |
| Nén ngữ cảnh | `sdk.compaction` | start/end |
| Gọi hook | `sdk.hook.call` | start/end |
| Chờ đầu vào người dùng / phê duyệt | `sdk.user.input.wait` | start/end |
| Thao tác skill | `sdk.skill.operation` | start/end |
| Thao tác bộ nhớ | `sdk.memory.operation` | start/end |
| Thao tác xác thực | `sdk.credential.operation` | start/end |
| Yêu cầu tích hợp (MCP, A2A, khám phá) | `sdk.integration.request` | start/end |
| Giao nhận xuất dữ liệu | `sdk.observer.failure`, `sdk.exporter.state` | điểm |

Các delta văn bản, suy luận, và hình ảnh là sự kiện **verbose**. Chúng không cần
cho việc hạch toán và mặc định bị tắt hoặc lấy mẫu.

## Độ phủ usage — mô hình hạch toán trung thực

Số liệu usage và *độ phủ* là hai khái niệm tách bạch:

```ts
interface ModelCallUsageObservation {
  status: 'complete' | 'partial' | 'estimated' | 'missing' | 'not-applicable'
  source: 'provider' | 'estimator' | 'mixed' | 'none'
  values?: TokenUsage
  missingFields?: readonly TokenUsageField[]
  reason?: 'provider-omitted' | 'stream-aborted' | 'stream-failed' | 'invalid-usage'
}
```

Các quy tắc có ý nghĩa thực tế:

- một lời gọi model logic sinh ra đúng một quan sát usage cuối cùng;
- vắng mặt là `missing`, **không bao giờ** là một `TokenUsage` toàn số 0;
- `not-applicable` chỉ dùng khi SDK chứng minh được là không có lượt gửi nào tới
  nhà cung cấp;
- dữ liệu một phần từ nhà cung cấp vẫn để là một phần, không lấp trường thiếu
  bằng số 0;
- giá trị ước lượng không bao giờ được trình bày như số do nhà cung cấp báo hay
  số có thẩm quyền tính tiền;
- lời gọi model cho việc nén và cho câu trả lời cuối bắt buộc vẫn tính là lời gọi
  model và xuất hiện trong độ phủ;
- usage của các lượt thất bại/thử lại được theo dõi riêng, vì nhà cung cấp có thể
  tính tiền một lượt thử mà không trả về bộ đếm.

### Báo cáo tổng hợp

```ts
interface RunUsageReport {
  reported: Partial<TokenUsage>
  estimated?: Partial<TokenUsage>
  budgetTokens?: number
  coverage: {
    logicalCalls: number
    attempts: number
    complete: number
    partial: number
    estimated: number
    missing: number
    notApplicable: number
    possiblyBilledAttemptsWithoutUsage: number
  }
  authoritative: boolean
}
```

`reported` là **tổng cận dưới** khi độ phủ chưa đầy đủ. Không giá trị nào được
gọi là "tổng chi phí" hay "tổng token" trừ khi độ phủ là `authoritative`.

Mỗi lượt thử vật lý ghi `dispatchState: 'not-sent' | 'sent' | 'unknown'`. Một
lời gọi bị gián đoạn ở trạng thái `sent` hoặc `unknown` mà không trả về usage sẽ
làm tăng `possiblyBilledAttemptsWithoutUsage` — đây là câu trả lời trung thực khi
không thể biết chính xác việc tính tiền từ phản hồi.

### Contribution ngân sách và các attempt partial

Mandatory usage stop áp dụng cả auto-compaction: summary trả `usageRequired`
hoặc `usageUnavailable` sẽ chặn request main, summary, retry và finalizer tiếp
theo trong invocation. Fail-open của maintenance không xóa quyết định này;
report vẫn giữ raw evidence của summary.

`runtimeLimits.maxTotalTokens` giới hạn normal rounds (gồm retry/finalizer),
không gồm compaction. Summary dùng riêng `maxSummaryTokens`, `summaryTimeoutMs`,
`compactionRetries`, `maxOverflowRetries` trong `compaction`; chưa có cumulative
summary-token cap riêng. Run report cộng cả hai nên tổng có thể vượt cap của
normal turns. Đây không phải trần billing của toàn invocation.

`usagePolicy.estimateTimeoutMs` giới hạn estimator bất đồng bộ, độc lập với
`modelTimeoutMs` (mặc định 30.000ms; số nguyên dương tối đa 2.147.483.647).
Callback nhận `input.signal`, bị hủy khi caller abort, ledger đóng hoặc hết hạn.
SDK lưu evidence provider/attempt trước khi gọi estimator. Timeout, rejection
hoặc counters không hợp lệ chặn request tiếp theo bằng `USAGE_REQUIRED`; usage
chưa biết không được đổi thành zero. Kết quả đến muộn không sửa report đã seal.
SDK không thể cưỡng chế ngắt callback đồng bộ đang khóa JavaScript thread;
estimator phải hợp tác và không được dùng busy loop.

Mọi continuation—retry hook, structured finalizer và `onTurnEnd`—đều tuân thủ
token cap đã biết và required-usage policy. Finalizer có thể được thêm một step,
không được thêm token budget. Request đang chạy vẫn có thể vượt cap; guard chặn
công việc tiếp theo, không thu hồi token provider đã sinh.

`budgetTokens` là phép chiếu tùy chọn để kiểm tra ngân sách, không phải tổng
hóa đơn. SDK ghép bucket reported với estimate cho bucket thiếu trong từng
logical call, rồi mới cộng các contribution. Bucket reported của call này
không che estimate của call khác. Contribution đã biết từ attempt vẫn được
giữ khi counters tổng hợp không biểu diễn được; không cộng đôi call và attempt.
Usage thiếu vẫn là chưa biết, không phải zero; estimate không có tính authoritative.

Aggregate bỏ `totalTokens` nếu các report đóng góp không có cùng độ phủ total.
Tầng tổng hợp sau không tự tạo total chính xác từ bucket partial. Report attempt
gốc giữ bằng chứng; counter có phạm vi không tương thích và không qua validation
sẽ bị bỏ khỏi summary.

Cancellation kết thúc việc chờ public, chưa chắc dừng công việc bên ngoài.
HTTP transport giữ quyền cleanup response đến muộn từ custom fetch và chặn
thời gian cleanup body chưa đọc ở 30 giây. SSE piping đang chạy nhận abort
signal. SDK không thể cưỡng chế dừng callback cancel không hợp tác.

### Khi thiếu usage

Một hàng rào tổng token không thể áp đúng giới hạn nếu nhà cung cấp bỏ qua usage,
nên chính sách của lượt chạy nói rõ điều đó:

| Chính sách | Hành vi |
| --- | --- |
| `warn` (mặc định) | Tiếp tục, phát một chẩn đoán critical về usage thiếu. |
| `estimate` | Áp ngân sách bằng bộ ước lượng đã cấu hình, có gắn nhãn ước lượng. |
| `fail` | Dừng trước lời gọi model kế tiếp — hợp đồng hạch toán không được đáp ứng. |

## Quyền riêng tư là mặc định

Bị loại trừ trừ khi bật tường minh: token OAuth, API key, cookie, thông tin tài
khoản, header ngoài danh sách cho phép, và nội dung prompt/completion.

Bộ ghi log wire chính xác tới nhà cung cấp là một **cầu nối chẩn đoán rủi ro cao
riêng biệt**, vì phần thân của nó chứa prompt và kết quả tool:

```ts
import { createDailyJsonlRequestLogger } from '@alvin0/ai-agent-sdk-observability-node/diagnostic'

registry.registerAdapter(['codex'], codexAdapter({
  requestLogger: createDailyJsonlRequestLogger({
    content: 'full',
    allowWireBodies: true,   // thiếu một trong hai cờ thì từ chối khởi tạo
  }),
}))
```

Các yêu cầu được ghi nối vào một tệp riêng, duy nhất, dưới
`.providers/<provider>/wire/`. Thông tin xác thực, cookie, và id tài khoản bị che;
**phần thân yêu cầu thì không**, vì prompt và kết quả tool chính là mục đích của
công cụ chẩn đoán này. `.providers/` đã được git-ignore nhưng vẫn phải coi là dữ
liệu cục bộ nhạy cảm.

## Các package exporter

| Package | Ranh giới | Dùng cho |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-observability-fetch` | `remote-acknowledged` | Lô HTTPS có xác nhận, Universal |
| `@alvin0/ai-agent-sdk-observability-node` | `local-durable` | Sổ JSONL có khung checksum |
| `@alvin0/ai-agent-sdk-observability-browser` | `local-durable` | Dàn dựng qua IndexedDB và khôi phục sau sập |
| `@alvin0/ai-agent-sdk-observability-otel` | — (processor) | Ánh xạ sự kiện sang API OpenTelemetry do caller cấp |

---

# Cấu hình

## Nó nằm ở đâu

```ts
const runtime = await createAgentRuntime({
  providers,
  resource: { serviceName: 'checkout-api', runtime: 'node' },
  observability: {
    mode: 'reliable',
    content: 'none',
    minimumLogLevel: 'info',
    exporters: [ /* các đăng ký */ ],
    processors: [ /* ObservationProcessor */ ],
    redactors: [ /* ContentRedactor */ ],
    includeErrorStacks: false,
    openSpan: bridge.openSpan,
    maxQueueEvents: 10_000,
    maxQueueBytes: 8 * 1024 * 1024,
    maxBatchEvents: 256,
    maxBatchBytes: 512 * 1024,
    flushTimeoutMs: 10_000,
    shutdownTimeoutMs: 15_000,
  },
})
```

## Chế độ giao nhận

```ts
type DeliveryMode = 'operational' | 'reliable' | 'audit'
```

| Chế độ | Ý nghĩa |
| --- | --- |
| `operational` | Telemetry nỗ lực tối đa. Việc rơi mất khi quá tải được ghi lại, không gây chết. |
| `reliable` | Đòi một exporter bền vững. Khoảng trống giao nhận được nêu rõ. |
| `audit` | Nghiêm nhất. Mọi sự kiện critical phải tới một ranh giới bền vững. |

`reliable` và `audit` đòi một package exporter bền vững. Giao nhận trong bộ nhớ
**không bao giờ** tuyên bố tính bền vững.

## Đăng ký exporter

Mỗi đăng ký nêu ba thứ độc lập:

```ts
{
  exporter: jsonlObservationExporter({ rootDir: './observations' }),
  ownership: 'owned',            // 'owned' | 'borrowed'
  requirement: 'required',       // 'required' | 'best-effort'
  boundary: 'local-durable',     // 'none' | 'local-durable' | 'remote-acknowledged'
}
```

| Trường | Trả lời câu hỏi |
| --- | --- |
| `ownership` | Runtime có đóng nó sau khi các lượt chạy lắng xuống không? |
| `requirement` | Việc xuất dữ liệu thất bại có được phép không? |
| `boundary` | Exporter này đang trung thực tuyên bố mức bền vững nào? |

Exporter `owned` được runtime đóng sau khi mọi lượt chạy đang hoạt động lắng
xuống. Exporter `borrowed` là của bạn, bạn tự đóng.

## Chọn exporter

| Môi trường | Package | Đăng ký |
| --- | --- | --- |
| Edge/Worker | `observability-fetch` | `boundary: 'remote-acknowledged'` |
| Trình duyệt | `observability-browser` | `boundary: 'local-durable'` |
| Node | `observability-node` | `boundary: 'local-durable'` |
| Bất kỳ + OpenTelemetry | `observability-otel` | `openSpan` + `processors`, không phải exporter |

Bạn có thể đăng ký nhiều cái. Một dịch vụ Node điển hình dùng sổ JSONL cục bộ ở
mức `required`/`local-durable` và một exporter HTTPS ở mức `best-effort`/
`remote-acknowledged`.

## Flush trên Edge

Host Edge không thể trông cậy vào việc tiến trình thoát. Hãy đưa promise flush
cho `waitUntil` tường minh của nền tảng:

```ts
import { flushObservabilityWithWaitUntil } from '@alvin0/ai-agent-sdk-observability-fetch'

export default {
  async fetch(request, env, ctx) {
    const response = await handle(request)
    flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
    return response
  },
}
```

Package không bao giờ giả định có biến toàn cục của nền tảng.

## Vòng đời trên trình duyệt

```ts
import { installBrowserObservabilityLifecycle } from '@alvin0/ai-agent-sdk-observability-browser'

installBrowserObservabilityLifecycle(observability)
```

Phải bật tường minh. Nó flush khi trang chuyển sang ẩn và khi `pagehide`, và
**không tuyên bố bền vững lúc unload**. Sự kiện đã lưu vẫn ở trạng thái chưa xác
nhận cho tới khi bạn gọi `acknowledgeBatch()` sau khi sink từ xa của chính bạn
xác nhận đã nhận.

## OpenTelemetry

```ts
const bridge = createOpenTelemetryBridge({
  tracer: tracerProvider.getTracer('my-agent'),
  meter: meterProvider.getMeter('my-agent'),
  logger: loggerProvider.getLogger('my-agent'),   // tuỳ chọn
})

const observation = createObservability({
  openSpan: bridge.openSpan,
  processors: [bridge.processor],
})
```

Cầu nối này **không phải exporter**. Nó không cài nhà cung cấp toàn cục, không sở
hữu exporter OTLP, không thực hiện I/O mạng, và không bao giờ tuyên bố đã giao
telemetry. Hãy cấu hình một sổ hoặc một exporter có xác nhận riêng khi bạn cần
bảo đảm giao nhận.

Ứng dụng của bạn giữ quyền sở hữu việc đăng ký nhà cung cấp, processor, exporter,
flush, và shutdown.

## Lấy mẫu

`priority` trên phong bì sự kiện điều khiển việc lấy mẫu, đệm, và backpressure:

| Mức ưu tiên | Lấy mẫu |
| --- | --- |
| `critical` | **Không bao giờ lấy mẫu.** Mỗi sự kiện bắt đầu có đúng một sự kiện kết thúc. |
| `normal` | Lấy mẫu theo chính sách. |
| `verbose` | Delta văn bản/suy luận/hình ảnh. Mặc định tắt hoặc lấy mẫu. |

## Sức khoẻ

```ts
const report = await runtime.close()
report.observationHealth   // số sự kiện và byte đã giữ/đã loại bỏ

runtime.diagnostics()      // vòng đệm chẩn đoán trong bộ nhớ, có chặn trên
```

Observability tự quan sát chính nó: `sdk.observer.failure` và
`sdk.exporter.state` ghi lại thất bại, việc rơi mất, khôi phục, và trạng thái
hàng đợi.

## Đọc tiếp

- [Security](/vi/10-advanced/security) — chính sách riêng tư trong ngữ cảnh
- [Tham chiếu API observability](/vi/13-api-reference/observability)
- [Khôi phục sau sập trình duyệt](/vi/10-advanced/deploy-browser)
