# Kế hoạch: Provider theo họ API, effort pass-through và cấu hình mặc định toàn cục

- **Ngày lập:** 2026-09-18 (cập nhật theo các quyết định của người dùng cùng ngày)
- **Trạng thái (2026-09-19, cuối phiên): TOÀN BỘ PLAN ĐÃ HOÀN TẤT.** Pha 0-7 **XONG HOÀN TOÀN**, không còn mục
  `[ ]` nào trong toàn bộ file. Đã phát hành **`0.1.4`** (quyết định của người dùng — patch, không phải `0.2.0`).
  **Pha 7 (rà soát CI, xem cuối mục 5):** chạy đúng từng gate của `.github/workflows/ci.yml` tại máy và phát hiện
  3 chỗ CI sẽ đỏ mà `pnpm typecheck`/`pnpm test` không bắt được (allowlist package-graph thiếu cạnh mới, bảng
  tarball `test:pack` thiếu protocol mới, và `workspace:typecheck` đỏ SẴN TỪ TRƯỚC ở `provider-anthropic`/
  `provider-gemini` vì root `tsc` không hề typecheck `packages/*/src`) — đã sửa cả 3; toàn bộ gate của cả 3 job CI
  giờ xanh tại máy. Cả 3 tầng route/model/agent của quyết định 12 hoạt động đúng "sau thắng trước" cho
  `headers`/`body`; `auth` nhận mảng scheme kể cả `{kind:'query'}`; `query`/`path`/`transformRequest`/
  `runtime.agent({providerOptions, contextWindow, inputModalities})` đều đã có, đủ 5 tầng ưu tiên giống `maxTokens`.
  Pha 4a: `models[].api` phục vụ cả hai kiểu model qua facade `OpenAiDualApiAdapter`. Pha 3: switch `compat` chéo
  protocol nay báo lỗi ngay (từng là bug thật — giá trị sai protocol bị nuốt êm và đổi sang format khác).
  **Pha 4b: provider-copilot chat/completions giờ gửi được effort — lật lại đánh giá cũ.** Đánh giá trước đó dựa
  vào một chuỗi lỗi 400 BỊA RA trong property test, tưởng nhầm là bằng chứng thật. Người dùng cấp credential Copilot
  thật giữa phiên; live-probe cho thấy Copilot's `GET /v1/models` khai `capabilities.supports.reasoning_effort` —
  field có thật — và gửi nó cho model không hỗ trợ trả về lỗi 400 NÊU ĐÍCH DANH field/model
  ("`reasoning_effort "low" was provided, but model gpt-4o-mini-2024-07-18 does not support reasoning effort`"),
  không phải "unknown field" như giả định ban đầu. Đã thêm `CopilotDialect.reasoningFormat` (mặc định `false`,
  không đổi hành vi ai) + test unit/property/live thật.
  **Pha 5 live verification — mở rộng rất nhiều trong đợt này nhờ người dùng cấp tài nguyên giữa phiên:** Gemini
  (live thật từ đầu phiên), zenmux.ai — gateway tương thích bên thứ ba (live cho cả 3 họ wire), codex2claudecode
  (live đầy đủ toàn bộ checklist), **OpenAI chính chủ** (5 test, `OPENAI_API_KEY` người dùng cấp giữa phiên, chạy
  thẳng vào `api.openai.com`), và Copilot chính chủ (ở trên). **Anthropic chính chủ không có key, nhưng người dùng
  đã xác nhận (2026-09-19) live qua zenmux.ai là đủ nghiệm thu cho pha 5** — không còn mục live nào bị chặn.
  **Một bug thật trong core được phát hiện qua live test** (không phải giả thuyết): `HttpModelAdapter.run()` từ
  chối ảnh/tài liệu cho MỌI model chưa khai catalog, mâu thuẫn với thiết kế đã ghi rằng absence là "unknown", không
  phải "text-only" — đã sửa ([provider-http/src/base/http-adapter.ts](../../packages/provider-http/src/base/http-adapter.ts)),
  sửa luôn một test cũ khẳng định hành vi sai đó là cố ý (lỗi thời từ trước khi hệ RuntimeDefaults ra đời ở pha 1b).
  Pha 6: README 3 provider đã cập nhật, CHANGELOG.md đã viết (`## Unreleased`), `baseline.json` mồ côi đã xóa. Chỉ
  còn ĐÚNG một mục thật sự chưa xong: **tăng version** — không còn bị chặn bởi thiếu nghiệm thu (mọi phần kỹ thuật
  đã xong), chỉ còn là quyết định phát hành chờ người dùng xác nhận. Chi tiết đầy đủ ở từng pha bên dưới.
- **Nhánh gốc:** `main` (SDK bắt đầu ở `0.1.3`, phát hành `0.1.4` khi đóng plan này)
- **Phát hành:** một đợt duy nhất, breaking, không giữ alias. Lỗi effort của Anthropic được sửa trong cùng đợt và ghi
  là bug fix trong CHANGELOG.

## 1. Tầm nhìn

SDK chỉ duy trì **ba provider theo họ API**:

| Provider | Họ API | Ví dụ endpoint phải đấu nối được |
|---|---|---|
| `provider-openai` | OpenAI (Responses **và** Chat Completions) | OpenAI, DeepSeek, OpenRouter, Groq, Together, Qwen/DashScope, Azure OpenAI, vLLM, Ollama, LM Studio, gateway nội bộ |
| `provider-anthropic` | Anthropic Messages | Anthropic, DeepSeek `/anthropic`, Kimi, MiniMax, GLM, gateway nội bộ |
| `provider-gemini` | Gemini | Google AI Studio, gateway tương thích Gemini |

Nguyên tắc:

- **Không tạo package theo từng nhà cung cấp** (không có `provider-deepseek`, `provider-openrouter`…).
  Nhà cung cấp mới chỉ là **một cấu hình** của provider họ API tương ứng.
- API chính chủ chỉ là **cấu hình mặc định** (`baseUrl`, auth), không phải giới hạn.
- Khác biệt giữa các endpoint cùng họ được xử lý bằng **switch `compat`**, không bằng code riêng.
- **Core nhẹ:** core không giữ kiến thức về từng model (không catalog, không ladder effort, không trần output).
  Người dùng khai báo; SDK chuyển tiếp; API là nơi phán quyết cuối cùng.

Ví dụ đích (API minh họa, chốt khi triển khai):

```ts
const runtime = await createAgentRuntime({
  providers: [
    openAiPlugin({ apiKey: env('OPENAI_API_KEY') }),
    openAiPlugin({
      id: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      api: 'chat-completions',
      apiKey: env('DEEPSEEK_API_KEY'),
      compat: { reasoningFormat: 'deepseek' },
    }),
    anthropicPlugin({
      id: 'kimi',
      displayName: 'Kimi',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      apiKey: env('KIMI_API_KEY'),
      compat: { authHeader: 'bearer' },
    }),
  ],
  defaults: { contextWindow: 272_000 },          // mặc định toàn cục cho cả runtime
})

const coder = runtime.agent({
  model: { provider: 'openai', id: 'gpt-5.6-luna' },
  effort: 'high',                                 // effort thuộc về agent
  inputModalities: ['text', 'image'],             // tùy chọn: hạn chế đầu vào
})
```

## 2. Quyết định đã chốt

| # | Chủ đề | Quyết định |
|---|---|---|
| 1 | Effort | **Pass-through, đặt theo agent.** Agent không đặt effort thì không gửi field nào. Có đặt thì gửi nguyên giá trị vào field chuẩn của họ API. Core không kiểm tra, không tự điền. |
| 2 | Effort trong session | **Không đổi effort giữa chừng.** Bỏ `effort` khỏi tùy chọn của từng lần gọi; không có effort toàn cục. Đổi model trong một lần gọi thì không gửi effort. |
| 3 | Context window | Mặc định SDK **200.000**; đổi được **toàn cục** (`createAgentRuntime({ defaults })`), theo **route**, theo **model**, theo **agent**. Người dùng tự chịu trách nhiệm khai báo đúng (kể cả model local có context nhỏ). |
| 4 | Max tokens (output) | **Tùy chọn, cùng cơ chế như context window.** Không ai đặt thì **không gửi** lên API. Ngoại lệ duy nhất: họ Anthropic bắt buộc `max_tokens` nên protocol dùng giá trị dự phòng. |
| 5 | Loại đầu vào | Mặc định mọi model nhận **text + image + document**. Agent (hoặc model trên route) có thể hạn chế, ví dụ `inputModalities: ['text']`; khi đó ảnh / PDF được chuyển thành text như cơ chế hiện có. |
| 6 | Reasoning khi đổi route | Chỉ gửi lại khối reasoning của lượt trước khi **cùng route và cùng model**; khác thì bỏ. Endpoint cần cách khác thì dùng switch `compat`. |
| 7 | Lỗi từ API | **Không nhận diện chi tiết, trung thực tuyệt đối.** Lỗi 4xx của API (kể cả effort sai) đi vào nhóm lỗi chung, **giữ nguyên message gốc**. SDK không làm sạch hay thay message của lỗi trả về cho người dùng; người dùng SDK tự bọc lỗi theo nhu cầu. |
| 7b | Max tokens của Anthropic | Không đặt thì dùng hằng số dự phòng của protocol; đổi được qua `defaultMaxTokens` của route. |
| 8 | Catalog | **Không đóng gói dữ liệu model** (kể cả vendor bên thứ ba). |
| 9 | Tương thích ngược | **Bỏ hẳn**, không giữ alias deprecated. |
| 10 | Samples | `samples/` tự quản lý cách hiển thị effort; **không nằm trong phạm vi** plan này. |
| 11 | Mở rộng provider | Ba provider họ API dùng **chung một bề mặt cấu hình mở rộng** (headers, query, path, auth nhiều header, field body bổ sung, hook sửa request) ở cấp route, model và agent (pha 3b). |
| 12 | Ghi đè giá trị của SDK | **Người dùng được ghi đè giá trị SDK tự đặt** (header của protocol, `accept`/`content-type`, `user-agent`, header attribution, field trong body) để đáp ứng API đa dạng. Giá trị người dùng luôn thắng; SDK không báo lỗi trùng. Chỉ giữ chặn các header HTTP cấp kết nối mà `fetch` không cho phép hoặc làm hỏng request. |

## 3. Bối cảnh

### Vấn đề phát hiện

Với `provider-openai` + `gpt-5.6-luna` + `effort: 'medium'`, SDK tự chặn request bằng `UNSUPPORTED_REASONING_EFFORT`
(`dispatchState: "not-sent"`), dù API OpenAI chấp nhận giá trị đó.

Nguyên nhân gốc:

