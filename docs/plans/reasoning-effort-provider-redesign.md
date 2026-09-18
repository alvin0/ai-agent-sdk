# Kế hoạch: Provider theo họ API, effort pass-through và cấu hình mặc định toàn cục

- **Ngày lập:** 2026-09-18 (cập nhật theo các quyết định của người dùng cùng ngày)
- **Trạng thái:** Đã chốt quyết định, sẵn sàng bắt đầu pha 0
- **Nhánh gốc:** `main` (SDK 0.1.3)
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
- [ ] **Chưa làm:** `contextWindow`, `inputModalities` ở cấp **agent** (tier 1, ví dụ
  `runtime.agent({ contextWindow, inputModalities })`). Cần thêm field vào `AgentDefinition`/
  `RuntimeAgentDefinitionInput` và thêm 2 field mới vào `CallConfig`, xuyên qua `sessionCallConfig` — khối lượng việc
  tương đương một lượt sửa core khác, để làm riêng sau nếu cần (không chặn các pha còn lại của plan, vì tier 2/3
  (model/route) và tier 4/5 (runtime defaults/SDK constant) đã đủ dùng được ngay).
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

### Pha 3: Switch `compat`, effort theo chuẩn từng họ API, lỗi gốc

File: serializer/translator/wire của `protocol-responses`, `protocol-openai-chat-completions`,
`protocol-anthropic-messages`, `protocol-gemini-interactions`; `core` (report lỗi)

- [ ] Quy tắc chung: không có effort thì không gửi; có thì gửi nguyên chuỗi vào field chuẩn. Không có `maxTokens` thì
  không gửi (trừ Anthropic).
- [ ] **Responses:** `reasoning.effort`; `max_output_tokens` chỉ khi có. Thêm switch cho endpoint không nhận `store`,
  `include`.
- [ ] **Chat Completions:** thay `dialect.reasoningEffort: boolean` bằng
  `compat.reasoningFormat: 'openai' | 'deepseek' | 'openrouter' | 'qwen' | false`, mặc định `'openai'`
  (`reasoning_effort`). Mỗi format chỉ quy định **field nào** mang effort và phía response đọc reasoning ở đâu
  (`reasoning_content`, `reasoning`…), không đổi giá trị.
- [ ] **Anthropic:**
  - Effort gửi nguyên vào `output_config.effort` (gộp với `output_config.format` nếu có).
  - Mặc định không gửi `thinking`; dialect `thinking?: 'adaptive' | 'disabled'` chỉ gửi khi người dùng cấu hình.
  - Xóa `DEFAULT_THINKING_BUDGETS` / `thinkingOf()` khỏi đường mặc định; giữ
    `compat.reasoningFormat: 'output-config' | 'thinking-budget'` (mặc định `'output-config'`) cho model cũ hoặc
    endpoint chỉ nhận `budget_tokens`, người dùng tự khai báo bảng `budgets`.
  - `max_tokens` bắt buộc: dùng giá trị người dùng đặt; không có thì dùng hằng số dự phòng của protocol (đổi được qua
    `defaultMaxTokens` của route).
  - Không tự bỏ `temperature` / `top_p` nữa: người dùng truyền gì gửi nấy.
  - `compat.authHeader: 'x-api-key' | 'bearer'`.
- [ ] **Gemini:** `thinking_level` như hiện tại; auth header cấu hình được.
- [ ] **Reasoning khi đổi route (quyết định 6):** chỉ gửi lại khối reasoning của lượt trước (`encrypted_content`,
  `signature`, `reasoning_content`…) khi cùng route và cùng model; khác thì bỏ. Endpoint cần quy tắc riêng thì dùng
  switch `compat` (ví dụ `requiresReasoningContentOnAssistantMessages`).
