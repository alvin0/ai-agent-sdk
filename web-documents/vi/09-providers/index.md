# Providers — Tổng quan

## Hai tầng, một quy tắc

**Adapter là tầng duy nhất biết định dạng wire.** Một package provider cung cấp
bốn thứ — `connect`, `endpointPath`, `buildBody`, `translate` — và `stream()` nằm
ở lớp cơ sở, không nằm trong provider.

Chính quy tắc duy nhất đó ngăn một provider tự viết vòng lặp fetch riêng rồi quên
header quy kết, xử lý sai abort, hoặc bịa mã lỗi.

## Provider dựng sẵn

| Điểm vào | Endpoint | Thông tin xác thực |
| --- | --- | --- |
| `@alvin0/ai-agent-sdk-provider-anthropic` | Messages API | `apiKey` tiêm vào |
| `@alvin0/ai-agent-sdk-provider-openai` | Responses API | `apiKey` tiêm vào |
| `@alvin0/ai-agent-sdk-provider-codex` | Codex nền ChatGPT | `CodexAuthStore` tiêm vào |
| `@alvin0/ai-agent-sdk-provider-gemini` | Gemini Interactions API | `apiKey` tiêm vào |
| `@alvin0/ai-agent-sdk-provider-copilot` | Bề mặt subscription Copilot | `CopilotCredentialStore` tiêm vào |
| `@alvin0/ai-agent-sdk-auth-node/codex` | Codex trên Node | đăng nhập device-code cục bộ theo dự án |
| `@alvin0/ai-agent-sdk-auth-node/copilot` | Copilot trên Node | đăng nhập device-code cục bộ theo dự án |

`openai` và `codex` dùng chung **một** hiện thực Responses
(`@alvin0/ai-agent-sdk-protocol-responses`) và chỉ khác nhau ở một bản ghi phương ngữ
nhỏ: base URL, cách xác thực, và endpoint chấp nhận những trường tuỳ chọn nào.

Mọi package provider đều là Universal và đòi thông tin xác thực tường minh. Nó
không bao giờ đọc biến môi trường hay tệp — việc tra cứu môi trường thuộc về một
lớp bọc Node như `@alvin0/ai-agent-sdk-auth-node`.

Bảng trên là danh sách cho **generation**. Embedding là một năng lực riêng với
plugin kind riêng: `openAiEmbeddingPlugin()` và `geminiEmbeddingPlugin()` cài cạnh
một plugin generation trên cùng runtime. Xem
[Embeddings](/vi/09-providers/embeddings).

## Hai kiểu đăng ký

Mới trong 0.1.2: [Gateway tương thích và credential trong database](/vi/09-providers/gateways-and-credentials).

**Plugin (khuyến nghị).** Một đăng ký có giao dịch mà runtime kích hoạt và gỡ bỏ:

```ts
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const apiKey = defineCredentialSource({
  id: 'openai',
  resolve: () => secretStore.get('openai'),
})

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey })],
})
```

**Adapter (tuyến thủ công).** Điều khiển registry trực tiếp:

```ts
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const registry = new ModelRegistry()
registry.registerAdapter(['openai'], openAiAdapter({ apiKey }))
```

`registry.install(plugin)` cũng nhận thẳng một plugin.

## Registry làm nhiều hơn định tuyến

`ModelRegistry` kiểm tra và chụp lại năng lực khai báo của từng adapter, và
`prepareCall()` trả về một ảnh chụp năng lực `model` **gắn theo thế hệ**: cửa sổ
ngữ cảnh tổng hợp, giới hạn output mặc định và cứng, các mức nỗ lực suy luận, các
phương thức đầu vào/đầu ra, và hỗ trợ native tool tường minh.

Trước bất kỳ thao tác I/O nào tới nhà cung cấp, registry:

- hiện thực hoá các giá trị mặc định của model;
- từ chối mức nỗ lực suy luận không hỗ trợ (`UNSUPPORTED_REASONING_EFFORT`);
- từ chối native tool không hỗ trợ (`UNSUPPORTED_NATIVE_TOOL`);
- từ chối lựa chọn output vượt trần cứng của model
  (`OUTPUT_TOKEN_LIMIT_EXCEEDED`);
