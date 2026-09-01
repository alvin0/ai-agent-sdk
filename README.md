# ai-agent-sdk

A provider-neutral TypeScript SDK for building AI agents. One message model, one
streaming protocol, one error taxonomy — across the Anthropic Messages API, the
OpenAI Responses API, and the ChatGPT-backed Codex endpoint.

Streaming-only by design: there is no separate non-streaming path that could drift
from the streaming one. When you want a single value, you await the assembled
message.

## Setup

```bash
npm install
npm run build
```

Requires Node 22.6+. Scripts and tests run TypeScript directly (`node file.ts`),
so no build step is needed for development.

## Quick start

```ts
import { BlockAssembler, ModelRegistry, createTextMessage } from 'ai-agent-sdk'
import { openAiAdapter } from 'ai-agent-sdk/openai'

const registry = new ModelRegistry()
registry.registerAdapter(['openai'], openAiAdapter())   // reads OPENAI_API_KEY

const assembler = new BlockAssembler()
for await (const chunk of registry.stream({
  provider: 'openai',
  model: 'gpt-5.4',
  system: 'Be concise.',
  messages: [createTextMessage('Explain a Merkle tree in one sentence.')],
})) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
  assembler.push(chunk)
}

const reply = assembler.message({ kind: 'model', provider: 'openai', model: 'gpt-5.4' })
console.log(assembler.usage, assembler.finish)
```

`model` is required and has no default. Provider lineups turn over faster than
this package's release cadence, so any built-in default would eventually name a
retired model.

## Providers

| Entry point | Endpoint | Credential |
| --- | --- | --- |
| `ai-agent-sdk/anthropic` | Messages API | `ANTHROPIC_API_KEY` |
| `ai-agent-sdk/openai` | Responses API | `OPENAI_API_KEY` |
| `ai-agent-sdk/codex` | ChatGPT-backed Codex | device-code login |

`openai` and `codex` share one Responses implementation (`src/providers/responses/`)
and differ only by a small dialect record — base URL, auth, and which optional
fields the endpoint accepts.

### Codex: project-local login

```bash
npm run provider:codex:login-device    # sign in
npm run provider:codex:status          # check state
```

Tokens land in `.providers/.codex/auth.json` (git-ignored), **not** in the Codex
CLI's `~/.codex/auth.json`. This isolation is deliberate: OAuth refresh tokens are
single-use and rotate on every refresh, so two programs sharing one credential
file will eventually race — the second to refresh replays a spent token and the
user is silently logged out of their real Codex CLI.

```ts
import { codexAdapter } from 'ai-agent-sdk/codex'

registry.registerAdapter(['codex'], codexAdapter())
const models = await registry.listModels('codex')   // discovered from the account
```

The Codex adapter discovers its catalog from the endpoint, because the available
models depend on the account's plan. Note that this endpoint serves the Codex CLI
and identifies its client with an `originator` header; the adapter defaults to the
CLI's value so requests are accepted. Use your own account, and prefer `openai`
for production.

### Exact provider request logs

Enable the Node-only logger when debugging the wire payload sent to a provider:

```ts
import { createDailyJsonlRequestLogger } from 'ai-agent-sdk/request-logger'
import { codexAdapter } from 'ai-agent-sdk/codex'

registry.registerAdapter(['codex'], codexAdapter({
  requestLogger: createDailyJsonlRequestLogger(),
}))
```

Requests append to `.providers/<provider>/logs/YYYY-MM-DD.jsonl`. Credentials,
cookies, and account ids are redacted; request bodies are not, because prompts and
tool results are the point of this diagnostic. `.providers/` is git-ignored but
should still be treated as sensitive local data. Spike B enables this logger by
default.

## Retry

Retry is a decorator, and it only retries failures that occur **before the first
chunk reaches the consumer** — replaying delivered tokens would duplicate output.

```ts
import { withRetry } from 'ai-agent-sdk'

registry.registerAdapter(['openai'], withRetry(openAiAdapter(), {
  policy: { mode: 'normal', maxRetries: 3 },
  onRetry: attempt => console.warn(`retry ${attempt.attempt}: ${attempt.failure.code}`),
}))
```