- [ ] Switch `compat` không thuộc protocol đang dùng thì báo lỗi ngay khi cấu hình.
- [ ] **Lỗi gốc (quyết định 7):** không map lỗi effort thành mã riêng. Lỗi 4xx của API giữ mã chung hiện có và
  **message gốc**. Mọi thứ SDK trả về cho người dùng phải trung thực:
  - Lỗi ném ra (`AgentRunError`, `session.run` reject, `ModelError`) mang message gốc, `status`, `requestId` và
    `cause` (body gốc của API).
  - `report.errors` / `ModelCallReport.error` trả về cho người dùng mang message gốc, **không** thay bằng câu chung
    "model call failed; inspect the stable code…" như hiện nay
    ([model-call-handle.ts:43](../../packages/core/src/runtime/model-call-handle.ts#L43)).
  - Việc che nội dung chỉ thuộc về **exporter quan sát** (dữ liệu gửi ra hệ thống bên ngoài), do cấu hình
    `observability.content` / `redactors` hiện có quyết định, không áp lên lỗi trả cho người dùng.
- [ ] Test: snapshot body JSON cho từng `reasoningFormat` và từng switch (có/không effort, có/không max tokens); test
  lỗi 400 từ API hiện đúng message gốc.

### Pha 3b: Bề mặt cấu hình mở rộng chung cho `provider-*`

**Mục tiêu:** endpoint tương thích thường cần thêm thứ gì đó ngoài chuẩn (header riêng, query `api-version`, field
body riêng của vendor, hai lớp khóa khi đi qua gateway…). Người dùng phải làm được bằng cấu hình, không fork package.

**Giới hạn hiện tại** (đã kiểm tra trong code):

| Nhu cầu | Hiện trạng | Vị trí |
|---|---|---|
| Header tùy chỉnh | Có (`headers` tĩnh hoặc hàm), nhưng hàm **không nhận ngữ cảnh** (model, agent, lần gọi) | [endpoint-headers.ts](../../packages/provider-http/src/common/endpoint-headers.ts) |
| Header nhạy cảm thứ hai (khóa gateway + khóa upstream, `cf-aig-authorization`, `x-portkey-api-key`…) | Bị chặn: tên giống credential chỉ được đi qua `auth`, mà `auth` chỉ nhận **một** scheme (hoặc `dynamic`) | [header-layers.ts:116](../../packages/provider-http/src/common/header-layers.ts#L116), [http-provider.ts:85](../../packages/provider-http/src/configurable/http-provider.ts#L85) |
| Query string (Azure `?api-version=`, `?key=`…) | Bị chặn: `baseUrl` không được chứa query | [transport/http.ts:187](../../packages/provider-http/src/transport/http.ts#L187) |
| Field body riêng của vendor (OpenRouter `provider`/`transforms`, vLLM `chat_template_kwargs`/`top_k`, Qwen `enable_thinking`, Anthropic `metadata`/`service_tier`…) | **Không có cách nào** | serializer các protocol |
| Đổi path endpoint | Chỉ Chat Completions có `dialect.path` | [protocol-openai-chat-completions/src/wire.ts:335](../../packages/protocol-openai-chat-completions/src/wire.ts#L335) |
| Header của protocol (`anthropic-version`, `anthropic-beta`) | Chỉ đổi qua dialect; ghi trong `headers` là lỗi trùng | [header-layers.ts:66](../../packages/provider-http/src/common/header-layers.ts#L66) |

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

Việc cần làm:

- [ ] **`headers`**: giữ dạng tĩnh; dạng hàm nhận ngữ cảnh `{ provider, model, agentId?, signal }`. Có ở route, model
  và `providerOptions` của agent; gộp theo thứ tự route, model, agent (sau ghi đè trước).
- [ ] **`auth` nhận mảng scheme**: mỗi phần tử sinh header credential riêng, tất cả được đánh dấu nhạy cảm và che trong
  log. Giữ quy tắc "header giống credential phải đi qua `auth`" để không lộ khóa qua `headers` thường.
- [ ] **`query`**: record tĩnh hoặc hàm; giá trị nhạy cảm (ví dụ `key`) khai báo qua `auth` kiểu mới
  `{ kind: 'query', name, value }` để được che trong log.
- [ ] **`path`**: có ở mọi protocol (Responses, Chat Completions, Messages, Gemini), không chỉ Chat Completions.
- [ ] **`body`**: record gộp sâu vào body sau khi protocol serialize, ở route, model và agent. **Giá trị người dùng
  thắng** kể cả khi trùng field SDK đặt (`model`, `max_tokens`, `reasoning`, `stream`…) (quyết định 12). Muốn xóa
  một field SDK đặt thì gán `null` hoặc dùng `transformRequest`.
- [ ] **`transformRequest(body, ctx)`**: hook cuối cùng, toàn quyền trên body. Chạy sau `body`, trước khi gửi; body cuối
  cùng vẫn đi qua `requestLogger` để dễ debug.
- [ ] **Ghi đè header của SDK (quyết định 12):** đổi chính sách trong
  [header-layers.ts](../../packages/provider-http/src/common/header-layers.ts) từ "trùng là lỗi" sang **lớp người dùng
  thắng** với:
  - Header của protocol: `anthropic-version`, `anthropic-beta`, … (lớp `wire-protocol`).
  - `accept`, `content-type` (lớp `transport`).
  - `user-agent` và `x-ai-agent-sdk-*` (lớp `sdk-attribution`).
  - Thứ tự gộp: transport, attribution, protocol, route, model, agent, auth (sau thắng trước).
- [ ] Vẫn chặn: header HTTP cấp kết nối mà `fetch` cấm hoặc làm hỏng request (`host`, `content-length`, `connection`,
  `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-*`, `sec-*`).
- [ ] Vẫn giữ quy tắc "header giống credential phải đi qua `auth`": không phải để cấm ghi đè, mà để SDK biết header nào
  cần che trong log. `auth` dạng mảng (ở trên) đủ để khai báo bao nhiêu credential cũng được.
- [ ] Test: mỗi cơ chế ở từng tầng (route / model / agent), thứ tự gộp, người dùng ghi đè được header protocol /
  `user-agent` / field body của SDK, header cấp kết nối vẫn bị chặn, credential trong `auth` mảng và `query` được che
  trong `requestLogger`.

### Pha 4a: Chat Completions trong `provider-openai`

**Lý do:** phần lớn endpoint tương thích OpenAI (DeepSeek, Groq, Together, Qwen/DashScope, vLLM, Ollama, LM Studio,
nhiều gateway) chỉ có `/chat/completions`, không có `/responses`. Thiếu nhánh này thì `provider-openai` chưa phải
provider cho cả họ API OpenAI.

**Hiện trạng:** package [`protocol-openai-chat-completions`](../../packages/protocol-openai-chat-completions/src/protocol.ts)
đã có đủ serializer, translator, xử lý lỗi và test (`tests/unit/chat-completions-*.spec.ts`), đang được
`provider-copilot` dùng. `provider-openai` chỉ phụ thuộc `protocol-responses`
([package.json:37](../../packages/provider-openai/package.json#L37)). Phần việc chủ yếu là nối, không viết protocol mới.

Việc cần làm:

- [ ] Thêm dependency `@alvin0/ai-agent-sdk-protocol-openai-chat-completions` vào `provider-openai`.
- [ ] Option `api: 'responses' | 'chat-completions'`:
  - Ở **route** (mặc định `'responses'`).
  - Ở **model** (`models[].api`) để một route phục vụ cả hai kiểu model, tránh giới hạn "một protocol cho mỗi route"
    mà deepseek-harness đang gặp. Cơ chế chọn protocol theo model tham khảo `copilotDualProtocol`
    ([dual-protocol.ts](../../packages/provider-copilot/src/dual-protocol.ts)), nhưng chọn theo cấu hình, không đoán.
- [ ] Đưa các knob hiện có của `ChatCompletionsDialect` ra thành `compat` công khai:
  `reasoningFormat` (pha 3), `maxTokensField` (`'max_tokens' | 'max_completion_tokens' | false`), `systemRole`
  (`'system' | 'developer'`), `structuredOutputs` (`'json-schema' | 'json-object' | false`), `tools`,
  `parallelToolCalls`, `streamUsage`, `stop`, `seed`, `promptCacheKey`.
- [ ] Giá trị mặc định theo protocol, không theo `baseUrl`: `systemRole: 'system'`, `maxTokensField: 'max_tokens'`
  (tương thích rộng nhất; và max tokens chỉ gửi khi người dùng đặt, theo quyết định 4). README ghi cấu hình khuyến nghị
  cho OpenAI chính chủ (`developer`, `max_completion_tokens`).
- [ ] `path` đổi được (quyết định 11); mặc định `/chat/completions`.
- [ ] Phía response: đọc reasoning theo `reasoningFormat` (`reasoning_content` của DeepSeek, `reasoning` của
  OpenRouter…), usage có `reasoning_tokens`, và lỗi giữ message gốc (quyết định 7).
- [ ] Reasoning của lượt trước chỉ gửi lại khi cùng route và cùng model (quyết định 6); endpoint yêu cầu gửi lại
  `reasoning_content` thì bật qua `compat`.
- [ ] Test:
  - Unit / snapshot: body JSON với từng tổ hợp `compat` chính; chọn protocol theo route và theo model.
  - Live với `OPENAI_API_KEY` trên `/v1/chat/completions`: không effort, effort `high`, effort sai (message gốc),
    tool call, structured output, ảnh.
  - Mock server: DeepSeek (`reasoning_content`), Ollama/vLLM (không auth, `max_tokens`).

### Pha 4: Chuyển 3 provider thành provider họ API

- [ ] **provider-openai:** `api` theo route / model (pha 4a); nhận `displayName`, `compat`; xóa `context-policy.ts`.
- [ ] **provider-anthropic:** nhận `displayName`, `compat.authHeader`, `thinking`; xóa `reasoningInfo()` và
  `context-policy.ts`.
- [ ] **provider-gemini:** nhận `displayName`, `compat`; xóa `context-policy.ts`.
- [ ] Không còn logic nào phụ thuộc "baseUrl có phải chính chủ không".
- [ ] **provider-codex:** giữ discovery `supported_reasoning_levels` làm metadata tham khảo, không kiểm tra, không tự
  điền effort.
- [ ] **provider-copilot:** nhánh chat/completions gửi effort theo `reasoningFormat` thay vì âm thầm bỏ.

### Pha 5: Ma trận tương thích (tiêu chí nghiệm thu)

Chứng minh bằng test rằng **chỉ cấu hình** là đủ, không thêm package:

| Họ API | Cấu hình cần chạy được | Cách kiểm tra |
|---|---|---|
| OpenAI Responses | OpenAI chính chủ | Live (`OPENAI_API_KEY`) |
| OpenAI Chat Completions | DeepSeek, OpenRouter, Ollama/vLLM | Mock server theo đúng wire từng bên; live khi có key |
| Anthropic Messages | Anthropic chính chủ, DeepSeek `/anthropic`, endpoint dùng Bearer | Mock server; live khi có key |
| Gemini | Google AI Studio | Mock server; live khi có key |
| **Cả ba wire trên một gateway** | codex2claudecode (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`) | Live khi gateway đang chạy (probe `GET /health`), tự bỏ qua nếu không |

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

Kiểm tra riêng cho codex2claudecode:

- [ ] Cùng một model (ví dụ `gpt-5.6-luna`) trả lời được qua cả 3 route.
- [x] Gateway áp dụng effort theo field chuẩn của cả 3 wire (đã đo bằng request thô, xem mục 4). Còn lại: kiểm tra
  **qua SDK** sau khi làm xong pha 1, 3, 4a (SDK gửi đúng field và giá trị).
- [ ] Hậu tố tên model (`gpt-5.6-sol_high`) vẫn chạy như một model id bình thường (SDK không can thiệp).
- [ ] Có password: cả `x-api-key` (Anthropic) và `Authorization: Bearer` (OpenAI) đều qua.
- [ ] Ảnh / PDF với mặc định `inputModalities`.

Mỗi dòng kiểm tra:

- [ ] Agent không đặt effort / max tokens: request không có các field đó, gọi thành công (Anthropic có `max_tokens`
  dự phòng).
- [ ] Agent đặt effort hợp lệ: request mang đúng giá trị, gọi thành công.
- [ ] Agent đặt effort sai: lỗi hiện **message gốc** của API.
- [ ] Gửi ảnh / PDF với mặc định; và với agent `inputModalities: ['text']`.

Thêm:

- [ ] Live test tự bỏ qua khi thiếu key tương ứng.
- [ ] README: mục "Đấu nối endpoint tương thích" (cấu hình mẫu cho từng dòng) và mục "Cấu hình mặc định" (bảng thứ tự
  ưu tiên ở pha 1b).

### Pha 6: Hoàn thiện

- [ ] Cập nhật `tests/fixtures/public-api/baseline.json`, README 3 provider, CHANGELOG (breaking changes + bug fix
  effort Anthropic).
- [ ] Tăng version.

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
