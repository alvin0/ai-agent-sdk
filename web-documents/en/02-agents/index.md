# Agents — Overview

An agent is a **frozen declaration** of identity and policy. It is not a
connection, a conversation, or a process.

Three objects, three lifetimes:

| Object | Lifetime | Owns |
| --- | --- | --- |
| `AgentRuntime` | Process or request scope | Providers, observability, operation leases, close reports |
| `RuntimeAgent` / `DefinedAgent` | Module scope, frozen | Identity, instructions, model route, capabilities |
| `RuntimeAgentSession` | One conversation | History, memory, activated skills, exclusion lock |

## Two authoring styles

**Runtime binding** — the composition root creates the agent:

```ts
const runtime = await createAgentRuntime({ providers: [openAiPlugin({ apiKey })] })

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'gpt-5.4' },
})
```

**Reusable definition** — identity and policy captured once at module scope:

```ts
export const assistant = defineAgent({
  id: 'assistant',
  instructions: 'Be concise.',
  provider: 'openai',
  model: 'gpt-5.4',
})

const session = assistant.createSession({ registry })
```

A definition is validated, normalized, and **frozen**. It is safe to export from
a module and reuse across requests. Definitions never mutate — derive with
`.with()` for a local variant, or `cloneAgent()` when the derived agent needs a
new stable identity.

## Three ways to run one

```ts
await agent.generate(input)          // stateless one-shot
agent.stream(input)                  // live event stream
agent.createSession().run(input)     // stateful conversation
```

`generate()` drains the same stream `stream()` exposes. There is no separate
non-streaming path.

## In this chapter

| Page | Answers |
| --- | --- |
| [Creating an Agent](/en/02-agents/creating-an-agent) | Every field on an agent, and how the model route resolves |
| [Agent Instructions](/en/02-agents/agent-instructions) | Where instructions go, who has authority, per-run additions |
| [Agent Context](/en/02-agents/agent-context) | What actually reaches the model on each request |
| [Structured Output](/en/02-agents/structured-output) | Plain text and provider-backed JSON Schema responses |
| [Streaming](/en/02-agents/streaming) | The run handle and every event it emits |
| [Lifecycle](/en/02-agents/lifecycle) | Startup, turn hooks, cancellation, close evidence |