- chỉ chiếu bỏ ảnh đầu vào với những model khai báo rõ là không có thị giác;
- ngăn phần dự trữ output nuốt trọn cửa sổ ngữ cảnh tổng hợp.

Đây là bất biến thực thi, không phải trường danh mục chỉ để hiển thị. Việc nén
ngữ cảnh tự động cũng dành sẵn khoảng output của model đã chọn, thay vì lấp đầy
toàn bộ cửa sổ tổng hợp.

## Cấu hình context và giới hạn output

SDK chọn ngân sách context ở bậc giá tiêu chuẩn cho đúng model đã xác minh trên
endpoint chính thức; không tự chọn context mở rộng có phụ thu. Chính sách kiểm tra
ngày 2026-09-13:

| Provider/model | Context vận hành mặc định | Trần kỹ thuật tổng đã biết |
| --- | ---: | ---: |
| OpenAI GPT-5.6 Luna, Sol, Terra | 272.000 | 1.050.000 |
| Anthropic Opus 4.6/4.7/4.8/5, Sonnet 4.6/5, Fable 5/5.1, Mythos 5/5.1/Preview | 1.000.000 | 1.000.000 |
| Gemini 2.5 Pro, 3.1 Pro Preview (gồm customtools) | 200.000 | Chưa biết: input/output được công bố riêng |
| Gemini 2.5 Flash, 3 Flash Preview | 1.000.000 | Chưa biết: input/output được công bố riêng |
| Model chưa rõ của OpenAI / Anthropic / Gemini | 128.000 / 200.000 / 200.000 | Chưa biết |

