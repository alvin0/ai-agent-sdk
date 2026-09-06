# `Tool`

Import from `@ai-agent-sdk/core`; tool-source authoring lives on
`@ai-agent-sdk/core/tools`.

## `defineTool`

```ts
defineTool<Args>(definition: ToolDefinition<Args>): ToolDefinition<Args>
```

```ts
interface ToolDefinition<Args = unknown> extends ToolSchema {
  name: string
  description: string
  parameters: JsonSchema

  parse?:             (raw: unknown) => Args
  execute:            (args: Args, ctx: ToolRunContext) => Promise<JsonValue | void> | JsonValue | void
  render?:            (value: JsonValue | undefined, args: Args) => readonly ContentBlock[]
  meta?:              (value: JsonValue | undefined, args: Args) => JsonObject | undefined
  timeoutMs?:         number
  isConcurrencySafe?: (args: Args) => boolean
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | ✓ | Stable; appears in history, traces, approval prompts |
| `description` | ✓ | Prompt engineering — tells the model *when* to call |
| `parameters` | ✓ | Plain JSON Schema, sent to the provider verbatim |
| `parse` | — | Trust boundary. A throw → `INVALID_ARGUMENTS` the model can correct |
| `execute` | ✓ | Returns lossless JSON, or nothing |
| `render` | — | Defaults to: string verbatim, else pretty-printed JSON |
| `meta` | — | UI metadata; the model **never** sees it |
| `timeoutMs` | — | Never sent to the model. Asserts `execute` forwards `ctx.signal` |
| `isConcurrencySafe` | — | **Fail-closed**: only exact `true` opts into parallel |

## `ToolRunContext`

```ts
interface ToolRunContext {
  readonly callId: ToolCallId     // provider-issued id for this call
  readonly toolName: string
  readonly turn: number           // 1-based turn in the conversation
  readonly step: number           // 1-based step within the turn
  readonly signal: AbortSignal
  readonly logger?: SdkLogger     // always present on AgentRuntime paths

  concludeTurn(): void
  addContext(content: string | readonly ContentBlock[]): void
}
```

## Results

```ts
type ToolExecutionResult = ToolSuccess | ToolFailure

interface ToolSuccess {
  readonly isError: false
  readonly value: JsonValue | undefined
  readonly content: readonly ContentBlock[]
  readonly meta?: JsonObject
  readonly additionalContext?: readonly ContentBlock[]
  readonly concludesTurn?: true
}

interface ToolFailure {
  readonly isError: true
  readonly error: { readonly message: string; readonly code: string }
  readonly content: readonly ContentBlock[]
  readonly meta?: JsonObject
  readonly additionalContext?: readonly ContentBlock[]
  readonly concludesTurn?: never          // a failure can NEVER end the turn
}
```

## Scheduling

```ts
type ToolExecutionMode = 'parallel' | 'exclusive'
```

Defaults to `exclusive`. A throwing or absent `isConcurrencySafe` classifier also
means exclusive, because the failure mode of guessing wrong is silent data
corruption rather than a visible error.

## Approvals

```ts
createApprovalBroker(options?: InteractiveApprovalBrokerOptions): InteractiveApprovalBroker
fixedApprovalBroker(decision: ApprovalDecision): ApprovalBroker
```

Types: `ApprovalBroker`, `ApprovalDecision`, `ApprovalRequest`,
`InteractiveApprovalBroker`, `InteractiveApprovalBrokerOptions`.

A rejected call becomes a `ToolFailure` with run-event `status: 'rejected'`.

## Tool sources — `@ai-agent-sdk/core/tools`

```ts
export { defineToolSource, TOOL_SOURCE_API_VERSION }
export type {
  ToolCatalogSnapshot, ToolSource, ToolSourceDefinition,
  ToolSourceRunReference, ToolSourceSnapshotOptions, ToolSchema,
}
```

A `ToolSource` publishes a whole catalog. Snapshots are **synchronous and
atomic** — one revision binds both schema and execution — and terminal evidence
carries source and revision only.

## Native tools

Declared on `nativeTools`, **not** `tools`, so the scheduler never tries to
execute them:

```ts
type NativeToolSchema = NativeWebSearchTool | NativeImageGenerationTool
type NativeToolName = 'web-search' | 'image-generation'

{ type: 'native', name: 'web-search', allowedDomains?: string[] }
{ type: 'native', name: 'image-generation', format?: string, partialImages?: number }
```

`ModelRegistry` rejects an unsupported native tool with
`UNSUPPORTED_NATIVE_TOOL` **before** provider I/O.

## Interceptors

```ts
const session = agent.createSession({ interceptors: [async (call, next) => next(call)] })
```

`ToolInterceptor` wraps dispatch. Interceptors are captured with their original
receivers, so a method taken off an object keeps its `this`.

## Bounds

| Bound | Default |
| --- | --- |
| `maxToolCalls` | 64 per run |
| `maxToolResultBytes` | Bounded retained serialized result |
| `maxToolDurationMs` | Per-call wall clock |
| `toolTeardownTimeoutMs` | Wait after cancelling an uncooperative tool |
| `maxConsecutiveToolErrors` | Cutoff |
| `maxParallel` | Simultaneous concurrency-safe calls |

## Read next

- [Agent](/en/13-api-reference/agent) · [Types](/en/13-api-reference/types)
- [Creating a Tool](/en/03-tools/creating-a-tool) — the narrative version
