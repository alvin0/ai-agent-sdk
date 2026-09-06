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
| `@ai-agent-sdk/provider-anthropic` | Messages API | `apiKey` tiêm vào |
| `@ai-agent-sdk/provider-openai` | Responses API | `apiKey` tiêm vào |
| `@ai-agent-sdk/provider-codex` | Codex nền ChatGPT | `CodexAuthStore` tiêm vào |
| `@ai-agent-sdk/provider-gemini` | Gemini Interactions API | `apiKey` tiêm vào |
| `@ai-agent-sdk/auth-node/codex` | Codex trên Node | đăng nhập device-code cục bộ theo dự án |

`openai` và `codex` dùng chung **một** hiện thực Responses
(`@ai-agent-sdk/protocol-responses`) và chỉ khác nhau ở một bản ghi phương ngữ
nhỏ: base URL, cách xác thực, và endpoint chấp nhận những trường tuỳ chọn nào.

Mọi package provider đều là Universal và đòi thông tin xác thực tường minh. Nó
không bao giờ đọc biến môi trường hay tệp — việc tra cứu môi trường thuộc về một
lớp bọc Node như `@ai-agent-sdk/auth-node`.

## Hai kiểu đăng ký

**Plugin (khuyến nghị).** Một đăng ký có giao dịch mà runtime kích hoạt và gỡ bỏ:

```ts
import { openAiPlugin } from '@ai-agent-sdk/provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: () => secretStore.get('openai') })],
})
```

**Adapter (tuyến thủ công).** Điều khiển registry trực tiếp:

```ts
import { ModelRegistry } from '@ai-agent-sdk/core'
import { openAiAdapter } from '@ai-agent-sdk/provider-openai'

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

## Khám phá model

```ts
const catalog = await runtime.modelCatalog('openai')
```

Một số nhà cung cấp khám phá danh mục từ chính endpoint vì model khả dụng phụ
thuộc gói dịch vụ của tài khoản — Codex là ví dụ dựng sẵn:

```ts
import { codexAdapter } from '@ai-agent-sdk/auth-node/codex'

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
import { withRetry } from '@ai-agent-sdk/core'

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
