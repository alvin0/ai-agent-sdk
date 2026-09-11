# What is Agent SDK?

AI Agent SDK is a TypeScript SDK for building AI agents that is neutral about
which model provider you use. It gives you one message model, one streaming
protocol, and one error taxonomy across the Anthropic Messages API, the OpenAI
Responses API, and the ChatGPT-backed Codex endpoint.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({ providers: [openAiPlugin({ apiKey })] })
const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'gpt-5.4' },
})

console.log((await agent.generate('Explain a Merkle tree in one sentence.')).text)
await runtime.close()
```

## What it gives you

**A neutral vocabulary.** Messages, content blocks, stream chunks, token usage,
finish reasons, and error codes are defined once in `@alvin0/ai-agent-sdk-core`.
Adapters are the only layer that knows a wire format; everything above speaks
the neutral vocabulary.

**A real agent loop.** Immutable history, staged tool dispatch, bounded parallel
scheduling, approvals, durability checkpoints, forced-final answers, and a
backpressured event stream — not a `while` loop around a chat completion call.

**Capability packages, not a monolith.** Twenty-three packages, each with a declared
runtime tier. An Edge worker installs three packages; a Node coding harness
installs six. Importing a Node capability elevates only that application's
reachable graph — it does not swap in a different harness implementation.

**Streaming-only by design.** There is no separate non-streaming path that could
drift from the streaming one. When you want a single value, you await the
assembled message.

## What it deliberately is not

- **Not a control plane.** It supplies bounded state, TTL, cancellation, error
  sanitization, and policy hooks. Authentication middleware, durable stores,
  rate limiting, secrets, deployment, and telemetry backends stay with the
  embedding service.
- **Not a tenancy or billing system.** Every limit is a deployment-neutral
  resource guard, not a product concept.
- **Not opinionated about your model.** `model` is required and has no default.
  Provider lineups turn over faster than this package's release cadence, so any
  built-in default would eventually name a retired model.
- **Not a plugin container.** There is no catch-all `plugins` array and no
  global Node facade. Capabilities are typed slots on explicit composition.
- **Not a declarative workflow engine.** There is no `defineWorkflow()`. Agents,
  tools, teams, and hooks are the orchestration primitives — see
  [Workflows](/en/06-workflows/).

## The shape of every program

```ts
// 1. Compose a runtime from explicit capability packages.
const runtime = await createAgentRuntime({ providers: [/* … */] })

// 2. Bind an agent: identity, instructions, model route, capabilities.
const agent = runtime.agent({ id: 'assistant', instructions: '…', model })

// 3. Run it — one shot, or as a live event stream.
const response = await agent.generate('…')

// 4. Close it and read the evidence.
const report = await runtime.close()
```

Everything else in this documentation is a variation on those four steps.

## Read next

- [Getting Started](/en/01-introduction/getting-started) — how the SDK is
  layered, and which layer you should use.
- [Installation](/en/01-introduction/installation) — pick the smallest runtime
  closure your deployment needs.
- [Quick Start](/en/01-introduction/quick-start) — a working agent with one tool.
