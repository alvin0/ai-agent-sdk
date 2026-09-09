# Custom Memory Provider

`defineMemoryStore()` cho phép bạn đặt bộ nhớ tác vụ lên kho của chính mình —
Postgres, Redis, Durable Objects, một vector index, bất cứ thứ gì.

```ts
import { defineMemoryStore, MEMORY_STORE_API_VERSION } from '@alvin0/ai-agent-sdk-core/memory'
```

## Hợp đồng

```ts
const pgMemory = defineMemoryStore({
  id: 'pg-memory',
  apiVersion: MEMORY_STORE_API_VERSION,

  async load({ scope, signal }): Promise<MemoryLoadResult> {
    const row = await db.query(
      'select revision, items from agent_memory where scope_key = $1',
      [scopeKey(scope)],
      { signal },
    )
    return row === null
      ? { revision: 0, items: [] }
      : { revision: row.revision, items: row.items }
  },

  async commit({ scope, revision, items, signal }): Promise<MemoryCommitResult> {
    // Compare-and-swap trên đúng revision mà SDK đã đọc.
    const updated = await db.query(
      `update agent_memory set items = $1, revision = revision + 1
         where scope_key = $2 and revision = $3
       returning revision`,
      [items, scopeKey(scope), revision],
      { signal },
    )

    if (updated === null) return { status: 'conflict' }
    return { status: 'committed', revision: updated.revision }
  },
})
```

| Phương thức | Mục đích |
| --- | --- |
| `load({ scope, signal })` | Trả về `revision` và `items` hiện tại |
| `commit({ scope, revision, items, signal })` | Chỉ ghi **nếu** revision vẫn khớp |

Cả hai đều nhận tín hiệu huỷ của thao tác. Hãy chuyển tiếp nó — một lần ghi bộ
nhớ sống lâu hơn một lượt chạy đã bị huỷ đúng là loại công việc mồ côi mà SDK
được thiết kế để tránh.

## Revision chính là điểm mấu chốt

Kho này **có revision**, không phải last-write-wins. `commit()` nhận revision mà
SDK đã đọc và phải từ chối ghi nếu bản ghi đã bị đổi bên dưới.

```ts
return { status: 'conflict' }   // SDK nạp lại và thử lại với trạng thái mới
```

Không có compare-and-swap, hai session dùng chung một phạm vi bộ nhớ sẽ âm thầm
ghi đè quyết định của nhau — và vì bộ nhớ là thứ model coi là có thẩm quyền, sự
hỏng đó vô hình cho tới khi agent tự mâu thuẫn với chính mình.

## Phạm vi

```ts
const agent = runtime.agent({
  id: 'migration-agent',
  model,
  instructions: '…',
  memory: { store: pgMemory, scope: { kind: 'conversation' } },
})
```

| Phạm vi | Khoá | Dùng cho |
| --- | --- | --- |
| `conversation` | `conversationId` của session | Bộ nhớ của một luồng |
| `fixed` | Khoá do caller cấp | Bộ nhớ dùng chung nhiều session — một dự án, một người dùng, một không gian làm việc |

```ts
// Một bộ nhớ cấp workspace, dùng chung cho mọi session trong đó:
memory: { store: pgMemory, scope: { kind: 'fixed', key: `workspace:${workspaceId}` } }
```

Ghi đè theo từng session được hỗ trợ:

```ts
const session = agent.createSession({
  memory: { store: pgMemory, scope: { kind: 'fixed', key: tenantKey } },
})

const noMemory = agent.createSession({ memory: false })
```

**Danh tính gắn kết snapshot** được ghi lại, nên một snapshot chụp dưới một phạm
vi không thể âm thầm khôi phục dưới phạm vi khác. Đó chính là bảo đảm cô lập giữa
các tenant: một session được khôi phục không thể kế thừa bộ nhớ của tenant khác vì
phần gắn kết không còn khớp.

## Quyền sở hữu

Một memory store là **đang mượn**. Runtime dùng nó và không bao giờ đóng nó — bạn
sở hữu connection pool, việc shutdown, và việc thử lại của nó.

| Nhãn | Nghĩa là |
| --- | --- |
| `borrowed-caller-owned` | Runtime đọc và ghi; bạn đóng nó |

```ts
try {
  await runtime.close()
} finally {
  await db.end()          // kho của bạn, shutdown của bạn
}
```

## Các chặn trên vẫn áp dụng

Kho của bạn không lách được giới hạn của SDK. Các đường khôi phục kiểm tra
**trước khi công bố**:

| Giới hạn | Mặc định |
| --- | --- |
| Số mục giữ lại | 1.024 |
| Ký tự mỗi mục | 65.536 |
| Tổng nội dung | 1 MiB |
| Ký tự tiêm vào mỗi yêu cầu | 12.000 |

Một kho trả về 50.000 mục không đưa được 50.000 mục vào ngữ cảnh — phần nạp được
kiểm tra và chặn trước. Chỉ các trường đã ghi tài liệu được chuẩn hoá; trường lạ
bị loại bỏ.

## Lỗi

`MEMORY_ERROR_CODES` mang tập đóng các mã lỗi bộ nhớ. Kho thất bại được nêu ra
dưới dạng lỗi có kiểu, không phải một bộ nhớ rỗng âm thầm — một agent chạy mà
**không** có mục tiêu vì cơ sở dữ liệu sập là thất bại bạn muốn thấy.

Thao tác bộ nhớ xuất hiện trên bus quan sát dưới tên `sdk.memory.operation` với
**số lần** load/append/save và **không bao giờ** kèm thân message.

## Đường lạc quan

`defineMemoryStore()` thuộc họ memory-store *lạc quan*: SDK đọc, làm việc, rồi
commit kèm kiểm tra revision, thay vì giữ khoá suốt cả một lượt. Nhờ vậy một kho
chậm không tuần tự hoá các agent của bạn, và việc giải quyết xung đột được đẩy về
đúng nơi duy nhất nhìn thấy cả hai phiên bản.

## Đọc tiếp

- [Short-term Memory](/vi/05-memory/short-term-memory) — bộ nhớ giữ gì và kết xuất thế nào
- [Persistent Memory](/vi/05-memory/persistent-memory) — đường snapshot dựng sẵn
