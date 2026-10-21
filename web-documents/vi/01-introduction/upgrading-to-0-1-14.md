# Nâng cấp lên 0.1.14

Nâng cấp đồng loạt các package SDK lên **0.1.14**. Workspace có 28 manifest
package, trong đó 27 package được publish; `testkit` vẫn là private. Một lần push
lên `main` kích hoạt bước publish có kiểm soát, còn chạy Release thủ công mặc
định là dry run. Kiểm tra local không chứng minh việc publish lên npm hay CI
hosted đã thành công.

Mục 0.1.14 trong `CHANGELOG.md` của repository là nguồn chính thức. Trang này
liệt kê những gì host cần kiểm tra.

## Nội dung lỗi tool giờ có mã lỗi

Trước đây một lần gọi tool thất bại được gửi cho model dưới dạng `Error: message`.
Giờ nó được hiển thị là `[CODE] message`, ví dụ `[TOOL_TIMEOUT] the tool exceeded
its time limit`. Quy tắc này áp dụng cho lỗi tool ném ra, đối số không hợp lệ,
interceptor từ chối, phê duyệt bị từ chối và timeout.

```ts
// Giữ nguyên nội dung như 0.1.13.
const session = agent.createSession({ registry, toolErrorRendering: false })

// Hoặc tự hiển thị. Chỉ `code` và `message` được truyền vào.
const custom = agent.createSession({
  registry,
  toolErrorRendering: ({ code }) => `The tool failed (${code}). Try a different approach.`,
})
```

Nếu hàm hiển thị ném lỗi, trả về giá trị không phải chuỗi hoặc chuỗi rỗng, SDK
dùng dạng mặc định `[CODE] message`. Nội dung interceptor viết cho model được giữ
nguyên. Hãy cập nhật test hoặc prompt đang so khớp tiền tố `Error: `.

## Khám phá skill bỏ qua candidate không hợp lệ

Ở 0.1.13, chỉ một candidate không hợp lệ cũng làm hỏng toàn bộ lần khám phá
skill. Giờ candidate đó bị bỏ qua, phần còn lại của catalog vẫn dùng được và SDK
phát một diagnostic có giới hạn kích thước.

```ts
const session = agent.createSession({
  registry,
  onSkillDiagnostic: diagnostic => logger.warn('skill candidate rejected', diagnostic),
  // strictSkillCandidates: true, // khôi phục hành vi và lỗi "tất cả hoặc không" của 0.1.13
})
```

Mỗi diagnostic có `type: 'skill-candidate-rejected'`, `code:
'SKILL_CANDIDATE_REJECTED'`, một `providerId`, một `candidateId` tùy chọn (tối đa
128 ký tự) và một `reason` có kiểu như `name-invalid`, `provider-mismatch`,
`duplicate-id`, `candidate-limit` hoặc `catalog-byte-limit`. `validateCandidate()`
ném `SkillCandidateValidationError` với cùng `reason`. Provider có thể kiểm tra
metadata theo `SKILL_CANDIDATE_LIMITS` được export trước khi trả về.

## Mới: giữ lại số ảnh có giới hạn

`imageRetention` giới hạn số image block trong mỗi request gửi model. Tính năng
này tắt nếu bạn không đặt.

```ts
const session = agent.createSession({
  registry,
  imageRetention: { keepLatest: 2, persist: 'drop-pruned' },
})
console.log(session.imageRetentionStats())
```

Ảnh cũ hơn được thay bằng một placeholder văn bản ổn định ngay tại vị trí cũ, nên
cặp tool-call/tool-result vẫn hợp lệ với mọi provider. Với `persist: 'keep'` (mặc
định), snapshot giữ nguyên byte ảnh gốc. Với `'drop-pruned'`, byte ảnh cũng bị xóa
khỏi history và snapshot. Chính sách này là cấu hình của session: hãy truyền lại
khi gọi `resumeSession(snapshot, options)`.

## Mới: cổng hoàn tất và tiếp tục lượt

`hooks.beforeCompletion` chạy khi model tự dừng trong lúc vẫn còn dung lượng, trước
bước khôi phục câu trả lời rỗng. Hook này và `onTurnEnd` giờ có thể trả về
`{ kind: 'continue', messages }` để tiếp tục làm việc trong cùng lượt và cùng lần
chạy.

```ts
import { createUserMessage } from '@alvin0/ai-agent-sdk-core'

const session = agent.createSession({
  registry,
  hooks: {
    beforeCompletion: ({ canContinue }) => {
      if (!canContinue || reviewDone()) return
      return { kind: 'continue', messages: [createUserMessage({
        source: { kind: 'app', producer: 'review-gate' },
        content: [{ type: 'text', text: 'The review is not done yet. Continue.' }],
      })] }
    },
  },
})
```

Mọi message phải là user message có `source.kind: 'app'`; nếu không, cả lô bị từ
chối và không message nào được thêm vào. Một lô rỗng không tiếp tục lượt. Việc
tiếp tục bị bỏ qua khi lượt đã hết ngân sách, lỗi hoặc bị hủy. Hãy tự giới hạn số
lần phản đối lặp lại trong cổng của bạn.

## Mới: tổng usage

`getUsageTotals(response.usage)` từ `@alvin0/ai-agent-sdk-core/agent` trả về
`inputTokens`, `outputTokens`, `cachedInputTokens` và `reasoningTokens`. Bộ đếm mà
provider không báo cáo là `undefined`, không phải 0. `RunUsageReport` đầy đủ không
thay đổi.

## Thay đổi khác

- Lỗi transport gốc của Bun như `ECONNRESET` hoặc `ETIMEDOUT` giờ được xem là lỗi
  mạng thay vì lỗi model sai định dạng.
- `@modelcontextprotocol/server` và `@modelcontextprotocol/client` lên 2.3.1, vá các
  advisory mức nghiêm trọng cao trong MCP server SDK.

## Danh sách kiểm tra

1. Nâng cấp đồng loạt mọi package `@alvin0/ai-agent-sdk-*` lên 0.1.14.
2. Cập nhật test hoặc prompt so khớp tiền tố lỗi tool `Error: `, hoặc đặt
   `toolErrorRendering: false`.
3. Quyết định có giữ việc khám phá skill ở chế độ dễ dãi không. Thêm log qua
   `onSkillDiagnostic`, hoặc đặt `strictSkillCandidates: true`.
4. Tùy chọn: đặt `imageRetention` cho session nhiều ảnh, và truyền lại khi resume.
5. Chạy bộ test của bạn.

## Liên quan

- [Xử lý lỗi tool](/vi/03-tools/error-handling)
- [Tải skill](/vi/04-skills/loading-skills)
- [Tối ưu ngữ cảnh](/vi/05-memory/context-optimization)
- [Vòng đời agent](/vi/02-agents/lifecycle)
- [Quan sát hệ thống](/vi/10-advanced/observability)
- [Nâng cấp lên 0.1.13](/vi/01-introduction/upgrading-to-0-1-13)
