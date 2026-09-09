# Creating a Tool

## A complete tool

```ts
import { defineTool } from '@ai-agent-sdk/core'
import { z } from 'zod'

const Args = z.object({ path: z.string().min(1) })

const readProjectFile = defineTool({
  name: 'read_project_file',
  description: 'Read a UTF-8 text file inside the project.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Project-relative path.' } },
    required: ['path'],
  },

  parse: raw => Args.parse(raw),

  execute: async ({ path }, ctx) => {
    ctx.logger?.info('reading file', { path })
    const text = await readFile(resolveInsideProject(path), {
      encoding: 'utf8',
      signal: ctx.signal,
    })
    return { path, bytes: Buffer.byteLength(text), text }
  },

  render: value => [{ type: 'text', text: value.text }],
  meta: value => ({ bytes: value.bytes }),

  timeoutMs: 30_000,
  isConcurrencySafe: () => true,
})
```

## The division of labour

```text
raw JSON from model
      │
      ▼  parse()          untrusted → typed. Throw = INVALID_ARGUMENTS the model can fix.
   Args
      │
      ▼  execute()        do the work. Returns lossless JSON, or nothing.
 JsonValue
      ├──▶ render()       → ContentBlock[]   what the MODEL reads
      └──▶ meta()         → JsonObject      what your UI reads (model never sees it)
```

Three consumers, three shapes, from one call. That is why the raw value is worth
keeping: it is what you log, replay, and assert on in tests.

## `name` and `description` are prompt engineering

Both go into the tool schema the model sees. They are the only thing telling it
*when* to call your tool.

```ts
// Weak: the model cannot tell when this applies.
description: 'Gets data.'

// Strong: states purpose, scope, and ordering.
description: 'Read a UTF-8 text file inside the project. Use before editing a file.'
```

Names must be stable — they appear in history, traces, approval prompts, and
snapshots. Renaming a tool invalidates nothing at runtime but makes old
transcripts harder to read.

## `execute` — the body

```ts
execute: async (args, ctx) => { /* … */ }
```

Return a **lossless-JSON** value, or nothing. Anything not JSON-safe cannot be
persisted with the result, replayed, or shown in a UI.

`ctx` carries call identity, cancellation, and the two side channels:

```ts
interface ToolRunContext {
  readonly callId: ToolCallId    // provider-issued id for this call
  readonly toolName: string      // so shared helpers can report their caller
  readonly turn: number          // 1-based turn in the conversation
  readonly step: number          // 1-based step within the turn
  readonly signal: AbortSignal   // cancellation for this call
  readonly logger?: SdkLogger    // always present on AgentRuntime paths

  concludeTurn(): void
  addContext(content: string | readonly ContentBlock[]): void
}
```

**Always forward `ctx.signal`** to anything async — `fetch`, `readFile`, a
database driver. Declaring `timeoutMs` without forwarding the signal is a broken
promise: the pipeline aborts and waits, and an uncooperative tool surfaces as
`MODEL_TEARDOWN_TIMEOUT`.

## `render` — what the model reads

Defaults to: a string passes through verbatim, anything else is pretty-printed
JSON. Override it to give the model prose, or to return an image.

```ts
// Prose instead of JSON
render: value => [{ type: 'text', text: `Found ${value.count} matches in ${value.file}.` }],

// An image result
render: value => [{
  type: 'image',
  source: { kind: 'base64', mediaType: 'image/png', data: value.png },
}],
```

Keeping `render` separate is what lets you change the model-facing wording
without breaking any test that asserts on the value.

## `meta` — what only your UI reads

```ts
meta: value => ({ bytes: value.bytes, cached: value.cached }),
```

Must be lossless JSON — it is persisted with the result. The model **never** sees
it. Use it for timings, cache flags, row counts, and anything else your interface
wants to show beside the tool node.

## `concludeTurn()` — a tool that is the answer

```ts
execute: (args, ctx) => {
  saveResult(args)
  ctx.concludeTurn()
  return { accepted: true }
}
```

Ends the turn **after this batch of tool calls commits**, so a parallel sibling's
work is never discarded. Use it for submitting a final result or handing off to a
human. See [Structured Output](/en/02-agents/structured-output).

## `addContext()` — tell the model something it did not ask

```ts
execute: async (args, ctx) => {
  const result = await run(args, ctx.signal)
  if (result.staleRead) {
    ctx.addContext('The file changed since your last read; re-read before editing.')
  }
  return result
}
```

The blocks become a user message on the **following** request, and appear on the
result as `additionalContext` so they stay auditable.

## Where tools are declared

```ts
// On the agent — available to every session
runtime.agent({ id: 'a', model, instructions: '…', tools: [readProjectFile] })

// On one session — combined with definition-owned tools
agent.createSession({ tools: [requestScopedTool] })
```

Session-level tools are **combined**, not replacing. That lets a shared agent
definition gain per-request capabilities.

## Marker-free ergonomics

`defineTool` captures the schema and method detachably: it does **not** mutate the
object you pass, and it cannot redirect execution after binding. A method taken
off an object keeps its original receiver, so `execute: service.lookup` still has
its `this` and its live operational state.

## Read next

- [Tool Parameters](/en/03-tools/tool-parameters) — schema design and `parse`
- [Tool Execution](/en/03-tools/tool-execution) — scheduling and concurrency
- [`Tool` API reference](/en/13-api-reference/tool)
