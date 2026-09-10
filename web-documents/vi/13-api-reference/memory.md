# `Memory`

Import từ `@alvin0/ai-agent-sdk-core/memory`.

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
interface MemoryStore {
  readonly kind: 'memory-store'
  readonly apiVersion: 1
  readonly id: string
  readonly load: (key: string, options: MemoryStoreOptions) => Promise<MemoryLoadResult | undefined>
  readonly commit: (input: MemoryCommitInput, options: MemoryStoreOptions) => Promise<MemoryCommitResult>
}

/** Thứ bạn truyền vào defineMemoryStore(); kind và apiVersion do SDK thêm. */
type MemoryStoreDefinition = Omit<MemoryStore, 'kind' | 'apiVersion'>

interface MemoryStoreOptions {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}
```

`load()` được định địa chỉ bằng **key**, không phải bằng scope — scope trên
binding là thứ runtime dùng để tạo ra key đó. Trả về `undefined` nghĩa là "chưa
lưu gì", khác với một snapshot rỗng.

```ts
interface MemoryLoadResult {
  readonly snapshot: AgentMemorySnapshot
  readonly revision: string
}

interface MemoryCommitInput {
  readonly key: string
  readonly snapshot: AgentMemorySnapshot
  readonly expectedRevision: string | null   // null ở lần ghi đầu
}

interface MemoryCommitResult {
  readonly revision: string
}
```

Revision là một **string** do kho tự quản; SDK chỉ trả lại đúng giá trị nó đã
nhận. Kho mang cả một `AgentMemorySnapshot`, không phải danh sách item trần.

Kho này **có revision**, không phải last-write-wins: `commit()` phải tôn trọng
`expectedRevision` và làm ghi thất bại khi bản ghi đã bị đổi bên dưới, để một
writer song song không bị ghi đè âm thầm.

```ts
const pgMemory = defineMemoryStore({
  id: 'pg-memory',
  load: async (key, { signal }) => {
    const row = await db.selectMemory(key, { signal })
    return row === undefined ? undefined : { snapshot: row.snapshot, revision: row.revision }
  },
  commit: async ({ key, snapshot, expectedRevision }, { signal }) => {
    const revision = await db.compareAndSetMemory(key, snapshot, expectedRevision, { signal })
    return { revision }
  },
})
```

## `MemoryScope`

```ts
type MemoryScope =
  | { readonly kind: 'conversation'; readonly namespace: string }
  | { readonly kind: 'fixed'; readonly key: string; readonly sharedAcrossSessions: true }
```

Phạm vi `conversation` khoá theo `conversationId` của session **bên trong**
`namespace`, nên hai tenant không thể trùng nhau. Phạm vi `fixed` buộc phải nói
rõ `sharedAcrossSessions: true` — chia sẻ state giữa các hội thoại không bao giờ
là thứ bạn nhận được do vô tình.

**Danh tính gắn kết snapshot** được ghi lại, nên một snapshot chụp dưới một phạm
vi không thể âm thầm khôi phục dưới phạm vi khác — đó chính là bảo đảm cô lập
giữa các tenant.

## `MemoryBinding`

```ts
interface MemoryBinding {
  readonly store: MemoryStore
  readonly bindingId: string                          // được ghi vào snapshot
  readonly scope: MemoryScope
  readonly requirement: 'required' | 'best-effort'
}
```

Mọi field đều bắt buộc — không có binding thiếu phần, vì mỗi field đổi chính cái
mà một snapshot khôi phục được phép làm.

```ts
// Trên một agent
runtime.agent({
  /* … */
  memory: {
    store: pgMemory,
    bindingId: 'billing-memory',
    requirement: 'required',
    scope: { kind: 'conversation', namespace: 'tenant-42' },
  },
})

// Theo từng session, hoặc tắt cho hội thoại này
agent.createSession({
  memory: {
    store: pgMemory,
    bindingId: 'team-memory',
    requirement: 'best-effort',
    scope: { kind: 'fixed', key: 'release-team', sharedAcrossSessions: true },
  },
})
agent.createSession({ memory: false })
```

`memory: false` là tuỳ chọn của **session**; một definition nhận `MemoryBinding`
hoặc không nhận gì.

Seed và việc bắt mục tiêu **không** thuộc binding — chúng thuộc memory config
của agent:

```ts
interface AgentMemoryConfigInput {
  readonly autoCaptureObjective?: boolean   // mặc định true
  readonly maxInjectedChars?: number        // mặc định 12.000
  readonly maxItems?: number                // mặc định 1.024
  readonly maxItemChars?: number            // mặc định 65.536
  readonly maxStoredChars?: number          // mặc định 1 MiB
  readonly seed?: readonly AgentMemorySeed[]
}
```

## Các mục bộ nhớ

```ts
type AgentMemoryKind =
  | 'objective' | 'constraint' | 'decision' | 'fact' | 'progress' | 'next-step'

interface AgentMemorySeed {
  readonly id?: string        // dùng lại một id sẽ CẬP NHẬT mục đó
  readonly kind: AgentMemoryKind
  readonly content: string
}

interface AgentMemoryItem extends AgentMemorySeed {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
}
```

Accessor `.memory` nằm trên `AgentSession` của **tầng `defineAgent()`**.
`RuntimeAgentSession` — thứ `runtime.agent().createSession()` trả về — chỉ có
`conversationId`, `isRunning`, `run`, `stream`, `inject`, `snapshot`, `compact`,
`reset` và `whenIdle`.

```ts
const session = ada.createSession({ registry })

session.memory.remember({ kind: 'decision', content: 'Use a transactional outbox.' })
session.memory.forget('release-constraint')
session.memory.items()
session.memory.render(12_000)
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
