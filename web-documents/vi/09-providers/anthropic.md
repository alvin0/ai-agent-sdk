# Anthropic

Runtime: **Universal** — Edge/Worker, trình duyệt, Deno, Bun, và Node.
Slot ghép nối: `runtime.providers`.
Vòng đời: `inert-runtime-owned-registration`.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-anthropic
```

Nhắm tới **Anthropic Messages API** thông qua
[`@alvin0/ai-agent-sdk-protocol-anthropic-messages`](/vi/09-providers/protocols).

## Ghép nối

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { anthropicPlugin } from '@alvin0/ai-agent-sdk-provider-anthropic'

const runtime = await createAgentRuntime({
  providers: [anthropicPlugin({ apiKey: () => secretStore.get('anthropic') })],
})

const agent = runtime.agent({
  id: 'reviewer',
  instructions: 'Review carefully and cite evidence.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
})
```

Thông tin xác thực được **tiêm vào**. Package là Universal và không bao giờ tự
đọc biến môi trường hay tệp; trên Node hãy dùng
`envCredential('ANTHROPIC_API_KEY')` từ `@alvin0/ai-agent-sdk-auth-node`.

## Export

```ts
export {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicAdapter,
  anthropicPlugin,
  type AnthropicAdapterOptions,
  type AnthropicCredential,
  type AnthropicPluginOptions,
  type AnthropicProviderOptions,
}
// Re-export cho tiện:
export {
  anthropicMessagesProtocol,
  type AnthropicDialect,
  type AnthropicReasoningState,
  type ThinkingBudgets,
}
```

| Export | Dùng để |
| --- | --- |
| `anthropicPlugin(options)` | **Khuyến nghị.** Đăng ký có giao dịch. |
| `anthropicAdapter(options)` | Tự đăng ký tuyến. |
| `ANTHROPIC_VERSION` | Header phiên bản API đã ghim mà adapter gửi đi. |
| `DEFAULT_THINKING_BUDGETS` | Ánh xạ mức nỗ lực suy luận sang ngân sách token suy nghĩ. |

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { anthropicPlugin } from '@alvin0/ai-agent-sdk-provider-anthropic'

const registry = new ModelRegistry()
registry.install(anthropicPlugin({ apiKey: () => secretStore.get('anthropic') }))
```

## Suy luận ánh xạ sang ngân sách suy nghĩ

Anthropic biểu diễn suy luận bằng **ngân sách token**, không phải mức nỗ lực.
Adapter làm cầu từ `effort` trung lập sang một ngân sách qua
`DEFAULT_THINKING_BUDGETS`:

```ts
runtime.agent({
  id: 'analyst',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
  instructions: '…',
  effort: 'medium',        // → một ngân sách token suy nghĩ
})
```

Ghi đè phép ánh xạ khi model hoặc khối lượng công việc của bạn cần một đường
cong khác:

```ts
anthropicPlugin({
  apiKey,
  thinkingBudgets: { low: 1_024, medium: 8_192, high: 32_768 },
})
```

`AnthropicReasoningState` mang trạng thái suy luận riêng tư của adapter, cần cho
việc phát lại.

## Năng lực

| Năng lực | Hỗ trợ | Khi không khớp |
| --- | --- | --- |
| Web search native | ✓ | — |
| Trạng thái phát lại kết quả/trích dẫn web-search đã mã hoá | ✓ được giữ | — |
| Sinh ảnh native | ✗ | `INVALID_REQUEST` có kiểu |
| Ảnh đầu vào qua URL / base64 | ✓ | — |
| Ảnh đầu vào qua `fileId` | ✗ | `INVALID_REQUEST` có kiểu |
| `detail: 'original'` | ✗ | `INVALID_REQUEST` có kiểu |
| Suy luận dưới dạng ngân sách suy nghĩ | ✓ | — |

**Các lựa chọn không hỗ trợ được báo thành lỗi có kiểu, không âm thầm bỏ qua.**
Đó là tính chất đáng dựa vào: một agent viết cho Responses không âm thầm mất bước
sinh ảnh khi bạn trỏ nó sang Anthropic — nó thất bại với một mã lỗi bạn có thể
phân nhánh theo.

```ts
try {
  await agent.generate(input)
} catch (error) {
  if (error instanceof AgentSdkError && error.code === MODEL_ERROR_CODES.INVALID_REQUEST) {
    // ví dụ: yêu cầu sinh ảnh native trên Anthropic
  }
}
```

### Trạng thái phát lại

Anthropic trả về kết quả web-search native và trích dẫn ở dạng **đã mã hoá**, và
chúng phải được phát lại nguyên văn ở yêu cầu kế tiếp. Adapter giữ chúng trong
`ReplayEnvelope` của chunk `finish` kết thúc, và bộ lắp ráp giữ metadata đó khớp
với nội dung đã lưu.

Bạn không bao giờ xử lý nó trực tiếp — nhưng đó là lý do một hội thoại Anthropic
có web search phải giữ lại các message đã lắp ráp, thay vì dựng lại từ văn bản.

## Khám phá model

```ts
const catalog = await runtime.modelCatalog('anthropic')
```

`model.id` là bắt buộc trừ khi tuyến đã có giá trị mặc định. Adapter khai báo dung
lượng ngữ cảnh tổng hợp, giới hạn output mặc định và cứng, các mức nỗ lực suy
luận, các phương thức, và hỗ trợ native tool — và `ModelRegistry` kiểm tra lựa
chọn **trước** khi có I/O tới nhà cung cấp.

## Chuyển được giữa hai nhà cung cấp

Mọi thứ phía trên adapter nói bằng từ vựng trung lập, nên cùng một định nghĩa
agent chạy được trên cả hai:

```ts
const definition = {
  id: 'reviewer',
  instructions: 'Review carefully and cite evidence.',
  tools: [readFile],
}

const onOpenAi = runtime.agent({ ...definition, model: { provider: 'openai', id: 'gpt-5.4' } })
const onAnthropic = runtime.agent({ ...definition, model: { provider: 'anthropic', id: 'claude-sonnet-4-5' } })
```

Thứ khác nhau đúng là bảng năng lực phía trên — và những khác biệt đó hiện ra
thành lỗi có kiểu, chứ không thành hành vi trôi lệch.

## Đọc tiếp

- [OpenAI](/vi/09-providers/openai) · [Codex](/vi/09-providers/codex)
- [Protocols](/vi/09-providers/protocols)
- [Native Tools](/vi/03-tools/native-tools)
