# Performance

Mọi ngưỡng dưới đây đều cấu hình được bởi host, và mặc định là giá trị an toàn
cho việc dùng SDK không giám sát.

## Chặn trên vòng lặp

Đặt trên một định nghĩa agent:

```ts
runtime.agent({
  id: 'worker',
  model,
  instructions: '…',
  maxTurns: 16,        // số bước model
  maxToolCalls: 64,    // số tool được điều phối
  maxTokens: 16_384,   // trần output cho mỗi phản hồi
})
```

| Chặn trên | Mặc định | Hành vi khi cạn |
| --- | --- | --- |
| Số bước model | 16 | Dành sẵn một câu trả lời cuối đã tắt tool. |
| Số tool điều phối | 64 | Dành sẵn một câu trả lời cuối đã tắt tool. |
| Tổng token đã báo cáo | 500.000 | **Dừng ngay** — ngân sách an toàn không được tự tiêu vào việc giải thích rằng nó đã cạn. |

Ở mốc **75% của `maxToolCalls`**, vòng lặp chèn một cảnh báo ngân sách do app
soạn trước bước model kế tiếp, để một agent lập trình dài hơi dừng thăm dò rộng
và để dành lượt gọi cho việc sửa và kiểm chứng.

`maxTokens` được đối chiếu với trần output cứng của model **trước** khi có I/O
tới nhà cung cấp, và thất bại bằng `OUTPUT_TOKEN_LIMIT_EXCEEDED` chứ không phải
một mã 400 từ nhà cung cấp.

## Giới hạn runtime của session

```ts
const session = agent.createSession({
  runtimeLimits: {
    maxSteps: 16,
    maxToolCalls: 64,
    maxConsecutiveToolErrors: 3,
    maxTotalTokens: 250_000,
    observerTimeoutMs: 5_000,
    repeatToolWarningAt: 3,
    repeatToolLimit: 6,
    toolCycleWarningAt: 2,
    toolCycleLimit: 3,
    maxToolCycleLength: 4,
    maxToolDurationMs: 120_000,
    toolTeardownTimeoutMs: 10_000,
  },
})
```

| Nhóm | Mục đích |
| --- | --- |
| `repeatTool*` | Phát hiện lặp y hệt — cảnh báo, rồi dừng. |
| `toolCycle*`, `maxToolCycleLength` | Phát hiện chu trình đa bước ngắn. |
| `maxConsecutiveToolErrors` | Ngưỡng cắt khi lỗi liên tiếp. |
| `maxToolDurationMs` | Chặn trên thời gian thực, mang tính hợp tác, cho mỗi lời gọi tool. |
| `toolTeardownTimeoutMs` | Thời gian tháo dỡ chờ sau khi abort, trước khi báo `MODEL_TEARDOWN_TIMEOUT`. |
| `observerTimeoutMs` | Chặn trên cho callback quan sát của host. |

## Giới hạn lịch sử

```ts
const session = agent.createSession({
  historyLimits: {
    maxEntries: 20_000,
    maxBytes: 128 * 1024 * 1024,
  },
})
```

| Giới hạn | Mặc định |
| --- | --- |
| Số mục | 100.000 |
| Byte mỗi mục | 16 MiB |
| Tổng byte | 128 MiB |

## Giới hạn bộ nhớ

| Giới hạn | Mặc định |
| --- | --- |
| Số mục giữ lại | 1.024 |
| Ký tự mỗi mục | 65.536 |
| Tổng nội dung | 1 MiB |
| Ký tự tiêm vào mỗi yêu cầu | 12.000 |

Các đường khôi phục kiểm tra giới hạn **trước khi công bố** và chỉ chuẩn hoá các
trường đã ghi tài liệu.

## Nén ngữ cảnh

```ts
runtime.agent({
  compaction: {
    thresholdRatio: 0.8,
    retainRatio: 0.2,
    maxSummaryTokens: 4096,
    maxOverflowRetries: 1,
    maxToolResultChars: 24_000,
  },
})
```

| Tuỳ chọn | Mặc định | Tác dụng |
| --- | --- | --- |
| `thresholdRatio` | `0.8` | Ngưỡng áp lực, tính theo tỉ lệ trên cửa sổ ngữ cảnh dùng được. |
| `retainRatio` | `0.2` | Phần đuôi gần đây giữ nguyên văn. |
| `maxSummaryTokens` | — | Trần output cho checkpoint, còn bị chặn thêm bởi giới hạn cứng của model tóm tắt. |
| `maxOverflowRetries` | `1` | Số lần khôi phục khi nhà cung cấp xác nhận `CONTEXT_WINDOW_EXCEEDED`. |
| `maxToolResultChars` | — | Ngưỡng cắt bớt kết quả tool quá lớn. |

Đặt `compaction: false` để tắt hoàn toàn việc checkpoint.

> Cửa sổ dùng được là `contextWindow` của model **trừ đi** phần dự trữ output
> hiệu dụng. Một cửa sổ tổng hợp 128k với ngân sách output 32k không bao giờ được
> coi là có 128k cho đầu vào.
>
> Nếu adapter không báo cửa sổ ngữ cảnh, nén theo áp lực tự động là no-op trừ khi
> có cấu hình `maxInputTokens`.

## Giới hạn skill

| Giới hạn | Mặc định |
| --- | --- |
| `maxCatalogChars` | 8.000 |
| `maxSearchResources` | 32 |
| `maxSearchInputChars` | 200.000 |

Văn bản trả về từ `read_skill_resource` và `search_skill_resources` bị chặn cứng;
tài nguyên lớn được phơi ra theo từng khối.

## Chính sách usage khi thiếu dữ liệu

```ts
const session = agent.createSession({ usagePolicy: { onMissing: 'warn' } })
```

| Chính sách | Hành vi |
| --- | --- |
| `warn` (mặc định) | Tiếp tục, phát một chẩn đoán critical về usage thiếu. |
| `estimate` | Áp ngân sách bằng bộ ước lượng đã cấu hình, có gắn nhãn ước lượng. |
| `fail` | Dừng trước lời gọi model kế tiếp. |

Một hàng rào tổng token không thể áp đúng giới hạn nếu nhà cung cấp bỏ qua usage,
nên chính sách nói rõ điều đó thay vì giả vờ.

## Deadline của runtime và của việc đóng

```ts
await createAgentRuntime({
  providers,
  startupTimeoutMs: 10_000,
  closeTimeoutMs: 30_000,
  diagnosticMaxEvents: 1_000,
  diagnosticMaxBytes: 1_048_576,
})
```

`close()` trả về `quiescenceEnd` (`settled` / `timeout` / `caller-abort`) và
`unsettledRuns`. Hãy coi `unsettledRuns > 0` là một khiếm khuyết, không phải
nhiễu.

## Đọc tiếp

- [Short-term Memory](/vi/05-memory/short-term-memory) — chi tiết việc nén
- [Tool Execution](/vi/03-tools/tool-execution) — đồng thời và timeout
- [Production Deployment](/vi/10-advanced/production-deployment)
