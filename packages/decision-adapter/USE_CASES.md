# Use cases and setup

The kit separates three concerns: the provider handles transport and model
capabilities; a task binds a model to reusable questions; application code owns
thresholds, branches, ranking and actions. A decision model selects from a closed
answer space. Generated prose, open-ended tool arguments and arbitrary extraction
remain generation tasks.

## Choosing the decision shape

| Use case | Question setup | Host workflow | Main pitfall |
| --- | --- | --- | --- |
| Intent, tool or model routing | Choice over known routes, including `other` | Gate the selected route; select a handler/model | A forced winner is not proof the request fits any route |
| Support triage / semantic features | Choice + independent booleans + ordinal scores in one request | Combine relevant answers in code | Questions do not consume each other's answers |
| Input/output/tool verification | One boolean per failure mode, with concrete true/false criteria | Block, review or continue using a three-way gate | An uncertain negative does not prove safety |
| RAG reranking / entity matching | Same relevance/match question on each query-candidate pair | Bounded batch, then filter and sort successful candidates | Choice probabilities are relative to the candidate set |
| Severity / lead prioritization | Ordered score rubric, or several independent indicators | Apply application weights and thresholds | A fractional expected score is not an integer label or a calibrated business value |
| Known-value extraction | Choice among parser-generated candidates plus `none` | Return the selected candidate's original value | A decision primitive cannot invent a missing address/date/argument |
| Hierarchical classification / cascades | Choice at each branch or a verification task after selection | Separate calls with explicit updated state and a depth/budget limit | A greedy early mistake propagates; multiplying evidence does not guarantee a calibrated path probability |

