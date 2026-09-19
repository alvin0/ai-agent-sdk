# Prompt caching

Prompt caching tái sử dụng prefix không đổi của request. Nó hữu ích nhất cho
session dài liên tục gửi lại cùng system instruction, tool schema và lịch sử hội
thoại cũ trước một turn mới ngắn.

SDK giữ một mục tiêu public nhất quán—cho phép tái sử dụng prefix ổn định—nhưng
vẫn giữ đúng wire semantics thực tế của từng provider:

| Provider | Option SDK | Hành vi wire | Mặc định |
| --- | --- | --- | --- |
| OpenAI Responses / Chat Completions | `promptCaching` hoặc `promptCacheKey` | gửi `prompt_cache_key` | tắt |
| Anthropic Messages | `promptCaching`, `promptCachingTtl` tuỳ chọn | thêm breakpoint `cache_control` | tắt |
| Gemini Interactions | không có | provider tự implicit prefix caching | tự động trên model hỗ trợ |

## OpenAI: session key ổn định

```ts
openAiPlugin({
  apiKey,
  promptCaching: true,
})
```

`promptCaching: true` sinh một key khi adapter được tạo và dùng lại key đó cho
mọi call qua instance này. Cách này phù hợp khi runtime/provider instance có
scope theo session. Nếu một instance phục vụ nhiều session, hãy truyền identity
tường minh hoặc tạo một provider instance cho mỗi cache group:

```ts
openAiPlugin({
  id: `openai:${tenantId}:${conversationId}`,
  apiKey,
  promptCacheKey: `tenant:${tenantId}:conversation:${conversationId}`,
})
```

Không đặt email thô, access token hoặc secret khác vào cache key. Hãy coi nó là
định danh routing/accounting ổn định, không phải thông tin xác thực.

Key áp dụng cho cả hai wire OpenAI được hỗ trợ và dùng chung giữa các model trên
route hỗn hợp Responses/Chat Completions. Nó giúp định tuyến các prefix tương tự;
nó không làm cho nội dung prompt khác nhau trở thành tương đương. Việc cache
match vẫn phụ thuộc vào prefix thực sự ổn định.

## Anthropic: breakpoint prefix tường minh

```ts
anthropicPlugin({
  apiKey,
  promptCaching: true,
  promptCachingTtl: '1h', // hoặc '5m'; bỏ qua để dùng mặc định API
})
```

Serializer đặt `cache_control: { type: 'ephemeral' }` trên tối đa ba ranh giới
ổn định:

1. system prompt;
2. tool definition cuối cùng;
3. wire message áp chót.

Mỗi breakpoint có nghĩa "cache prefix đến hết block này". Message mới nhất được
cố ý để ngoài history breakpoint vì đó thường là phần thay đổi giữa các turn.
SDK không mutate object message hoặc tool của caller khi thêm các marker chỉ tồn
tại trên wire này.

`promptCachingTtl` điều khiển vòng đời breakpoint. Đây là tính năng của provider,
không phải local cache của SDK, và có thể ảnh hưởng giá hoặc data retention.

## Gemini: không có cache key để cấu hình

Gemini Interactions hỗ trợ implicit caching cho prefix trùng khớp. SDK không gửi
`prompt_cache_key` giả vì field đó thuộc OpenAI. SDK cũng không gửi
`cached_content`, vì explicit cached-content resource là tính năng của
`generateContent` và Interactions không nhận nó.

Provider hiện dùng request Interactions stateless nên gửi lại lịch sử hội thoại.
Giữ phần đầu ổn định để tăng cache hit implicit. `store` là vấn đề riêng: nó điều
khiển Google có được giữ Interaction hay không, không điều khiển implicit prompt
caching.

## Gateway tương thích và fallback

Không phải gateway tương thích OpenAI/Anthropic nào cũng hỗ trợ field cache của
provider gốc. Khi bật caching, adapter chỉ phản ứng với tín hiệu hẹp: HTTP 400 và
error message nêu đúng `prompt_cache_key` hoặc `cache_control` tương ứng.

Với tín hiệu đó, adapter:

1. tắt field tuỳ chọn cho adapter instance này;
2. thử lại call bị từ chối một lần không có field;
3. gửi các call sau không có field, kể cả call đã prepare trước đó.

Các call đồng thời bị từ chối đều nhận fallback riêng và trong suốt. Lỗi 400 cho
field khác, lỗi xác thực hoặc lỗi model vẫn được trả ra bình thường.

## Giữ prefix có thể cache

- Giữ system prompt và tool schema ổn định trong session.
- Append turn mới; tránh viết lại message cũ sang shape khác.
- Giữ thứ tự xác định cho tools và structured schema.
- Scope provider instance và key tường minh theo tenant/account rồi mới tới session.
- Đo cache read thực tế; bật hint không bảo đảm chắc chắn có cache hit.

Usage từ provider được chuẩn hoá thành `cacheReadTokens` và `cacheWriteTokens`
khi response upstream có các counter đó. Ví dụ,
`usage.total_cached_tokens` của Gemini ánh xạ thành `cacheReadTokens`. Counter
thiếu hoặc bằng 0 không chứng minh caching không được hỗ trợ; nó chỉ cho biết
response không báo cache hit.

## Đọc tiếp

- [OpenAI](/vi/09-providers/openai)
- [Anthropic](/vi/09-providers/anthropic)
- [Gemini](/vi/09-providers/gemini)
- [Gateway tương thích và credential trong database](/vi/09-providers/gateways-and-credentials)
