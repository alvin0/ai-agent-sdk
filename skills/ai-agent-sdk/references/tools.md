# Tools

Tools are ordinary typed values. There is no second string-id registry to keep
in sync.

## `defineTool`

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
| `parse` | — | Trust boundary. A throw becomes `INVALID_ARGUMENTS` the model can correct |
| `execute` | ✓ | Returns lossless JSON, or nothing |
| `render` | — | Defaults to: string verbatim, else pretty-printed JSON |
| `meta` | — | UI metadata; the model **never** sees it |
| `timeoutMs` | — | Never sent to the model. Asserts `execute` forwards `ctx.signal` |
| `isConcurrencySafe` | — | **Fail-closed**: only exact `true` opts into parallel |
| `maxOutputTokens` | — | Estimated result tokens the model may see; stricter of this and the turn budget wins |
| `budgetExempt` | — | Exempt from the turn's tool-call budget and loop guards. For calls that END work — submitting, asking, delegating. Only exact `true` |

`parse` is the boundary between untrusted model output and typed code. It runs
before `execute`, and its failure is reported to the model as a tool error, not
as a crash.

## Reuse one schema library

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

`parameters` and `parse` then come from one source and cannot drift. The SDK
depends on no schema library.

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

Defaults to `exclusive`. A throwing or absent `isConcurrencySafe` also means
exclusive — guessing wrong causes silent data corruption rather than a visible
error, so the default fails closed.

```ts
// A shell command can change state another command reads: never parallel.
isConcurrencySafe: () => false,
timeoutMs: 120_000,
```

## Native tools

Declared on `nativeTools`, never `tools`, so the scheduler never executes them:

```ts
type NativeToolName = 'web-search' | 'image-generation'

{ type: 'native', name: 'web-search', allowedDomains?: string[] }
{ type: 'native', name: 'image-generation', format?: string, partialImages?: number }
```

`ModelRegistry` rejects an unsupported native tool with `UNSUPPORTED_NATIVE_TOOL`
before provider I/O.

## Approvals

```ts
createApprovalBroker(options?: InteractiveApprovalBrokerOptions): InteractiveApprovalBroker
fixedApprovalBroker(decision: ApprovalDecision): ApprovalBroker
createApprovalRequest(input): ApprovalRequest
withApprovalPersistence(broker: ApprovalBroker, store: ApprovalStateStore): ApprovalBroker

type ApprovalDecision = 'allow' | 'deny' | 'abort'
```

```ts
interface ApprovalRequest {
  readonly approvalRequestId: string      // SDK-issued, SINGLE-USE
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
```

Answer `approvalRequestId`, **never** `providerCallId` — the SDK id is
single-use, so a replayed provider call id cannot reuse an old decision.

`withApprovalPersistence` journals every pending request and decision, and
registers the interactive waiter **before** the first storage write, so a
decision can never arrive while nothing is listening. A saved decision is never
auto-applied to a new request: on recovery the host reissues a fresh approval.

A rejected call becomes a `ToolFailure` with run-event `status: 'rejected'`.

## User input

```ts
createUserInputBroker(options?: InteractiveUserInputBrokerOptions): InteractiveUserInputBroker
fixedUserInputBroker(decision: UserInputDecision): UserInputBroker
```

Use with `mode: 'deep-human-in-loop'`, which gives the model
`request_user_input` for material decisions.

## Interceptors

```ts
createToolExecutionInterceptor(options): ToolInterceptor

interface ToolInterceptor {
  readonly name: string                    // a NAMED object, not a bare function
  readonly before?: (call, next) => Promise<PreToolDecision>
  readonly around?: (call, next) => Promise<ToolExecutionResult>
  readonly after?:  (call, result, next) => Promise<PostToolDecision>
}

type PreToolDecision  = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }
type PostToolDecision = { kind: 'accept' }
                      | { kind: 'replace'; content: readonly ContentBlock[]; meta?: JsonObject }
                      | { kind: 'block'; feedback: readonly ContentBlock[]; code?: string }
```

`ToolCallContext` carries `rawArguments` (verbatim provider text) alongside the
parsed-but-untyped `args`, plus `callId`, `toolName`, `tool`, `signal`, `turn`,
`step`, `logger`. Each phase is optional.

## Whole catalogs — tool sources

```ts
import { defineToolSource, TOOL_SOURCE_API_VERSION } from '@alvin0/ai-agent-sdk-core/tools'
```

A `ToolSource` publishes a catalog and is passed as `toolSources: [...]`.
Snapshots are synchronous and atomic — one revision binds both schema and
execution — and terminal evidence carries source and revision only. An MCP
connection is a `ToolSource`; see references/mcp.md.

## Durable execution

`localToolExecutionBackend` is the default. `ToolExecutionBackend`,
`ToolExecutionStore`, `ToolOperation`, and `ToolOperationClaim` exist for
resuming long-running tool work across processes.
