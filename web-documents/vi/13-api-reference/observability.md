# Các package observability

Bốn package, một bus. Chọn theo **nơi sự kiện cần đáp xuống**.

| Package | Runtime | Ranh giới | Slot ghép nối |
| --- | --- | --- | --- |
| `observability-fetch` | Universal | `remote-acknowledged` | `runtime.observability.exporters` |
| `observability-node` | Node | `local-durable` | `runtime.observability.exporters` |
| `observability-browser` | Browser | `local-durable` | `runtime.observability.exporters` |
| `observability-otel` | Universal | — (processor) | `runtime.observability.openSpan-processors` |

---

## `@alvin0/ai-agent-sdk-observability-fetch`

Exporter HTTPS có xác nhận, chạy Universal. Gửi các lô JSON có chặn trên kèm khoá
idempotency và chỉ thử lại **lô quan sát** — không thử lại thao tác
model/provider đã sinh ra nó.

```ts
export {
  FetchObservationExporter,
  fetchObservationExporter,
  type FetchObservationExporterOptions,
}
export { flushObservabilityWithWaitUntil, type WaitUntil }
```

```ts
const exporter = fetchObservationExporter({
  endpoint: 'https://telemetry.example.com/v1/observations',
  headers: { authorization: `Bearer ${telemetryToken}` },
})
```

| Hành vi | Giá trị |
| --- | --- |
| Truyền tải | POST JSON kèm `idempotency-key: <batchId>` |
| Timeout yêu cầu | 10 giây |
| Trần mỗi lô | 256 sự kiện / 512 KiB |
| Phản hồi được chấp nhận | HTTP 204, hoặc `{ "acceptedBatchId": "<batchId>" }` |
| Có thử lại | lỗi mạng, 408, 425, 429, 5xx — gửi lại đúng lô đã tuần tự hoá, jitter toàn phần có chặn trên |
| Không thử lại | mọi phản hồi khác |
| Chính sách truyền tải | Bắt buộc HTTPS trừ endpoint test localhost/loopback được bật tường minh; từ chối redirect và phản hồi khác origin |

Trên host Edge, hãy đưa promise flush cho `waitUntil` tường minh của nền tảng:

```ts
flushObservabilityWithWaitUntil(observability, ctx.waitUntil)
```

Package không bao giờ giả định có biến toàn cục của nền tảng.

---

## `@alvin0/ai-agent-sdk-observability-node`

Sổ quan sát bền vững chỉ chạy trên Node, cộng với các hàm trợ giúp vòng đời và
chẩn đoán tường minh. **Thư mục gốc của sổ luôn do caller cấp.**

Điểm vào: `.`, `./journal`, `./diagnostic`. Root re-export cả hai.

```ts
export {
  JsonlObservationJournalExporter,
  jsonlObservationExporter,
  recoverRuntimeObservationJournal,
  recoverJournal,
  type JournalDurabilityMode, type JournalRecoveryRecord,
  type JournalRecoveryResult, type JournalStats,
  type RuntimeJournalRecoveryRecord, type RuntimeJournalRecoveryResult,
  type JsonlObservationJournalOptions,
}
export {
  installNodeObservabilityLifecycle,
  NODE_OBSERVATION_ERROR_CODES, NodeObservationError,
  type NodeLifecycleOptions, type NodeLifecycleTarget, type NodeObservationErrorCode,
}
```

```ts
const runtime = await createAgentRuntime({
  providers: [provider],
  observability: {
    mode: 'reliable',
    exporters: [{
      exporter: jsonlObservationExporter({ rootDir: './observations', mode: 'reliable' }),
      ownership: 'owned',
      requirement: 'required',
      boundary: 'local-durable',
    }],
  },
})

await runtime.close()
const recovered = await recoverRuntimeObservationJournal('./observations')
```

Factory này **trơ** — tài nguyên hệ tệp chỉ được chiếm khi `createAgentRuntime()`
gọi ranh giới vòng đời `ready()` của nó. Bản ghi dùng JSONL có khung checksum,
chế độ thư mục/tệp riêng tư, phân đoạn duy nhất, con trỏ xác nhận nguyên tử, giữ
lại có chặn trên, và khôi phục nghiêm ngặt khi hỏng dữ liệu.

Bộ chuyển đổi runtime lưu các sự kiện đã lọc quyền riêng tư và bản ghi lượt chạy
kết thúc dạng nguyên tử trong `runtime-delivery/`, và xác nhận ID của chúng riêng
biệt. Bạn vẫn phải đóng runtime tường minh; một exporter **thuộc sở hữu** sẽ được
runtime đóng sau khi mọi lượt chạy đang hoạt động lắng xuống.

