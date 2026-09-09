# Tools — Overview

A tool is a **typed host function the model can call**. There is no second
string-id registry to keep in sync — the definition *is* the registration.

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
  parse: raw => raw as { a: number; b: number },
  execute: ({ a, b }) => ({ product: a * b }),
})

const agent = runtime.agent({ id: 'calc', model, instructions: '…', tools: [multiply] })
```

## Three kinds of tool

| Kind | Declared as | Executed by | Example |
| --- | --- | --- | --- |
| **Host tool** | `tools: [defineTool(...)]` | The SDK scheduler | Read a file, call your API |
| **Native tool** | `nativeTools: [{ type: 'native', … }]` | The provider | Web search, image generation |
| **Tool source** | `toolSources: [connection]` | The SDK scheduler, via the source | A whole MCP server catalog |

They are declared **separately on purpose**: the scheduler must never try to
execute a provider-side tool, and a remote catalog must be able to change
revision without touching your host functions.

## Two shape decisions worth knowing

**The body returns a value, not model-facing text.** `execute` produces a
lossless-JSON value; `render` turns it into the blocks the model reads. Keeping
them apart means the value can be logged, replayed, asserted on in tests, and
handed to a UI, while the model-facing wording stays free to change without
invalidating any of that.

Simple tools ignore `render` and get a sensible default: a string passes through
verbatim, anything else is pretty-printed JSON.

**Side channels live on the context, not in the return type.** A tool that wants
to end the turn or inject extra context calls `ctx.concludeTurn()` or
`ctx.addContext()`. The common return type stays trivial — a string or an object
— instead of forcing every tool to wrap its result in an envelope.

## The full contract

```ts
interface ToolDefinition<Args> extends ToolSchema {
  name: string
  description: string
  parameters: JsonSchema

  parse?:              (raw: unknown) => Args
  execute:             (args: Args, ctx: ToolRunContext) => Promise<JsonValue | void> | JsonValue | void
  render?:             (value: JsonValue | undefined, args: Args) => readonly ContentBlock[]
  meta?:               (value: JsonValue | undefined, args: Args) => JsonObject | undefined
  timeoutMs?:          number
  isConcurrencySafe?:  (args: Args) => boolean
}
```

## Safety defaults you should know

| Default | Why |
| --- | --- |
| Scheduling is **exclusive** unless `isConcurrencySafe` returns exactly `true` | Guessing wrong causes silent data corruption, not a visible error |
| `timeoutMs` aborts the signal and **waits** | An orphaned tool would keep mutating state behind the loop's back |
| A `parse` throw becomes `INVALID_ARGUMENTS`, not a crash | The model can see the error and correct itself |
| A failure can **never** end the turn | `concludesTurn` is typed `never` on `ToolFailure` |
| 64 dispatched tools per run | Unattended safety; host-configurable |

## In this chapter

| Page | Answers |
| --- | --- |
| [Creating a Tool](/en/03-tools/creating-a-tool) | Every field, and how `execute` / `render` / `meta` divide the work |
| [Tool Parameters](/en/03-tools/tool-parameters) | Schema design and the `parse` trust boundary |
| [Tool Execution](/en/03-tools/tool-execution) | Scheduling, concurrency, timeouts, interceptors, tool sources |
| [Error Handling](/en/03-tools/error-handling) | What the model sees when a tool fails |
| [Permissions](/en/03-tools/permissions) | Approval brokers and gating destructive calls |
| [Native Tools](/en/03-tools/native-tools) | Provider-executed web search and image generation |
