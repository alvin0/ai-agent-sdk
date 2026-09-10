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
| `@alvin0/ai-agent-sdk-auth-node/codex` | Codex trên Node | đăng nhập device-code cục bộ theo dự án |

`openai` và `codex` dùng chung **một** hiện thực Responses
(`@alvin0/ai-agent-sdk-protocol-responses`) và chỉ khác nhau ở một bản ghi phương ngữ
nhỏ: base URL, cách xác thực, và endpoint chấp nhận những trường tuỳ chọn nào.

Mọi package provider đều là Universal và đòi thông tin xác thực tường minh. Nó
không bao giờ đọc biến môi trường hay tệp — việc tra cứu môi trường thuộc về một
lớp bọc Node như `@alvin0/ai-agent-sdk-auth-node`.

## Hai kiểu đăng ký

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
| `models[].contextWindow` | Tổng dung lượng input/output cho đúng ID model đó. |
| `models[].maxTokens` | Đồng thời là output mặc định và trần output mà SDK áp dụng cho model. |
| `defaultContextWindow` | Fallback khi model được chọn chưa khai báo context window. |
| `defaultMaxTokens` | Fallback cho output mặc định và trần output khi model chưa khai báo `maxTokens`. |
| `maxTokens` của agent | Ngân sách output của agent; có thể thấp hơn trần model. |

Fallback áp dụng theo từng field, không chỉ khi model vắng trong catalog.
Nếu cũng bỏ trống mặc định của provider, SDK dùng mặc định dựng sẵn của adapter.
Đây là thông số SDK được khai báo, không bảo đảm tự đồng bộ với giới hạn mới
nhất của nhà cung cấp.

Ngân sách output lấy `maxTokens` tường minh của agent/call, nếu không có thì
lấy mặc định đã resolve của model. Vượt trần khai báo sẽ bị từ chối với
`OUTPUT_TOKEN_LIMIT_EXCEEDED`, không tự cắt xuống. Phần dự trữ output cũng
phải nhỏ hơn tổng context window.

**Giới hạn catalog hiện tại:** `ProviderCatalogModel` chỉ có `maxTokens`,
chưa có hai field riêng `defaultMaxTokens` và `maxOutputTokens` cho từng
model. Nội bộ dùng giá trị này cho cả hai. Đặt `defaultMaxTokens: 8192` ở
provider không giảm mặc định của model đã khai báo `maxTokens: 16384`;
hãy đặt `maxTokens` ở agent nếu muốn output thấp hơn.

Khi bật auto-compaction, ngưỡng áp lực mặc định là
`min(contextWindow * 0.8, contextWindow - outputReserve)`. Phần dự trữ lấy
`maxTokens` tường minh, rồi mặc định model, rồi tối đa model nếu có.
`maxInputTokens` tường minh của compaction thay ngưỡng theo tỷ lệ nhưng vẫn
bị chặn bởi phần context còn lại cho input. Số token là ước lượng, không phải
tokenizer chính xác theo model; overflow vẫn có thể xảy ra. Khai báo này không
nâng giới hạn server và không làm endpoint hỗ trợ thêm wire parameter.

## Khám phá model

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

- [OpenAI](/vi/09-providers/openai) · [Anthropic](/vi/09-providers/anthropic) · [Codex](/vi/09-providers/codex) · [Gemini](/vi/09-providers/gemini)
- [Custom Provider](/vi/09-providers/custom-provider) — mọi endpoint khác
- [Đường ống adapter](/vi/11-internals/adapter-pipeline) — lớp cơ sở sở hữu gì