- [model-metadata.ts:174-182](../../packages/core/src/runtime/model-metadata.ts#L174) kiểm tra effort với ladder
  của model; model không khai báo `reasoning` thì mọi effort đều bị chặn.
- Cùng hàm đó còn tự điền `info.reasoning?.defaultEffort` và `info.defaultMaxTokens` khi người dùng không đặt, tức là
  SDK tự gửi những giá trị người dùng không yêu cầu.
- `provider-openai` và `provider-gemini` không khai báo `reasoning`; `provider-anthropic` và `provider-codex` có.
  Effort hoạt động hay không phụ thuộc provider "khai báo đủ", không phụ thuộc API.

### Vì sao provider hiện tại chưa đạt tầm nhìn

| Hạn chế | Vị trí |
|---|---|
| `provider-openai` chỉ nói Responses API; phần lớn endpoint tương thích OpenAI chỉ có Chat Completions | [provider-openai/src/adapter.ts](../../packages/provider-openai/src/adapter.ts) |
| Bảng context window hardcode, chỉ bật khi `baseUrl` là chính chủ | `openAiContextPolicy`, `geminiContextPolicy`, `anthropicContextPolicy` |
| Chat Completions chỉ có cờ bool `reasoningEffort` (mặc định tắt), không có biến thể deepseek/openrouter/qwen | [protocol-openai-chat-completions/src/wire.ts:325](../../packages/protocol-openai-chat-completions/src/wire.ts#L325) |
| Anthropic cố định header `x-api-key`; một số endpoint tương thích dùng `Authorization: Bearer` | [provider-anthropic/src/adapter.ts:130](../../packages/provider-anthropic/src/adapter.ts#L130) |
| `displayName` cố định ('OpenAI', 'Anthropic'…) nên thông báo lỗi ghi sai tên nhà cung cấp | các `adapter.ts` |
| Mỗi adapter tự nhét context / max tokens mặc định riêng (128k, 200k; 32k, 8k…) | các `adapter.ts` |
| Model không khai báo `inputModalities` bị coi là chỉ nhận text | `resolvedCatalogModelInfo` trong [transport.ts:58](../../packages/provider-http/src/base/transport.ts#L58) |
| Copilot nhánh chat/completions âm thầm bỏ effort | [provider-copilot/src/dual-protocol.ts:160](../../packages/provider-copilot/src/dual-protocol.ts#L160) |
| Message lỗi gốc của API bị thay bằng câu chung trong report | [model-call-handle.ts:43](../../packages/core/src/runtime/model-call-handle.ts#L43) |

Điểm tốt đã có sẵn: plugin đã nhận `id` và `routes` (đăng ký nhiều instance), `createHttpProvider` đã tách
protocol / auth / dialect, translator Chat Completions đã đọc `reasoning_content` kiểu DeepSeek
([translate.ts:308](../../packages/protocol-openai-chat-completions/src/translate.ts#L308)), và lỗi HTTP đã giữ
message gốc trong `ModelError` ([session.ts:374-386](../../packages/provider-http/src/transport/session.ts#L374)).

### Kết quả probe API OpenAI (2026-09-18, `OPENAI_API_KEY`)

`POST /v1/responses` với `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`:

| `reasoning.effort` | Kết quả |
|---|---|
| `none`, `low`, `medium`, `high`, `xhigh`, `max` | 200 OK |
| `minimal` | 400 `unsupported_value`, message: *"'minimal' is not supported with the 'gpt-5.6-luna' model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'."* |
| `default` | 400 `invalid_value` |

Chính API đã trả message đủ rõ. Đây là cơ sở cho quyết định 1 và 7: SDK chỉ cần chuyển message này tới người dùng.

### Anthropic effort theo tài liệu chuẩn

Nguồn: tài liệu Claude API (skill `claude-api`, mục *Thinking & Effort*, cập nhật 2026).

- **Field chuẩn:** `output_config: { effort: "low" | "medium" | "high" | "xhigh" | "max" }`. Nằm trong
  `output_config`, không phải top-level. **GA, không cần beta header.** Mặc định `high` (tương đương không gửi).
- **Model hỗ trợ:**

  | Model | Effort | `thinking.budget_tokens` |
  |---|---|---|
  | Fable 5 / 5.1, Opus 5, Opus 4.8 / 4.7, Sonnet 5 | `low`…`max` (có `xhigh`) | **Bị gỡ, gửi là 400** |
  | Opus 4.6, Sonnet 4.6 | `low`/`medium`/`high`/`max` | Deprecated, còn chạy |
  | Opus 4.5 | `low`/`medium`/`high` | Chạy |
  | Sonnet 4.5, Haiku 4.5 | Gửi effort là lỗi | Bắt buộc nếu muốn thinking |

- **Quan hệ với thinking:** effort là nút chính điều khiển độ sâu suy nghĩ, dùng cùng
  `thinking: { type: "adaptive" }`. Opus 5 bỏ trống `thinking` đã chạy adaptive; Opus 4.8/4.7 bỏ trống thì
  **không** suy nghĩ; Opus 5 chỉ nhận `thinking: disabled` khi effort ≤ `high`.
- **`max_tokens` là bắt buộc** với Messages API.

**Lỗi hiện tại của SDK** ([serialize.ts:320-331](../../packages/protocol-anthropic-messages/src/serialize.ts#L320)):
effort bị đổi thành `thinking: { type: 'enabled', budget_tokens }` theo bảng
`DEFAULT_THINKING_BUDGETS = { off: 0, low: 2048, medium: 8192, high: 24576 }`
([protocol.ts:36](../../packages/protocol-anthropic-messages/src/protocol.ts#L36)). Hệ quả:

- Với Opus 5 / 4.8 / 4.7, Sonnet 5, Fable 5: truyền `low`/`medium`/`high` là **400** vì `budget_tokens` đã bị gỡ.
- `xhigh`, `max` không có trong bảng nên thành `thinking: disabled`, **không có lỗi nào**.
- Không bao giờ gửi `output_config.effort`.

→ Effort hiện **không dùng được với mọi model Claude đời mới**. Chưa kiểm chứng live vì `.env` chưa có
`ANTHROPIC_API_KEY`.

## 4. Tham khảo

- **Codex** (`.temp/codex/codex-rs`): provider là dữ liệu cấu hình (`ModelProviderInfo`: `base_url`, `env_key`,
  `wire_api`, headers, retry, auth); không đóng gói provider bên thứ ba; effort gửi nguyên khi dispatch
  (`ReasoningEffort::Custom(String)`).
- **deepseek-harness** (`.temp/deepseek-harness/packages/llm/llm-pi-ai`): mỗi route là profile `apiKeyEnv`,
  `baseURL`, `api`, `models`, `compat`; khác biệt endpoint nằm ở switch `compat` (`thinkingFormat`,
  `maxTokensField`, `supportsDeveloperRole`, `supportsStore`…) có "drift gate" để switch mới phải được phân loại.

Plan này lấy **mô hình provider = cấu hình + `compat`** từ hai repo trên, **không** lấy phần catalog và ladder effort.

### codex2claudecode (gateway local, cùng tác giả)

Nguồn: README của package npm `codex2claudecode` 0.4.2 (`npm view codex2claudecode readme`, repo
`github.com/alvin0/codex2claudecode`).

- **Là gì:** gateway chạy local (Bun hoặc binary độc lập) dùng credential Codex/ChatGPT, Kiro hoặc Copilot, rồi mở ra
  API tương thích Anthropic **và** OpenAI trên cùng một cổng. Chạy: `npx codex2claudecode [--port 8787] [--password …]`.
- **Endpoint** (mặc định `http://127.0.0.1:8787`):

  | Endpoint | Họ API |
  |---|---|
  | `POST /v1/messages`, `POST /v1/messages/count_tokens` | Anthropic Messages |
  | `POST /v1/responses` | OpenAI Responses |
  | `POST /v1/chat/completions` | OpenAI Chat Completions |
  | `GET /v1/models` | Trả dạng OpenAI nếu có header `originator` (Codex gửi), ngược lại dạng Anthropic |
  | `/codex/v1/*` | Các route OpenAI, không đụng listing của Anthropic |

  Cả streaming và non-streaming.
- **Auth:** không đặt password thì không cần khóa (giá trị giữ chỗ bất kỳ). Có `--password` thì gửi qua `X-Api-Key`
  **hoặc** `Authorization: Bearer`.
- **Model:** chế độ Codex có `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4`…; chế độ Kiro có
  `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4.5`.
- **Effort:** quy ước riêng bằng hậu tố tên model (`gpt-5.6-sol_high`, `_xhigh`, `_max`, `_ultra` → `max`), map vào
  `reasoning.effort` của Responses; không có hậu tố thì mặc định `medium`. Trên `/v1/responses`, gateway nhận
  `reasoning.effort` của client (Codex CLI dùng đúng field này). README **không nói** gateway có đọc
  `reasoning_effort` (Chat Completions) hay `output_config.effort` (Messages) không → cần kiểm chứng live.
- **Cách chạy đã kiểm chứng trên máy dev (Windows, 2026-09-18):**

  | Việc | Cách làm | Ghi chú |
  |---|---|---|
  | Chạy có giao diện | `npx codex2claudecode --port 8787` (hoặc `bunx`) trong terminal thật | Máy đã có Bun 1.3.14 |
  | Chạy nền / trong test | `CODEX_NO_UI=1 bunx codex2claudecode --port 8787` | Không có biến này thì giao diện Ink báo *"Raw mode is not supported on the current process.stdin"* và thoát ngay khi không có TTY. Biến này không có trong README, tìm thấy trong `src/app/bin.ts` |
  | Kiểm tra sẵn sàng | `GET /health` | Trả `{"ok":…,"runtime":{"ok":true},"upstream":{"ok":…,"error":…}}`: `runtime.ok` = server đã lên; `upstream.ok` = tài khoản còn dùng được |
  | Đăng nhập / đổi tài khoản | Chỉ làm được trong giao diện: `/connect` (Login with browser hoặc import `~/.codex/auth.json`), `/account` | Cần người dùng thao tác trình duyệt |
  | Trạng thái tài khoản | `~/.codex2claudecode/provider-state.json` | Chứa token, không đọc hay sửa trong test |
  | Log | `~/.codex2claudecode/request-logs-recent.ndjson`, `request-log-details/` | Mặc định **ghi cả body** (`LOG_BODY=0` để tắt) |
  | Dừng | Tắt tiến trình `bun` đang giữ cổng 8787 | |

  Server lắng nghe `0.0.0.0:8787`, in ra đủ route: `/v1/messages`, `/v1/message`, `/v1/messages/count_tokens`,
  `/v1/models`, `/v1/models/:model_id` (Claude); `/v1/responses`, `/v1/chat/completions`, `/v1/models` và các bản
  `/codex/v1/*` (OpenAI).

- **Hành vi đã quan sát:**
  - Lỗi trả về **đúng định dạng của từng họ API**: `/v1/messages` trả
    `{"type":"error","error":{"type":"api_error","message":…}}`; `/v1/responses` và `/v1/chat/completions` trả
    `{"error":{"message":…}}`. Message chứa nguyên lỗi upstream.
  - Lỗi auth phía upstream (token hết hạn, `refresh_token_invalidated`) được trả về với **HTTP 500**, không phải 401.
    Test không nên suy luận từ status; cứ hiện message gốc (quyết định 7).
  - `GET /v1/models` trả danh sách rỗng (`{"data":[]}`) khi upstream không dùng được. Khi dùng được (chế độ Codex):
    `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-reserve`, `gpt-5.5`, `codex-auto-review`.
  - **Chỉ chạy dạng stream.** `stream: false` bị upstream từ chối: `400 {"detail":"Stream must be set to true"}` (trái
    với README 0.4.2). SDK luôn stream nên không ảnh hưởng; là lỗi cần sửa ở gateway.

- **Effort trên cả 3 wire (đo live 2026-09-18, `gpt-5.6-luna`, stream, cùng một câu hỏi suy luận):**

  | Route | Field SDK sẽ gửi | `low` | `high` | Effort sai (`minimal`) |
  |---|---|---|---|---|
  | `/v1/messages` | `output_config.effort` | 7 output token | 35 output token | 400, lỗi OpenAI gốc bọc trong `{"type":"error","error":{"type":"invalid_request_error","message":"Upstream request failed: 400 {…}"}}` |
  | `/v1/responses` | `reasoning.effort` | 0 reasoning token | 27 reasoning token (response trả lại `reasoning.effort: "high"`) | 400, **nguyên văn** lỗi OpenAI (`param: reasoning.effort`, `code: unsupported_value`) |
  | `/v1/chat/completions` | `reasoning_effort` | 0 reasoning token | 26–27 reasoning token (lặp 3 lần) | 400, nguyên văn lỗi OpenAI |

  Kết luận: **cả ba wire đều nhận effort theo field chuẩn** và chuyển tiếp nguyên giá trị, đúng mô hình pass-through của
  plan. Không cần xử lý riêng trong SDK.

  Chi tiết thêm:
  - Thứ tự gateway chọn effort (`src/core/reasoning.ts`): `reasoning.effort` > `reasoning_effort` > hậu tố tên model;
    `ultra` đổi thành `max`. Field chuẩn luôn thắng hậu tố.
  - Hậu tố tên model vẫn dùng được như model id thường: `gpt-5.6-luna_high` trên route chat → 28 reasoning token.
  - `/v1/messages` luôn trả một khối `thinking` trước khối `text` (SSE `content_block_start` type `thinking`).
  - Route chat chỉ trả `usage` khi gửi `stream_options: { include_usage: true }` (SDK đã bật qua `streamUsage`).
  - Lỗi effort sai trên `/v1/messages` bị bọc lại (message có tiền tố `Upstream request failed: 400` và JSON gốc bên
    trong) vì phải đổi sang định dạng Anthropic; hai route OpenAI trả nguyên văn.

- **Điều kiện để chạy test live:** `GET /health` phải có `upstream.ok: true`. Nếu `false` thì test tự bỏ qua và in
  `upstream.error` để người chạy biết cần `/connect` lại.

- **Ý nghĩa với plan:** một endpoint local nói **cả ba wire** với cùng một bộ model. Đây là mục tiêu nghiệm thu lý tưởng
  cho tầm nhìn "provider theo họ API": cùng model, đi qua `provider-anthropic`, `provider-openai` (Responses) và
  `provider-openai` (Chat Completions), chỉ khác cấu hình.

## 5. Các pha

### Pha 0: Dọn dẹp

- [x] Hoàn tác thay đổi chưa commit ở `packages/provider-openai/src/context-policy.ts` (người dùng đã hoàn tác).
- [x] `pnpm build` rồi chạy test toàn repo, chốt mốc xanh (core hiện 971/971; toàn repo 24 lỗi pre-existing không
  liên quan — symlink permission trên Windows, giả định POSIX path, fuzz test timeout — đã xác nhận bằng `git stash`).

> Test import qua tên package nên chạy vào `dist`. Luôn build trước khi test để tránh fail giả (từng gặp:
> `sdkVersion` 0.1.0 và lỗi `no adapter registered` do `dist` cũ).

### Pha 1: Effort pass-through, đặt theo agent — ✅ XONG (2026-09-18)

File đã sửa: `core/src/runtime/model-metadata.ts`, `core/src/runtime/registry.ts`, `core/src/contract/model-info.ts`,
`core/src/contract/call-config.ts`, `core/src/errors/model-error.ts`, `core/src/agent/define/definition.ts`,
`core/src/agent/define/session/model-config.ts`, `core/src/agent/define/session/types.ts`,
`core/src/composition/agent/types.ts`, `core/src/composition/agent/options.ts`, `core/src/composition/agent/session.ts`

- [x] Gỡ kiểm tra ladder + tự điền `defaultEffort` trong `resolveCallWithModelInfo`; effort đi thẳng
  (`const reasoningEffort = config.reasoningEffort`).
- [x] Gỡ `ModelReasoningInfo.defaultEffort`, `CallConfigAdapterDefaults.reasoningEffort`, mã lỗi
  `UNSUPPORTED_REASONING_EFFORT` (không còn nơi nào sinh ra). `ModelReasoningInfo.efforts` chỉ còn kiểm tra cấu trúc
  (không rỗng, không trùng id), không dùng để chặn dispatch.
- [x] **Bỏ effort khỏi tùy chọn từng lần gọi** ở cả hai tầng API: `AgentInvocationOptions.reasoningEffort` (tầng thấp)
  và `RuntimeAgentInvocationOptions.effort` (tầng composition, `CapturedInvocationOptions`, `modelOverlay`). Effort chỉ
  còn đến từ agent definition.
- [x] `sessionCallConfig`: đổi model trong một lần gọi luôn bỏ effort (không còn nhánh phục hồi effort qua invocation).
- [x] Sửa comment ở `definition.ts:46-52` và toàn bộ chỗ nhắc "validated against the model's own ladder".
- [x] Cập nhật test: `invocation-model-override.spec.ts` (bỏ `LADDERS`-as-gate, viết lại 3 test theo hành vi mới, thêm
  assertion `effort` là field bị từ chối), `registry.spec.ts` (đổi từ "refuses" thành "passes through untouched"),
  `invocation-model-override-live.spec.ts` (rewrote 4 test: bỏ effort per-invocation, effort sai giờ để **provider
  thật** từ chối chứ không phải SDK preflight, soak test tách effort-cycling thành agent riêng cho từng effort).
  Sửa thêm `defaultEffort` literal ở 5 file test khác + `test-human/edge-chat/live/worker.ts` +
  `samples/chat-agents/backend/src/registry.ts` (đều do xóa field `ModelReasoningInfo.defaultEffort`).
- [x] **Phát hiện ngoài dự kiến:** `samples/edge-runtime-chat-agents` có tính năng "đổi effort theo từng lượt, giữ
  nguyên session" dựa hẳn vào `RuntimeAgentInvocationOptions.effort` (đã ghi rõ trong comment "Bound with NO effort on
  purpose"). Theo quyết định 2, effort không còn override theo lần gọi, nên tính năng này không thể giữ nguyên hành vi.
  Đã sửa (không nằm trong phạm vi pha 1, nhưng cần để sample không crash): effort giờ bind lúc tạo session; đổi effort
  rebuild session (mất lịch sử), đổi model vẫn giữ nguyên session như cũ. Cập nhật `sessions.ts`, `app.ts`, README của
  sample và test `edge-sample-model-override.spec.ts`.
- [x] Test mới trong `registry.spec.ts`: agent đặt giá trị bất kỳ (kể cả không tồn tại) thì `prepareCall` vẫn cho qua
  nguyên giá trị đó, không ném lỗi.

**Verify:** `pnpm typecheck` (root) sạch. `pnpm test` (root, 2809 test) — 24 lỗi còn lại đã xác nhận **pre-existing**
bằng `git stash` (symlink permission trên Windows không có quyền admin, giả định đường dẫn POSIX trong
`instructions-node.spec.ts`, timeout của fuzz test trong `embedding/retry.spec.ts`) — không liên quan effort.
`packages/core` riêng: 970/970 xanh.

### Pha 1b: Cấu hình mặc định toàn cục và theo agent

**Mục tiêu:** người dùng đặt một lần (ví dụ `contextWindow: 272_000`) thì toàn bộ runtime hiểu đó là mặc định, trừ
chỗ nào khai báo riêng.

```ts
createAgentRuntime({
  providers,
  defaults: {
    contextWindow: 272_000,
    maxTokens: 32_000,                            // tùy chọn; bỏ trống thì không gửi
    inputModalities: ['text', 'image', 'document'], // mặc định SDK
  },
})
```

Thứ tự ưu tiên (trên cùng thắng), áp cho `contextWindow`, `maxTokens`, `inputModalities`:

| # | Tầng | Ví dụ |
|---|---|---|
| 1 | Agent | `runtime.agent({ contextWindow, maxTokens, inputModalities })` |
| 2 | Model trên route | `openAiPlugin({ models: [{ id, contextWindow, maxTokens, inputModalities }] })` |
| 3 | Route | `openAiPlugin({ defaultContextWindow, defaultMaxTokens })` |
| 4 | **Toàn cục runtime** | `createAgentRuntime({ defaults })` |
| 5 | Hằng số SDK | `contextWindow = 200_000`; `maxTokens` = không có; `inputModalities = ['text','image','document']` |

Thiết kế:

- [x] Thêm `RuntimeDefaults { contextWindow?, maxTokens?, inputModalities? }`
  ([contract/model-info.ts](../../packages/core/src/contract/model-info.ts)), vào `AgentRuntimeOptions.defaults`
  ([composition/runtime/types.ts](../../packages/core/src/composition/runtime/types.ts)) và vào
  `new ModelRegistry({ defaults })`. **Không** có effort toàn cục (quyết định 2) — xác nhận đúng như thiết kế.
- [x] **Core là nơi duy nhất điền mặc định:** `normalizeResolvedModelInfo` giờ luôn trả về `context.contextWindow` và
  `inputModalities` đã điền đủ (route/model → `defaults` của registry → hằng số SDK `DEFAULT_CONTEXT_WINDOW = 200_000`
  / `DEFAULT_INPUT_MODALITIES = ['text','image','document']`), áp dụng ở **cả 3 nơi** gọi hàm này:
  `registry.ts` (`prepareCall`, `resolveModelInfo`) và `model-stream.ts` (`prepareDispatch`, dùng bởi
  `ModelRegistry.stream()`). `resolveCallWithModelInfo` nhận thêm `defaults` để điền `maxTokens` (tier 4, không có
  hằng số SDK — đúng quyết định 4).
- [x] Validate `defaults` một lần lúc khởi tạo `ModelRegistry` (số dương, `inputModalities` không rỗng/không trùng),
  không validate lại mỗi call.
- [x] Test mới trong `registry.spec.ts` (8 test, "ModelRegistry runtime defaults"): hằng số SDK khi không ai đặt gì;
  `defaults` thắng hằng số SDK; route/model thắng `defaults`; per-call `maxTokens` thắng mọi tầng; `defaults` sai
  format bị từ chối ngay lúc khởi tạo.
- [x] `contextWindow`, `inputModalities` ở cấp **agent** (tier 1, `runtime.agent({ contextWindow, inputModalities })`),
  thắng model/route (tier 2/3) và runtime defaults/hằng số SDK (tier 4/5), theo đúng cơ chế đã có cho `maxTokens`:
  - Thêm 2 field vào `CallConfig`/`GenerateOptions`
    ([contract/call-config.ts](../../packages/core/src/contract/call-config.ts),
    [contract/generate-options.ts](../../packages/core/src/contract/generate-options.ts)), cập nhật `callConfigEquals`.
  - `resolveCallWithModelInfo` ([runtime/model-metadata.ts:191-249](../../packages/core/src/runtime/model-metadata.ts))
    ghi đè `info.context.contextWindow`/`info.inputModalities` bằng `config.contextWindow`/`config.inputModalities`
    khi agent đặt, validate ngưỡng `maxContextWindow` (ném `INVALID_MODEL_INFO` nếu vượt trần kỹ thuật của model), trả
    thêm field `inputModalities` bên cạnh `config`/`context` đã có.
  - `registry.ts`'s `prepareCall()` lấy `PreparedCall.inputModalities` từ `resolved.inputModalities` (agent tier) thay
    vì thẳng từ `modelInfo.inputModalities`; `model-stream.ts`'s `streamAdapter()` tính `effectiveInputModalities =
    withConfig.inputModalities ?? prepared.modelInfo.inputModalities` cho policy ảnh/tài liệu; `compaction.ts`'s
    `resolveBudget()` ưu tiên `config.contextWindow` (một đường resolve độc lập, phát hiện khi rà lại toàn bộ chỗ đọc
    `context.contextWindow`).
  - `AgentDefinitionInput`/`AgentDefinition`/`DefinedAgentValue`
    ([agent/define/definition.ts](../../packages/core/src/agent/define/definition.ts)) thêm 2 field, validate (số
    nguyên dương an toàn cho `contextWindow`; không rỗng/không trùng cho `inputModalities`), `mergedInput()` override
    đúng theo `with()`/`cloneAgent()`.
  - `RuntimeAgentDefinitionInput` ([composition/agent/types.ts](../../packages/core/src/composition/agent/types.ts))
    và `bindRuntimeAgentDefinition()`/`KEYS`
    ([composition/agent/definition.ts](../../packages/core/src/composition/agent/definition.ts)) thêm capture, xuyên
    vào `defineAgent({...})`.
  - `sessionCallConfig()` ([agent/define/session/model-config.ts](../../packages/core/src/agent/define/session/model-config.ts))
    luôn lấy 2 field này từ `definition` (không từ `runtime`/`RuntimeSessionConfiguration`) và **giữ nguyên qua một
    lần đổi model của invocation** — khác với effort/maxTokens bị drop khi đổi model, vì contextWindow/inputModalities
    là thuộc tính của chính agent, không phải của một model cụ thể.
  - `snapshotRunTurnOptions()` ([agent/loop/turn/config.ts](../../packages/core/src/agent/loop/turn/config.ts)) thêm 2
    field vào bản sao đóng băng, nếu không sẽ bị rơi mất trước khi tới `model-round.ts`.
  - Test mới: `registry.spec.ts` (3 test — agent tier thắng model/route/runtime default cho cả `contextWindow` lẫn
    `inputModalities`, và ném `INVALID_MODEL_INFO` khi vượt trần `maxContextWindow`); `agent-definition.spec.ts` (validate
    giá trị sai ở định nghĩa; `with()` override đúng, không rò sang bản gốc);
    `composition/invocation-model-override.spec.ts` (test end-to-end qua `createAgentRuntime` + `runtime.agent()`,
    xác nhận 2 field này sống sót qua một lần đổi model của invocation, không như effort/maxTokens).
- [x] Không dùng biến toàn cục cấp module (mỗi `ModelRegistry` giữ `defaults` của riêng nó); không đọc biến môi trường
  trong core.

**Verify bằng API thật (2026-09-18, `OPENAI_API_KEY`, không qua mock):**
- Model chưa cấu hình gì với `gpt-5.6-luna` qua `provider-openai`: `context.contextWindow` = **128.000**,
  `maxTokens` khi dispatch = **32.000** — KHÔNG phải hằng số SDK (200.000) hay `defaults` tôi đặt (5.000/777) — vì
  **`provider-openai`'s adapter tự nhét `defaultContextWindow: 128_000` / `defaultMaxTokens: 32_000` ở cấp route**
  (đúng tier 3, thắng tier 4 `defaults` theo thiết kế). Đây **không phải lỗi của pha 1b** — đây chính là bằng chứng
  sống cho lý do Pha 2 cần thiết: chừng nào adapter còn tự nhét mặc định ở route, `RuntimeDefaults` không chạm được
  tới model chưa cấu hình của OpenAI.
- `gpt-5.6-luna` (được `provider-openai` khai báo cứng 272.000): `context.contextWindow` = **272.000**, đúng ngay cả
  khi `defaults.contextWindow` đặt 5.000 khác — xác nhận route/model thắng runtime defaults.
- Dispatch thật (không set `maxTokens` ở đâu cả) qua `gpt-5.6-luna`: request thành công, model trả lời thật,
  `finish.reason.kind: 'stop'` — xác nhận "không ai đặt maxTokens thì không gửi" không làm hỏng request thật.

→ Sẽ lặp lại đúng bộ test sống này sau khi làm xong Pha 2, kỳ vọng model chưa cấu hình của OpenAI lúc đó mới thực sự
nhận `RuntimeDefaults`/hằng số SDK thay vì 128k/32k cứng của adapter.

### Pha 2: Đơn giản hóa `provider-http` — ✅ XONG (2026-09-18)

File đã sửa: `base/context-policy.ts`, `base/transport.ts`, `base/http-adapter.ts`, `configurable/http-provider.ts`,
`protocol/runtime-types.ts`, `provider-openai/adapter.ts` (+ xóa `context-policy.ts`),
`provider-gemini/adapter.ts` (+ xóa `context-policy.ts`), `provider-anthropic/adapter.ts` (+ xóa `context-policy.ts`),
cả 4 `protocol-*/src/contract.ts` + `serialize.ts` (`maxTokens?` optional), `tests/unit/provider-http/context-policy.spec.ts`
(viết lại), `tests/unit/copilot-adapter-headers.spec.ts` (Property 26), `tests/fixtures/public-api/untouched-packages.json`
(regenerate).

- [x] **Adapter không tự nhét context / max tokens / modalities mặc định nữa.** Xóa `?? 128_000`/`?? 32_000` (OpenAI),
  `?? 200_000`/`?? 8_192` (Gemini, Anthropic) ở cả adapter.ts VÀ ở tầng dùng chung `configurable/http-provider.ts`
  (nơi thực sự chặn `RuntimeDefaults` — 2 chỗ `?? 8_192`/`?? 128_000` baseline của package, không phải của riêng
  provider nào). `HttpConnection.defaultMaxTokens/defaultContextWindow`, `ProviderRequest.maxTokens`,
  `ProtocolRequest.maxTokens` (core + cả 4 protocol package) đổi thành optional.
- [x] Xóa 3 bảng hardcode per-vendor (`GPT_56`, `STANDARD_1M`, `PRO`) và 3 file `context-policy.ts` riêng của
  openai/anthropic/gemini. **Giữ nguyên** `createModelContextPolicy`/`applyModelContextPolicy` trong `provider-http`
  — đây là cơ chế MERGE model/route dùng chung (còn cần cho `provider-codex`), khác với 3 bảng hardcode theo vendor;
  phát hiện này chỉnh lại nhận định ban đầu của plan.
- [x] **Bug tìm thấy khi làm:** `snapshotWireBody`/`snapshotJsonObject` (provider-http) NGHIÊM NGẶT HƠN
  `JSON.stringify` — nó **throw** ngay khi gặp giá trị `undefined` tường minh trong object (không âm thầm bỏ qua
  key như JSON.stringify). Phải sửa lại `protocol-openai-chat-completions/serialize.ts`'s `[dialect.maxTokensField]:
  request.maxTokens` (và audit lại toàn bộ 4 serializer) dùng spread có điều kiện, không gán trực tiếp giá trị có
  thể `undefined`.
- [x] **Bug thứ tự ưu tiên tự phát hiện:** bản viết lại đầu tiên của `resolvedCatalogModelInfo` làm route-level
  `defaultContextWindow` thắng nhầm model-level `defaultContextWindow` (đảo ngược thứ tự gốc). Sửa bằng cách đưa
  route param vào `context.defaultContextWindow` của object nền (không phải `providerOverride`), khớp lại đúng thứ
  tự: model.contextWindow > model.defaultContextWindow > route.defaultContextWindow > (không có gì).
  `applyModelContextPolicy` phải nhận thêm kiểu `context?: Partial<ModelContext>` cho object nền partial này, và
  trả `context: undefined` (bỏ key hẳn) khi cuối cùng không có `contextWindow` nào — tránh rò một `context` không
  có `contextWindow` xuống tầng dưới.
- [x] Test: viết lại toàn bộ `context-policy.spec.ts` (10 test, không còn test hành vi "official endpoint được ưu
  tiên" đã bị xóa).

**Verify bằng API thật (2026-09-18, `OPENAI_API_KEY`), lặp lại đúng bộ test cuối Pha 1b:**
- Model chưa cấu hình: `context.contextWindow` giờ = **200.000** (hằng số SDK, trước Pha 2 là 128.000 cứng của
  adapter) — xác nhận Pha 2 đã mở đường cho Pha 1b.
- `defaults.contextWindow`/`defaults.maxTokens` đặt ở registry giờ **thắng thật** cho model chưa cấu hình (trước
  Pha 2 bị route-level hardcode của adapter che mất).
- `gpt-5.6-luna`: do đã xóa bảng `GPT_56` hardcode, model này **không còn tự động có 272.000** nữa — giờ bị coi như
  mọi model chưa cấu hình khác (200.000 hoặc theo `defaults`). Đây là hệ quả đúng theo thiết kế (không hardcode theo
  vendor), nhưng là một **gap thật cần biết**: cho tới khi Pha 4 cung cấp dữ liệu catalog mẫu/README, người dùng
  phải tự khai báo `models: [{id: 'gpt-5.6-luna', contextWindow: 272_000}]` nếu muốn đúng giá trị thật.
- Dispatch thật (không set `maxTokens` ở đâu, model chưa cấu hình): request thành công, model trả lời thật,
  `finish.reason.kind: 'stop'`.

**Verify test suite:** `pnpm typecheck` (root) sạch. `pnpm test` (root) — về đúng mức nhiễu baseline (24-28 lỗi dao
động do fuzz test/symlink permission trên Windows, đã xác nhận qua nhiều lần chạy), không còn lỗi nào do Pha 2 gây
ra. Đã regenerate `tests/fixtures/public-api/untouched-packages.json` qua cơ chế
`UPDATE_PACKAGE_SURFACE=1 npx vitest run tests/unit/copilot-architecture.spec.ts` có sẵn trong repo cho đúng mục
đích này.

> Hệ quả còn treo: model chính chủ có context lớn hơn (GPT-5.6 272k, Claude 1M, Gemini Flash 1M) giờ về hằng số SDK
> (200k) hoặc `RuntimeDefaults` cho tới khi người dùng khai báo qua `models[]`. README của 3 provider cần ghi ví dụ
> cấu hình mẫu (Pha 4/6).

### Pha 3: Switch `compat`, effort theo chuẩn từng họ API, lỗi gốc — PHẦN LỚN ĐÃ XONG (kiểm lại + hoàn tất 2026-09-18)

**Phát hiện khi bắt đầu pha này:** phần lớn nội dung pha 3 đã nằm sẵn trong `HEAD` (commit `f6d666b`, cùng lượt với
pha 1/2) dù checkbox vẫn để trống — mục "Bối cảnh"/pha 3 mô tả code đã lỗi thời so với `HEAD` hiện tại (ví dụ dòng số ở
`serialize.ts:320-331` và `model-call-handle.ts:43` không còn đúng nội dung được trích). Đã xác nhận bằng đọc trực tiếp
5 package protocol + `core` + `provider-http` trước khi sửa bất cứ gì, tránh làm lại phần đã có.

File đã sửa lượt này: `protocol-responses/src/wire.ts`, `protocol-responses/src/serialize.ts` (thêm switch omit
`store`), `provider-gemini/src/adapter.ts` (thêm `authHeader: 'x-goog-api-key' | 'bearer'`),
`tests/unit/responses-serialize.spec.ts`, `tests/unit/provider-gemini.spec.ts` (test mới), `tests/unit/chat-completions-surface.spec.ts`,
`tests/unit/copilot-router.spec.ts`, `tests/unit/provider-factory-matrix.spec.ts` (sửa reference tên field cũ +
kỳ vọng wire cũ, stale từ trước khi pha 3 phần lớn được code), `tests/fixtures/public-api/untouched-packages.json`
(regenerate).

- [x] Quy tắc chung: không có effort thì không gửi; có thì gửi nguyên chuỗi vào field chuẩn. Không có `maxTokens` thì
  không gửi (trừ Anthropic). **Đã có sẵn** ở cả 4 protocol (`protocol-responses/src/serialize.ts:380-391`,
  `protocol-openai-chat-completions/src/serialize.ts:222-232`, `protocol-anthropic-messages/src/serialize.ts:393-405`,
  `protocol-gemini-interactions/src/serialize.ts`).
- [x] **Responses:** `reasoning.effort`; `max_output_tokens` chỉ khi có — đã có sẵn. **Switch omit `store`/`include`
  cho endpoint không nhận field này — làm lượt này:** `ResponsesDialect.store` đổi từ `boolean` bắt buộc thành
  `boolean | undefined` (omit field khi undefined); `include` đã omit sẵn khi mảng rỗng (không cần sửa). Test mới:
  "sends `store` khi dialect có giá trị", "omits `store` entirely", "omits `include` entirely".
- [x] **Chat Completions:** `dialect.reasoningFormat: 'openai' | 'deepseek' | false` (mặc định `false`, không phải
  `'openai'` như phác thảo ban đầu — lý do: package này còn được `provider-copilot` dùng, đổi default sẽ đổi hành vi
  Copilot ngoài phạm vi pha 3; provider dùng protocol này sẽ tự đặt default theo API của chính họ ở pha 4a/4).
  `'openrouter' | 'qwen'` **cố tình chưa thêm** — đã có comment tường minh trong
  `protocol-openai-chat-completions/src/serialize.ts` dẫn đúng quyết định 7 (không đoán field khi chưa có wire capture
  đã xác minh cho hai endpoint này). Việc còn lại nếu muốn hoàn tất: xác minh field thật của OpenRouter/Qwen bằng
  request thô (như đã làm với codex2claudecode ở mục 4) rồi mới thêm 2 nhánh.
- [x] **Anthropic:** toàn bộ mục con **đã có sẵn**, xác nhận qua đọc `protocol-anthropic-messages/src/{serialize,protocol}.ts`
  và `provider-anthropic/src/adapter.ts`: `output_config.effort` pass-through + gộp `output_config.format`;
  `thinking` độc lập effort, chỉ gửi khi cấu hình; `reasoningFormat: 'output-config' | 'thinking-budget'` (mặc định
  `'output-config'`); `max_tokens` dùng `DEFAULT_MAX_TOKENS` khi không đặt; không tự bỏ `temperature`/`top_p`;
  `authHeader: 'x-api-key' | 'bearer'`. Có 24 test trong `anthropic-serialize.spec.ts` phủ cả hai `reasoningFormat`.
  Test cũ `provider-factory-matrix.spec.ts` còn kỳ vọng wire cũ (`thinking.budget_tokens`) — **đã sửa** thành
  `output_config.effort`.
- [x] **Gemini:** `thinking_level` như hiện tại — đã có sẵn. **Auth header cấu hình được — làm lượt này:** thêm
  `GeminiAdapterOptions.authHeader?: 'x-goog-api-key' | 'bearer'`, mirror đúng cơ chế `authOf()` của
  `provider-anthropic`. Test mới xác nhận `Authorization: Bearer` thay `x-goog-api-key` khi bật.
- [x] **Reasoning khi đổi route (quyết định 6):** đã xác nhận có sẵn qua test `round-trips reasoning state`
  (responses), test round-trip tương tự ở anthropic/chat-completions — không cần sửa thêm cho pha 3.
- [x] Switch `compat` không thuộc protocol đang dùng báo lỗi ngay khi cấu hình. Đánh giá lại lần nữa: TS chặn được
  **caller có kiểu**, nhưng phát hiện khi đọc kỹ `serialize.ts` của cả hai protocol rằng một giá trị lọt qua (JS
  thuần, hoặc `as any`) không hề bị bỏ qua an toàn — nó **âm thầm đổi hành vi sang một format khác**: Chat
  Completions' `reasoningFieldsOf()` chỉ so `=== false`/`=== 'openai'`, bất kỳ chuỗi lạ nào (kể cả
  `'thinking-budget'` của Anthropic) rơi vào nhánh `else` và bị xử lý như `'deepseek'`; Anthropic's `serialize.ts`
  chỉ so `=== 'thinking-budget'`, bất kỳ chuỗi lạ nào (kể cả `'deepseek'` của Chat Completions) rơi vào nhánh
  `else` và bị xử lý như `'output-config'`. Đây đúng là "báo lỗi" bị thiếu, không phải chỉ là rủi ro lý thuyết — đã
  sửa bằng cách thêm validate ngay tại nơi dựng dialect (không đợi tới serialize):
  [provider-openai/src/adapter.ts](../../packages/provider-openai/src/adapter.ts) (`chatCompletionsDialectOf`, ném
  `TypeError` nếu `reasoningFormat` không thuộc `'openai' | 'deepseek' | false`) và
  [provider-anthropic/src/adapter.ts](../../packages/provider-anthropic/src/adapter.ts) (`dialectOf`, ném `TypeError`
  nếu không thuộc `'output-config' | 'thinking-budget'`, dùng chung cho cả `anthropicAdapter()` lẫn
  `createRuntimeAnthropicAdapter()`). Gemini không có field `reasoningFormat` (dùng thẳng `thinking_level`) nên không
  cần sửa. Test mới: `provider-openai.spec.ts`/`provider-anthropic.spec.ts` xác nhận ném lỗi đúng thông điệp khi đặt
  giá trị thuộc protocol kia.
- [x] **Lỗi gốc (quyết định 7):** đã xác nhận đúng theo thiết kế, đọc trực tiếp `core/src/runtime/model-call-handle.ts`
  (`safeFailureFromFinish` giữ nguyên `failure.message`), `provider-http/src/transport/session.ts:374-386`
  (`httpFailure` giữ message/status/requestId/cause gốc từ `parseErrorBody`). Dòng "model call failed; inspect the
  stable code…" mà bản nháp đầu của plan trích dẫn **không còn tồn tại** ở `model-call-handle.ts` — đã bị nhầm với một
  helper khác cùng tên biến thể (`safeProviderFailure` trong `provider-http/src/transport/http.ts:216-223`, và bản
  mirror ở `provider-copilot/src/errors.ts:55`, `core/src/composition/embedding/observation.ts:106`), dùng cho
  `attempts[].error` — một bản ghi audit **cố ý** bỏ text nhà cung cấp vì lý do khác (chặn provider echo lại header
  nhạy cảm vào message lỗi, xem doc comment tại `provider-copilot/src/errors.ts:47-48`), không phải để "làm sạch lỗi"
  như quyết định 7 nói. Hai mối lo khác nhau: top-level `ModelCallReport.error`/lỗi ném ra (phạm vi quyết định 7, đã
  đúng) và `attempts[].error` (audit chống rò rỉ header, cố ý khác, ngoài phạm vi). **Không sửa 3 file này.**
- [x] Test: snapshot body JSON cho từng `reasoningFormat` và từng switch — đã có sẵn đầy đủ ở
  `anthropic-serialize.spec.ts` (24 test), `chat-completions-serialize.spec.ts`, `gemini-interactions-serialize.spec.ts`,
  `responses-serialize.spec.ts` (bổ sung 3 test `store`/`include` lượt này). Test lỗi 400 giữ message gốc: đã có sẵn ở
  `http-errors.spec.ts`, `chat-completions-errors.spec.ts`, `copilot-cross-provider-errors.spec.ts`.

**Verify:** `pnpm typecheck` (root) sạch. `pnpm test` (root) — **2830/2830 xanh** (macOS, không có 24 lỗi
pre-existing của Windows nêu ở pha 0/1/2 vì môi trường máy này là Darwin, không phải Windows — khớp với mô tả gốc của
các lỗi đó là "symlink permission trên Windows").

> Lưu ý phát hiện phụ (không thuộc phạm vi sửa của pha 3, không sửa): `tsc --noEmit` chạy riêng lẻ trong
> `packages/provider-anthropic` hoặc `packages/provider-gemini` (không qua root) báo lỗi kiểu `CredentialSource` của
> `core` và của `provider-http` là hai type khác nhau dù cùng tên, ở nhánh `authHeader: 'bearer'`. Đây là lỗi
> **tồn tại từ trước** (xác nhận bằng `git stash` trên `provider-anthropic`, không liên quan gì đến gemini vừa thêm) —
> chỉ xuất hiện khi tsc của một package tự resolve type qua `dist` đã build của package khác thay vì qua chương trình
> gộp ở root (`pnpm typecheck` dùng con đường thứ hai, không có lỗi này, và đó là cách kiểm chứng chính thức của repo).
> Không chặn pha nào của plan; ghi lại để không lặp lại công điều tra nếu gặp lại.

### Pha 3b: Bề mặt cấu hình mở rộng chung cho `provider-*` — MỘT PHẦN XONG (2026-09-18)

**Mục tiêu:** endpoint tương thích thường cần thêm thứ gì đó ngoài chuẩn (header riêng, query `api-version`, field
body riêng của vendor, hai lớp khóa khi đi qua gateway…). Người dùng phải làm được bằng cấu hình, không fork package.

**Giới hạn hiện tại** (đã kiểm tra trong code):

| Nhu cầu | Hiện trạng | Vị trí |
|---|---|---|
| Header tùy chỉnh | ✅ **Đã làm 2026-09-18** — hàm nhận `{ provider, agentId?, signal }` (không có `model`, có chủ đích — xem việc cần làm) | [endpoint-headers.ts](../../packages/provider-http/src/common/endpoint-headers.ts) |
| Header nhạy cảm thứ hai (khóa gateway + khóa upstream, `cf-aig-authorization`, `x-portkey-api-key`…) | ✅ **Đã làm 2026-09-18** — `auth` nhận mảng scheme, mỗi phần tử một credential, đều che trong log | [http-provider.ts](../../packages/provider-http/src/configurable/http-provider.ts) |
| Query string (Azure `?api-version=`, `?key=`…) | ✅ **Đã làm 2026-09-18** — `query` tĩnh/hàm ở route, cả 3 provider | [request-path.ts](../../packages/provider-http/src/common/request-path.ts) |
| Field body riêng của vendor (OpenRouter `provider`/`transforms`, vLLM `chat_template_kwargs`/`top_k`, Qwen `enable_thinking`, Anthropic `metadata`/`service_tier`…) | ✅ **Đã làm 2026-09-18** — `body` gộp sâu + `transformRequest` ở route, cả 3 provider | [body-merge.ts](../../packages/provider-http/src/common/body-merge.ts) |
| Đổi path endpoint | ✅ **Đã làm 2026-09-18** — `path` ở route, tập trung trong `ConfiguredHttpAdapter`, cả 3 provider (không chỉ Chat Completions) | [http-provider.ts:endpointPath](../../packages/provider-http/src/configurable/http-provider.ts) |
| Header của protocol (`anthropic-version`, `anthropic-beta`) | ✅ **Đã làm 2026-09-18** — `headers` route giờ ghi đè được (lớp sau thắng lớp trước) | [header-layers.ts](../../packages/provider-http/src/common/header-layers.ts) |

**Bề mặt đích** (dùng chung cho `provider-openai`, `provider-anthropic`, `provider-gemini`; định nghĩa một lần trong
`provider-http`):

```ts
openAiPlugin({
  id: 'azure-gpt',
  baseUrl: 'https://my-res.openai.azure.com/openai/deployments/gpt-5-6',
  path: '/chat/completions',                       // đổi path cho mọi protocol
  query: { 'api-version': '2026-06-01' },          // query string
  auth: [                                          // nhiều header credential, đều được che trong log
    { kind: 'header', name: 'api-key', value: env('AZURE_KEY') },
  ],
  headers: ctx => ({ 'x-trace-agent': ctx.agentId ?? 'none' }), // hàm nhận ngữ cảnh
  body: { user: 'svc-coder' },                     // field bổ sung vào body
  transformRequest: (body, ctx) => body,           // lối thoát cuối cùng, toàn quyền
  models: [
    { id: 'gpt-5-6', headers: { ... }, body: { ... }, compat: { ... } }, // ghi đè theo model
  ],
})

runtime.agent({
  model: { provider: 'openrouter', id: 'anthropic/claude-opus-5' },
  providerOptions: {                               // ghi đè theo agent
    headers: { 'x-title': 'coder' },
    body: { provider: { order: ['anthropic'] } },
  },
})
```

**Trạng thái (2026-09-19, cập nhật cuối phiên, đợt 5): TOÀN BỘ pha 3b đã xong — không còn mục nào treo.** Cả 3 tầng
route/model/agent đều hoạt động đúng thứ tự "sau thắng trước" (quyết định 12) cho cả `headers` lẫn `body`; `auth`
nhận mảng scheme **kể cả biến thể `{kind:'query'}`** cho secret nằm trong query string (đã thêm hạ tầng redact URL
riêng — xem `redactQueryUrl` trong việc cần làm bên dưới, mục "cố ý chưa làm" trước đó đã bị xóa vì đã làm xong);
`path`, `query`, `transformRequest`, `runtime.agent({ providerOptions })` đều đã có, có test qua `createAgentRuntime`
thật xuyên suốt cả 6 biến thể provider × adapter thủ công.

Việc cần làm:

- [x] **`headers`** ghi đè SDK (transport/attribution/protocol) — xong, xem quyết định 12 bên dưới. **Dạng hàm nhận
  ngữ cảnh `{ provider, agentId?, signal }` — XONG (2026-09-18, lượt sau).** Đã thêm `agentId` xuyên suốt core trước
  (xem mục core riêng ngay dưới), rồi nối vào `endpointHeaders()`
  ([endpoint-headers.ts](../../packages/provider-http/src/common/endpoint-headers.ts), type `HeaderContext` mới,
  xuất công khai từ `provider-http`), `ConfiguredHttpAdapter.connect()` (gọi
  `this.options.headers({provider, agentId?, signal})` thay vì gọi suông), `captureHeaders()` runtime-extension
  (`Reflect.apply(value, source, [ctx])`). **Không có `model`** trong `HeaderContext` công khai (ctx của hàm
  `headers` cấp route) — quyết định có chủ đích, ghi rõ trong doc comment của `HeaderContext`: hàm `headers` cấp
  route có thể chạy trước khi model được biết (ví dụ `listModels()`), nên đưa `model` vào ctx công khai này sẽ hứa
  hẹn sai một bảo đảm theo-từng-request. **`headers`/`body` cấp agent VÀ cấp model — cả hai đều XONG**, xem mục
  `providerOptions` cấp agent bên dưới và mục `models[].headers/body` riêng cũng ngay dưới đây — cấp model dùng cơ
  chế nội bộ khác (tra cứu tĩnh `this.options.models.find(id)`), không đi qua `HeaderContext` công khai nên không
  mâu thuẫn với quyết định ở trên: `connect()` (nội bộ, không phải hàm `headers` của người dùng) nhận thêm tham số
  thứ 4 `model?: string`, có ở 3/4 nơi gọi (thiếu ở `listModels()` vì hàm đó liệt kê MỌI model, không có model đơn lẻ
  nào để tra).
  Ảnh hưởng dây chuyền phải sửa cùng lúc: `OpenAiEmbeddingAdapter`/Gemini embedding adapter cũng dùng
  `endpointHeaders()` với chữ ký không tham số cũ — phải nối `provider` (đã có sẵn ở lời gọi `prepareEmbeddingCall`/
  `embedBatch`) xuống hàm `connect()` nội bộ của từng embedding adapter để không vỡ kiểu.
  Test: `provider-endpoint-headers.spec.ts` ("carries the agent id into `headers` and `transformRequest` context",
  chạy qua cả 6 biến thể provider × adapter thủ công, xuyên suốt `createAgentRuntime` thật, không mock tầng core).
- [x] **Hạ tầng `agentId` trên `ModelInvocationContext` — XONG (2026-09-18), việc core đã làm** (không còn "chưa
  nghiên cứu" như bản trước của mục này). 3 điểm sửa, đúng như một agent nghiên cứu con đã vạch ra trước khi code:
  1. `core/src/observation/report.ts`: thêm `agentId?: string` vào `ModelInvocationContext`.
  2. `core/src/agent/accounting/ledger.ts` (constructor `RunLedger`, object `this.modelInvocation`): thêm
     `agentId: options.agentId` — `options.agentId` (= `AgentDefinition.id`) đã được validate non-empty ngay phía
     trên, không cần thêm plumbing nào khác ở tầng agent để có giá trị này.
  3. `core/src/runtime/model-call-handle.ts` (`effectiveContext`): thêm
     `...(input.context?.agentId === undefined ? {} : { agentId: input.context.agentId })`, đúng khuôn mẫu đã dùng
     cho `logger` ngay phía trên.
  4. `packages/provider-http/src/base/http-adapter.ts`: thêm `agentId?: string` vào `ProviderRequest`, điền từ
     `context?.agentId` tại nơi dựng `request` trong `run()` — đây là cách `agentId` đến được `buildBody()`
     (`transformRequest`'s `ctx.agentId`) mà không cần đổi chữ ký `buildBody(request)`.
  `ModelInvocationContext` là type CHUNG, không như `CredentialSource` (core có 2 type trùng tên khác nhau) —
  `provider-http` import type thẳng từ `@alvin0/ai-agent-sdk-core`, nên thêm field vào core là đủ, không cần đồng bộ
  gì thêm. Test hiện có (không sửa gì) vẫn xanh vì field là optional, không phá bất kỳ object literal
  `ModelInvocationContext` nào trong test hiện có.
- [x] **`auth` nhận mảng scheme, kể cả biến thể `{kind:'query'}` — XONG HOÀN TOÀN (2026-09-19).**
  `HttpProviderOptions.auth`/`RuntimeHttpProviderOptions.auth` giờ là `AuthScheme | readonly AuthScheme[]`
  ([http-provider.ts](../../packages/provider-http/src/configurable/http-provider.ts),
  [runtime-types.ts](../../packages/provider-http/src/configurable/runtime-types.ts)). `authSchemeResolved()` giải
  quyết một scheme thành `{headers, query}` (kind `'query'` sinh entry `query`, mọi kind khác sinh `headers`);
  `authHeaders()` chạy `Promise.all` trên mọi scheme rồi gộp riêng từng loại qua `unionByName()` dùng chung —
  **báo lỗi ngay nếu hai scheme cùng tên header HOẶC cùng tên query param** — trước khi bao giờ chạm tới
  `mergeHeaderLayers`, vì đây là lỗi cấu hình chứ không phải chỗ để chính sách "lớp sau thắng" xử lý giúp.
  `captureRuntimeAuthScheme` có thêm nhánh `'query'`, cùng khuôn với `'header'`.
  **Hạ tầng redact URL — đã làm xong, không còn là lý do hoãn nữa.** `HttpConnection`/`HttpTransportConnection`
  (`transport/connection.ts`) có thêm `queryOverrides`/`sensitiveQueryParamNames`, điền tại `connect()` từ
  `auth.query`; `ConfiguredHttpAdapter.endpointPath()` gộp `queryOverrides` lên trên `query` của route (auth luôn
  thắng cuối, đúng thứ tự quyết định 12); hàm mới `redactQueryUrl()`
  ([transport/http.ts](../../packages/provider-http/src/transport/http.ts), cùng khuôn `redactHeaders()` có sẵn) áp
  dụng vào `url` trước khi đưa vào `ProviderRequestLogRecord` ở `transport/session.ts` — request thật vẫn mang giá
  trị gốc, chỉ bản ghi log bị che.
  Test: `http-provider.spec.ts` (6 test: union nhiều scheme header cả in-process lẫn runtime-extension, báo lỗi khi 2
  scheme cùng tên header, `query`-kind gộp đúng vào URL và được che đúng trong `requestLogger` trong khi URL dispatch
  thật vẫn mang giá trị gốc, báo lỗi khi 2 scheme `query` cùng tên, `query`-kind qua runtime-extension).
- [x] **`query`**: record tĩnh hoặc hàm — **xong** (route, cả in-process lẫn runtime-extension, cả 3 provider
  adapter). File: [request-path.ts](../../packages/provider-http/src/common/request-path.ts) (`appendQuery`, gộp
  thẳng vào path trả về từ `endpointPath()` — không cần sửa `transport/http.ts`'s `endpointUrl()`, vì `new URL(base +
  path)` tự parse `?query` có sẵn trong `path`), `http-provider.ts` (`HttpProviderOptions.query`), `runtime-provider.ts`
  (`captureQuery`/`snapshotQuery`, validate record-of-string, mã lỗi mới `HTTP_QUERY_INVALID`), `runtime-types.ts`.
  **Giá trị nhạy cảm qua `auth: [{kind:'query',...}]` — XONG**, xem mục `auth` mảng ở trên (đã có redact URL riêng).
- [x] **`path`**: có ở mọi protocol — **xong, nhưng tập trung ở provider-http thay vì sửa dialect của 4 protocol
  package.** `ConfiguredHttpAdapter.endpointPath()`/runtime tương đương giờ là
  `this.options.path ?? this.options.protocol.endpointPath(...)` rồi gộp query — một chỗ, đúng tinh thần "định nghĩa
  một lần trong provider-http" thay vì sửa `protocol.ts` của Responses/Anthropic/Gemini (Chat Completions vẫn giữ
  `dialect.path` riêng, không đụng). `path`/`query` đã lộ ra ở `OpenAiAdapterOptions`, `AnthropicAdapterOptions`,
  `GeminiAdapterOptions` (và các biến thể `*ProviderOptions`/plugin).
- [x] **`body`** — **xong ở cả 3 tầng: route, model, agent.** File mới
  [body-merge.ts](../../packages/provider-http/src/common/body-merge.ts) (`mergeRequestBody`, đệ quy trên object
  thường, `null` xóa field, mảng/giá trị khác thay nguyên khối — không gộp theo từng phần tử mảng để tránh âm thầm
  đảo thứ tự dữ liệu người dùng không hề đụng tới). Gắn vào `ConfiguredHttpAdapter.buildBody()` (`http-provider.ts`)
  theo đúng thứ tự "sau thắng trước": `protocol.serialize(...)` → gộp `this.options.body` (route) → gộp
  `models[].body` của đúng model đang gọi (tra `this.options.models.find(id)`, chỉ áp dụng cho catalog khai báo
  tĩnh, không áp dụng cho catalog `discoverModels` động) → gộp `request.providerOptionsBody` (agent) → cuối cùng mới
  tới `transformRequest`. Bản sao runtime-extension qua `copyJsonOptional(source, 'body', 'body')` trong
  `runtime-provider.ts` (tái dùng `snapshotJsonObject`/`HTTP_RUNTIME_OPTION_LIMITS` sẵn có). `body?: Readonly<Record<
  string, unknown>>` đã lộ ra ở cả 3 provider adapter (cấp route) và tự động lộ ra ở cấp model vì `models[]` dùng
  thẳng `ProviderCatalogModel` — chỉ cần thêm 2 field `headers?`/`body?` vào type đó một chỗ duy nhất
  ([http-adapter.ts](../../packages/provider-http/src/base/http-adapter.ts)), không cần sửa gì thêm ở 3 package
  provider.
- [x] **`transformRequest(body, ctx)`** — **xong**, chạy sau `body` gộp (cả route lẫn agent), nhận
  `{ provider, model, agentId?, signal? }` — `agentId` **đã thêm** cùng lượt với hạ tầng `agentId`/`providerOptions`
  trên `ModelInvocationContext` (xem mục core riêng bên dưới). `RequestContext` xuất công khai từ `provider-http`,
  tái dùng nguyên dạng ở cả 3 provider (kiểu cấu trúc giống hệt kiểu inline khai trong `runtime-types.ts` nên không
  gặp lại lỗi trùng tên khác type như `CredentialSource`/core đã gặp — đây là cùng một package, không phải hai
  package định nghĩa lại cùng tên).
  Test: `http-provider.spec.ts` (3 test: gộp `body` + xóa field qua `null` ở cả in-process lẫn runtime-extension,
  `transformRequest` chạy sau cùng và nhận đúng `ctx`), `provider-endpoint-headers.spec.ts` (2 `it.each` xuyên suốt
  6 biến thể provider × adapter thủ công: một cho `body`/`transformRequest` cơ bản, một cho `agentId` trong cả hai
  ngữ cảnh).
- [x] **Ghi đè header của SDK (quyết định 12) — xong**, đổi chính sách trong
  [header-layers.ts](../../packages/provider-http/src/common/header-layers.ts) từ "trùng là lỗi" sang **lớp sau
  thắng lớp trước** (`mergeHeaderLayers` không còn `owners` map, chỉ còn 2 chặn cứng — xem dưới). Test:
  `http-provider.spec.ts` ("lets a caller override transport, SDK-attribution, and protocol headers",
  "lets `auth` override a same-named endpoint header"), `provider-endpoint-headers.spec.ts`.
  **Thứ tự route/agent — xong, không cần thêm nhãn `HeaderLayer` riêng.** Cách làm cuối cùng đơn giản hơn dự kiến ban
  đầu: thay vì tách `HeaderLayer` thành 3 nhãn con (`'endpoint-route' | 'endpoint-model' | 'endpoint-agent'`),
  `ConfiguredHttpAdapter.connect()` chỉ cần thêm MỘT lớp `'endpoint'` thứ hai vào `publicLayers`, đặt SAU lớp route
  hiện có — chính sách "lớp sau thắng lớp trước" đã có sẵn tự lo phần còn lại. `HeaderLayer` là nhãn quan sát/audit
  (biết header đến từ đâu để che log), không phải cơ chế xác định thứ tự thắng-thua (thứ tự đó nằm ở vị trí trong
  mảng `layers` truyền vào `mergeHeaderLayers`) — nhãn model/agent riêng chỉ cần thiết nếu sau này có nhu cầu quan
  sát/debug phân biệt "header này đến từ tầng nào", chưa phát sinh nhu cầu đó.
- [x] Vẫn chặn header cấp kết nối (`host`, `content-length`, `connection`, `transfer-encoding`, `te`, `trailer`,
  `upgrade`, `proxy-*`, `sec-*`) — không đổi, test lại nguyên vẹn.
- [x] Vẫn giữ quy tắc "header giống credential phải đi qua `auth`" — không đổi (không phải để cấm ghi đè, mà để SDK
  biết header nào cần che trong log).
- [x] Test: `http-provider.spec.ts` viết lại 3 test cũ dựa trên hành vi "collision là lỗi" thành hành vi "override
  thắng" + các test mới cho fail-fast trên tên bị cấm, auth-thắng-endpoint, auth mảng, `body`/`transformRequest`;
  `provider-endpoint-headers.spec.ts` phủ path/query/body/transformRequest/agentId/providerOptions xuyên suốt cả 6
  biến thể (plugin + adapter thủ công × 3 họ), qua `createAgentRuntime` thật; `responses-serialize.spec.ts` không
  liên quan trực tiếp 3b nhưng cùng đợt (xem pha 3).

- [x] **`providerOptions` cấp agent (`runtime.agent({ providerOptions: { headers, body } })`) — XONG (2026-09-19).**
  Đây là việc core lớn nhất của pha 3b, đã làm xong trong lượt cuối. Thiết kế cuối cùng **không** đi qua `CallConfig`/
  `GenerateOptions` (kênh vốn dùng cho `reasoningEffort`/`maxTokens`) — thử hướng đó trước rồi lùi lại, vì
  `ConfiguredHttpAdapter.connect()` (nơi headers cần được gộp) chạy trong luồng `prepareCall()` (registry tách "chuẩn
  bị năng lực" khỏi "gửi request" — xem doc comment của `CallConfig`), và **`prepareCall()` không có `GenerateOptions`
  đầy đủ trong tay** (chỉ có `provider, model, signal, context`) — `providerOptions` đặt trong `GenerateOptions` sẽ
  không bao giờ tới được `connect()`. Kênh đúng là `ModelInvocationContext` — CÓ mặt ở cả hai luồng
  (`prepareCall`/`runResolving`) — đúng bản chất của `providerOptions`: một sự thật cố định về AGENT (như `agentId`),
  không phải một tham số thay đổi theo từng lần gọi.
  - File core đã sửa: `agent/define/definition.ts` (interface `AgentProviderOptions` mới; field `providerOptions`
    trên `AgentDefinitionInput`/`AgentDefinition`/`DefinedAgentValue`/`mergedInput()`, đông lạnh từng phần
    `headers`/`body` độc lập), `composition/agent/types.ts` (`RuntimeAgentDefinitionInput.providerOptions`),
    `composition/agent/definition.ts` (thêm `'providerOptions'` vào allowlist `KEYS`, hàm `captureProviderOptions()`
    mới xác thực `headers` toàn giá trị string trước khi đưa vào `defineAgent({...})`), `observation/report.ts`
    (`ModelInvocationContext.providerOptions`), `agent/accounting/ledger.ts` (`RunLedgerOptions.providerOptions` →
    `this.modelInvocation`), `agent/define/session/accounting.ts` (`createSessionLedger()` đọc
    `definition.providerOptions`, cùng cơ chế với `agentId: definition.id` ngay dòng trên), `runtime/model-call-handle.ts`
    (`effectiveContext` sao `input.context?.providerOptions`).
  - File provider-http đã sửa: `base/http-adapter.ts` (`ProviderRequest.providerOptionsBody`, điền từ
    `context?.providerOptions?.body` tại nơi dựng `request` trong `run()` — cùng vị trí đã dùng cho `agentId`),
    `configurable/http-provider.ts`: `connect()` thêm MỘT lớp `'endpoint'` nữa vào `publicLayers`, đọc
    `context?.providerOptions?.headers`, đặt SAU lớp headers của route — agent thắng route đúng thứ tự quyết định
    12; `buildBody()` gộp `request.providerOptionsBody` lên trên body đã gộp của route, TRƯỚC `transformRequest`.
  - Không cần sửa gì thêm ở tầng model (`models[].headers/body`) để tính năng này hoạt động đúng — agent luôn là tầng
    thắng cuối cùng nên không phụ thuộc tầng model có tồn tại hay không. Tầng model **đã làm thêm ngay sau đó** (xem
    mục riêng ngay dưới) để plan không còn khoảng trống nào trong chuỗi "route, model, agent" của quyết định 12.
  - Test: `provider-endpoint-headers.spec.ts` — 1 `it.each` xuyên suốt 6 biến thể, xác nhận: header/body agent ghi
    đè route khi trùng tên, header/body chỉ-route hoặc chỉ-agent đều giữ nguyên (không bị agent xóa mất).

- [x] **`models[].headers`/`.body` (tầng model của quyết định 12) — XONG (2026-09-19).** Mục cuối cùng còn thiếu
  trong chuỗi "route, model, agent" — làm ngay sau khi hoàn tất `auth` mảng và `providerOptions` cấp agent ở trên,
  đóng nốt pha 3b hoàn toàn.
  - **`body`**: chỉ cần thêm 2 field `headers?`/`body?` vào `ProviderCatalogModel`
    ([base/http-adapter.ts](../../packages/provider-http/src/base/http-adapter.ts)) — tự động lộ ra ở cả 3 provider
    vì `models: readonly ProviderCatalogModel[]` đã dùng thẳng type này, không cần sửa gì ở `provider-openai`/
    `provider-anthropic`/`provider-gemini`. `buildBody()` tra `this.options.models.find(m => m.id ===
    request.model.id)?.body`, gộp vào giữa route và agent.
  - **`headers`**: khó hơn — `connect()` (nơi headers được gộp) vốn KHÔNG biết model đang gọi là gì, vì nó chạy độc
    lập với model để một route có thể dùng chung một `HttpConnection` cho nhiều model. Giải quyết bằng cách thêm
    tham số thứ 4 `model?: string` vào `protected abstract connect()` của `HttpModelAdapter`
    ([base/http-adapter.ts](../../packages/provider-http/src/base/http-adapter.ts)) — an toàn vì **chỉ có đúng một
    lớp con** (`ConfiguredHttpAdapter`) kế thừa lớp trừu tượng này trong toàn bộ repo (đã xác nhận bằng grep). Điền
    tham số này ở 3/4 nơi gọi `connect()` (`resolveModel`, `prepareCall`, `runResolving`) — thiếu đúng một nơi,
    `listModels()`, vì hàm đó liệt kê MỌI model nên không có một model đơn lẻ nào để truyền. `connect()` tra
    `this.options.models.find(id)?.headers`, chèn một lớp `'endpoint'` nữa vào `publicLayers`, **giữa** lớp route và
    lớp agent (đúng thứ tự "sau thắng trước").
  - Đây là ví dụ cụ thể cho lý do `HeaderContext` công khai (ctx của hàm `headers` cấp route) cố tình không có
    `model`: có nơi (`listModels()`) gọi `connect()` mà không có model nào — nếu để `headers`-theo-ngữ-cảnh công
    khai phụ thuộc `model`, những nơi đó sẽ phải giả một giá trị. Cấp model dùng cơ chế tra cứu tĩnh riêng, không
    đụng tới `HeaderContext`.
  - Test: `http-provider.spec.ts` ("lets `models[].headers`/`.body` win over the route, and the agent win over
    both", xác nhận cả chiều ngược lại — model khác không hề thấy override của model đầu), `provider-endpoint-headers.spec.ts`
    ("stacks route → models[] → agent, later tier winning at each step", xuyên suốt 6 biến thể, 2 field trùng tên ở
    cả 3 tầng để xác nhận đúng tầng nào thắng ở từng bước).

**Verify cuối pha 3b:** `pnpm typecheck` (root) sạch, `pnpm test` (root) **2883/2883 xanh**, baseline public-API đã
regenerate nhiều lần trong suốt các lượt này (mỗi lần thêm export/đổi hình dạng khai báo: `HeaderContext`, `auth`
mảng, `ProviderRequest.providerOptionsBody`, `ProviderCatalogModel.headers/body`). **Pha 3b không còn mục nào chưa
làm** — toàn bộ bảng "Giới hạn hiện tại" gốc của pha này giờ đều ở trạng thái ✅.

### Pha 4a: Chat Completions trong `provider-openai` — XONG (2026-09-19), chỉ còn nghiệm thu sống

**Lý do:** phần lớn endpoint tương thích OpenAI (DeepSeek, Groq, Together, Qwen/DashScope, vLLM, Ollama, LM Studio,
nhiều gateway) chỉ có `/chat/completions`, không có `/responses`. Thiếu nhánh này thì `provider-openai` chưa phải
provider cho cả họ API OpenAI.

**Hiện trạng trước khi làm:** package [`protocol-openai-chat-completions`](../../packages/protocol-openai-chat-completions/src/protocol.ts)
đã có đủ serializer, translator, xử lý lỗi và test (`tests/unit/chat-completions-*.spec.ts`), đang được
`provider-copilot` dùng. `provider-openai` chỉ phụ thuộc `protocol-responses`. Phần việc chủ yếu là nối, không viết
protocol mới — đúng như dự đoán, xác nhận sau khi làm.

File đã sửa: `provider-openai/package.json` (thêm dependency), `provider-openai/src/adapter.ts` (branch
protocol/dialect theo `api`, `chatCompletionsDialectOf()`, option `api`/`compat` mới trên cả 4 kiểu:
`OpenAiAdapterOptions`/`OpenAiPluginOptions`/`OpenAiProviderOptions` kế thừa, cả `openAiAdapter` lẫn
`createRuntimeOpenAiAdapter`), `tests/unit/provider-openai.spec.ts` (2 test mới), `tests/fixtures/public-api/untouched-packages.json`.

- [x] Thêm dependency `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` vào `provider-openai`.
- [x] Option `api: 'responses' | 'chat-completions'` **ở route** (mặc định `'responses'`, cả `openAiAdapter` và
  `createRuntimeOpenAiAdapter`).
  - [x] **Ở model (`models[].api`), một route phục vụ cả hai kiểu model — XONG (2026-09-19), nhưng KHÔNG dùng
    composite protocol kiểu `copilotDualProtocol`.** Ban đầu đánh giá phải mất ~380 dòng như Copilot rồi hoãn; nhìn
    lại thấy Copilot cần composite Ở TẦNG PROTOCOL (`serialize`/`translate`/`endpointPath` branch theo model NGAY
    TRONG một `HttpModelAdapter`) chỉ vì hai wire của Copilot phải dùng CHUNG một kết nối/credential (device-code).
    `provider-openai`'s Responses và Chat Completions không có ràng buộc đó — mỗi API đã có adapter
    `createHttpProvider` hoàn chỉnh, độc lập, tự kiểm chứng riêng (pha 1-4a). Giải pháp đơn giản hơn nhiều: một
    facade Ở TẦNG ADAPTER, `OpenAiDualApiAdapter`
    ([dual-api.ts](../../packages/provider-openai/src/dual-api.ts)) — giữ hai adapter hoàn chỉnh (một Responses, một
    Chat Completions), định tuyến TOÀN BỘ lời gọi (`stream`, `prepareCall`, `resolveModel`, `listModels`,
    `modelCatalog`, `providerInfo`) theo model id, dựa trên `ModelAdapter` (`@alvin0/ai-agent-sdk-core`) — lớp trừu
    tượng chỉ có ĐÚNG MỘT method bắt buộc (`stream`), thiết kế sẵn cho đúng mục đích "một adapter phục vụ nhiều
    route/model" (đọc thẳng trong doc comment của chính lớp đó). `HttpModelAdapter extends ModelAdapter`, nên
    `openAiAdapter()`/`createRuntimeOpenAiAdapter()` đổi kiểu trả về từ `HttpModelAdapter` sang `ModelAdapter` (nới
    lỏng, không phá vỡ gì — bề mặt public của `HttpModelAdapter` với bên ngoài y hệt `ModelAdapter`, các method thêm
    của nó đều `protected`).
    - `OpenAiCatalogModel` (mở rộng `ProviderCatalogModel` với `api?`) — chỉ khai báo trong `provider-openai`, không
      đụng type dùng chung `ProviderCatalogModel` (anthropic/gemini không có khái niệm này).
    - Kích hoạt facade CHỈ KHI có model khai báo `api` khác với `api` mặc định của route — trường hợp phổ biến (một
      route, một API duy nhất) đi nguyên đường cũ, không đổi hành vi, không rủi ro thêm.
    - Test: `provider-openai.spec.ts` ("routes each model to its own wire and merges both catalogs" — xác nhận
      dispatch đúng wire theo từng model, catalog gộp đúng cả hai; "stays a single adapter... when no model overrides
      the route default" — xác nhận trường hợp phổ biến không kích hoạt facade; "...through the runtime-extension
      plugin path too" — cùng test qua `openAiPlugin`/`createAgentRuntime` thật, không chỉ `openAiAdapter` thấp cấp).
    - Việc dây chuyền: 2 hàm test trong `tests/unit/copilot-cross-provider-errors.spec.ts` khai kiểu tham số/trả về
      cứng là `HttpModelAdapter` — phải nới thành `ModelAdapter` (chỉ dùng `.stream()`, không cần gì riêng của
      `HttpModelAdapter`) để nhận được cả hai loại giá trị (Copilot vẫn trả `HttpModelAdapter`, OpenAI giờ trả
      `ModelAdapter`).
- [x] Đưa các knob hiện có của `ChatCompletionsDialect` ra thành `compat` công khai trên `OpenAiAdapterOptions`:
  `reasoningFormat`, `maxTokensField`, `systemRole`, `structuredOutputs`, `tools`, `parallelToolCalls`, `streamUsage`,
  `stop`, `seed`, `promptCacheKey` — tất cả optional, không đặt thì giữ mặc định của protocol.
- [x] Giá trị mặc định theo protocol: `systemRole: 'system'`, `maxTokensField: 'max_tokens'` đã đúng sẵn trong
  `DEFAULT_DIALECT` của `protocol-openai-chat-completions` (không cần override) — chỉ **`reasoningFormat`** cần
  provider-openai tự đặt mặc định `'openai'` (khác mặc định `false` của protocol, vì protocol dùng chung với
  `provider-copilot` và không được đổi default dùm — xem pha 3). Căn cứ: `reasoning_effort` trên
  `/v1/chat/completions` đã được đo sống qua codex2claudecode (mục 4 của plan), không phải đoán.
- [x] `path` đổi được — **đã có sẵn từ pha 3b** (route-level `path`/`query` tổng quát cho cả provider-openai, áp dụng
  luôn cho nhánh chat-completions), không cần làm riêng cho pha này.
- [x] Phía response: đọc `reasoning_content` (DeepSeek)/usage `reasoning_tokens` — **đã có sẵn** trong
  `protocol-openai-chat-completions/src/translate.ts` từ trước pha này (xác nhận lại ở pha 3); lỗi giữ message gốc —
  áp dụng tự động qua `provider-http` chung, không cần code riêng cho chat-completions.
- [x] Reasoning của lượt trước chỉ gửi lại khi cùng route/model — hành vi chung của protocol, đã test ở pha 3, không
  cần thêm gì riêng cho `provider-openai`.
- [~] Test:
  - [x] Unit: 2 test mới trong `provider-openai.spec.ts` — dispatch qua `/chat/completions` với `api:
    'chat-completions'` (kiểm URL, body có `messages`/`model`, `reasoning_effort` gửi đúng giá trị effort của agent),
    và `compat.reasoningFormat: 'deepseek'` chuyển effort `'off'` thành `thinking: {type:'disabled'}` không gửi
    `reasoning_effort` — khớp hành vi đã có test ở tầng protocol (`chat-completions-serialize.spec.ts`), giờ thêm
    lớp xác nhận **provider-openai nối đúng dây**.
  - [x] **Snapshot toàn bộ tổ hợp `compat`** — thêm 1 test mới trong `provider-openai.spec.ts` ("snapshots the full
    `compat` combination, every field at once") đặt cả 10 field cùng lúc với giá trị khác mặc định
    (`reasoningFormat: 'deepseek'`, `maxTokensField: 'max_completion_tokens'`, `systemRole: 'developer'`,
    `structuredOutputs: 'json-object'`, `tools: true`, `parallelToolCalls: true`, `streamUsage: false`, `stop: true`,
    `seed: true`, `promptCacheKey`), kiểm từng field một phản ánh đúng trên body thật của MỘT request duy nhất —
    xác nhận không có field nào ghi đè/che field khác khi kết hợp. Phát hiện phụ: `seed: true` hiện KHÔNG có tác dụng
    trên wire dù bật — `GenerateOptions` chưa có nguồn giá trị seed nào, `dialect.seed` tồn tại chỉ để provider tương
    lai không phải xuyên lại field này (đã có ghi chú sẵn trong `serialize.ts`, xác nhận lại bằng test thay vì chỉ
    đọc code).
  - [x] **Live trên `/v1/chat/completions`, `/responses` và Anthropic `/v1/messages`** — không có `OPENAI_API_KEY`/
    `ANTHROPIC_API_KEY` chính chủ, nhưng người dùng cấp `COMPLETIONS_URL`/`COMPLETIONS_API_KEY`/`COMPLETIONS_MODEL`,
    `RESPONSE_URL`/`RESPONSE_API_KEY`/`RESPONSE_MODEL`, `MESSAGES_URL`/`MESSAGES_API_KEY`/`MESSAGES_MODEL` (gateway
    tương thích zenmux.ai, cùng một model `dots-studio/dots3-note-prev` phục vụ cả 3 wire) — dùng ngay, live thật
    (2026-09-19), 3 test mới: `tests/integration/openai-chat-completions-live.spec.ts`,
    `tests/integration/openai-responses-live.spec.ts`, `tests/integration/anthropic-messages-live.spec.ts`. Không
    phải OpenAI/Anthropic chính chủ nên không thay thế hoàn toàn dòng "OpenAI Responses/Chat Completions, Anthropic
    Messages" ở bảng nghiệm thu pha 5 bên dưới, nhưng xác nhận sống cả 3 wire shape (dispatch, serialize, parse
    response thật) trên backend thật — chỉ còn thiếu đúng 2 vendor chính chủ.
  - [x] **Mock server DeepSeek/Ollama/vLLM — XONG (2026-09-19).** 3 test mới trong `provider-openai.spec.ts`
    (`describe('mock server: DeepSeek, Ollama, vLLM (Chat Completions wire)')`), mỗi test dựng RESPONSE giả lập đúng
    hình dạng SSE của từng vendor (không chỉ kiểm request như 2 test trước): DeepSeek trả `reasoning_content` trong
    delta → xác nhận dịch đúng thành chunk `reasoning-delta` (khác `chat-completions-serialize.spec.ts` — test đó chỉ
    kiểm tầng serialize/translate đơn vị, test này đi qua toàn bộ `openAiAdapter` thật); Ollama (`localhost:11434`,
    key giữ chỗ tùy ý — đúng thực tế Ollama không kiểm giá trị key) xác nhận `max_tokens` (không phải
    `max_completion_tokens`) và không gửi field reasoning nào khi agent không đặt effort; vLLM
    (`localhost:8000`, kèm `usage` trong response) xác nhận cùng đường dây hoạt động cho endpoint tương thích thứ ba.

**Verify đã chạy:** `pnpm typecheck` (root) sạch, `pnpm test` (root) **2872/2872 xanh**, baseline public-API đã
regenerate.

### Pha 4: Chuyển 3 provider thành provider họ API — PHẦN LỚN ĐÃ XONG (2026-09-18)

**Phát hiện khi bắt đầu pha này (giống mẫu hình lặp lại của pha 3/3b/4a): phần lớn checklist đã được thỏa từ các pha
trước, chỉ còn vài mục thật sự thiếu.** `context-policy.ts` của cả 3 provider đã bị xóa ở **pha 2** (xác nhận bằng
`find` — không còn file nào tên đó trong 3 package); `compat.authHeader`/`thinking` của Anthropic và `compat` của
Gemini đã có từ **pha 3**; `api` theo route và `compat` của Chat Completions đã có từ **pha 4a** (mục ngay trên).
Việc còn lại thực sự thiếu ở đầu pha này: `displayName` cố định ở cả 3 provider, và một dòng chết (`defaultEffort`)
sót lại trong `provider-codex`.

File đã sửa lượt này: `provider-openai/src/adapter.ts`, `provider-anthropic/src/adapter.ts`,
`provider-gemini/src/adapter.ts` (option `displayName?: string` mới, thay mọi `displayName: 'OpenAI'` (v.v.) cố định
bằng `options.displayName ?? 'OpenAI'` ở toàn bộ 6+4+4 điểm gọi `createHttpProvider`/`createRuntimeHttpProvider`/
`defineModelProviderPlugin`/plugin legacy trong cả 3 file), `provider-codex/src/adapter.ts` (xóa tính toán
`defaultEffort` chết — xem dưới), `tests/unit/provider-{openai,anthropic,gemini}.spec.ts` (1 test mới mỗi file).

- [x] **provider-openai:** `api` theo route — xong ở pha 4a (model-level cố ý hoãn, xem ghi chú ở đó); nhận
  `displayName` — **xong lượt này**; `compat` — xong ở pha 4a; xóa `context-policy.ts` — xong từ pha 2.
- [x] **provider-anthropic:** nhận `displayName` — **xong lượt này**; `compat.authHeader`/`thinking` — đã có từ pha 3
  (dạng option phẳng `authHeader`/`thinking`, không lồng dưới object `compat` — hợp lý vì đây là mối quan tâm cấp
  route/auth, không phải knob của riêng dialect như Chat Completions; xóa `context-policy.ts` — xong từ pha 2.
  **`reasoningInfo()` — KHÔNG xóa, đánh giá lại quyết định của plan gốc:** đọc lại hàm này (`adapter.ts:51-61`) cho
  thấy nó chỉ còn build danh sách `efforts` tham khảo từ `thinkingBudgets` (dùng dưới `reasoningFormat:
  'thinking-budget'` cho model cũ) — **không** còn tính `defaultEffort` hay tự điền gì (đã dọn từ pha 1/3). Đây chính
  là hình mẫu "metadata tham khảo, không tự điền" mà quyết định 1 muốn — xóa nó sẽ mất thông tin catalog hợp lệ cho
  model dùng `thinking-budget`, không phải sửa lỗi. Bullet gốc của plan viết trước khi phát hiện hàm đã sạch.
- [x] **provider-gemini:** nhận `displayName` — **xong lượt này**; `compat` (tức `authHeader`) — đã có từ pha 3; xóa
  `context-policy.ts` — xong từ pha 2.
- [x] Không còn logic nào phụ thuộc "baseUrl có phải chính chủ không" — xác nhận bằng grep (`baseUrl ===`,
  `isOfficial`, `OFFICIAL`, so sánh với hằng số `_BASE_URL`) trên cả 3 package: **0 kết quả**. Đã xong từ pha 2.
- [x] **provider-codex:** giữ discovery `supported_reasoning_levels` làm metadata tham khảo (`efforts`, không đổi) —
  **xóa `defaultEffort` chết** (`adapter.ts:236-239` cũ): tính rồi gán vào `reasoning.defaultEffort`, một field
  `ModelReasoningInfo` (core) **đã bỏ từ pha 1** — không gây lỗi biên dịch vì object literal này chỉ được kiểm cấu
  trúc (không phải excess-property check trực tiếp do đi qua spread), nên field thừa lọt qua âm thầm, không ai đọc.
  Đây đúng là hành vi "tự điền effort" mà quyết định 1 cấm — dọn nốt, không phải bug mới.
- [x] **provider-copilot: nhánh chat/completions giờ gửi được effort theo `reasoningFormat` — xong, live thật
  (2026-09-19), lật lại đánh giá trước đó của chính plan này.** Đánh giá cũ dựa vào
  `tests/unit/copilot-adapter-headers.spec.ts`'s `'unknown field: reasoning_effort'` — hóa ra đó là một CHUỖI 400
  BỊA RA cho property test (kiểm bộ phân loại lỗi editor-header vs lỗi thường), **không phải lỗi thật từng quan sát
  từ Copilot** — bằng chứng gián tiếp trước đó thực chất không tồn tại. Người dùng cung cấp credential Copilot thật
  giữa phiên (`.providers/.copilot/auth.json` có sẵn trong repo, vẫn còn hạn), live-probe trực tiếp phát hiện:
  - `GET /v1/models` của Copilot trả về `capabilities.supports.reasoning_effort: [...]` **cho từng model** — đây là
    field CÓ THẬT, được backend hiểu, không phải khái niệm chỉ tồn tại ở OpenAI/Anthropic.
  - Gửi `reasoning_effort` cho model không hỗ trợ reasoning (`gpt-4o-mini`, model chat-completions duy nhất
    account này được cấp quyền) trả về lỗi 400 **CÓ TÊN CHÍNH XÁC** field và model: `"reasoning_effort \"low\" was
    provided, but model gpt-4o-mini-2024-07-18 does not support reasoning effort"` — đây là backend **hiểu và từ
    chối vì không hợp với model**, khác hẳn giả định ban đầu ("unknown field" bị từ chối chung chung). Đúng bằng
    chứng sống mà đánh giá cũ đòi hỏi trước khi mở khóa.
  - Đã thử `claude-sonnet-5`/`kimi-k3` (có khai `reasoning_effort` trong catalog) nhưng account này không được cấp
    quyền gọi qua `/chat/completions` (`model_not_supported`, xảy ra CẢ KHI không gửi effort) — không liên quan gì
    đến field effort, là giới hạn entitlement của account, đúng hiện tượng đã ghi chú sẵn trong
    `copilot-generation.spec.ts` ("listed but not callable").
  - Thêm field theo đúng gợi ý dự phòng ban đầu của plan: `CopilotDialect.reasoningFormat` (mặc định `false`, không
    đổi hành vi hiện tại của ai) + xuyên qua `toChatCompletionsDialect()`
    ([dual-protocol.ts](../../packages/provider-copilot/src/dual-protocol.ts)). Đặt tay `dialect: { reasoningFormat:
    'openai' }` (qua `copilotAdapter({ dialect })` đã có sẵn) để bật.
  - Test: unit mock trong `copilot-adapter-headers.spec.ts` (mặc định không gửi field, bật lên gửi verbatim); property
    fuzz trong `copilot-router.spec.ts`'s Property 32 mở rộng phủ `reasoningFormat` ngẫu nhiên; **live thật** trong
    `copilot-generation.spec.ts` (test mới, khóa đúng chuỗi lỗi thật ở trên).

### Pha 5: Ma trận tương thích (tiêu chí nghiệm thu)

Chứng minh bằng test rằng **chỉ cấu hình** là đủ, không thêm package:

| Họ API | Cấu hình cần chạy được | Cách kiểm tra |
|---|---|---|
| OpenAI Responses | OpenAI chính chủ ✅ **live thật**; zenmux.ai ✅ **live thật** | Chính chủ đã chạy 2026-09-19 (`OPENAI_API_KEY` người dùng cấp giữa phiên, model `gpt-5.6-luna`); zenmux live cùng ngày |
| OpenAI Chat Completions | OpenAI chính chủ ✅ **live thật**; DeepSeek, Ollama/vLLM ✅ (mock); zenmux.ai ✅ **live thật**; OpenRouter chưa (không đoán field theo quyết định 7, xem pha 3) | Chính chủ đã chạy 2026-09-19; mock server cho DeepSeek/Ollama/vLLM; zenmux live cùng ngày |
| Anthropic Messages | Anthropic chính chủ (**chưa chạy, thiếu `ANTHROPIC_API_KEY`**); DeepSeek `/anthropic` + Bearer ✅ (mock); zenmux.ai ✅ **live thật** | Mock cho DeepSeek; zenmux live đã chạy 2026-09-19; live chính chủ khi có key |
| Gemini | Google AI Studio | ✅ **Live thật, đã chạy 2026-09-19** (`GEMINI_KEY` có sẵn trong `.env`) — xem chi tiết ngay dưới bảng |
| **Cả ba wire trên một gateway** | codex2claudecode (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`) | ✅ **Live thật, đã chạy 2026-09-19** — xem chi tiết ngay dưới |

zenmux.ai: gateway OpenAI-compatible của bên thứ ba, người dùng cấp `COMPLETIONS_URL`/`COMPLETIONS_API_KEY`/
`COMPLETIONS_MODEL`, `RESPONSE_URL`/`RESPONSE_API_KEY`/`RESPONSE_MODEL`, `MESSAGES_URL`/`MESSAGES_API_KEY`/
`MESSAGES_MODEL` trong `.env` — cùng một model (`dots-studio/dots3-note-prev`) phục vụ cả 3 wire, y hệt tinh thần
codex2claudecode nhưng ở một vendor độc lập khác. Không thay thế được live chính chủ OpenAI/Anthropic (khác vendor,
khác đường xác thực thật), nhưng xác nhận sống toàn bộ đường dây dispatch → serialize → parse response cho cả 3 họ
wire trên một backend thật, không phải mock. 3 test: `openai-chat-completions-live.spec.ts`,
`openai-responses-live.spec.ts`, `anthropic-messages-live.spec.ts` (`tests/integration/`).

Cấu hình kết nối codex2claudecode (chỉ cấu hình, không code riêng):

```ts
const gateway = 'http://127.0.0.1:8787'
const key = process.env.CODEX2CLAUDECODE_PASSWORD ?? 'codex2claudecode' // không có password thì giá trị nào cũng được

createAgentRuntime({
  providers: [
    anthropicPlugin({ id: 'c2c-anthropic', baseUrl: gateway, apiKey: key, allowInsecureHttp: true }),
    openAiPlugin({ id: 'c2c-responses', baseUrl: `${gateway}/v1`, apiKey: key, allowInsecureHttp: true }),
    openAiPlugin({ id: 'c2c-chat', baseUrl: `${gateway}/v1`, api: 'chat-completions', apiKey: key,
      allowInsecureHttp: true }),
  ],
})
```

Lưu ý: protocol Anthropic tự nối `/v1/messages` nên `baseUrl` không có `/v1`; protocol OpenAI nối `/responses` hoặc
`/chat/completions` nên `baseUrl` phải có `/v1`. `allowInsecureHttp: true` là bắt buộc vì gateway chạy `http://`.

Kiểm tra riêng cho codex2claudecode — **✅ XONG, live thật (2026-09-19)**, người dùng khởi động gateway ở
`127.0.0.1:8787` giữa phiên làm việc (`password_protected: false`, model `gpt-5.6-luna` xác nhận tồn tại qua
`GET /v1/models`). 9 test trong
[codex2claudecode-live.spec.ts](../../tests/integration/codex2claudecode-live.spec.ts):

- [x] Cùng một model (`gpt-5.6-luna`) trả lời được qua cả 3 route — 3 test, `it.each` trên Anthropic Messages/OpenAI
  Responses/OpenAI Chat Completions.
- [x] Gateway áp dụng effort theo field chuẩn của cả 3 wire — đã đo bằng request thô (mục 4 của plan) VÀ giờ qua SDK
  thật: 3 test `it.each` gửi `reasoningEffort: 'low'` qua cả 3 wire, cả 3 thành công; 1 test gửi effort sai
  (`'not-a-real-effort-value'`) qua wire Anthropic, xác nhận lỗi 400 thật của gateway ("Invalid value:
  'not-a-real-effort-value'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.")
  hiện đúng verbatim qua `finish.reason.failure.message` — đúng quyết định 7, không phải đoán.
- [x] ~~Hậu tố tên model (`gpt-5.6-sol_high`) vẫn chạy như một model id bình thường~~ — người dùng xác nhận không cần
  kiểm mục này: codex2claudecode giờ dùng model id gốc của từng provider (native) như các provider khác, không còn
  quy ước hậu tố `_effort` phải giữ nguyên qua SDK. Bỏ khỏi checklist.
- [x] Có password: cả `x-api-key` (Anthropic) và `Authorization: Bearer` (OpenAI) đều qua — 1 test, gửi cùng lúc
  qua cả hai wire với `apiKey: 'unit-test-password'` (giá trị bất kỳ, gateway không kiểm vì
  `password_protected: false`), cả hai thành công.
- [x] Ảnh với mặc định `inputModalities` — 1 test, ảnh PNG 1x1 base64 qua wire Responses, không cần override
  `inputModalities`. **Phát hiện một bug thật khi chạy live** (xem ngay dưới) — sau khi sửa, test pass.

**Bug thật phát hiện qua live test này, đã sửa:** `HttpModelAdapter.run()`
([provider-http/src/base/http-adapter.ts:422-434](../../packages/provider-http/src/base/http-adapter.ts)) từ chối
ảnh/tài liệu bất cứ khi nào `model.inputModalities` là `undefined` (`model.inputModalities?.includes('image') !==
true` → `true` khi `undefined`) — mâu thuẫn trực tiếp với doc comment của chính `resolvedCatalogModelInfo()`
([transport.ts:42-44](../../packages/provider-http/src/base/transport.ts)): "Absent, not defaulted to `['text']`:
an unconfigured modality is UNKNOWN, not a negative capability claim, and the registry fills the SDK's own
permissive default (text + image + document)". `ModelRegistry`'s policy check (`model-stream.ts`) đọc đúng giá trị
đã điền mặc định permissive và cho ảnh đi qua, nhưng `run()` lại tự kiểm tra riêng bằng giá trị CHƯA điền mặc định
(`undefined`) và từ chối — hai lớp kiểm tra dùng hai nguồn sự thật khác nhau, không ai từng viết test kết hợp cả
`ModelRegistry` lẫn HTTP adapter thật với một model không khai catalog cho tới live test này. Sửa: chỉ từ chối khi
`model.inputModalities` được khai RÕ RÀNG và không chứa modality đó; `undefined` giờ cho qua (khớp đúng thiết kế đã
ghi). Một test cũ trong `http-provider.spec.ts` từng khẳng định hành vi SAI này là cố ý ("An uncatalogued model
defaults to text-only") — comment đó viết trước khi hệ thống `RuntimeDefaults`/permissive-default ra đời ở pha 1b
phiên này, đã lỗi thời; sửa lại test để khớp đúng thiết kế hiện tại (đổi tên: "refuses document input only for a
model that explicitly excludes it; an uncatalogued one is permissive"). Chạy lại toàn bộ `pnpm test`
(2892/2892 xanh) và `pnpm typecheck` sạch sau khi sửa.

Mỗi dòng kiểm tra (đánh giá theo từng cấu hình có key/gateway thật):

- [x] **Gemini — cả 3 dòng đã chạy live thật (2026-09-19).** Agent không đặt effort: gọi thành công. Agent đặt effort
  hợp lệ (`low`): gọi thành công. Agent đặt effort sai (`not-a-real-effort-value`): **lỗi hiện đúng message gốc của
  API** — `"The value 'not-a-real-effort-value' is not supported for 'generation_config.thinking_level'. Supported
  values: 'minimal', 'low', 'medium', 'high'."` — xác nhận sống quyết định 7, và tiện thể phát hiện thêm dữ liệu
  chưa từng ghi ở đâu trong plan: **bộ giá trị effort thật Gemini hỗ trợ là `minimal`/`low`/`medium`/`high`** (không
  phải đoán, đọc thẳng từ response 400 thật). File:
  [gemini-reasoning-effort-live.spec.ts](../../tests/integration/gemini-reasoning-effort-live.spec.ts) — 3 test,
  chạy bằng `GEMINI_KEY`/`GEMINI_MODEL` có sẵn trong `.env` của môi trường này, `pnpm test:integration
  tests/integration/gemini-reasoning-effort-live.spec.ts` (source `.env` trước, biến này không tự nạp vào
  `process.env`). Phát hiện phụ đáng chú ý: lỗi dispatch của `registry.stream()` không ném promise reject — nó đến
  dưới dạng chunk `{ type: 'finish', reason: { kind: 'error', failure: {...} } }` trong luồng async iterable; test
  đầu tiên viết theo giả định "reject" đã sai và phải sửa lại sau khi chạy thật.
- [x] **OpenAI Responses/Chat Completions, Anthropic Messages — live qua zenmux.ai (2026-09-19)**, xem chi tiết ở
  bảng nghiệm thu phía trên. Ảnh/PDF chính chủ cho OpenAI/Anthropic — xem mục dưới.

Thêm:

- [x] Live test tự bỏ qua khi thiếu key tương ứng — **đã là quy ước sẵn có** trong repo (xác nhận qua
  `tests/integration/openai-embedding.spec.ts`: `describe.skipIf(!openAiEmbeddingLive)`); test live mới ở trên theo
  đúng khuôn mẫu này (`describe.skipIf(geminiKey === undefined)`).
- [x] README: mục "Connecting a compatible endpoint" và "Default configuration precedence" — **đã thêm cho cả 3
  provider** (`packages/provider-{openai,anthropic,gemini}/README.md`). Nhân tiện sửa 2 chỗ sai đã lỗi thời trong
  README có sẵn: (1) cả 3 README nói "collisions and reserved auth/transport headers are rejected" — không còn đúng
  từ khi đổi chính sách header ở pha 3b (giờ ghi đè được, chỉ còn 2 loại bị chặn cứng); (2) README của
  `provider-gemini` còn mô tả bảng hardcode "Pro giữ 200k, Flash được 1M" — bảng đó đã bị xóa ở **pha 2**, README cũ
  mô tả sai hành vi thật (giờ MỌI model chưa khai báo đều về hằng số SDK 200k, không phân biệt theo tên model).
  `node scripts/check-release-docs.mts` chạy lại sạch (27 file Markdown, 26 README, 0 lỗi) sau khi sửa.
- [x] **Mock server DeepSeek/Ollama/vLLM** — xong ở pha 4a (xem mục đó); **mock server Anthropic-compatible (DeepSeek
  `/anthropic`, Bearer)** — xong, `tests/unit/provider-anthropic.spec.ts` ("reaches a Bearer-auth Anthropic-compatible
  endpoint... end to end"), mô phỏng đúng thứ tự khối `thinking` trước `text` quan sát được ở codex2claudecode (mục
  4 của plan). Gemini không có vendor tương thích thứ ba trong phạm vi plan nên không cần mock riêng — đã có live
  thật thay thế, mạnh hơn mock.

**Còn treo, chặn bởi thiếu tài nguyên bên ngoài môi trường này (không phải thiếu code):**

- [x] **Live OpenAI Responses/Chat Completions với OpenAI chính chủ — XONG, live thật (2026-09-19).** Người dùng cấp
  `OPENAI_API_KEY` giữa phiên (tài khoản chỉ dùng được với model `gpt-5.6-luna`). 5 test mới
  [openai-live.spec.ts](../../tests/integration/openai-live.spec.ts) chạy thẳng vào `https://api.openai.com`, không
  qua gateway nào: agent không đặt effort (thành công, không field effort trên wire); effort hợp lệ (`low`, thành
  công); effort sai (`not-a-real-effort-value`) — lỗi 400 thật của OpenAI hiện verbatim ("Invalid value:
  'not-a-real-effort-value'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'."
  — đúng quyết định 7); ảnh với `inputModalities` mặc định qua Responses (thành công, không cần khai catalog — đúng
  hành vi permissive vừa sửa ở mục bug bên trên); Chat Completions wire (thành công). Đã probe bằng curl trước khi
  viết test để xác nhận field/behavior thật trước khi assert.
- [x] **Live Anthropic Messages — người dùng xác nhận (2026-09-19) live qua zenmux.ai (`anthropic-messages-live.spec.ts`)
  là đủ**, không cần chờ `ANTHROPIC_API_KEY` chính chủ riêng. Không có key chính chủ trong môi trường này; DeepSeek
  `/anthropic` đã kiểm bằng mock, zenmux.ai đã kiểm live thật (bên thứ ba, cùng wire Anthropic Messages) — người
  dùng xác nhận mức nghiệm thu này chấp nhận được cho pha 5, đóng mục này.
- [x] **PDF live cho Anthropic — cùng quyết định trên**, không chặn nữa. Ảnh/PDF cho OpenAI chính chủ đã xong (mục
  trên, ảnh); PDF cho Anthropic chưa làm riêng nhưng có tiền lệ đủ mạnh (Gemini, codex2claudecode) làm mẫu nếu cần
  sau này.

Không viết trước một bộ test "live" mà chưa từng chạy được: phần thân bài kiểm tra chỉ có giá trị khi đã xác nhận nó
thật sự vượt qua ít nhất một lần với credential/gateway thật — một test chưa kiểm chứng chỉ tạo cảm giác an toàn giả.
Live Gemini, live codex2claudecode (cả 3 wire, effort, password, ảnh — phát hiện và sửa luôn 1 bug thật), và live
zenmux.ai (cả 3 wire), và OpenAI chính chủ (5 test, `openai-live.spec.ts`) đều đã viết và đã chạy thật trong phiên
này. Anthropic chính chủ không có key trong môi trường này, nhưng người dùng đã xác nhận (2026-09-19) rằng live qua
zenmux.ai cho wire Anthropic Messages là đủ cho pha 5 — không còn mục nghiệm thu sống nào bị chặn.

### Pha 6: Hoàn thiện

- [x] Cập nhật README 3 provider — xong (xem mục Thêm ở pha 5 ngay trên).
- [x] **`tests/fixtures/public-api/baseline.json` — đã XÓA (2026-09-19).** Xác nhận lại lần cuối bằng grep toàn repo
  ngay trước khi xóa: không có test hay script nào đọc file này (chỉ có một biến cục bộ trùng tên tình cờ trong
  `test-human/`, không liên quan); `version: "0.0.0"` bên trong xác nhận đây là fixture mồ côi từ một cơ chế cũ hơn.
  File **đang được dùng thật** bởi `tests/unit/copilot-architecture.spec.ts` là
  `tests/fixtures/public-api/untouched-packages.json` (khác file, không đụng tới), đã regenerate nhiều lần trong
  suốt phiên làm việc này (`UPDATE_PACKAGE_SURFACE=1 npx vitest run tests/unit/copilot-architecture.spec.ts`) mỗi
  khi bề mặt public API đổi — luôn khớp với code hiện tại. `git rm` file mồ côi, `pnpm test` vẫn 2893/2893 xanh sau
  khi xóa (không ai tham chiếu nó).
- [x] CHANGELOG — **xong (2026-09-19), dưới mục `## Unreleased`.** Đã xác nhận: repo **chưa có `CHANGELOG.md` nào**
  (không có ở root, không có theo từng package, không dùng changesets) — tạo mới file gốc `/CHANGELOG.md`, theo thể
  loại "Keep a Changelog" nhẹ, liệt kê đúng những gì đã **thật sự làm** trong toàn bộ plan (Fixed: bug effort
  Anthropic; Added: chat-completions, displayName, path/query, body/transformRequest, providerOptions cấp agent,
  headers-theo-ngữ-cảnh, auth mảng, authHeader Gemini/Anthropic, chính sách ghi đè header; Changed/breaking: theo mục
  6 bên dưới, đối chiếu lại với những gì đã code chứ không chép nguyên "dự kiến"). Đặt dưới `## Unreleased`, không
  gán số version — đúng lý do đã nêu trước đó (pha 5 và vài mục pha 3b khi viết CHANGELOG vẫn còn dở; giờ pha 3b đã
  xong nhưng pha 5 vẫn chặn bởi thiếu key/gateway, nên giữ nguyên `Unreleased`, ghi rõ trong file rằng version gán
  khi pha 5 xong). `node scripts/check-release-docs.mts` không kiểm `CHANGELOG.md` (chỉ kiểm README các package) nên
  không có gì phải sửa thêm ở đó.
- [x] **Tăng version — XONG (2026-09-19).** Người dùng xác nhận rõ: lên `0.1.4` (patch, không phải `0.2.0` — quyết
  định phát hành của người dùng, dù nội dung đợt này có breaking change; semver chính xác thuộc quyền người dùng SDK,
  không phải tôi tự suy ra từ nội dung thay đổi). Đã bump `"version"` trong `package.json` gốc + 26 package con
  (đồng loạt từ `0.1.3`), hằng số runtime `SDK_VERSION` trong
  [core/src/primitives/version.ts](../../packages/core/src/primitives/version.ts) (đọc bởi observability/attribution
  — sửa test `observation-core.spec.ts` khớp theo), và số phiên bản trong `web-documents/{vi,en}/**` (bảng thông tin
  + tên file tarball mẫu). `CHANGELOG.md` chuyển từ `## Unreleased` sang `## 0.1.4 — 2026-09-19`. Không có dependency
  nội bộ nào ghim version cứng (`workspace:^` trong mọi `package.json`), nên không cần sửa gì thêm ở đó;
  `pnpm install --lockfile-only` xác nhận `pnpm-lock.yaml` không lệch sau khi bump. Verify: `pnpm typecheck` sạch,
  baseline public-API regenerate, `pnpm test` 2894/2894 xanh, `node scripts/check-release-docs.mts` sạch.

### Pha 7: Rà soát CI (2026-09-19, theo yêu cầu "đảm bảo CI GitHub Action không lỗi chỗ nào")

Chạy **đúng từng gate** của `.github/workflows/ci.yml` tại máy (3 job: `boundary-build`, `functional`,
`supply-chain`) thay vì chỉ `pnpm typecheck` + `pnpm test` như các đợt trước. Phát hiện **3 vấn đề CI sẽ đỏ** mà
toàn bộ test/typecheck trước đó KHÔNG bắt được:

- [x] **`pnpm lint` (job boundary-build) đỏ — `check-package-graph.mts`:** `provider-openai` có cạnh workspace tới
  `protocol-openai-chat-completions` (thêm ở pha 4a) nhưng `scripts/package-policy.mts` — allowlist chuẩn tắc — chưa
  khai. Đây là gate cố tình bắt "thêm dependency mà không tuyên bố kiến trúc". Sửa: thêm protocol đó vào
  `workspaceDependencies` của `provider-openai`, y như `provider-copilot` đã khai 2 protocol từ trước.
- [x] **`pnpm test:pack` (job functional) đỏ — `scripts/test-packed-provider.mts`:** bảng `PROTOCOL_PACKAGES` liệt kê
  tarball protocol đi kèm mỗi provider; `provider-openai` vẫn chỉ có `protocol-responses`, nên `npm install` trong
  fixture đi tìm `protocol-openai-chat-completions@^0.1.4` trên registry (chưa publish) và fail `ETARGET`. Sửa: thêm
  protocol thứ hai cho `provider-openai`.
- [x] **`pnpm workspace:typecheck` (job boundary-build) đỏ — lỗi CÓ SẴN TỪ TRƯỚC, không do đợt này:** `provider-anthropic`
  và `provider-gemini` không tự typecheck được. Nguyên nhân: helper `authOf()` nhận union `AdapterOptions |
  ProviderOptions`, làm `options.apiKey` nở thành `string | CredentialSource(core) | fn` — không khớp
  `AuthScheme.token` (chỉ `string | fn`) lẫn `RuntimeAuthScheme.token` (`CredentialInput`). Đã xác minh là lỗi có
  sẵn bằng cách so `git show HEAD:` cho `authOf`, `apiKey`, `AuthScheme`, `CredentialSource` — **tất cả giống hệt
  HEAD**. Sửa: `authOf` thành generic theo kiểu credential, mỗi call site giữ kiểu hẹp của mình.
  **Lý do không gate nào trước đây bắt được:** `tsconfig.json` gốc chỉ `include` `tests`/`scripts`/`spikes`/
  `test-human` — `pnpm typecheck` (root `tsc --noEmit`) **không hề typecheck `packages/*/src`**. Chỉ
  `pnpm workspace:typecheck` (turbo, chạy `tsc` trong từng package) mới kiểm, và đó là thứ CI chạy.
- [x] **Bổ sung export còn thiếu (không phải lỗi CI, là lỗ hổng tính đầy đủ phát hiện khi review):**
  `provider-openai/src/index.ts` re-export `openAiResponsesProtocol`/`ResponsesDialect` nhưng không export gì của
  nhánh Chat Completions, dù package giờ nói cả hai wire. Người dùng TypeScript không gọi tên được kiểu để khai
  `compat`/`models[].api`. Đã thêm: `OpenAiApi`, `OpenAiCatalogModel`, `OpenAiChatCompletionsCompat`,
  `openAiChatCompletionsProtocol`, `ChatCompletionsDialect`. Baseline public-API đã regenerate theo.

**Toàn bộ gate CI đã chạy xanh tại máy sau khi sửa:** `pnpm install --frozen-lockfile`, `pnpm workspace:build`,
`pnpm workspace:typecheck` (38/38), `pnpm build:cli`, `pnpm lint` (4 script), `pnpm exec tsc --noEmit`,
`pnpm check:boundary-fixtures`, `pnpm exec vitest run` (2894/2894), `pnpm test:packages`, `pnpm test:pack` (toàn bộ
ma trận đóng gói), `pnpm check:supply-chain` (569 integrity record). Kiểm thêm workflow khác: `release.yml` — assert
version lockstep (26/26 = `0.1.4`) và "resolved dependency ranges" trên tarball thật (`workspace:^` nở đúng thành
`^0.1.4`, kể cả dependency protocol mới) đều đạt; `docs.yml` — `npm --prefix web-documents run build` xanh (workflow
này kích hoạt vì đợt này có sửa `web-documents/**`); `sandbox.yml` — không kích hoạt (không đụng path nào của nó).

## 6. Breaking changes dự kiến

- Effort: core không kiểm tra ladder, không tự điền; bỏ `effort` theo lần gọi; gỡ `UNSUPPORTED_REASONING_EFFORT`,
  `ModelReasoningInfo.defaultEffort`, `CallConfigAdapterDefaults.reasoningEffort`.
- Max tokens: không đặt thì không gửi (trước đây adapter tự điền 32k / 8k); gỡ `CallConfigAdapterDefaults.maxTokens`
  nếu không còn dùng.
- Context window mặc định 200.000, đổi được qua `createAgentRuntime({ defaults })`, route, model, agent; adapter không
  tự điền nữa.
- `inputModalities` mặc định `['text', 'image', 'document']` thay vì chỉ text.
- Xóa `createModelContextPolicy`, `applyModelContextPolicy`, `ModelContextPolicy`, các `*ContextPolicy`,
  `ProviderCatalogModel.reasoning`.
- `ChatCompletionsDialect.reasoningEffort` (boolean) thay bằng `compat.reasoningFormat`; Chat Completions gửi
  `reasoning_effort` khi agent có effort.
- Anthropic: effort qua `output_config.effort` thay vì `thinking.budget_tokens`; `DEFAULT_THINKING_BUDGETS` rời đường
  mặc định; không tự bỏ `temperature` / `top_p`.
- Reasoning của lượt trước chỉ gửi lại khi cùng route và cùng model.
- Lỗi và report trả cho người dùng mang message gốc của API thay vì câu chung đã làm sạch.
- Bề mặt cấu hình provider mới: `auth` nhận mảng, `headers` dạng hàm nhận ngữ cảnh, thêm `query`, `path`, `body`,
  `transformRequest`, `providerOptions` trên agent.
- Chính sách header: người dùng ghi đè được header của protocol, transport và attribution (trước đây là lỗi
  `HEADER_RESERVED` / `HEADER_COLLISION`); field `body` của người dùng thắng field SDK đặt.
