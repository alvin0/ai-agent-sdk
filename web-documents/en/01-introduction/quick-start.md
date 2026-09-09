# Quick Start

This page builds a working agent with one tool, then shows the same agent as a
reusable definition.

## 1. Compose a runtime

`createAgentRuntime()` is the recommended composition root. It owns provider
registration, observability, and lifecycle.

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})
```

## 2. Define a tool

Tools are ordinary typed values. There is no second string-id registry to keep
in sync.

```ts
import { defineTool } from '@alvin0/ai-agent-sdk-core'

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
```

`parse` is the boundary between untrusted model output and your typed code. It
runs before `execute` and its failure is reported to the model as a tool error,
not as a crash.

## 3. Bind and run an agent

```ts
const agent = runtime.agent({
  id: 'calculator',
  name: 'Calculator',
  instructions: 'Use the available tools and explain the result briefly.',
  model: { provider: 'openai', id: 'gpt-5.4' },
  tools: [multiply],
})

const response = await agent.generate('What is 21 * 2?')
console.log(response.text)
console.log(response.usage)
```

## 4. Keep a conversation

`generate()` is stateless. For a chat, create a session — it owns history and
prevents overlapping runs on the same conversation.

```ts
const session = agent.createSession()

await session.run('What is 21 * 2?')
await session.run('Now multiply that by 10.')   // remembers the previous turn

console.log(session.conversationId)
```

## 5. Close the runtime

```ts
const report = await runtime.close()
console.log(report.state, report.activeRunsAtClose, report.unsettledRuns)
```

`close()` quiesces active runs, closes owned components, and returns structured
evidence. It is not a formality — a report with `unsettledRuns > 0` means
something ignored cancellation.

## The reusable-definition style

`defineAgent()` captures identity and policy once, at module scope, and produces
sessions per conversation. Use it when the same agent serves many requests.

```ts
import { defineAgent } from '@alvin0/ai-agent-sdk-core'

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
```

A definition is validated, normalized, and frozen. It is safe to export from a
module and reuse across requests. Definitions never mutate — derive with
`.with()` for a local variant, or `cloneAgent()` when the derived agent needs a
new stable identity.

Omitting `provider`, `model`, and `effort` on a definition selects Codex
`gpt-5.6-luna` at `medium` effort.

## Full working file

```ts
import { createAgentRuntime, defineTool } from '@alvin0/ai-agent-sdk-core'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

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

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})

try {
  const agent = runtime.agent({
    id: 'calculator',
    instructions: 'Use the available tools and explain the result briefly.',
    model: { provider: 'openai', id: 'gpt-5.4' },
    tools: [multiply],
  })

  const session = agent.createSession()
  console.log((await session.run('What is 21 * 2?')).text)
  console.log((await session.run('Now multiply that by 10.')).text)
} finally {
  await runtime.close()
}
```

## Read next

- [Streaming a model call](/en/02-agents/streaming)
- [Runtime, agents, sessions](/en/02-agents/creating-an-agent)
- [Tools](/en/03-tools/)
