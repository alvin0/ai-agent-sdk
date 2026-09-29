# Program tool experimental

Các API này thuộc **0.1.5**, hiện chưa phát hành. Tool thông thường vẫn hoạt động mà
không cần chúng. Program là tool exclusive do host định nghĩa, gọi child tool
được cấp grant qua scheduler hiện có, không cần model round trung gian.

## Grant rõ ràng

Đăng ký program và child như tool bình thường, rồi cấu hình session:

```ts
const session = agent.createSession({
  experimentalPrograms: [{ tool: 'lookup_pair', allow: ['lookup'], maxCalls: 2 }],
})
```

Trong `execute` của program, lấy `experimentalNestedToolPort(ctx)` từ
`@alvin0/ai-agent-sdk-core/tools`. Hàm trả undefined khi chưa gắn port. Xử lý
trường hợp này thay vì gọi child trực tiếp để bỏ qua grant. Dùng
`port.call(name, args)` tuần tự và kiểm tra `result.ok`. `catalog()` chỉ liệt kê
tool được cấp grant.

Program không được concurrency-safe/budget-exempt hoặc gọi program khác được
grant, kể cả chính nó. `maxCalls` tính child request kể cả child được miễn
budget. Outer call và child không được miễn dùng cùng tool budget gốc. Mỗi child
đi qua policy, approval, checkpoint, cancellation, timeout và xử lý output sau
policy. Checkpoint/interceptor nhận `parentCallId`; child call không vào history
mà model nhìn thấy.

## Kiểm tra và giữ child value

`experimentalOutputSchema` tùy chọn trên child kiểm tra JSON value đã finalize
khi schema được hỗ trợ. Schema thiếu/không được hỗ trợ cho
`schema: 'unchecked'`; không coi đây là hợp đồng typed đã kiểm tra. Schema của
MCP bridge mô tả `structuredContent` trong envelope trả về, không phải rendered text.

`port.call(name, args, { retain: true })` có thể trả handle. Hết sức chứa được
báo qua `retainRefused`; không bảo đảm luôn có handle. `load` và `release` dùng
handle theo scope program trong lượt hiện tại. Handle hết hạn khi lượt kết thúc,
không phải storage output bền vững.

## Gộp mutation và validation

Host cung cấp các tool definition `applyPatch` và `runValidation` dưới đây:

```ts
import { defineActionFusion } from '@alvin0/ai-agent-sdk-core/tools'

const fusion = defineActionFusion<{ patch: string }>({
  name: 'edit_and_validate',
  description: 'Apply a patch and run host-selected validation.',
  parameters: {
    type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'],
  },
  parse(raw) {
    if (typeof raw !== 'object' || raw === null || !('patch' in raw)
      || typeof raw.patch !== 'string') throw new TypeError('patch required')
    return { patch: raw.patch }
  },
  steps: [
    { tool: 'apply_patch', arguments: args => ({ patch: args.patch }) },
    { tool: 'run_validation', arguments: (_args, results) => ({ receipt: results[0] ?? null }),
      accept: value => typeof value === 'object' && value !== null
        && 'exitCode' in value && value.exitCode === 0 },
  ],
})
const agent = runtime.agent({
  id: 'editor', model, instructions: 'Use edit_and_validate for edits.',
  tools: [fusion.tool, applyPatch, runValidation],
})
const session = agent.createSession({ experimentalPrograms: [fusion.grant] })
```

Mapping và predicate `accept` phải đồng bộ. Pipeline dừng khi child thất bại
hoặc predicate không chấp nhận. Kiểm tra JSON `ok`, `completedSteps` và
`results`: outer tool thực thi thành công vẫn có thể báo `ok: false`.
Mutation trước đó vẫn được áp dụng nếu validation thất bại; không có rollback
hay tự replay mutation. Journal/interceptor của host có thể cung cấp operation
identity bền vững và quyết định recovery có an toàn hay không.

Xem [tối ưu context](/vi/05-memory/context-optimization),
[durable execution](/vi/03-tools/durable-execution) và
[nâng cấp từ 0.1.4](/vi/01-introduction/upgrading-from-0-1-4).
