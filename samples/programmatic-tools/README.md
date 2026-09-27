# Programmatic tool calling (experimental)

A model can write a short program that pages, filters, joins or aggregates many tool
results itself, and only the program's result enters its context. This sample adds
an `execute_program` tool that runs that program in a QuickJS/WASM guest inside a
Node worker ([program-tool.ts](./program-tool.ts),
[program-worker.mjs](./program-worker.mjs)). Node 22.18+.

The core surface is **experimental and off by default**: `experimentalPrograms`,
`experimentalNestedToolPort` and `experimentalOutputSchema`. The names are prefixed
because they may change or be removed. Nothing here is a package.

## Enable it for one session

The executor needs `quickjs-emscripten`, which this repository does not install. Pin
the version the evidence below was produced with:

```sh
npm install --prefix vendor/quickjs --ignore-scripts --save-exact quickjs-emscripten@0.32.0
```

```ts
import { resolve } from 'node:path'
import { createProgramTool } from './program-tool.ts'

const program = createProgramTool({
  quickjsEntry: resolve('vendor/quickjs/node_modules/quickjs-emscripten/dist/index.mjs'),
})
const agent = runtime.agent({ id: 'analyst', model, instructions, tools: [program, listRows, listOwners] })
const session = agent.createSession({
  // The host decides which tools a program may call. The model cannot widen this.
  experimentalPrograms: [{ tool: 'execute_program', allow: ['list_rows', 'list_owners'], maxCalls: 20 }],
})
```

## What a program looks like

A program is the body of a **synchronous** function that ends with `return`.
`callTool(name, args)` returns the tool's value, or throws. `TOOLS` lists the granted
tools with their parameters and output contract. Code that uses `async` or `await` is
refused (`PROGRAM_ASYNC_UNSUPPORTED`). Resuming an asyncified host call inside a
QuickJS job corrupted the WASM stack in testing.

```js
const rows = []
for (let offset = 0; offset !== null;) {
  const page = callTool('list_rows', { offset })
  rows.push(...page.rows)
  offset = page.nextOffset
}
return { ids: rows.filter(row => row.active && row.amount >= 30).map(row => row.id) }
```

`callToolResult(name, args, { retain: true })` also returns `schema` (`validated` or
`unchecked`) and a `handle`. `loadResult(handle)` reads that value back in a later
program in the same turn.

With `createProgramTool({ executor: 'async', ... })`, a program is instead the body of
an **async** function. `await callTool(...)`, async helpers and `Promise.all` all work.
Children still run one at a time: the executor queues them, and there is no asyncify.
Both executors pass the same conformance suite.

## Programs that change state

The SDK adds no mutation mode; the host's existing hooks decide. Every child call
carries `parentCallId`, the outer program call, on the context that interceptors and
`createToolExecutionInterceptor({ operationId })` receive.

- **Refuse:** an interceptor `before` can deny a mutating tool when `parentCallId` is
  set.
- **Deduplicate:** scope operation IDs by `parentCallId` and journal them with
  [durable-operations](../durable-operations/README.md).
  - If you journal the program call too, rerunning the same outer call returns the
    stored program result.
  - If you journal only the children, rerunning the program replays completed
    children from the journal instead of running them again.
  - An `unknown` child outcome closes the program and fails the turn.

Resuming a program after the turn or process ends is a host runner's job, built on
these hooks. The SDK does not keep programs alive.

## What the host still owns

Every child call runs through the same admission, pre-policy, approval, checkpoint,
execution and post-policy stages as a call the model makes directly.

- **Budget:** children spend the turn's `maxToolCalls`, and the program tool itself
  costs one call. `maxCalls` also stops loops over `budgetExempt` tools.
- **Authority:** only granted names are callable, resolved when the program starts.
  If a tool definition changes while the program runs, the port closes with
  `PROGRAM_STALE_CATALOG`.
- **Data:** a program gets only the finalized, post-policy value. If a policy removed
  the value, the program gets `STRUCTURED_OUTPUT_UNAVAILABLE`; rendered text is never
  parsed back.
  - With a declared `experimentalOutputSchema`, the value is checked against a small
    JSON Schema subset.
  - A value that fails the check is refused.
  - A missing or unsupported schema gives `unchecked`.
- **Failure:** a fatal child failure, or a throwing interceptor, closes the port and
  fails the turn, even if the program catches the error.
- **History:** children never enter the model-visible history. They appear as
  `execute_tool` trace spans under the program's span, and checkpoints carry
  `parentCallId`.
- **Isolation:** the QuickJS guest has no filesystem, network, env or module access;
  its only way out is the port. The Node worker around it is ordinary host code (it
  is spawned with an empty `env`) and is not a security boundary by itself.
  - The QuickJS interrupt enforces CPU time, and a timer enforces wall-clock time.
  - The QuickJS heap is capped. The worker's V8 heap is capped too.
  - Reply size and result size are bounded.
  - If the executor is missing, the tool fails closed. It never falls back to
    host evaluation.

## Evidence and limits

- **Conformance:** PTC-A01…A15 pass ([gates](../../docs/evaluations/sp-01-architecture-gate-2026-09-26/gates.json)).
  13 cases run through `AgentRuntime` with this executor
  (`test-human/spikes/ptc-conformance.ts`). A13 and A15 are covered by unit tests.
- **Development benchmark:** Codex `gpt-6-luna`, medium effort, 12 synthetic tasks × 3
  repeats, paired against the same tools with spill and `read_tool_output`
  ([report](../../docs/evaluations/sp-01-value-gate-2026-09-26/report.json)).
  - On filter and join tasks, PTC passed 24/24 against 14/24.
  - Median tokens fell 77%.
  - p95 latency did not rise.
  - On small control tasks, PTC used about 27% **more** tokens. Enable it only for
    workloads that page or aggregate.
- **Paired held-out run with PTC on every task:** 26 neutral families × 5 repeats × 2
  arms ([interpretation](../../docs/evaluations/codex-luna-ptc-paired-final-2026-09-27/interpretation.json)).
  - Quality was non-inferior: 123/130 against 118/130.
  - No mutations occurred.
  - The model never called `execute_program` on these general tasks.
  - It still cost 26% more tokens and 9% more p95 latency, which is why PTC stays opt-in.
- **Replication on a second model:** free ZenMux `dots3-note-prev`.
  - On the target workload, PTC passed 23/24 against 8/24, with at least 78% fewer
    tokens.
  - With PTC on every task, quality was **not** non-inferior (−4pp). The extra tool
    made this weaker model emit invalid JSON.
  - In one run, the model called a mutating tool on its own; that fixture enforced
    authority only through instructions.
  - So: enable programs per workload, and enforce mutation authority with
    interceptors, never with instructions.
- **Limits:**
  - Development and held-out split cohorts are author-exposed, not blind. Two
    models were tested; that does not establish generalization to other models.
  - Cost is measured in tokens; no USD cost is claimed.
  - No total process RSS limit is claimed.
  - Only one child call runs at a time. Sync and async guest executors are
    available; detached continuation is not provided.
  - Mutation is a host grant/policy decision. Programs do not create authority,
    and unknown outcomes require receipt reconciliation before retrying.