`recoverRuntimeObservationJournal()` kiểm tra checksum và trả về cả bản ghi sự
kiện lẫn bản ghi lượt chạy kết thúc. `recoverJournal()` vẫn là API khôi phục sổ
legacy ở mức nâng cao.

### `./diagnostic` — wire chính xác của nhà cung cấp

Một **năng lực rủi ro cao riêng biệt**: nó từ chối khởi tạo trừ khi đặt cả
`content: 'full'` lẫn `allowWireBodies: true`.

```ts
export {
  createDiagnosticWireLogger,
  createDailyJsonlRequestLogger,
  combineProviderRequestLoggers,
  type DiagnosticWireLoggerOptions, type ProviderWireLogRecord,
  type ProviderWireLogger, type DailyJsonlRequestLogger,
  type DailyJsonlRequestLoggerOptions, type ProviderRequestLogLike,
}
```

Không có gì tự động cài đặt handler vòng đời tiến trình.

---

## `@alvin0/ai-agent-sdk-observability-browser`

Tính bền vững cục bộ, chỉ chạy trên trình duyệt. Exporter dàn dựng các sự kiện đã
xử lý quyền riêng tư vào IndexedDB trong lúc **thu thập đồng bộ**, và chỉ xác
nhận `local-durable` sau khi giao dịch commit ở thời điểm flush/checkpoint.

```ts
export {
  IndexedDbObservationExporter,
  indexedDbObservationExporter,
  BROWSER_OBSERVATION_ERROR_CODES, BrowserObservationError,
  type BrowserObservationErrorCode, type BrowserQueueStats,
  type IndexedDbObservationExporterOptions,
}
export { installBrowserObservabilityLifecycle, type BrowserLifecycleOptions }
```

```ts
const queue = indexedDbObservationExporter()

const observability = createObservability({
  mode: 'reliable',
  exporters: [{ exporter: queue, requirement: 'required', boundary: 'local-durable' }],
})
```

Cơ sở dữ liệu mặc định là `ai-agent-sdk-observability`, schema phiên bản 1, với
các store `events`, `batches`, và `meta`.

Sự kiện đã lưu vẫn ở trạng thái **chưa xác nhận** cho tới khi host gọi
`acknowledgeBatch()` sau khi sink từ xa của chính nó xác nhận đã nhận.
`recoverEvents()` phơi ra khả năng khôi phục sau sập/mở lại mà không cần import
một exporter mạng.

`installBrowserObservabilityLifecycle()` phải **bật tường minh**, và nó flush khi
trang chuyển sang ẩn và khi `pagehide`. Nó **không tuyên bố bền vững lúc unload**.

---

## `@alvin0/ai-agent-sdk-observability-otel`

Cầu nối ánh xạ Universal cho các đối tượng API OpenTelemetry **do caller cấp**.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-observability-otel \
  @opentelemetry/api @opentelemetry/api-logs
```

```ts
export {
  createOpenTelemetryBridge,
  OTEL_SEMANTIC_CONVENTIONS_COMMIT,
  OpenTelemetryBridgeError,
  type OpenTelemetryBridge, type OpenTelemetryBridgeOptions,
  type OpenTelemetryLogEnabledOptions, type OpenTelemetryLogger,
  type OpenTelemetryLogRecord,
}
```

```ts
const bridge = createOpenTelemetryBridge({
  tracer: tracerProvider.getTracer('my-agent'),
  meter: meterProvider.getMeter('my-agent'),
  // logger: loggerProvider.getLogger('my-agent'),
})

const observation = createObservability({
  openSpan: bridge.openSpan,
  processors: [bridge.processor],
})
```

Nó tạo **span thật một cách đồng bộ**, giữ ngữ cảnh cha tường minh mà không dùng
ngữ cảnh ngầm hay `AsyncLocalStorage`, và ánh xạ các sự kiện SDK đã xử lý quyền
riêng tư sang span, metric, và log tuỳ chọn.

Package **không cài nhà cung cấp toàn cục nào**, không sở hữu SDK hay exporter
OTLP, không thực hiện I/O mạng, và không bao giờ tuyên bố đã giao telemetry. Hãy
cấu hình một sổ hoặc một exporter có xác nhận riêng khi cần bảo đảm giao nhận.

Thuộc tính nội dung mặc định tắt. Muốn ánh xạ thân prompt/completion thì cần
`content: 'full'` trên **cả** cầu nối lẫn bus observability của SDK.

Ứng dụng giữ quyền sở hữu việc đăng ký nhà cung cấp, processor, exporter, flush,
và shutdown.

## Đọc tiếp

- [Khái niệm observability](/vi/10-advanced/observability)
- [Cấu hình observability](/vi/10-advanced/observability)
