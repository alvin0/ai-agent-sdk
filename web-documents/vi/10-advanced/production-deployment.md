# Production Deployment

## Khởi động

```ts
const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: () => secrets.get('openai') })],
  resource: { serviceName: 'checkout-api', runtime: 'node' },
  observability: { mode: 'reliable', exporters: [/* … */] },
  startupTimeoutMs: 10_000,
  closeTimeoutMs: 30_000,
  signal: bootController.signal,
})
```

`createAgentRuntime()` là async vì các plugin provider có ranh giới vòng đời
`ready()` — đó là nơi một năng lực thực sự chiếm giữ tài nguyên. Việc đăng ký là
**có giao dịch**: các yêu sách tuyến được khai báo ngay từ đầu, nên xung đột thất
bại *trước khi hoàn tất thiết lập*, và một lần khởi động thất bại sẽ rollback mọi
đăng ký dở dang.

`resource.serviceName` và `resource.runtime` xuất hiện trên **mọi** sự kiện quan
sát. Hãy đặt chúng, nếu không telemetry của bạn không phân biệt được hai lần
triển khai.

## Shutdown

```ts
const report = await runtime.close({ signal })

if (report.unsettledRuns > 0) {
  logger.error('shutdown left work unsettled', {
    quiescenceEnd: report.quiescenceEnd,
    activeRunsAtClose: report.activeRunsAtClose,
    abortedRuns: report.abortedRuns,
    unsettledRuns: report.unsettledRuns,
  })
}
```

| Trường | Đọc để biết |
| --- | --- |
| `quiescenceEnd` | `settled` / `timeout` / `caller-abort` |
| `deadlineReached` | `closeTimeoutMs` có hết hạn không? |
| `activeRunsAtClose` | Có bao nhiêu việc đang chạy |
| `abortedRuns` | Bao nhiêu việc bị huỷ một cách sạch sẽ |
| `unsettledRuns` | **> 0 là khiếm khuyết** — có thứ gì đó phớt lờ tín hiệu huỷ |
| `components` | Báo cáo đóng theo từng thành phần |
| `observationHealth` | Số sự kiện và byte đã giữ/đã loại bỏ |

Việc chấp nhận đóng là nguyên tử, tín hiệu huỷ được tổ hợp, các thế hệ tới muộn
bị niêm phong, một tác vụ đóng chung duy nhất an toàn trước việc caller huỷ, và
các logger trở thành no-op sau khi đóng.

### Thứ tự đóng, khi bạn có kết nối thêm thứ gì

```ts
try {
  await runtime.close()               // 1. làm lắng các lượt chạy
} finally {
  await mcp?.closeWithReport()        // 2. đóng thứ BẠN đã kết nối
  await team?.dispose?.()             // 3. tháo các peer từ xa
  await db.end()                      // 4. tài nguyên bạn đang mượn
}
```

Runtime đóng những gì nó **sở hữu** và không bao giờ bịa ra hành động đóng cho thứ
nó không chiếm giữ. Một observation exporter **thuộc sở hữu** sẽ được runtime đóng
sau khi mọi lượt chạy đang hoạt động lắng xuống; cái **đang mượn** thì là của bạn.

## Checklist theo từng runtime

### Dịch vụ Node

```text
[ ] resource.serviceName + runtime: 'node'
[ ] jsonlObservationExporter → ownership 'owned', requirement 'required',
    boundary 'local-durable'
[ ] handler SIGTERM → await runtime.close(), rồi đóng các kết nối
[ ] closeTimeoutMs ngắn hơn thời gian gia hạn của orchestrator
[ ] recoverRuntimeObservationJournal() ở lần khởi động sau
[ ] thông tin xác thực được tiêm vào — đừng bao giờ đọc process.env trong provider
```

```ts
process.on('SIGTERM', async () => {
  const report = await runtime.close()
  if (report.unsettledRuns > 0) process.exitCode = 1
})
```

### Edge / Worker

```text
[ ] chỉ package Universal — không auth-node, mcp-node, skill-filesystem,
    observability-node, a2a
[ ] resource.runtime: 'edge'
[ ] fetchObservationExporter → boundary 'remote-acknowledged',
    requirement 'best-effort'
[ ] flush đưa cho waitUntil tường minh của nền tảng — đừng giả định có biến toàn cục
[ ] snapshot hội thoại nằm ở KV / D1 / Durable Objects, không nằm trong bộ nhớ worker
[ ] handle.abort() khi client ngắt kết nối
```