Adapters assign a stable `code` at the wire boundary; policy decides which codes
are eligible. `AUTH`, `INVALID_REQUEST`, `QUOTA`, and `CONTEXT_WINDOW_EXCEEDED` are
excluded by default because they fail identically on every attempt.
The opt-in `mode: 'always'` is accepted only when the request carries an
`AbortSignal`; normal agent turns provide one through their model deadline, while
direct callers must supply their own cancellation boundary.

## Architecture

```
src/
├── core/                 provider-neutral; knows nothing about any vendor
│   ├── primitives/       branded ids, deep freeze, exhaustiveness
│   ├── errors/           the `code`-routed taxonomy + its serializable twin
│   ├── message/          content blocks, immutable messages, projection
│   ├── stream/           chunk protocol, assembler, SSE, idle bound
│   ├── contract/         what an adapter implements and what it receives
│   ├── runtime/          the registry that routes calls, and retry
│   └── http/             credential and attribution concerns
└── providers/
    ├── base/             the shared HTTP/SSE pipeline every provider runs through
    ├── http-provider.ts  turns a config object into an adapter
    ├── protocols/        reusable wire protocols, decoupled from any endpoint
    ├── responses/        OpenAI Responses serialize + translate
    ├── anthropic/        Messages serialize + translate, and its config
    ├── openai/           Responses on api.openai.com  (config only)
    └── codex/            Responses on the ChatGPT backend + OAuth (config only)
```

Two structural rules carry most of the weight:

- **Adapters are the only layer that knows a wire format.** Everything above
  speaks the neutral vocabulary in `core/`.
- **`stream()` lives in the base class, not in providers.** A provider supplies
  four things — `connect`, `endpointPath`, `buildBody`, `translate` — and cannot
  accidentally ship its own fetch loop that forgets attribution headers,
  mishandles abort, or invents error codes.

See [`src/providers/README.md`](src/providers/README.md) for how the adapter layer
works in detail: the pipeline, who owns error classification, throw-vs-finish-chunk
layering, where the two wire protocols genuinely differ, and how to add a provider.

## Tool loop

The agent layer includes immutable history, staged tool dispatch, bounded parallel
scheduling, approvals, durability checkpoints, forced-final answers, and a
backpressured event stream:

### Agent definitions (recommended)

Most applications should declare a reusable agent once, then create one session
per conversation. The session owns history, so callers do not have to assemble a
new `runAgent()` options object for every user turn:

```ts
import { defineAgent, defineTool } from 'ai-agent-sdk'

const multiply = defineTool({
  name: 'multiply',
  description: 'Multiply two numbers.',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  parse: value => value as { a: number; b: number },
  execute: ({ a, b }) => ({ product: a * b }),
})

export const calculator = defineAgent({
  id: 'calculator',
  name: 'Calculator',
  instructions: 'Use the available tools and explain the result briefly.',
  provider: 'openai',
  model: 'gpt-5.4',
  tools: [multiply],
})

const session = calculator.createSession({ registry })
const response = await session.run('What is 21 * 2?')
console.log(response.text)

// The same session remembers prior turns.
await session.run('Now multiply that by 10.')
```

Omitting `provider`, `model`, and `effort` selects Codex `gpt-5.6-luna` at
`medium` effort. Use `session.stream()` instead of `session.run()` when a GUI
needs live commentary, reasoning summaries, tool nodes, image deltas, and trace
events. See [`docs/agent-definitions.md`](docs/agent-definitions.md) for modes,
native tools, variants, and session ownership.