Nguồn: [OpenAI Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[Claude context](https://platform.claude.com/docs/en/build-with-claude/context-windows),
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
Chính sách context không tự quảng cáo model có sẵn hoặc các capability của model.
Alias chưa xác minh và base URL tùy chỉnh không kế thừa chính sách endpoint gốc.

Ưu tiên: `models[].contextWindow` tường minh → `defaultContextWindow` tường minh
ở provider → `defaultContextWindow` của model → fallback provider.
Catalog tùy chỉnh có thể khai báo `defaultContextWindow`, `maxContextWindow` và
`standardPriceInputTokens`. Override không nâng được trần kỹ thuật chính thức đã
biết; số không hợp lệ hoặc vượt trần báo lỗi, không âm thầm cắt xuống.

Ví dụ chủ động bật context lớn hơn:

```ts
openAiPlugin({
  apiKey,
  models: [{ id: 'gpt-5.6-luna', contextWindow: 800_000 }],
})
```

`ModelContext` đã resolve cung cấp `contextWindow` hiệu lực và các thông số đã biết:
`defaultContextWindow`, `maxContextWindow`, `standardPriceInputTokens`.
Nếu ngân sách vượt ngưỡng giá đã biết, metadata có thêm
`pricingWarning: 'extended-context-may-cost-more'` để host hiển thị; đây không phải
console log hay khẳng định request sẽ bị phụ thu. Ngưỡng chưa biết vẫn để trống.
Compaction dùng context hiệu lực, trừ dự trữ output và giữ tỷ lệ an toàn hiện có.
Đây không phải bộ chặn hóa đơn bằng tokenizer chính xác và không bảo đảm tổng phí.

Bạn khai báo các giới hạn này khi tạo plugin hoặc adapter của provider. Các
provider dựng sẵn dựa trên HTTP nhận `models`, `defaultContextWindow` và
`defaultMaxTokens`. ID model và số liệu dưới đây chỉ minh họa, không phải
thông số model thật; hãy thay bằng giá trị đúng với endpoint của bạn.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({
    apiKey: 'YOUR_API_KEY',
    defaultContextWindow: 128_000,
    defaultMaxTokens: 8_192,
    models: [
      { id: 'model-a', contextWindow: 128_000, maxTokens: 16_384 },
      { id: 'model-b', contextWindow: 200_000, maxTokens: 32_768 },
    ],
  })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'model-a' },
  maxTokens: 4_096,
})
```

| Cấu hình | Ý nghĩa |
| --- | --- |
| `models[].contextWindow` | Override ngân sách context input/output vận hành cho đúng ID model. |
| `models[].defaultContextWindow` | Context vận hành mặc định của model trước override. |
| `models[].maxContextWindow` | Trần kỹ thuật đã biết, độc lập ngân sách vận hành. |
| `models[].standardPriceInputTokens` | Ngưỡng giá theo input token, không phải tổng context. |
| `models[].maxTokens` | Trần output; cũng là mặc định nếu chưa đặt `models[].defaultMaxTokens`. |
| `models[].defaultMaxTokens` | Ngân sách output mặc định riêng cho model, độc lập với trần output. |
| `defaultContextWindow` | Override context vận hành ở provider; khi bỏ trống dùng chính sách model rồi fallback. |
| `defaultMaxTokens` | Ngân sách output fallback, không phải bằng chứng về trần output của model. |
| `maxTokens` của agent | Ngân sách output của agent; có thể thấp hơn trần model. |

Fallback áp dụng theo từng field, không chỉ khi model vắng trong catalog.
Nếu cũng bỏ trống mặc định của provider, SDK dùng mặc định dựng sẵn của adapter.
Đây là thông số SDK được khai báo, không bảo đảm tự đồng bộ với giới hạn mới
nhất của nhà cung cấp.

Ngân sách output lấy `maxTokens` tường minh của agent/call, nếu không có thì
lấy mặc định đã resolve của model. Vượt trần khai báo sẽ bị từ chối với
`OUTPUT_TOKEN_LIMIT_EXCEEDED`, không tự cắt xuống. Phần dự trữ output cũng
phải nhỏ hơn tổng context window.

Dùng `models[].defaultMaxTokens` để giữ output mặc định vừa phải trong khi khai
báo trần `maxTokens` cao hơn. Khi chưa biết trần, SDK không suy ra nó từ fallback;
request lớn hơn vẫn chịu kiểm tra phần context dự trữ và giới hạn phía server.
Catalog cũ chỉ khai báo `maxTokens` giữ nguyên mặc định và trần như trước.

### Context giá tiêu chuẩn và context mở rộng

Không tự thay context vận hành bằng mức tối đa model quảng cáo: context mở rộng
có thể bị tính phí cao hơn. Kiểm tra ngày 2026-09-13:
[OpenAI API GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
có context tối đa 1.050.000 và output tối đa 128.000 token, nhưng input vượt
272.000 token tính 2x giá input và 1,5x giá output cho toàn request.
Cấu hình vận hành theo giá tiêu chuẩn cho endpoint API này:

```ts
models: [{
  id: 'gpt-5.6-luna',
  contextWindow: 272_000, // Ngân sách vận hành, không phải context mở rộng tối đa.
  maxTokens: 128_000,
  defaultMaxTokens: 32_000,
}]
```

Ví dụ trên không bật context mở rộng. Endpoint Codex khác OpenAI API: catalog
live trả `context_window: 272000` và `max_context_window: 872000` cho cả Luna và
`gpt-reserve`. Discovery của SDK dùng giá trị đầu, không dùng mức mở rộng;
fallback Codex vẫn là 272.000. Catalog này không công bố trần output nên không
gán trần 128.000 của OpenAI API cho Codex. Dialect Codex không gửi
`max_output_tokens`. Copilot cũng lấy giới hạn theo catalog của chính endpoint,
không theo trang model gốc.

Ước lượng token và compaction không bảo đảm hóa đơn: cần giữ khoảng an toàn dưới
ngưỡng giá và không tắt compaction khi history tăng dài nếu cần tránh phụ thu.

Khi bật auto-compaction, ngưỡng áp lực mặc định là
`min(contextWindow * 0.8, contextWindow - outputReserve)`. Phần dự trữ lấy
`maxTokens` tường minh, rồi mặc định model, rồi tối đa model nếu có.
`maxInputTokens` tường minh của compaction thay ngưỡng theo tỷ lệ nhưng vẫn
bị chặn bởi phần context còn lại cho input. Số token là ước lượng, không phải
tokenizer chính xác theo model; overflow vẫn có thể xảy ra. Khai báo này không
nâng giới hạn server và không làm endpoint hỗ trợ thêm wire parameter.

## Khám phá model

### Snapshot usage trong stream

Anthropic phát `usage-progress` từ usage của `message_start` và `message_delta`.
Đây là snapshot tích lũy của một attempt: thay thế snapshot trước, không cộng dồn.
Khi có accounting context, event mang `attemptId` để phân biệt các lần retry.
Agent session cũng cung cấp event này. Chỉ event `usage` cuối mới là báo cáo đã
hoàn tất.

Nếu stream bị hủy hoặc đứt trước `message_stop`, snapshot cuối được giữ trong
attempt report với `coverage: 'partial'`, dù có đủ input/output/total. Nó không
đáp ứng chính sách bắt buộc usage đầy đủ. Retry trước khi có nội dung vẫn hoạt
động sau usage progress; mỗi attempt được tính riêng.

OpenAI Responses và Gemini Interactions tiếp tục lấy usage từ event kết thúc;
SDK không bịa số tạm khi provider không gửi. Usage progress không thay usage cuối
của message và không khiến tổng token bị cộng trùng.

```ts
const catalog = await runtime.modelCatalog('openai')
```

Một số nhà cung cấp khám phá danh mục từ chính endpoint vì model khả dụng phụ
thuộc gói dịch vụ của tài khoản — Codex là ví dụ dựng sẵn:

```ts
import { codexAdapter } from '@alvin0/ai-agent-sdk-auth-node/codex'

