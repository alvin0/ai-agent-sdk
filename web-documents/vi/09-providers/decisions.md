# Typed decisions

Companion runtime decision trả lời các câu hỏi choice, score và boolean có tập
đáp án đóng. Cài `@alvin0/ai-agent-sdk-decision-adapter` cùng provider đã chọn.

## OpenAI Decisions native (0.1.11+)

Import `openAiDecisionPlugin` hoặc `openAiDecisionAdapter` từ
`@alvin0/ai-agent-sdk-provider-openai/decisions`. Transport này gọi
`/v1/decisions` và giữ evidence xác suất có nguồn `provider`, khác với LLM bridge
gọi Responses hoặc Chat Completions. Cần OpenAI API key riêng; OAuth ChatGPT của
Codex Responses không tự cấp quyền Decisions. Không fallback sang Responses khi
lỗi. API root tùy chỉnh phải bao gồm `/v1`.

```ts
import { createDecisionRuntime, choiceQuestion }
  from '@alvin0/ai-agent-sdk-decision-adapter'
import { openAiDecisionPlugin }
  from '@alvin0/ai-agent-sdk-provider-openai/decisions'

const runtime = createDecisionRuntime({
  providers: [openAiDecisionPlugin({ apiKey })], // injected string or CredentialSource
})
try {
  const result = await runtime.decisionModel({ provider: 'openai', model: 'gpt-6-luna' }).evaluate({
    state: { message: 'Please refund the duplicate payment.' },
    questions: {
      department: choiceQuestion('Choose the department.', {
        billing: 'Payments and refunds', support: 'Technical issues',
      }),
    },
  })
  console.log(result.answers.department.choice)
} finally {
  await runtime.close()
}
```

Adapter chạy một attempt; companion runtime quản lý retry và deadline tổng.
Refusal native báo lỗi không retry `OPENAI_DECISION_REFUSED`. Input hiện là
text/JSON, chưa có native image message. Usage decision trong tool không gộp
vào token budget agent. Đóng cả hai runtime khi dùng cùng nhau; decision plugin
không được đăng ký trong `AgentRuntime.providers`.

## Backend khác

`llmDecisionPlugin({ id, routes, adapter })` bọc raw SDK model adapter chạy một
attempt. `typesafePlugin` trả evidence xác suất native. Confidence
`model-generated` của LLM bridge là tự báo cáo, không phải xác suất provider.
Evidence gate abstain khi không có evidence được chấp nhận.

- [OpenAI generation](/vi/09-providers/openai)
- [Nâng cấp hiện tại](/vi/01-introduction/upgrading-to-0-1-12)
