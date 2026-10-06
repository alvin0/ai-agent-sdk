# Decision adapter

Runtime: **Universal** (Node, browser, and Web-standard workers).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-decision-adapter
```

Provider-neutral typed decisions, independently of chat generation and embeddings.
Use `choiceQuestion`, `scoreQuestion`, and `booleanQuestion` to define a closed
answer space. The return type preserves question IDs and literal choice options.

See [Use cases and setup](./USE_CASES.md) for routing, triage, guardrails, RAG
reranking, extraction, and staged workflows, including their tradeoffs.

```ts
import {
  createDecisionRuntime, choiceQuestion,
} from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'

const runtime = createDecisionRuntime({
  providers: [typesafePlugin({ apiKey: 'your-server-side-key' })],
})
try {
  const model = runtime.decisionModel({ provider: 'typesafe', model: 'jev-latest' })
  const result = await model.evaluate({
    state: { message: 'Please refund my invoice' },
    questions: {
      department: choiceQuestion('Which department should handle this?', {
        billing: 'Invoices and refunds', support: 'Technical issues',
      }),
    },
  })
  // Typed as 'billing' | 'support'.
  console.log(result.answers.department.choice)
} finally {
  await runtime.close()
}
```

## Contract

- `choice`: selected option; optional full probability distribution.
- `score`: expected zero-based ordinal level; fractional scores are valid.
- `boolean`: boolean value; optional probability of true. The TypeSafe provider
  uses `probabilityTrue >= 0.5` for `value`; application thresholds can use the raw
  probability instead.
- Evidence carries `probabilitySource`: `provider`, `token-logprobs`, or
  `model-generated`. The tag identifies provenance, not a calibration guarantee.
  Missing evidence/usage stays absent. Confidence is not inferred.
- JSON is detached and frozen before async preparation. Results are checked for
  IDs, types, allowed choices, probability bounds/sums, and score consistency.
  JSON is bounded to 2 MiB, 100,000 nodes and depth 64.
- Model catalogs are advisory. Unknown model IDs remain callable.

## OpenAI, Anthropic and Gemini decisions

`llmDecisionAdapter({ adapter })` wraps an existing SDK `ModelAdapter`.
`llmDecisionPlugin({ id, routes, adapter })` installs that bridge into the companion
runtime. Install only the provider packages you use; the decision package adds no
dependency on concrete providers. Their existing credentials, gateways, injected
fetch, request logging and provider-attempt accounting remain in use.

OpenAI project examples and live calls use `gpt-6-luna` as the minimum model.
Select it or a newer model explicitly; do not fall back to older OpenAI models.

```ts
import { createDecisionRuntime, createDecisionTask, choiceQuestion, llmDecisionPlugin }
  from '@alvin0/ai-agent-sdk-decision-adapter'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'
import { anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'
import { geminiAdapter } from '@alvin0/ai-agent-sdk-provider-gemini'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node/env'

const runtime = createDecisionRuntime({ providers: [
  llmDecisionPlugin({ id: 'openai-decisions', routes: ['openai'],
    adapter: openAiAdapter({ apiKey: envCredential('OPENAI_API_KEY') }) }),
  llmDecisionPlugin({ id: 'anthropic-decisions', routes: ['anthropic'],
    adapter: anthropicAdapter({ apiKey: envCredential('ANTHROPIC_API_KEY') }) }),
  llmDecisionPlugin({ id: 'gemini-decisions', routes: ['gemini'],
    adapter: geminiAdapter({ apiKey: envCredential('GEMINI_API_KEY') }) }),
] })
try {
  const task = createDecisionTask(runtime.decisionModel({
    provider: 'openai', model: 'gpt-6-luna',
  }), { questions: {
    route: choiceQuestion('Which team should handle this?', {
      billing: 'Invoices and refunds', support: 'Technical issues', other: 'Neither',
    }),
  } })
  const result = await task.evaluate('Please refund my duplicate invoice')
  console.log(result.answers.route.choice)
  // Select provider: 'anthropic' or 'gemini' with that provider's model ID
  // to use the same question/task contract. evaluateBatch works identically.
} finally { await runtime.close() }
```

The default `outputMode: 'json-schema'` sends a closed JSON Schema through the
provider's existing structured-output protocol. OpenAI Responses and Chat
Completions, Anthropic Messages and Gemini Interactions are covered by HTTP fixture
tests. Choose a model/endpoint supporting that feature. Unsupported options fail
explicitly; the bridge does not silently switch formats or providers.

For endpoints using function calling instead, configure `outputMode: 'tool'`.
The bridge asks for exactly one `submit_decisions` call and consumes its arguments
as data. No host tool or agent loop executes. The model must support forced tool
selection; some models/reasoning configurations reject it. Additional/wrong tool
calls, truncated responses, invalid JSON, unknown fields/options, and inconsistent
scores/distributions fail validation. Numeric constraints are checked locally to
keep the schema portable across provider subsets.

`evidence: 'none'` is the default: only choice/score/boolean values are requested.
Missing probabilities/confidence remain absent. With `evidence: 'model-generated'`,
Choice/Score request full probability distributions and confidence, and Boolean
requests `probabilityTrue`. These are model estimates, not native probabilities or
token logprobs. They are always tagged `model-generated`, cannot spoof provenance,
and require explicit `allowedSources: ['model-generated']` in a gate. Structured
output constrains shape; it does not calibrate those estimates.

Options also accept `generation: { maxTokens, temperature, topP, reasoningEffort }`
and `maxResponseBytes` (default 2 MiB, maximum 16 MiB), including reasoning and
arguments. Sampling/effort support remains model-specific; omission adds no sampling
defaults. Pass a raw single-attempt adapter, not a retry-wrapped registry/agent
handle. The decision runtime owns retry/deadline policy and reuses one prepared
generation across attempts. Direct bridge calls are also deadline-bounded.
For score questions in evidence mode, the wire schema requests only the
distribution and confidence. The SDK derives the public fractional score from
that validated distribution; it does not ask the model to duplicate the arithmetic.
Extra score fields and malformed distributions are rejected rather than repaired.

The SDK generation stream does not expose an authoritative response model ID or
request ID as public fields. The bridge therefore returns the requested model ID
and omits `providerRequestId`; provider-attempt telemetry remains with the wrapped
adapter. Pin model IDs when evaluation reproducibility matters. TypeSafe's native
adapter continues to preserve its actual response model ID and native evidence.

Protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
[Anthropic tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
[Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview).

## Providers and lifecycle

Extend `DecisionAdapter`; only `evaluate()` is abstract. One invocation performs
one physical attempt. Override `resolveModel()` to declare question types and
provider-specific bounds. Mutable connection configurations must override
`prepareDecisionCall()` to bind metadata and dispatch to the same generation.
Its optional fourth argument is the invocation context: forward it during
connection/credential preparation as well as dispatch. A prepared call belongs to
one logical request; reuse that request for retries, prepare again for a new input.
Adapters must honor the request's `signal` and may report physical attempts using
the supplied SDK `ModelInvocationContext`.

`defineDecisionProviderPlugin()` declares versioned route ownership. Register
multiple plugins with `createDecisionRuntime({ providers })`, or register adapters
directly with `runtime.registerAdapter(routes, adapter)`. A route cannot have two
decision adapters; registration is atomic and returns an idempotent disposer.

This package supplies a **companion runtime**, not an `AgentRuntime` plugin. Keep
the decision runtime next to the agent runtime and call its model handles from
host workflow code or a tool. Pass `ModelInvocationContext` as the second argument
to `evaluate()` to join existing provider-attempt accounting; this runtime does
not create an independent observation exporter or fabricate attempt telemetry.

The default logical deadline is 30 seconds, including preparation, attempts and
backoff. Override with runtime `timeoutMs` or per-call `timeoutMs`. SDK retry policy
and backoff helpers are reused; the adapter's route retry policy takes precedence
over the runtime default when explicitly configured (TypeSafe inherits the runtime
policy when its `retryPolicy` is omitted). A single prepared call is reused across
retries. The runtime owns the overall deadline; the LLM bridge does not add an
independent 30-second deadline inside a runtime call. Direct LLM calls retain a
30-second default. Transport request limits may still bound a physical attempt.
`close()` aborts active work, runs plugin cleanup, and rejects subsequent calls.
Noncooperative extension promises are detached after cancellation; their late
rejections are observed, but external side effects cannot be undone.

### Connecting to a core agent

The current `AgentRuntime.providers` accepts generation and embedding plugins,
not decision plugins, and `AgentRuntime` has no `decisionModel()` method. A decision
task can nevertheless run inside a core tool through the public API:

```ts
import { defineTool } from '@alvin0/ai-agent-sdk-core'

// `task` is a configured decision task with a `route` choice question.
const classifyTicket = defineTool<{ message: string }>({
  name: 'classify_ticket', description: 'Classify a support ticket',
  parameters: {
    type: 'object', properties: { message: { type: 'string' } },
    required: ['message'], additionalProperties: false,
  },
  parse(raw) {
    if (raw === null || typeof raw !== 'object' || !('message' in raw)
      || typeof raw.message !== 'string') throw new Error('message required')
    return { message: raw.message }
  },
  async execute(args, ctx) {
    const result = await task.evaluate({ message: args.message },
      { signal: ctx.signal }, { ...(ctx.logger ? { logger: ctx.logger } : {}) })
    return { route: result.answers.route.choice, model: result.model }
  },
})
// Pass tools: [classifyTicket] when binding a core agent/session.
```

Return the selected JSON fields to the agent, and always forward `ctx.signal`.
Closing core aborts a decision called by an active tool when that signal is
forwarded. Core does not close the independently-created decision runtime; the
host must close both owners, including decisions called outside agent runs.
Tool signals are scoped to one invocation and are aborted during cleanup, so do
not keep them for later background work.

`ToolRunContext` exposes cancellation, logging and run position; it does not
expose a complete `ModelInvocationContext` or provider-attempt accounting handle.
Forwarding its logger alone does not merge nested decision usage into the core
agent's token totals, budgets or model-call reports. A host-owned invocation
context can be passed explicitly; full core-managed admission, lifecycle,
catalogs and accounting would require a native decision capability in core.

The public integration tests cover tool output reaching the next agent step,
core-close cancellation, independent companion lifecycle, and rejection of
decision plugins in the core provider list.

Run `pnpm --filter @alvin0/ai-agent-sdk-decision-adapter test` for offline contract
tests and `test:pack` for installed-tarball verification.
For live acceptance with workspace `.env` keys, run `pnpm human:decision:all` after
building. It covers TypeSafe and OpenAI JSON Schema/tool mode, English/Vietnamese,
batches, model-generated evidence and a core agent tool. Unconfigured providers
are skipped. OpenAI defaults to `gpt-6-luna`. `OPENAI_DECISION_MODEL` (or
`OPENAI_MODEL`) may select it or a newer model; `TYPESAFE_MODEL` pins the TypeSafe
model. The runner emits safe status/usage/latency diagnostics without keys or raw
errors.

## Reusable tasks and batches

`createDecisionTask(model, { questions, timeoutMs, context })` binds a detached,
frozen rubric to a model handle. `task.evaluate(state, { signal, timeoutMs }, context)`
overrides call options without repeating questions or connection configuration.
SDK-created immutable snapshots are reused; arbitrary frozen caller inputs still
undergo validation. Task batches share the captured rubric across queued states.
The LLM bridge and TypeSafe compile each rubric once per adapter/rubric identity,
and reuse the captured request through retries. No result cache or cross-call
credential/connection cache is introduced. LLM prompts put the fixed questions
before changing state; evidence instructions appear only in evidence mode.
Use a separate task per model/rubric combination; changing providers requires no
change to the task's question contract.

`task.evaluateBatch(states, { concurrency, signal, timeoutMs, context })` evaluates
independent states with the same rubric. `evaluateDecisionBatch(model, inputs, options)`
also accepts a different question set per input. Both preserve input order and
return `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }` per item.
They use at most four concurrent logical calls by default (configurable 1–256).
This is client-side scheduling, not a provider batch endpoint. Retries occupy the
same concurrency slot. A batch accepts at most 1,024 inputs, snapshots queued
payloads before dispatch, and does not automatically chunk or truncate data.

The batch deadline defaults to 30 seconds and includes queue time. Batch `timeoutMs`
sets that overall deadline; task `timeoutMs` or input `timeoutMs` still governs each
dispatched call, including custom handles that ignore deadlines. Item deadlines
start on dispatch, independently of the overall deadline that includes queue time.
Batch cancellation/deadline rejects the operation and stops queued
dispatches; individual item failures/cancellation remain partial results. Invalid
input/configuration rejects the batch before dispatch. Empty batches return `[]`.
For large datasets, submit application-managed chunks with explicit deadlines.
Concurrency limits active logical calls, not the memory used by queued snapshots;
choose chunk sizes based on payload size as well as item count.

## Evidence gates

`gateChoice(answer, { minConfidence, minProbability, minMargin, allowedSources })`
requires at least one explicit threshold and accepts only when every configured
threshold passes. `minMargin` compares the selected probability to the runner-up.
`gateBoolean(answer, { falseMax, trueMin, allowedSources })` accepts false below or
at `falseMax`, true above or at `trueMin`, and abstains between them. Both return
`{ status: 'accepted', value }` or `{ status: 'abstained', reason }`.

Gates consume validated answers and default to `allowedSources: ['provider']`.
Missing required evidence or disallowed provenance causes abstention. These pure
helpers do not call a fallback model, run tools, derive confidence, or authorize
actions. Calibrate thresholds against labeled examples for each model, question
and domain. A provider confidence statistic is not an empirical accuracy estimate.
