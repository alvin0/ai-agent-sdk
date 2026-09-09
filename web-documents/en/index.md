---
title: AI Agent SDK
---

# AI Agent SDK

> A provider-neutral TypeScript SDK for building AI agents.

One message model, one streaming protocol, one error taxonomy — across the
Anthropic Messages API, the OpenAI Responses API, and the ChatGPT-backed Codex
endpoint.

```bash
pnpm add @alvin0/ai-agent-sdk-core @alvin0/ai-agent-sdk-provider-openai @alvin0/ai-agent-sdk-auth-node
```

```ts
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'

const runtime = await createAgentRuntime({
  providers: [openAiPlugin({ apiKey: envCredential('OPENAI_API_KEY') })],
})

const agent = runtime.agent({
  id: 'assistant',
  instructions: 'Be concise.',
  model: { provider: 'openai', id: 'gpt-5.4' },
})

console.log((await agent.generate('Explain a Merkle tree in one sentence.')).text)
await runtime.close()
```

## Start here

| I want to… | Read |
| --- | --- |
| Install and run something today | [1. Introduction](/en/01-introduction/) → [Installation](/en/01-introduction/installation), [Quick Start](/en/01-introduction/quick-start) |
| Build an agent | [2. Agents](/en/02-agents/) |
| Give it typed functions | [3. Tools](/en/03-tools/) |
| Give it progressively disclosed knowledge | [4. Skills](/en/04-skills/) |
| Keep continuity across long tasks | [5. Memory](/en/05-memory/) |
| Coordinate several steps or agents | [6. Workflows](/en/06-workflows/) |
| Consume or publish MCP tools | [7. MCP](/en/07-mcp/) |
| Talk to agents in other services | [8. A2A](/en/08-a2a/) |
| Point the SDK at a model endpoint | [9. Providers](/en/09-providers/) |
| Ship it to production | [10. Advanced](/en/10-advanced/) |
| Understand the internals | [11. Internals](/en/11-internals/) |
| Know what might still change | [12. Experimental](/en/12-experimental/) |
| Look up an exact export | [13. API Reference](/en/13-api-reference/) |
| Contribute, test, or check the license | [14. Project](/en/14-project/) |

## Three levels of API

The SDK is deliberately layered. Start at the top and descend only when you need
to own a boundary yourself.

| Level | Entry point | Owns |
| --- | --- | --- |
| Composition root | `createAgentRuntime()` | Providers, observability, lifecycle, close reports |
| Reusable definition | `defineAgent()` + `createSession()` | Agent identity, policy, conversation state |
| Raw loop | `runAgent()`, `runTurn()`, `ModelRegistry.stream()` | Every execution boundary, explicitly |

See [Getting Started](/en/01-introduction/getting-started) for how to choose.

## Status

Version `0.1.0`, licensed under MIT. Registry publication is intentionally
deferred while npm ownership is being arranged — see
[Experimental](/en/12-experimental/) and
[Project Information](/en/14-project/).
