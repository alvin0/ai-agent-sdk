# `Tool`

Import from `@alvin0/ai-agent-sdk-core`; tool-source authoring lives on
`@alvin0/ai-agent-sdk-core/tools`.

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
  maxOutputTokens?:   number
  budgetExempt?:      true
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
| `maxOutputTokens` | — | Estimated tokens of text this tool's result may show the model. Never sent to the model; the stricter of this and the turn budget wins |
| `budgetExempt` | — | Exempt from the turn's tool-call budget and loop guards. For calls that END work — submitting, asking, delegating. Only exact `true`; run-level ledger limits still apply |

## `defineToolFromSchema`

```ts
interface RuntimeSchema<T> {
  readonly jsonSchema: JsonObject
  readonly parse: (value: unknown) => T
}

defineToolFromSchema<T>(
  schema: RuntimeSchema<T>,
  definition: Omit<ToolDefinition<T>, 'parameters' | 'parse'>,
): ToolDefinition<T>
```

Adapt a schema library **once**: `parameters` and `parse` come from the same
source, so the JSON Schema the provider sees can never drift from the validator
that guards `execute`.

```ts
import { defineToolFromSchema } from '@alvin0/ai-agent-sdk-core'
import { z } from 'zod'

const shape = z.object({ path: z.string() })
const schema = { jsonSchema: z.toJSONSchema(shape), parse: value => shape.parse(value) }

const readFile = defineToolFromSchema(schema, {
  name: 'read_file',
  description: 'Read one UTF-8 file.',
  execute: async args => readUtf8(args.path),   // args is typed
})
```

The SDK depends on no schema library. `RuntimeSchema` is the two-method surface
any of them can satisfy in three lines.

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
createApprovalRequest(input: Omit<ApprovalRequest, 'approvalRequestId' | 'providerCallId'>): ApprovalRequest
withApprovalPersistence(broker: ApprovalBroker, store: ApprovalStateStore): ApprovalBroker
```

```ts
type ApprovalDecision = 'allow' | 'deny' | 'abort'

interface ApprovalRequest {
  readonly approvalRequestId: string      // SDK-issued, single-use
  readonly providerCallId: ToolCallId
  readonly callId: ToolCallId
  readonly toolName: string
  readonly args: unknown
  readonly reason?: string
  readonly runId?: string
  readonly conversationId?: string
  readonly turn: number
  readonly step: number
}

interface ApprovalStateStore {
  savePending(request: ApprovalRequest, signal?: AbortSignal): Promise<void>
  saveDecision(request: ApprovalRequest, decision: ApprovalDecision, signal?: AbortSignal): Promise<void>
}
```

Answer `approvalRequestId`, never `providerCallId` — the SDK id is single-use, so
a replayed provider call id cannot reuse an old decision.

`withApprovalPersistence` journals every pending request and every decision
around an existing broker. It registers the interactive waiter **before** the
first storage write, so a decision can never arrive while nothing is listening.
A saved decision is never auto-applied to a new request: on recovery the host
loads pending records and reissues a fresh approval.

Types: `ApprovalBroker`, `ApprovalDecision`, `ApprovalRequest`,
`ApprovalStateStore`, `InteractiveApprovalBroker`,
`InteractiveApprovalBrokerOptions`.

A rejected call becomes a `ToolFailure` with run-event `status: 'rejected'`.

## Tool sources — `@alvin0/ai-agent-sdk-core/tools`

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
interface ToolInterceptor {
  readonly name: string
  readonly before?: (call: ToolCallContext, next: () => Promise<PreToolDecision>)  => Promise<PreToolDecision>
  readonly around?: (call: ToolCallContext, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>
  readonly after?:  (call: ToolCallContext, result: ToolExecutionResult,
                     next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
}

interface ToolCallContext {
  readonly callId: ToolCallId
  readonly toolName: string
  readonly tool: ToolDefinition | undefined
  readonly rawArguments: string       // verbatim provider text
  readonly args: unknown              // parsed, still untyped here
  readonly signal: AbortSignal
  readonly turn: number
  readonly step: number
  readonly logger?: SdkLogger
}

type PreToolDecision  = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
type PostToolDecision = { kind: 'accept' }
                      | { kind: 'replace'; content: readonly ContentBlock[]; meta?: JsonObject }
                      | { kind: 'block'; feedback: readonly ContentBlock[]; code?: string }
```

An interceptor is a **named object**, not a bare function, and each phase is
optional:

```ts
const audit: ToolInterceptor = {
  name: 'audit',
  around: async (call, next) => {
    const started = performance.now()
    try {
      return await next()
    } finally {
      metrics.record(call.toolName, performance.now() - started)
    }
  },
}

const session = agent.createSession({ interceptors: [audit] })
```

`before` returning `{ kind: 'ask' }` routes the call to the approval broker;
`{ kind: 'deny' }` never reaches `execute`. `after` can replace or block a result
the model would otherwise read. Interceptors are captured with their original
receivers, so a method taken off an object keeps its `this`.

## Durable execution

```ts
createToolExecutionInterceptor(options: {
  readonly backend?: ToolExecutionBackend        // defaults to localToolExecutionBackend
  readonly identity: JsonObject                  // trusted host identity
  readonly operationId: (call: ToolCallContext) => string
  readonly store?: ToolExecutionStore
}): ToolInterceptor

localToolExecutionBackend: ToolExecutionBackend
```

Types: `ToolExecutionBackend`, `ToolExecutionCapabilities`,
`ToolExecutionRequest`, `ToolExecutionStore`, `ToolOperation`,
`ToolOperationClaim`.

See [Durable Execution](/en/03-tools/durable-execution) for the contract.

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
