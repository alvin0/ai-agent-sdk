# Typed decisions

The decision companion runtime answers closed choice, score and boolean questions.
Install `@alvin0/ai-agent-sdk-decision-adapter` alongside the selected provider.

## Native OpenAI Decisions (0.1.11+)

`openAiDecisionPlugin` and `openAiDecisionAdapter` are exported from
`@alvin0/ai-agent-sdk-provider-openai/decisions`. This is a native `/v1/decisions`
transport with `provider` probability evidence, distinct from the LLM bridge's
Responses or Chat Completions calls. Use a separate OpenAI API key; ChatGPT OAuth
for Codex Responses alone does not provide Decisions access. There is no fallback
to Responses on error. A custom API root includes `/v1`.

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

The adapter performs one attempt; the companion runtime owns retries and the
logical deadline. Native refusals throw non-retryable `OPENAI_DECISION_REFUSED`
errors. The current input is text/JSON, not native image messages. Nested decision
usage is not merged into an agent's token budget. Close both runtimes when they
are used together; decision plugins do not belong in `AgentRuntime.providers`.

## Other backends

`llmDecisionPlugin({ id, routes, adapter })` wraps a raw, single-attempt SDK
model adapter; `typesafePlugin` supplies native TypeSafe probability evidence.
The LLM bridge's opt-in `model-generated` confidence is self-reported, not provider
probability evidence. Evidence gates abstain without acceptable evidence.

- [OpenAI generation](/en/09-providers/openai)
- [Current migration](/en/01-introduction/upgrading-to-0-1-14)
