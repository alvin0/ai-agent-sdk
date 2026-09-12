---
name: ai-agent-sdk
description: Build and maintain applications with the @alvin0/ai-agent-sdk-* TypeScript SDK — generation and embeddings, runtime composition, agents, sessions, streaming, tools, structured output, progressive-disclosure skills, task memory and compaction, multi-agent orchestration, MCP, A2A, observability, testing, releases, and deployment to Node, Edge/Worker, or the browser. Use when writing or reviewing code that imports any @alvin0/ai-agent-sdk-* package, choosing an install profile, or validating this SDK repository for release.
---

# ai-agent-sdk

Provider-neutral TypeScript SDK for generation and embedding workloads. One
message model, one public streaming protocol, and stable error taxonomies across
Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, ChatGPT-backed
Codex, GitHub Copilot, and Gemini Interactions.

## Read this first — five facts that prevent most wrong code

1. **Streaming-only.** `generate()` drains the same stream `stream()` exposes.
   There is no separate non-streaming call.
2. **`model` is required.** No default model exists, except `defineAgent()` with
   `provider`/`model`/`effort` all omitted, which selects Codex `gpt-5.6-luna`
   at `medium` effort.
3. **Credentials are injected.** Provider packages are Universal and never read
   env vars or files. `envCredential()` from `@alvin0/ai-agent-sdk-auth-node` is
   the Node wrapper that does.
4. **No workflow engine.** `defineWorkflow`, `createWorkflow` and `WorkflowStep`
   do not exist. Control flow is ordinary TypeScript over agent primitives.
5. **`runtime.close()` returns evidence, not a formality.** `unsettledRuns > 0`
   means something ignored cancellation.

## Minimal working program

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

Model IDs above are illustrative. Use an ID your endpoint actually serves.

## Which reference to open

Load only the file the task needs. Each is self-contained.

| Task | File |
| --- | --- |
| Pick packages, install profile, runtime tier, credentials | [references/packages.md](references/packages.md) |
| `createAgentRuntime`, `runtime.agent`, `defineAgent`, sessions, hooks, close | [references/runtime-and-agents.md](references/runtime-and-agents.md) |
| Stream events, render a live UI, cancellation, `stopReason` | [references/streaming.md](references/streaming.md) |
| `defineTool`, `ToolRunContext`, parallelism, approvals, user input | [references/tools.md](references/tools.md) |
| Force JSON output with a schema | [references/structured-output.md](references/structured-output.md) |
| Progressive-disclosure skills the model loads on demand | [references/skills.md](references/skills.md) |
| Task memory, compaction, snapshots, resume | [references/memory.md](references/memory.md) |
| Multi-step flows, agent teams, `mode: 'deep'`, human gates | [references/orchestration.md](references/orchestration.md) |
| Point the SDK at a new endpoint, or author a provider | [references/providers.md](references/providers.md) |
| `runtime.embeddingModel()`, `embed()`, `embedMany()`, embedding providers, `Space_Id` | [references/providers.md](references/providers.md) |
| Instructions, always-on moving context, `AGENTS.md` files | [references/context-and-instructions.md](references/context-and-instructions.md) |
| Messages, content blocks, images and vision, PDF/document input | [references/messages-and-content.md](references/messages-and-content.md) |
| Turn limits, token budgets, usage coverage, oversized tool output | [references/budgets-and-usage.md](references/budgets-and-usage.md) |
| Consume or publish MCP tools | [references/mcp.md](references/mcp.md) |
| Remote agents over A2A, agent cards | [references/a2a.md](references/a2a.md) |
| Traces, logs, exporters, correlation ids | [references/observability.md](references/observability.md) |
| Error codes, retry policy, what each failure means | [references/errors.md](references/errors.md) |
| Test an agent or embedding provider without a live endpoint | [references/testing.md](references/testing.md) |
| Validate repository CI, package versions, tarballs, or a release | [references/testing.md](references/testing.md) |
| Something is wrong and you want the cause | [references/troubleshooting.md](references/troubleshooting.md) |
| Ship to Node CLI, Edge/Worker, or browser | [references/deploy.md](references/deploy.md) |

## Import routes

`@alvin0/ai-agent-sdk-core` is a curated re-export-only facade. Subpaths are
views over the same implementation, never copies.

| Specifier | Audience |
| --- | --- |
| `@alvin0/ai-agent-sdk-core` | Applications |
| `.../core/agent` | Agent authoring, low-level loop, `defineSkill`, teams |
| `.../core/provider` | Provider and credential authors |
| `.../core/tools` | Tool-source authors |
| `.../core/skills` | Skill-provider authors |
| `.../core/memory` | Memory-store authors |
| `.../core/embedding` | Embedding adapter authors, and callers who need the contract beyond the handle: request/result vocabulary, profile and `Space_Id`, catalog, batch limits, `EMBEDDING_ERROR_CODES` |
| `.../core/observability` | Observation bus and exporter authors |

Application code should reach for `AgentRuntime` rather than the low-level
registry/plugin assembly that remains reachable at the root.

## Traps that cost the most time

Each of these is a real type error, not a style preference. The reference files
carry the fix; this is the index.

| Symptom | Where |
| --- | --- |
| `apiKey: () => token` gives an unassignable plugin | references/packages.md |
| `registerAdapter` argument order differs by receiver | references/providers.md |
| `runtime.agent(definedAgent)` does not type-check | references/context-and-instructions.md |
| `resource: { runtime: 'edge' }` is not a field | references/observability.md |
| `session.memory` / `session.skills` missing | references/runtime-and-agents.md |
| Memory `revision` is a string; scope needs `namespace` | references/memory.md |
| Two different skill-provider contracts | references/skills.md |
| Two different exporter shapes | references/observability.md |
| `createSdkMcpHandler({ tools })` wants a `ToolCatalog` | references/mcp.md |

## Where the prose docs and the typings disagree

`web-documents/en/**` (81 pages, mirrored in `vi/`) carries the reasoning behind
the design. These references carry what compiles: every imported name here is
checked against the built `.d.ts` files and the code paths are compiled under
`--strict`. In a handful of places the narrative docs describe an older shape —
memory stores and scopes, the two skill-provider contracts, the credential
overloads, `resource`, `McpCloseReport`, the browser observability lifecycle,
`registerAdapter` argument order, and `runtime.agent(definedAgent)`. The
references follow the **typings** there and flag the difference inline. Trust
these files over the prose when writing code.
