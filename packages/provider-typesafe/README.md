# TypeSafe provider

Runtime: **Universal** (Node, browser, and Web-standard workers).

```sh
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-decision-adapter @alvin0/ai-agent-sdk-provider-typesafe
```

TypeSafe Jev adapter for typed decisions. Implements `POST /v1/systemone` and
`GET /v1/models`; it does not register Jev as a chat-generation model.

```ts
import {
  createDecisionRuntime, choiceQuestion, scoreQuestion, booleanQuestion,
} from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node/env'

const runtime = createDecisionRuntime({ providers: [typesafePlugin({
  apiKey: envCredential('TYPESAFE_API_KEY'),
})] })
try {
  const result = await runtime.decisionModel({
    provider: 'typesafe', model: 'jev-latest',
  }).evaluate({
    state: { message: 'My payouts have failed for three days. Please help today.' },
    questions: {
      department: choiceQuestion('Which department should handle this?', {
        billing: 'Payments and refunds', support: 'Technical bugs',
      }),
      urgency: scoreQuestion('How urgent is this?', ['Routine', 'Urgent', 'Critical']),
      needsAttention: booleanQuestion('Does this require prompt attention?'),
    },
  })
  console.log(result.model, result.answers, result.usage)
} finally {
  await runtime.close()
}
```

Install `@alvin0/ai-agent-sdk-auth-node` separately for the Node environment-key
example. The universal provider does not read environment variables; it accepts
a string or the SDK's versioned `CredentialSource`, resolved once per attempt.
Never embed a server API key in client-side code. Use a server endpoint/proxy for
browser applications.

## Configure tasks for different consumers

Use `createDecisionTask(runtime.decisionModel(target), { questions, timeoutMs })`
to inject a reusable typed task into a service handler, agent tool, CLI or batch
job. For request-scoped accounting, pass `ModelInvocationContext` to
`task.evaluate(state, options, context)` or `task.evaluateBatch(states, { context })`.
Independent questions share a request; different states use bounded client-side
batching. [Workflow examples](../decision-adapter/USE_CASES.md) cover routing,
verification, reranking and sequential decisions.

Separate accounts or endpoints can coexist with named routes:

```ts
const runtime = createDecisionRuntime({ providers: [
  typesafePlugin({
    id: 'typesafe-primary', routes: ['primary'],
    apiKey: envCredential('TYPESAFE_API_KEY'),
  }),
  typesafePlugin({
    id: 'typesafe-secondary', routes: ['secondary'],
    apiKey: envCredential('TYPESAFE_SECONDARY_API_KEY'),
  }),
] })
const primary = runtime.decisionModel({ provider: 'primary', model: 'jev-1.13.0' })
const secondary = runtime.decisionModel({ provider: 'secondary', model: 'jev-latest' })
// Application code chooses which task/handle to call, and when to fall back.
```

For workers, inject the host's secret binding as `apiKey`; for tests, inject `fetch`.
Native Noul answers close to 0.5 are uncertain. Use
`gateBoolean(answer, { falseMax: 0.2, trueMin: 0.8 })` when the workflow needs an
explicit review interval; tune those example thresholds using labeled data.
Choice routing can use `gateChoice` with probability, margin and confidence
thresholds. Provider confidence describes a distribution; it does not prove
that the business decision is correct.

## Mapping and options

| SDK question | TypeSafe wire type | Returned evidence |
| --- | --- | --- |
| `choice` with `options` | `choice` with `criteria` | choice, probabilities, confidence |
| `score` with `levels` | `score` with `criteria` | fractional score, probabilities, confidence |
| `boolean` | `noul` | probabilityTrue; value is probabilityTrue >= 0.5 |

All native evidence has `probabilitySource: 'provider'`. Noul does not supply
confidence; the adapter keeps it absent. The actual response model ID is retained
even when the request uses an alias. New/pinned model IDs need no SDK release.

`typesafeAdapter(options)` supports direct use and catalog discovery.
`typesafePlugin(options)` installs it into the decision runtime. Options include
`apiKey`, `baseUrl` (default `https://api.typesafe.ai/v1`), injected `fetch`, custom
headers, `requestTimeoutMs` (30 seconds), `maxRequestBytes` (2 MiB),
`maxResponseBytes` (4 MiB), and `retryPolicy`. Plugins also accept `id` and `routes`
(default `['typesafe']`). Local HTTP requires explicit `allowInsecureHttp: true`.
Connection options are captured at construction. Redirects are rejected, custom
headers cannot override authentication/transport headers, and errors omit raw
response bodies and credentials.

When `retryPolicy` is omitted, the runtime policy applies; an explicit provider
policy overrides it. Direct calls perform one attempt and honor per-call
`timeoutMs`, bounded also by `requestTimeoutMs`, during credentials and transport.
Prepared calls reuse the captured JSON body across retries; tasks share compiled
rubrics without caching decisions, credentials or connections across calls.
Valid usage is retained in provider-attempt reports even if answer validation
fails. Invalid or overflowing usage counters fail validation and are not reported
as trustworthy billing evidence.

Choice accepts 2–255 options; Score accepts 2–10 ordered levels. Invalid requests
fail before network IO. Responses are byte-bounded and validated. The adapter
performs one attempt; the runtime applies retries for transient rate limiting,
overload, timeout and transport errors. HTTP 401/403 map to `AUTH`, 422 to
`INVALID_REQUEST`, 429 to `RATE_LIMIT`, and 529 to `SERVER`; `Retry-After` is honored
within the retry policy's delay ceiling.

## Verification

Offline: `pnpm --filter @alvin0/ai-agent-sdk-provider-typesafe test`.
Installed tarballs: `pnpm --filter @alvin0/ai-agent-sdk-provider-typesafe test:pack`.
Live acceptance from the workspace root: set `TYPESAFE_API_KEY` in `.env`, build
the packages, then run `pnpm human:decision`. The runner prints English/Vietnamese
decision results, usage, model IDs and latency; it never prints the API key.
Optionally set `TYPESAFE_MODEL` to pin a model ID.
Run `pnpm test:decision-live` from the workspace root for paid TypeSafe accounting
checks. They inject an invalid choice after a real response and an overload before
a real retry, verifying billed usage and reuse of the captured request.

API references: [Evaluation](https://docs.typesafe.ai/api),
[Models](https://docs.typesafe.ai/models), [Confidence](https://docs.typesafe.ai/confidence).
