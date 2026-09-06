# Creating an Agent

## `runtime.agent()`

```ts
const agent = runtime.agent({
  // Identity
  id: 'reviewer',
  name: 'Release Reviewer',
  description: 'Reviews release candidates and reports concrete risks.',

  // Model route
  model: { provider: 'openai', id: 'gpt-5.4' },
  effort: 'medium',
  maxTokens: 16_384,
  outputFormat: { type: 'text' }, // or a named JSON Schema for the final answer

  // Behaviour
  instructions: 'Review carefully and cite evidence.',
  mode: 'basic',                 // 'basic' | 'deep' | 'deep-human-in-loop'
  commentary: 'concise',         // 'auto' | 'concise' | 'off'
  maxTurns: 16,
  maxToolCalls: 64,

  // Capabilities
  tools: [readFile],
  nativeTools: [{ type: 'native', name: 'web-search' }],
  toolChoice: 'auto',
  toolSources: [mcpConnection],
  skills: [skillProvider],
  allowedSkillIds: ['release-review'],

  // Continuity
  memory: memoryBinding,
  compaction: { thresholdRatio: 0.8, retainRatio: 0.2 },
})
```

### Every field

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | **Required.** Stable identity; emitted on trace spans. |
| `name` | `string` | Human label for GUIs and A2A Agent Cards. |
| `description` | `string` | Used by `createAgentCardFromDefinition()` and team rosters. |
| `model` | `{ provider, id? }` | Route. `id` may be omitted when the provider has a configured default. |
| `instructions` | `string` | **Required** on a definition. See [Agent Instructions](/en/02-agents/agent-instructions). |
| `effort` | `string` | Reasoning effort. Validated against the model's declared efforts. |
| `maxTokens` | `number` | Output ceiling. Checked against the model's hard limit before provider I/O. |
| `outputFormat` | `ModelOutputFormat` | Plain text or a named JSON Schema for the final answer. |
| `mode` | `'basic' \| 'deep' \| 'deep-human-in-loop'` | Execution policy. |
| `commentary` | `'auto' \| 'concise' \| 'off'` | Progress narration. |
| `maxTurns` | `number` | Model steps. Default 16. |
| `maxToolCalls` | `number` | Dispatched tools. Default 64. |
| `tools` | `ToolDefinition[]` | Host functions the scheduler executes. |
| `nativeTools` | `NativeToolSchema[]` | Provider-executed. The scheduler never runs these. |
| `toolChoice` | `ToolChoice` | Forced/auto/none tool selection. |
| `toolSources` | `ToolSource[]` | Whole catalogs, e.g. an MCP connection. |
| `skills` | `RuntimeSkillSource[]` | Progressively disclosed capabilities. |
| `allowedSkillIds` | `string[]` | Authorization boundary, not an activation list. |
| `memory` | `MemoryBinding` | Durable task memory. |
| `compaction` | `AgentCompactionOptions \| false` | Context checkpoint policy. |

## `defineAgent()`

The same model expressed as a frozen module-scope value. Note the flatter model
fields:

```ts
export const ada = defineAgent({
  id: 'ada',
  name: 'Ada',
  description: 'Explains and reviews TypeScript code.',
  instructions: 'Be precise, inspect evidence before concluding, and keep answers concise.',
  provider: 'codex',
  model: 'gpt-5.6-luna',
  effort: 'medium',
  mode: 'basic',
  maxTurns: 16,
  maxToolCalls: 64,
  commentary: 'concise',
})
```

Omitting `provider`, `model`, and `effort` on a definition selects Codex
`gpt-5.6-luna` at `medium` effort. That is an explicitly reviewed and approved
default, not an implicit fallback — and it applies **only** to `defineAgent()`.

## How the model route resolves

```text
model: { provider: 'openai', id: 'gpt-5.4' }   → exact route + exact model
model: { provider: 'openai' }                   → route's configured default model
model omitted                                   → runtime's selected or unique-default provider
defineAgent() with no provider/model            → Codex gpt-5.6-luna, effort medium
```

There is otherwise **no default model**. Provider lineups turn over faster than
this package's release cadence, so any built-in default would eventually name a
retired model.

Multiple accounts of the same provider family compose through explicit instance
IDs and routes, so `{ provider: 'openai-eu' }` and `{ provider: 'openai-us' }`
are unambiguous.

## Deriving agents

Definitions never mutate.

```ts
// Local variant, same identity:
const deepAda = ada.with({ mode: 'deep', maxTurns: 24 })

// Derived agent with a NEW stable identity:
const reviewer = cloneAgent(ada, {
  id: 'reviewer',
  name: 'Reviewer',
  instructions: 'Find correctness risks and cite the relevant evidence.',
})
```

Use `.with()` for a temporary policy change; use `cloneAgent()` when the derived
agent will appear in traces, team rosters, or snapshots under its own name. A
session snapshot records the agent id, and resuming with a different id fails
early.

## Validation happens before provider I/O

`ModelRegistry` snapshots each adapter's declared capabilities and rejects an
impossible selection **before** any network call:

| Selection | Rejected with |
| --- | --- |
| Unsupported reasoning effort | `UNSUPPORTED_REASONING_EFFORT` |
| Unsupported native tool | `UNSUPPORTED_NATIVE_TOOL` |
| `maxTokens` above the hard ceiling | `OUTPUT_TOKEN_LIMIT_EXCEEDED` |
| Unknown provider route | `NO_ADAPTER` |

These cost nothing — no request is sent.

## Creating a session

```ts
const session = agent.createSession({
  conversationId: 'thread-42',
  tools: [extraTool],            // combined with definition-owned tools
  toolSources: [requestScopedMcp],
  skills: [requestScopedSkills],
  memory: false,                 // disable memory for this session
  skillCwd: process.cwd(),
  userInput: broker,             // required for 'deep-human-in-loop'
  approvals: approvalBroker,
  interceptors: [auditInterceptor],
  hooks: turnHooks,
  usagePolicy,
  historyLimits: { maxEntries: 5_000, maxBytes: 32 * 1024 * 1024 },
  ledgerLimits: { maxSerializedBytes: 8 * 1024 * 1024 },
  eventBufferLimits: { maxEvents: 2_000, maxBytes: 4 * 1024 * 1024 },
  runtimeLimits: { maxTotalTokens: 250_000, maxToolResultBytes: 1_048_576 },
  compaction: { thresholdRatio: 0.75 },
})
```

Session-level `tools` are **combined** with definition-owned tools, not replaced.
Session-level `compaction` and `runtimeLimits` override the definition. History,
ledger, and event-buffer limits bound each session's retained working set.

## Read next

- [Agent Instructions](/en/02-agents/agent-instructions)
- [Agent Context](/en/02-agents/agent-context)
- [`Agent` API reference](/en/13-api-reference/agent)