```ts
ctx.waitUntil((async () => {
  try {
    await handle.result
    await env.CONVERSATIONS.put(id, JSON.stringify(session.snapshot()))
  } finally {
    await runtime.close()
  }
})())
```

Xem [Triển khai lên Edge Worker](/vi/10-advanced/deploy-edge-worker).

### Trình duyệt

```text
[ ] token ngắn hạn do backend của bạn phát hành — không phải API key của nhà cung cấp
[ ] indexedDbObservationExporter → boundary 'local-durable'
[ ] installBrowserObservabilityLifecycle() — phải bật tường minh, không tuyên bố bền vững lúc unload
[ ] recoverEvents() khi tải trang, acknowledgeBatch() chỉ sau khi sink CỦA BẠN xác nhận
[ ] session.snapshot() do bạn tự lưu
```

Xem [Triển khai lên trình duyệt](/vi/10-advanced/deploy-browser).

## Ngân sách trước khi có lưu lượng

Mặc định an toàn cho vận hành không giám sát, không phải được tinh chỉnh cho mô
hình chi phí của bạn.

```ts
const session = agent.createSession({
  runtimeLimits: {
    maxTotalTokens: 250_000,
    maxToolDurationMs: 120_000,
    toolTeardownTimeoutMs: 15_000,
    maxConsecutiveToolErrors: 3,
  },
  usagePolicy: { onMissing: 'warn' },   // 'estimate' | 'fail' nếu cần kiểm soát chi phí cứng
})
```

Nếu bạn có kiểm soát chi phí cứng, hãy chọn `estimate` hoặc `fail` một cách có ý
thức. Một hàng rào tổng token **không thể** áp đúng giới hạn khi nhà cung cấp bỏ
qua usage — chính sách nói rõ điều đó thay vì giả vờ.

## Hạch toán chi phí, một cách trung thực

```ts
const r = response.report
const billedInput = r.reported.inputTokens
  + (r.reported.cacheReadTokens ?? 0)
  + (r.reported.cacheWriteTokens ?? 0)

if (!r.authoritative) {
  // reported là CẬN DƯỚI. Đừng tính tiền từ nó như thể đó là tổng.
  metrics.increment('usage.incomplete', r.coverage.missingCalls)
}
```

`possiblyBilledAttemptsWithoutUsage` đếm số lượt đã gửi (hoặc có thể đã gửi) mà
không trả về bộ đếm. Đó là câu trả lời trung thực khi không thể biết chính xác
việc tính tiền từ phản hồi — hãy nêu nó ra, đừng làm tròn cho mất đi.

## Sức khoẻ và mức sẵn sàng

```ts
// Sẵn sàng: có với tới được nhà cung cấp nào không?
await runtime.modelCatalog('openai')

// Sống / gỡ lỗi: chẩn đoán trong bộ nhớ, có chặn trên
runtime.diagnostics()
```

Observability tự quan sát chính nó: `sdk.observer.failure` và
`sdk.exporter.state` ghi lại thất bại, việc rơi mất, khôi phục, và trạng thái
hàng đợi. Tỉ lệ rơi mất tăng dần là tín hiệu về dung lượng, không phải nhiễu.

## Trước khi phát hành

```text
[ ] runtime.close() được gọi trên mọi đường thoát, và báo cáo của nó được xem
[ ] unsettledRuns > 0 được coi là một cảnh báo
[ ] boundary của exporter khớp mức bền vững thật
[ ] chính sách nội dung đã rà soát — bộ ghi log wire chính xác đang TẮT nếu không gỡ lỗi
[ ] chính sách endpoint đã đặt cho client MCP và A2A (HTTPS, origin, mạng riêng)
[ ] bề mặt server MCP/A2A xác thực TRƯỚC handler.fetch()
[ ] exposeInternalErrors là false ngoài phạm vi chẩn đoán đáng tin cậy
[ ] bundle đã kiểm tra xem có lẫn tầng runtime sai không
[ ] ngân sách và usagePolicy đã chọn theo mô hình chi phí của bạn
```

## Đọc tiếp

- [Security](/vi/10-advanced/security)
- [Observability](/vi/10-advanced/observability)
- [Troubleshooting](/vi/10-advanced/troubleshooting)
