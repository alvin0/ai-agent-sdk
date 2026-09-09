# Tool Execution

## Đường ống điều phối

```text
model phát ra các lời gọi tool (một lô)
      │
      ▼  phân loại       isConcurrencySafe(args) → parallel | exclusive
      ▼  phê duyệt       broker phê duyệt, nếu có cấu hình
      ▼  chặn ngang      interceptor bọc quanh lời gọi
      ▼  parse           không đáng tin → có kiểu  (ném → INVALID_ARGUMENTS)
      ▼  execute         với ctx.signal và deadline timeoutMs
      ▼  render / meta   block hướng model + metadata giao diện
      ▼  commit          cả lô commit cùng nhau
      │
      └── concludeTurn()? → lượt kết thúc SAU KHI lô commit
```

Các lời gọi được **xếp theo lô**. Vòng lặp commit hết mọi lời gọi trong lô hiện
tại trước khi hành động theo `concludeTurn()`, nên công việc của một lời gọi song
song không bao giờ bị vứt bỏ.

## Đồng thời là fail-closed

```ts
isConcurrencySafe: args => args.mode === 'read'
```

Chỉ đúng giá trị `true` mới cho phép một lời gọi chạy song song. Bộ phân loại ném
lỗi hoặc không khai báo đều bị coi là **exclusive**.

Cả hai hiện thực tham chiếu đều mặc định exclusive và đòi bật tường minh, vì kiểu
thất bại khi đoán sai là **hỏng dữ liệu âm thầm** do hai tool cùng sửa một trạng
thái — không phải một lỗi nhìn thấy được.

Chỉ trả `true` khi lời gọi không thể quan sát hay sửa trạng thái mà một lời gọi
song song khác chạm tới. Một phép đọc thuần từ nguồn bất biến thì đủ điều kiện;
"chắc là ổn" thì không.

| Tool | An toàn? |
| --- | --- |
| Đọc một revision tệp bất biến | ✓ |
| Truy vấn một read replica | ✓ |
| Tính toán thuần | ✓ |
| Ghi một tệp | ✗ |
| Chạy một lệnh shell | ✗ |
| Bất cứ thứ gì dùng chung cursor, cache, hay đường dẫn tạm | ✗ |

`maxParallel` chặn số lời gọi an toàn thực sự chạy cùng lúc.

## Timeout mang tính hợp tác

```ts
timeoutMs: 30_000,
execute: async (args, ctx) => fetch(url, { signal: ctx.signal }),
```

`timeoutMs` là chặn trên theo thời gian thực cho một lời gọi và **không bao giờ
được gửi cho model**.

Khai báo nó là một **lời hứa** rằng `execute` chuyển tiếp `ctx.signal`: đường ống
abort tín hiệu rồi **chờ**. Nó không bỏ rơi promise, vì một tool mồ côi sẽ tiếp
tục sửa trạng thái sau lưng vòng lặp.

Nếu một tool phớt lờ tín hiệu, việc tháo dỡ chờ tối đa `toolTeardownTimeoutMs`
rồi báo `MODEL_TEARDOWN_TIMEOUT` — và báo cáo đóng của runtime hiện
`unsettledRuns > 0`. Đó là khiếm khuyết của tool/adapter, không phải lỗi thoáng
qua.

## Rào chắn

Các tool skill được sinh ra là **rào chắn của bộ lập lịch**. Điều này giữ đúng
thứ tự model cho một lô như `load_skill` rồi `read_skill_resource`, và không giả
định rằng một provider từ xa an toàn khi truy cập đồng thời.

Hãy dùng cùng ý đó cho tool của bạn: trả `false` từ `isConcurrencySafe` khi thứ
tự quan trọng, thay vì cố tự phối hợp bên trong `execute`.

## Interceptor

```ts
const audit: ToolInterceptor = {
  name: 'audit',
  around: async (call, next) => {
    const started = performance.now()
    try {
      return await next()
    } finally {
      metrics.record(call.toolName, performance.now() - started)
    }
  },
}

const session = agent.createSession({ interceptors: [audit] })
```

Interceptor là một **đối tượng có tên** với ba pha tuỳ chọn — `before`
(allow / deny / ask), `around` (bọc quanh việc thực thi), `after` (accept /
replace / block kết quả). `next()` không nhận đối số; lời gọi tới ở tham số thứ
nhất.

Interceptor bọc quanh việc điều phối — kiểm toán, đo lường, che dữ liệu, chính
sách theo tenant. Chúng được nắm bắt kèm **receiver gốc**, nên một phương thức
lấy ra khỏi đối tượng vẫn giữ `this` và trạng thái vận hành sống của nó.

`createToolExecutionInterceptor` là một adapter `around` có sẵn cho backend từ xa
và thao tác bền. Xem [Durable Execution](/vi/03-tools/durable-execution).

## Tool source

Một `ToolSource` công bố cả một danh mục cùng lúc. MCP server là ví dụ kinh điển.

```ts
const agent = runtime.agent({ id: 'a', model, instructions: '…', toolSources: [mcp] })
```

Ảnh chụp là **đồng bộ và nguyên tử**: một revision gắn cả schema lẫn việc thực
thi. Do đó một danh mục thay đổi giữa chừng không thể khiến model gọi một tool có
schema mà nó chưa từng thấy. Bằng chứng kết thúc chỉ mang nguồn và revision.

Vòng đời là `connected-caller-owned`:

```ts
try {
  await runtime.close()          // làm lắng các lượt chạy trước
} finally {
  await mcp.closeWithReport()    // rồi mới đóng thứ bạn đã kết nối
}
```

## Chặn trên cho kết quả

| Chặn trên | Tác dụng |
| --- | --- |
| `maxToolResultBytes` | Số byte đã tuần tự hoá được giữ cho một kết quả hoàn tất |
| `maxToolDurationMs` | Hạn mức đầu-cuối cho một lời gọi |
| `toolTeardownTimeoutMs` | Thời gian chờ sau khi huỷ một tool bất hợp tác |
| `maxToolCalls` | Số tool điều phối mỗi lượt chạy (mặc định 64) |
| `maxConsecutiveToolErrors` | Số lỗi liên tiếp trước khi cắt |

Văn bản kết quả tool quá lớn được cắt còn phần đầu/đuôi bền vững trước khi tóm
tắt trong lúc nén, nên một kết quả khổng lồ suy giảm mềm mại thay vì làm nổ cửa
sổ ngữ cảnh.

## Mọi lời gọi đều được quan sát

`sdk.tool.call` ghi start/end cho từng lần điều phối, cộng thêm thời gian chờ phê
duyệt và quyết định khi có. Sự kiện mang `traceId`, `spanId`, và `parentSpanId`;
các lời gọi song song tới cùng một tool luôn nhận **span id khác nhau**, trong khi
id lời gọi tool vẫn là id tương quan.

## Đọc tiếp

- [Error Handling](/vi/03-tools/error-handling)
- [Durable Execution](/vi/03-tools/durable-execution)
- [Permissions](/vi/03-tools/permissions)
- [Parallel Execution](/vi/06-workflows/parallel-execution)