These patterns follow TypeSafe's [use-case map](https://docs.typesafe.ai/concepts/use-case-map),
[fan-out](https://docs.typesafe.ai/patterns/fan-out),
[reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe), and
[hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification)
examples. They are workflow patterns rather than provider-specific task types.

## Setup once, reuse across consumers

For a service, create one runtime during startup, inject task handles into request
handlers/tools, and close the runtime during shutdown. For a CLI/job, use
`try/finally`. Connection configuration is separate from the rubric so consumers
do not receive credentials. Pass request-scoped invocation context explicitly
instead of storing it on a singleton task.

```ts
import {
  createDecisionRuntime, createDecisionTask, choiceQuestion, booleanQuestion,
  scoreQuestion, gateChoice, gateBoolean,
} from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node/env'

const runtime = createDecisionRuntime({
  providers: [typesafePlugin({ apiKey: envCredential('TYPESAFE_API_KEY') })],
  timeoutMs: 5_000,
  retryPolicy: { mode: 'normal', maxRetries: 1 },
})
const model = runtime.decisionModel({ provider: 'typesafe', model: 'jev-1.13.0' })
const triage = createDecisionTask(model, {
  timeoutMs: 3_000,
  questions: {
    route: choiceQuestion('Which team should handle this ticket?', {
      billing: 'Invoices, charges and refunds',
      support: 'Product failures and technical issues',
      other: 'Outside the listed categories or insufficient information',
    }),
    severity: scoreQuestion('Impact of the technical issue, if present', [
      'Cosmetic', 'Degraded with a workaround', 'Blocked without a workaround',
    ]),
    refund: booleanQuestion('Is a refund explicitly requested?', {
      true: 'An explicit request for money back or a credit',
      false: 'No explicit refund request, including merely asking about prices',
    }),
  },
})
```

Pin a tested model version for stable evaluation/calibration. An alias such as
`jev-latest` is convenient for exploration; keep `result.model` in evaluation
records so an alias change is visible. Models need no catalog allowlist. Other
providers can bind the same questions through their own decision plugins, subject
to their declared capabilities. Do not assume identical limits or probability
semantics across providers.

### Routing and triage

```ts
const result = await triage.evaluate({ message: 'I was charged twice; please refund.' })
const route = gateChoice(result.answers.route, {
  minProbability: 0.85, minMargin: 0.2,
})
const refund = gateBoolean(result.answers.refund, { falseMax: 0.2, trueMin: 0.8 })
// Example thresholds only; measure them against your own labeled tickets.
if (route.status === 'abstained') {
  // Queue for review or ask a separate model; retain the original result.
} else if (route.value === 'billing') {
  // Attach refund.status/value to the billing queue, rather than issuing a refund.
} else if (route.value === 'support') {
  // Read severity here; the billing path can ignore that speculative answer.
}
```

Multiple questions in one request all see the same state. This supports multi-label
tagging through independent booleans; a single Choice returns one mutually exclusive
winner. Questions whose rubric actually depends on an earlier answer require a
second call with that answer included in the next state.

### Guardrails and verification

Use a reusable boolean task for each input/output/tool check, passing the artifact,
relevant policy and evidence in the state. Name the question so the polarity is
clear, for example `violatesPolicy`, rather than an ambiguous `safe`.

```ts
const verify = createDecisionTask(model, { questions: {
  violatesPolicy: booleanQuestion('Does the proposed response violate the supplied policy?', {
    true: 'At least one concrete policy violation is supported by the response',
    false: 'The proposed response complies with every applicable supplied rule',
  }),
} })
const check = await verify.evaluate({ policy: 'Do not disclose internal access tokens.', response: 'Hello!' })
const verdict = gateBoolean(check.answers.violatesPolicy, { falseMax: 0.1, trueMin: 0.8 })
// accepted false: continue; accepted true: block; abstained: review/fallback.
```

Transport/auth failures throw; they do not become a semantic negative. The host
sets failure behavior. Decision checks supplement deterministic permission and
schema checks; the gate itself executes no action. For citations, supply both the
claim and source passage. For tool selection, validate tool arguments separately.

### Rerank a shortlist or match entities

For a runnable example combining access/date filtering, per-facet document
selection and OpenAI answers with exact source quotes, see the
[document-selection sample](../../samples/decision-document-selection/README.md).
It also handles historical policies and abstains when evidence is incomplete.

Use one state per candidate so relevance scores do not depend on which other
candidates happen to share a request. Keep candidate IDs in the host array.

```ts
const relevance = createDecisionTask(model, { questions: {
  relevant: booleanQuestion('Does this passage directly answer the query?', {
    true: 'Contains information sufficient to answer the query',
    false: 'Only shares a topic or lacks the needed information',
  }),
} })
const candidates = [
  { id: 'a', text: 'Refunds are processed in five business days.' },
  { id: 'b', text: 'Our logo is blue.' },
]
const rows = await relevance.evaluateBatch(candidates.map(candidate => ({
  query: 'When will my refund arrive?', passage: candidate.text,
})), { concurrency: 4, timeoutMs: 15_000 })
const ranked = rows.flatMap((row, index) => {
  if (row.status !== 'fulfilled') return [] // Record failures separately; do not score them as zero.
  const answer = row.value.answers.relevant
  if (answer.probabilitySource !== 'provider' || answer.probabilityTrue === undefined) return []
  return [{ candidate: candidates[index]!, score: answer.probabilityTrue, result: row.value }]
}).sort((a, b) => b.score - a.score)
```

Retrieval produces the shortlist first; reranking cannot recover missing candidates.
Use this pattern for record linkage by supplying two candidate records and a fixed
match rubric. Prefer a labeled evaluation set to interpreting a raw probability
as a guaranteed match rate. The batch preserves order, partial failures and actual
model IDs. Configure its overall deadline for the entire queue, not just one call.

### Staged decisions and model fallback

The host can first call a routing task, gate its evidence, then call a specialized
task with `{ originalState, selectedRoute }`. For an uncertain result, explicitly
invoke another configured decision handle or an existing generation model. Treat
semantic abstention separately from network failure. Never silently relabel an
auth/configuration failure as uncertainty. Keep each stage's result for audit.

For a taxonomy, bound depth, model calls and time; optional beam search explores
several probable branches rather than only the first winner. For candidate
extraction, let deterministic parsing produce candidates, select among their IDs,
and verify the chosen value in a second stage. Include `none`/`other` where absence
is valid. Split independent work into batches; keep dependencies sequential.

## Provider and environment choices

| Consumer | Setup |
| --- | --- |
| Node service / agent tool | Lazy `envCredential`, shared runtime/tasks, per-request signal/context |
| Browser app | Server endpoint holding the key; inject a server-side task behind it |
| Worker / edge runtime | Inject a key from the host's secret binding or a `CredentialSource`; use Web fetch |
| Local/self-hosted API | Adapter with `baseUrl`, injected transport, explicit HTTP opt-in for local development |
| Multiple accounts/endpoints | Multiple TypeSafe plugins with distinct `id` and `routes`; bind a task to each route |
| Unit tests / offline execution | Register a deterministic `DecisionAdapter` or inject mocked fetch; keep the same task/gate code |

Credential resolution follows the underlying adapter: TypeSafe resolves per physical
attempt; prepared LLM adapters may capture credentials once per logical call.
An explicitly configured provider retry policy overrides the runtime default;
TypeSafe inherits the runtime policy when omitted. Choose one retry owner to avoid compounded attempts. Cancellation
bounds scheduling and waiting; it does not undo provider processing or host actions.
No batch cache, automatic fallback, model-specific calibration, business side effects,
or streaming dataset ingestion is implied by this package.

See TypeSafe's [confidence explanation](https://docs.typesafe.ai/confidence) for
the distribution statistic behind Choice/Score confidence. A Boolean's probability
near 0.5 is uncertain; it has no native separate confidence. The kit preserves raw
evidence and requires explicit gates rather than fabricating a shared metric.

## Use an LLM for the same tasks

Wrap `openAiAdapter`, `anthropicAdapter`, `geminiAdapter` or another SDK model
adapter in `llmDecisionPlugin`. The [LLM setup example](./README.md#openai-anthropic-and-gemini-decisions)
registers all three. Keep the rubric and batch/workflow code; change the target
provider/model to select the implementation. Different providers can coexist with
TypeSafe in the same decision runtime.

Use JSON Schema by default, or select the tool mode for a compatible endpoint.
Generation must finish successfully before its answer is accepted; a partially
valid answer cut off by the token limit is rejected. No format repair or automatic
fallback is hidden in the adapter. Host cascades can explicitly catch failures or
handle abstention and invoke a different configured task.

LLM decisions default to values without confidence. For a routing policy that
needs raw evidence, prefer a provider that supplies it, or explicitly opt into
`evidence: 'model-generated'` and validate its behavior on your dataset. Existing
gates abstain on absent evidence and disallow these self-reported estimates by
default. Configuring structured output does not turn an LLM into a calibrated
native decision model. A batch may span an alias update; pinned IDs and per-stage
records help evaluation, while response model IDs are unavailable on this bridge.
