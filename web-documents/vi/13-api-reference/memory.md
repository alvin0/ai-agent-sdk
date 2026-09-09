# `Memory`

Import từ `@ai-agent-sdk/core/memory`.

```ts
export { defineMemoryStore, MEMORY_STORE_API_VERSION, MEMORY_ERROR_CODES }
export type {
  MemoryBinding, MemoryCommitInput, MemoryCommitResult, MemoryLoadResult,
  MemoryScope, MemoryStore, MemoryStoreDefinition, MemoryStoreOptions,
}
```

## `defineMemoryStore`

```ts
defineMemoryStore(definition: MemoryStoreDefinition): MemoryStore
```

```ts
interface MemoryStoreDefinition {
  readonly id: string
  readonly apiVersion: typeof MEMORY_STORE_API_VERSION

  load(input: { scope: MemoryScope; signal?: AbortSignal }): Promise<MemoryLoadResult>
  commit(input: MemoryCommitInput): Promise<MemoryCommitResult>
}
```

```ts
interface MemoryLoadResult {
  readonly revision: number
  readonly items: readonly MemoryItem[]
}

interface MemoryCommitInput {
  readonly scope: MemoryScope
  readonly revision: number          // revision mà load() đã trả về
  readonly items: readonly MemoryItem[]
  readonly signal?: AbortSignal
}

type MemoryCommitResult =
  | { readonly status: 'committed'; readonly revision: number }
  | { readonly status: 'conflict' }
```

Kho này **có revision**, không phải last-write-wins. `commit()` phải từ chối ghi
nếu bản ghi đã bị đổi bên dưới và trả về `conflict`; sau đó SDK nạp lại và thử
lại với trạng thái mới.

## `MemoryScope`

```ts
type MemoryScope =
  | { readonly kind: 'conversation' }               // khoá theo conversationId của session
  | { readonly kind: 'fixed'; readonly key: string } // dùng chung nhiều session
```

**Danh tính gắn kết snapshot** được ghi lại, nên một snapshot chụp dưới một phạm
vi không thể âm thầm khôi phục dưới phạm vi khác — đó chính là bảo đảm cô lập
giữa các tenant.

## `MemoryBinding`

```ts
interface MemoryBinding {
  readonly store?: MemoryStore
  readonly scope?: MemoryScope
  readonly seed?: readonly MemoryItemInput[]
  readonly autoCaptureObjective?: boolean            // mặc định true
}
```

```ts
// Trên một agent
runtime.agent({ /* … */, memory: { store, scope: { kind: 'conversation' } } })

// Theo từng session, hoặc tắt hẳn
agent.createSession({ memory: { store, scope: { kind: 'fixed', key } } })
agent.createSession({ memory: false })
```

## Các mục bộ nhớ

```ts
type MemoryItemKind =
  | 'objective' | 'constraint' | 'decision' | 'fact' | 'progress' | 'next-step'

interface MemoryItemInput {
  readonly id?: string        // dùng lại một id sẽ CẬP NHẬT mục đó
  readonly kind: MemoryItemKind
  readonly content: string
}
```

```ts
session.memory.remember({ kind: 'decision', content: 'Use a transactional outbox.' })
session.memory.forget('release-constraint')
session.memory.items()
```

Việc kết xuất có chặn trên và ưu tiên mục tiêu, ràng buộc, quyết định. Bộ nhớ đến
dưới dạng ngữ cảnh **user** do app soạn, trong `<task-memory>`, không bao giờ dưới
dạng chỉ dẫn hệ thống.

## Nén ngữ cảnh

```ts
interface AgentCompactionOptions {
  readonly thresholdRatio?: number        // 0.8
  readonly retainRatio?: number           // 0.2
  readonly maxSummaryTokens?: number
  readonly maxOverflowRetries?: number    // 1
  readonly maxToolResultChars?: number
}
```

```ts
const result: CompactionResult | null = await session.compact({ signal })
result?.shadowedSeqs
result?.estimatedTokensAfter
```

`compaction: false` tắt việc checkpoint. `session.compact()` chiếm cùng khoá loại
trừ theo session như một lượt model.

## Snapshot của session

```ts
interface RuntimeAgentSessionSnapshot extends AgentSessionSnapshot {
  readonly memoryBindingId?: string
}
```

An toàn JSON, có phiên bản. Chứa `conversationId`, danh tính agent, lịch sử
chỉ-thêm, bộ nhớ bền vững, và **danh tính** của các skill đã kích hoạt. Phần thân
và tài nguyên của skill **không bao giờ** được lưu.

Phương án tầng thấp, cho ứng dụng nào cố ý quản lý hai kho này độc lập:

```ts
History.fromSnapshot(snapshot)
AgentMemory.fromSnapshot(snapshot)
```

## Các chặn trên

| Giới hạn | Mặc định |
| --- | --- |
| Số mục giữ lại | 1.024 |
| Ký tự mỗi mục | 65.536 |
| Tổng nội dung | 1 MiB |
| Ký tự tiêm vào mỗi yêu cầu | 12.000 |
| Số mục lịch sử | 100.000 |
| Byte mỗi mục lịch sử | 16 MiB |
| Tổng byte lịch sử | 128 MiB |

Các đường khôi phục kiểm tra giới hạn **trước khi công bố** và chỉ chuẩn hoá các
trường đã ghi tài liệu.

## Quyền sở hữu

Một memory store là `borrowed-caller-owned`: runtime đọc và ghi, và **không bao
giờ đóng nó**. Thao tác bộ nhớ xuất hiện trên bus quan sát dưới tên
`sdk.memory.operation` với **số lần** load/append/save và không bao giờ kèm thân
message.

## Đọc tiếp

- [Memory](/vi/05-memory/) — bản kể chuyện
- [Custom Memory Provider](/vi/05-memory/custom-memory-provider)
