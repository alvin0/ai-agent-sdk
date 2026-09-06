# Creating an Agent

## `runtime.agent()`

```ts
const agent = runtime.agent({
  // Danh tính
  id: 'reviewer',
  name: 'Release Reviewer',
  description: 'Reviews release candidates and reports concrete risks.',

  // Tuyến model
  model: { provider: 'openai', id: 'gpt-5.4' },
  effort: 'medium',
  maxTokens: 16_384,
  outputFormat: { type: 'text' }, // hoặc JSON Schema có tên cho câu trả lời cuối

  // Hành vi
  instructions: 'Review carefully and cite evidence.',
  mode: 'basic',                 // 'basic' | 'deep' | 'deep-human-in-loop'
  commentary: 'concise',         // 'auto' | 'concise' | 'off'
  maxTurns: 16,
  maxToolCalls: 64,

  // Năng lực
  tools: [readFile],
  nativeTools: [{ type: 'native', name: 'web-search' }],
  toolChoice: 'auto',
  toolSources: [mcpConnection],
  skills: [skillProvider],
  allowedSkillIds: ['release-review'],

  // Liên tục
  memory: memoryBinding,
  compaction: { thresholdRatio: 0.8, retainRatio: 0.2 },
})
```

### Toàn bộ các trường

| Trường | Kiểu | Ghi chú |
| --- | --- | --- |
| `id` | `string` | **Bắt buộc.** Danh tính ổn định; được phát ra trên span vết. |
| `name` | `string` | Nhãn cho người đọc, dùng ở giao diện và A2A Agent Card. |
| `description` | `string` | Dùng bởi `createAgentCardFromDefinition()` và danh bạ team. |
| `model` | `{ provider, id? }` | Tuyến. `id` có thể bỏ trống khi provider đã có mặc định. |
| `instructions` | `string` | **Bắt buộc** trong một định nghĩa. Xem [Agent Instructions](/vi/02-agents/agent-instructions). |
| `effort` | `string` | Mức nỗ lực suy luận. Đối chiếu với các mức model khai báo. |
| `maxTokens` | `number` | Trần output. Đối chiếu trần cứng của model trước khi có I/O. |
| `outputFormat` | `ModelOutputFormat` | Văn bản hoặc JSON Schema có tên cho câu trả lời cuối. |
| `mode` | `'basic' \| 'deep' \| 'deep-human-in-loop'` | Chính sách thực thi. |
| `commentary` | `'auto' \| 'concise' \| 'off'` | Tường thuật tiến độ. |
| `maxTurns` | `number` | Số bước model. Mặc định 16. |
| `maxToolCalls` | `number` | Số tool được điều phối. Mặc định 64. |
| `tools` | `ToolDefinition[]` | Hàm của host, do bộ lập lịch thực thi. |
| `nativeTools` | `NativeToolSchema[]` | Nhà cung cấp thực thi. Bộ lập lịch không bao giờ chạy chúng. |
| `toolChoice` | `ToolChoice` | Chọn tool: bắt buộc/tự động/không. |
| `toolSources` | `ToolSource[]` | Cả một danh mục, ví dụ một kết nối MCP. |
| `skills` | `RuntimeSkillSource[]` | Năng lực tiết lộ dần. |
| `allowedSkillIds` | `string[]` | Ranh giới uỷ quyền, không phải danh sách kích hoạt. |
| `memory` | `MemoryBinding` | Bộ nhớ tác vụ bền vững. |
| `compaction` | `AgentCompactionOptions \| false` | Chính sách checkpoint ngữ cảnh. |

## `defineAgent()`

Cùng mô hình đó, biểu diễn thành giá trị đóng băng ở phạm vi module. Lưu ý các
trường model phẳng hơn:

```ts
export const ada = defineAgent({
  id: 'ada',
  name: 'Ada',
  description: 'Explains and reviews TypeScript code.',
  instructions: 'Be precise, inspect evidence before concluding, and keep answers concise.',
  provider: 'codex',
  model: 'gpt-5.6-luna',
  effort: 'medium',
  mode: 'basic',
  maxTurns: 16,
  maxToolCalls: 64,
  commentary: 'concise',
})
```

Bỏ trống `provider`, `model`, và `effort` trong một định nghĩa sẽ chọn Codex
`gpt-5.6-luna` ở mức `medium`. Đó là một mặc định đã được rà soát và phê duyệt
tường minh, không phải phương án dự phòng ngầm — và nó **chỉ** áp dụng cho
`defineAgent()`.

