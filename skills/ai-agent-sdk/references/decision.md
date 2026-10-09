# Typed decisions

`@alvin0/ai-agent-sdk-decision-adapter` answers a fixed set of closed questions
(choice, score, boolean) about a piece of state and returns a typed, validated
result. It is a **companion runtime**, not an `AgentRuntime` plugin: create it
next to the agent runtime and close both.

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-decision-adapter
# plus the provider package(s) you route to:
pnpm add @alvin0/ai-agent-sdk-provider-openai      # Responses / Chat Completions
pnpm add @alvin0/ai-agent-sdk-provider-anthropic   # Messages
pnpm add @alvin0/ai-agent-sdk-provider-gemini      # Interactions
pnpm add @alvin0/ai-agent-sdk-provider-typesafe    # TypeSafe native evidence
```

## Pick a backend

| Backend | Install into `createDecisionRuntime({ providers })` | Evidence |
| --- | --- | --- |
| TypeSafe | `typesafePlugin({ apiKey })` | Native `provider` probabilities |
| Any SDK chat provider | `llmDecisionPlugin({ id, routes, adapter })` | None, or opt-in `model-generated` |

`llmDecisionPlugin` wraps a raw `ModelAdapter` (`openAiAdapter`,
`anthropicAdapter`, `geminiAdapter`, or any custom HTTP adapter). The wrapped
adapter's credentials, `baseUrl`, gateway headers, injected `fetch`, and wire
protocol are used unchanged. Which API is called is decided by the adapter, not by
the decision package.

## Setup per wire API

```ts
import {
  booleanQuestion, choiceQuestion, createDecisionRuntime, createDecisionTask, llmDecisionPlugin,
} from '@alvin0/ai-agent-sdk-decision-adapter'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'
import { anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node/env'

const runtime = createDecisionRuntime({ providers: [
  // OpenAI Responses API (/v1/responses). `api` defaults to 'responses'.
  llmDecisionPlugin({
    id: 'openai-responses', routes: ['openai-responses'],
    adapter: openAiAdapter({ apiKey: envCredential('OPENAI_API_KEY'), api: 'responses' }),
  }),
  // OpenAI Chat Completions (/v1/chat/completions), also most compatible gateways.
  llmDecisionPlugin({
    id: 'openai-chat', routes: ['openai-chat'],
    adapter: openAiAdapter({
      apiKey: envCredential('OPENAI_API_KEY'),
      api: 'chat-completions',
      compat: { maxTokensField: 'max_completion_tokens' }, // reasoning models reject max_tokens
    }),
  }),
  // Anthropic Messages API (/v1/messages).
  llmDecisionPlugin({
    id: 'anthropic', routes: ['anthropic'], outputMode: 'tool',
    adapter: anthropicAdapter({ apiKey: envCredential('ANTHROPIC_API_KEY') }),
  }),
] })

try {
  const task = createDecisionTask(
    runtime.decisionModel({ provider: 'openai-responses', model: 'gpt-6-luna' }),
    { questions: {
      department: choiceQuestion('Which department should handle this request?', {
        billing: 'Invoices, payments, refunds', technical: 'Bugs, outages', sales: 'Pricing',
      }),
      refund: booleanQuestion('Is the customer asking for a refund?'),
    } },
  )
  const result = await task.evaluate('I was charged twice. Please refund the duplicate.')
  result.answers.department.choice // 'billing' | 'technical' | 'sales'
  result.answers.refund.value      // boolean
} finally {
  await runtime.close()
}
```

`decisionModel({ provider })` takes the **route** name registered by the plugin,
not the vendor name. Register one plugin per wire/output-mode combination you
need, and switch by route; the task's question contract does not change.

OpenAI examples, smoke tests and live calls in this project use `gpt-6-luna` or
a newer explicitly selected model. Do not fall back to an older model on error.

## Output mode

| `outputMode` | What is sent | Finish reason expected |
| --- | --- | --- |
| `'json-schema'` (default) | Closed JSON Schema through the wire's structured output (`text.format` on Responses, `response_format` on Chat Completions, `output_config.format` on Messages) | `stop` |
| `'tool'` | One forced `submit_decisions` function call; its arguments are parsed as data and nothing is executed | `tool-calls` |

The bridge never switches modes or providers on failure. If the model or endpoint
lacks the feature, the call fails with that error.

## Known wire pitfalls (verified live with `gpt-6-luna`)

| Wire + mode | Symptom | Fix |
| --- | --- | --- |
| Responses, both modes | — | Works as configured above |
| Chat Completions, any mode | `INVALID_REQUEST: 'max_tokens' is not supported with this model` | `compat: { maxTokensField: 'max_completion_tokens' }` on `openAiAdapter` |
| Chat Completions, `tool` | `INVALID_REQUEST: Function tools with reasoning_effort are not supported ... in /v1/chat/completions` | Prefer Responses for `tool` mode, or pass `generation: { reasoningEffort: 'none' }` |
| Any, `tool` | Model rejects forced tool choice | Use `json-schema`, or a model that supports forced tool selection |

## Options worth knowing

```ts
llmDecisionPlugin({
  id, routes, adapter,
  outputMode: 'json-schema' | 'tool',
  evidence: 'none' | 'model-generated', // model-generated = self-reported, NOT calibrated
  generation: { maxTokens, temperature, topP, reasoningEffort },
  maxResponseBytes: 2_097_152,          // includes reasoning + tool arguments; max 16 MiB
})
createDecisionRuntime({ providers, timeoutMs: 30_000, retryPolicy })
```

- Pass a **raw, single-attempt** adapter, not a runtime/agent handle. The
  decision runtime owns retries and the logical deadline (30 s default, including
  backoff).
- `task.evaluateBatch(states, { concurrency })` runs independent states with one
  rubric (default concurrency 4, max 1,024 inputs). It is client-side
  scheduling, not a provider batch endpoint.
- Gates: `gateChoice(answer, { minProbability, minMargin, minConfidence })` and
  `gateBoolean(answer, { falseMax, trueMin })` accept only `provider` evidence by
  default. `model-generated` evidence needs `allowedSources: ['model-generated']`.
  Without evidence, gates abstain.
- The LLM bridge reports the requested model id; it does not expose the
  provider's response model id or request id.

## Calling a decision from an agent

`AgentRuntime.providers` rejects decision plugins and has no `decisionModel()`.
Call the decision from inside a core tool and forward the tool's signal:

```ts
const classify = defineTool<{ message: string }>({
  name: 'classify_ticket', description: 'Classify a support ticket',
  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  parse: raw => ({ message: String((raw as { message: unknown }).message) }),
  async execute(args, ctx) {
    const result = await task.evaluate(args.message, { signal: ctx.signal })
    return { department: result.answers.department.choice }
  },
})
```

The agent itself can run on any wire (Responses, Chat Completions, Messages);
the tool's decision uses whichever decision route the task was built with. Close
both runtimes. Nested decision usage is not merged into the agent's token totals
or budgets.

## Verify a setup

- Offline: `pnpm --filter @alvin0/ai-agent-sdk-decision-adapter test`;
  wire fixtures for Responses, Chat Completions, Messages and Gemini live in
  `tests/unit/decision-llm.spec.ts`.
- Live (repository, keys from `.env`): `pnpm human:decision:all`. Narrow it with
  `DECISION_SMOKE_FOCUS=openai-json-schema | openai-tool | openai-evidence`;
  `OPENAI_DECISION_MODEL` may select `gpt-6-luna` or newer. Unconfigured
  providers are skipped.

Full contract, batch and gate semantics: `packages/decision-adapter/README.md`
and `packages/decision-adapter/USE_CASES.md`.