registry.registerAdapter(['codex'], codexAdapter())
const models = await registry.listModels('codex')
```

> Endpoint Codex phục vụ Codex CLI và nhận diện client bằng header `originator`;
> adapter mặc định dùng giá trị của CLI để yêu cầu được chấp nhận. Hãy dùng tài
> khoản của chính bạn, và ưu tiên `openai` cho production.

## `model` là bắt buộc

Không có model mặc định. Danh mục model của nhà cung cấp thay đổi nhanh hơn nhịp
phát hành của package này, nên bất kỳ mặc định dựng sẵn nào rồi cũng trỏ vào một
model đã ngừng phục vụ.

Ngoại lệ duy nhất là `defineAgent()`: bỏ trống `provider`, `model`, và `effort`
trong một *định nghĩa* sẽ chọn Codex `gpt-5.6-luna` ở mức `medium` — đây là một
quyết định đã được rà soát và phê duyệt tường minh, không phải phương án dự phòng
ngầm.

## Nhiều tài khoản của cùng một provider

Các thực thể provider mang ID và tuyến tường minh, nên hai tài khoản cùng họ ghép
với nhau không nhập nhằng. Kết quả khám phá báo một dòng cho mỗi tuyến, với danh
tính tuyến, danh tính thực thể plugin, và danh tính họ provider tách bạch.

## Thử lại

Thử lại là một decorator, và nó chỉ thử lại những thất bại xảy ra **trước khi
chunk đầu tiên tới tay bên tiêu thụ** — phát lại token đã giao sẽ nhân đôi output.

```ts
import { withRetry } from '@alvin0/ai-agent-sdk-core'

registry.registerAdapter(['openai'], withRetry(openAiAdapter({ apiKey }), {
  policy: { mode: 'normal', maxRetries: 3 },
  onRetry: attempt => console.warn(`retry ${attempt.attempt}: ${attempt.failure.code}`),
}))
```

Adapter gán một `code` ổn định tại ranh giới wire; **chính sách** quyết định mã
nào đủ điều kiện thử lại — không bao giờ do adapter đã gán mã đó quyết. `AUTH`,
`INVALID_REQUEST`, `QUOTA`, và `CONTEXT_WINDOW_EXCEEDED` bị loại trừ mặc định vì
chúng thất bại y hệt ở mọi lần thử.

`mode: 'always'` chỉ được chấp nhận khi yêu cầu có mang `AbortSignal`. Lượt agent
thông thường cung cấp sẵn qua deadline model; người gọi trực tiếp phải tự cấp
ranh giới huỷ của mình.

## Đọc tiếp

- [OpenAI](/vi/09-providers/openai) · [Anthropic](/vi/09-providers/anthropic) · [Codex](/vi/09-providers/codex) · [Gemini](/vi/09-providers/gemini) · [Copilot](/vi/09-providers/copilot)
- [Embeddings](/vi/09-providers/embeddings) — năng lực embedding riêng biệt
- [Custom Provider](/vi/09-providers/custom-provider) — mọi endpoint khác
- [Đường ống adapter](/vi/11-internals/adapter-pipeline) — lớp cơ sở sở hữu gì