## Tuyến model được giải quyết thế nào

```text
model: { provider: 'openai', id: 'gpt-5.4' }   → đúng tuyến + đúng model
model: { provider: 'openai' }                   → model mặc định của tuyến
bỏ trống model                                  → provider đã chọn, hoặc provider mặc định duy nhất, của runtime
defineAgent() không có provider/model           → Codex gpt-5.6-luna, effort medium
```

Ngoài các trường hợp trên thì **không có model mặc định**. Danh mục model của nhà
cung cấp thay đổi nhanh hơn nhịp phát hành của package này, nên bất kỳ mặc định
dựng sẵn nào rồi cũng trỏ vào một model đã ngừng phục vụ.

Nhiều tài khoản cùng một họ provider ghép với nhau qua ID và tuyến thực thể tường
minh, nên `{ provider: 'openai-eu' }` và `{ provider: 'openai-us' }` là không
nhập nhằng.

## Dẫn xuất agent

Định nghĩa không bao giờ bị thay đổi tại chỗ.

```ts
// Biến thể cục bộ, giữ nguyên danh tính:
const deepAda = ada.with({ mode: 'deep', maxTurns: 24 })

// Agent dẫn xuất với danh tính ổn định MỚI:
const reviewer = cloneAgent(ada, {
  id: 'reviewer',
  name: 'Reviewer',
  instructions: 'Find correctness risks and cite the relevant evidence.',
})
```

Dùng `.with()` khi chỉ đổi chính sách tạm thời; dùng `cloneAgent()` khi agent dẫn
xuất sẽ xuất hiện trong vết, danh bạ team, hoặc snapshot dưới tên riêng của nó.
Snapshot của session ghi lại id agent, và khôi phục với id khác sẽ thất bại sớm.

## Kiểm tra diễn ra trước khi có I/O

`ModelRegistry` chụp lại năng lực khai báo của từng adapter và từ chối lựa chọn
bất khả thi **trước** mọi lời gọi mạng:

| Lựa chọn | Bị từ chối với |
| --- | --- |
| Mức nỗ lực suy luận không hỗ trợ | `UNSUPPORTED_REASONING_EFFORT` |
| Native tool không hỗ trợ | `UNSUPPORTED_NATIVE_TOOL` |
| `maxTokens` vượt trần cứng | `OUTPUT_TOKEN_LIMIT_EXCEEDED` |
| Tuyến provider không tồn tại | `NO_ADAPTER` |

Những lỗi này không tốn chi phí — không có yêu cầu nào được gửi đi.

## Tạo một session

```ts
const session = agent.createSession({
  conversationId: 'thread-42',
  tools: [extraTool],            // gộp với tool do định nghĩa sở hữu
  toolSources: [requestScopedMcp],
  skills: [requestScopedSkills],
  memory: false,                 // tắt bộ nhớ cho session này
  skillCwd: process.cwd(),
  userInput: broker,             // bắt buộc với 'deep-human-in-loop'
  approvals: approvalBroker,
  interceptors: [auditInterceptor],
  hooks: turnHooks,
  usagePolicy,
  historyLimits: { maxEntries: 5_000, maxBytes: 32 * 1024 * 1024 },
  ledgerLimits: { maxSerializedBytes: 8 * 1024 * 1024 },
  eventBufferLimits: { maxEvents: 2_000, maxBytes: 4 * 1024 * 1024 },
  runtimeLimits: {
    maxTotalTokens: 250_000,
    maxToolResultBytes: 1_048_576,
    memoryOperationTimeoutMs: 30_000,
  },
  compaction: { thresholdRatio: 0.75 },
})
```

`tools` ở mức session được **gộp** với tool do định nghĩa sở hữu, không thay thế.
`compaction` và `runtimeLimits` ở mức session thì ghi đè định nghĩa. Các giới hạn
history, ledger và event buffer chặn working set được giữ lại của từng session.
`memoryOperationTimeoutMs` giới hạn từng callback memory-store của host; commit
mất phản hồi xác nhận được báo là `MEMORY_COMMIT_OUTCOME_UNKNOWN` và không tự động
retry.

## Đọc tiếp

- [Agent Instructions](/vi/02-agents/agent-instructions)
- [Agent Context](/vi/02-agents/agent-context)
- [Tham chiếu API `Agent`](/vi/13-api-reference/agent)