Agents can also own progressively disclosed skills. Web applications declare
portable in-memory skills with `defineSkill()` or a custom `defineSkillProvider()`;
Node CLIs discover `SKILL.md` folders through the separate
`ai-agent-sdk/skill-filesystem` entry point. Reusable definitions may declare a
strict `skillIds` allowlist over session-provided request/workflow sources without
pre-activating those skills. See the
[skills section](docs/agent-definitions.md#skills-web-definitions-and-cli-discovery)
for both setups and the discovery rules.

Definitions also enable long-task continuity by default: the original user
objective is pinned outside compactable history, and older context is replaced
with a structured handoff checkpoint near the model's context limit. See
[`docs/memory-and-compaction.md`](docs/memory-and-compaction.md).

Long-lived agents can exchange attributed messages through an `AgentTeam`.
Quiet local messages add context without waking an idle agent; wake-up messages
are queued behind an active turn and guaranteed a follow-up turn.
`createManagedAgentTeam()` gives a lead a parallel-safe `spawn_agent` tool for
Codex-style dynamic delegation, while `createDefinedAgentTeam()` connects stable
pre-defined agents and sessions. Both expose the same roster, which can link
remote peers using the official
[`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js), with Agent Card discovery,
JSON-RPC/HTTP+JSON, streaming task results, and retained A2A contexts. A
`DefinedAgent` can also be exposed through the official server request handler.
Attached models receive bound `list_agents`, `send_message`, `followup_task`, and
`wait_agents` tools by default. Production controls are capability-oriented:
hosts choose ownership, auth, endpoint, storage, and tool policies while the SDK
provides quotas, TTL, cancellation, sanitized errors, and lifecycle hooks. See
[`docs/a2a.md`](docs/a2a.md).

The SDK can also consume remote MCP tools or expose SDK tools and defined agents
as an MCP API. MCP stays in optional `mcp-client`, `mcp-server`, and Node-only
`mcp-node` entry points so web/workflow users do not inherit CLI dependencies.
See [`docs/mcp.md`](docs/mcp.md) and run `npm run human:mcp` for a credential-free
protocol round trip.

### Low-level loop

Use `runTurn()` when the application needs to own history and every execution
boundary directly:

```ts
import { History, ToolRegistry, defineTool, createTextMessage, runTurn } from 'ai-agent-sdk'

const history = new History()
history.append({ kind: 'user', message: createTextMessage('What is 21 * 2?') })

const tools = new ToolRegistry()
tools.register(defineTool({
  name: 'multiply',
  description: 'Multiply two numbers.',
  parameters: { type: 'object' },
  parse: value => value as { a: number; b: number },
  execute: ({ a, b }) => ({ product: a * b }),
  isConcurrencySafe: () => true,
}))

for await (const event of runTurn({
  registry,
  config: { provider: 'openai', model: 'gpt-5.4' },
  history,
  tools,
  commentary: 'concise',
  trace: { agentId: 'calculator', agentName: 'Calculator' },
})) {
  if (event.type === 'assistant-reasoning') console.log('[reasoning]', event.text)
  if (event.type === 'assistant-text' && event.phase === 'commentary') console.log('[progress]', event.text)
  if (event.type === 'assistant-text' && event.phase === 'final-answer') console.log('[answer]', event.text)
  if (event.type === 'turn-end') console.log(event.outcome)
}
```

For a ready-made execution policy, use `runAgent()` above `runTurn`:

```ts
import { createUserInputBroker, runAgent } from 'ai-agent-sdk'

const userInput = createUserInputBroker()

for await (const event of runAgent({
  mode: 'deep-human-in-loop', // also: 'basic' or 'deep'
  registry,
  // config omitted: defaults to Codex gpt-5.6-luna, reasoning effort medium
  history,
  tools,
  userInput,
  maxTurns: 8,
})) {
  if (event.type === 'user-input-request') {
    // Later, resume by the exact provider call id. Answers may select a suggested
    // option or contain free-form feedback.
    const response = await askInGui(event.request)
    userInput.resolve(event.request.requestId, response)
  }
  if (event.type === 'agent-end') console.log(event.outcome)
}
```

`basic` uses tools within the configured turn budget. `deep` keeps comparing tool
evidence with the objective until its structural `submit_result` self-check is
accepted. `deep-human-in-loop` adds the blocking `request_user_input` boundary;
the event carries 2-3 suggested choices and always permits a free-form answer.

The loop is safe for unattended SDK use by default: 16 model steps, 64 dispatched
tools, per-call/model byte and time limits, exact-repeat detection, short
multi-step cycle detection, consecutive-error cutoff, and a 500,000 aggregate
reported-token ceiling. Exhaustion normally reserves one tool-disabled final
answer; token exhaustion stops immediately so the safety budget cannot spend
itself explaining that it was reached. These are SDK policies, not tenancy,
billing, or deployment-control-plane features, and every threshold is host
configurable.

`commentary: 'concise'` asks the model for short, user-visible progress narration
before tools and after results. This is deliberately separate from reasoning:
`assistant-reasoning` contains only reasoning summary/content the provider actually
emitted, while `assistant-text` is public text classified as `commentary` or
`final-answer`. Its `timing` is one of `before-tools`, `after-tools`,
`between-tools`, or `standalone`, and its tool-call id arrays make GUI linking
direct rather than heuristic. Use `commentary: 'auto'` to leave narration to the
model, or `'off'` to request only the final answer.

Every model and tool event carries `traceId`, `spanId`, and `parentSpanId` through
its `trace` field. Explicit `span-start` / `span-end` events use W3C-sized ids and
`buildTraceTree()` projects them into an immutable Foundry-style process tree for
GUI call graphs. Tool call ids remain correlation ids; parallel calls to the same
tool always receive distinct span ids.

### Reasoning, native tools, and images

Reasoning effort is part of the neutral call config, while provider-executed tools
are passed separately from host functions so the scheduler never tries to execute
them:

```ts
import { ReasoningEffortId, runAgent } from 'ai-agent-sdk'

for await (const event of runAgent({
  mode: 'basic',
  registry,
  history,
  // Omit config for Codex gpt-5.6-luna with medium effort, or override it:
  config: { provider: 'openai', model: 'gpt-5.6', reasoningEffort: ReasoningEffortId('medium') },
  nativeTools: [
    { type: 'native', name: 'web-search', allowedDomains: ['openai.com'] },
    { type: 'native', name: 'image-generation', format: 'webp', partialImages: 2 },
  ],
})) {
  if (event.type === 'image-delta') renderPreview(event.data, event.mediaType)
  if (event.type === 'assistant-native-tool') renderTraceNode(event.call.id, event.call.name)
}
```

Adapters may declare combined context capacity, default/hard output limits,
reasoning efforts, modalities, and supported native tools. `ModelRegistry`
validates and snapshots those capabilities for every adapter, applies model
defaults, rejects impossible output/native-tool selections before dispatch, and
projects image input for explicitly text-only models. Automatic compaction also
reserves the selected model's output headroom rather than filling the entire
combined context window.

Image input uses the same `ImageBlock` in user messages: URL and base64 sources are
portable; Responses also accepts `{ kind: 'file', fileId }` and
`detail: 'original'`. Generated images arrive progressively through `image-delta`
and authoritatively in the final `native-tool-call.content`. Responses supports
native web search and image generation. Anthropic maps native web search, preserves
its encrypted result/citation replay state, and reports unsupported native image
generation or file-id image input as typed `INVALID_REQUEST` errors.

See [`docs/tool-loop-design.md`](docs/tool-loop-design.md) for the architecture,
bounds, checkpoint contract, and design rationale.

For manual acceptance against a real provider, use the interactive commands in
[`test-human/README.md`](test-human/README.md). They cover basic/deep/HIL modes,
host tools, native web search, image input/output, request logs, and terminal-based
human decisions.

### Adding a provider

For any endpoint speaking a protocol this package already implements, adding it is
configuration — no new file, no new folder, no edit to this package:

```ts
import { createHttpProvider, apiKeyFromEnv, openAiResponsesProtocol } from 'ai-agent-sdk'

registry.registerAdapter(['openrouter'], createHttpProvider({
  displayName: 'OpenRouter',
  protocol: openAiResponsesProtocol,
  baseUrl: 'https://openrouter.ai/api/v1',
  auth: { kind: 'bearer', token: apiKeyFromEnv('OPENROUTER_API_KEY') },
}))
```

`auth: { kind: 'dynamic' }` covers OAuth, so even a refreshing credential needs no
subclass — the built-in `codex` provider is itself only config.

Subclass `HttpModelAdapter` only when connection facts cannot be expressed as data
(request signing over the body, such as AWS SigV4). Decision table and a new-protocol
walkthrough in [`src/providers/README.md`](src/providers/README.md#adding-a-provider).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm test` | unit suite (fast, no network) |
| `npm run test:integration` | live provider calls; needs credentials |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | bundle + declarations to `dist/` |

Integration tests are a separate run because they cost tokens and are slow enough
that mixing them in would discourage running the fast suite.

## License

Apache-2.0
