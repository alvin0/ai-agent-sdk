# Agents — Tổng quan

Một agent là **khai báo đã đóng băng** về danh tính và chính sách. Nó không phải
một kết nối, một hội thoại, hay một tiến trình.

Ba đối tượng, ba vòng đời:

| Đối tượng | Vòng đời | Sở hữu |
| --- | --- | --- |
| `AgentRuntime` | Phạm vi tiến trình hoặc yêu cầu | Provider, observability, lease thao tác, báo cáo đóng |
| `RuntimeAgent` / `DefinedAgent` | Phạm vi module, đã đóng băng | Danh tính, chỉ dẫn, tuyến model, năng lực |
| `RuntimeAgentSession` | Một hội thoại | Lịch sử, bộ nhớ, skill đã kích hoạt, khoá loại trừ |

## Hai kiểu khai báo

**Gắn qua runtime** — gốc ghép nối tạo ra agent:

```ts
const runtime = await createAgentRuntime({ providers: [openAiPlugin({ apiKey })] })

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'gpt-5.4' },
})
```

**Định nghĩa tái dùng** — chốt danh tính và chính sách một lần ở phạm vi module:

```ts
export const assistant = defineAgent({
  id: 'assistant',
  instructions: 'Be concise.',
  provider: 'openai',
  model: 'gpt-5.4',
})

const session = assistant.createSession({ registry })
```

Một định nghĩa được kiểm tra, chuẩn hoá, rồi **đóng băng**. Nó an toàn để export
từ module và tái dùng qua nhiều yêu cầu. Định nghĩa không bao giờ bị thay đổi tại
chỗ — dùng `.with()` để tạo biến thể cục bộ, hoặc `cloneAgent()` khi agent dẫn
xuất cần một danh tính ổn định mới.

## Ba cách chạy một agent

```ts
await agent.generate(input)          // một phát, không giữ trạng thái
agent.stream(input)                  // luồng sự kiện trực tiếp
agent.createSession().run(input)     // hội thoại có trạng thái
```

`generate()` rút cạn đúng luồng mà `stream()` phơi ra. Không có đường
không-streaming riêng.

## Trong chương này

| Trang | Trả lời |
| --- | --- |
| [Creating an Agent](/vi/02-agents/creating-an-agent) | Mọi trường của một agent, và tuyến model được giải quyết thế nào |
| [Agent Instructions](/vi/02-agents/agent-instructions) | Chỉ dẫn đặt ở đâu, ai có thẩm quyền, bổ sung theo từng lượt |
| [Agent Context](/vi/02-agents/agent-context) | Thực sự cái gì tới được model ở mỗi yêu cầu |
| [Structured Output](/vi/02-agents/structured-output) | Văn bản và kết quả JSON Schema do nhà cung cấp ràng buộc |
| [Streaming](/vi/02-agents/streaming) | Run handle và mọi sự kiện nó phát ra |
| [Lifecycle](/vi/02-agents/lifecycle) | Khởi động, turn hook, huỷ, bằng chứng đóng |
