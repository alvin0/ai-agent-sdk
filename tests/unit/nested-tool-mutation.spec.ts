import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { History } from '../../packages/core/src/agent/history/history.ts'
import { scheduleToolCalls } from '../../packages/core/src/agent/loop/schedule.ts'
import { defineTool } from '../../packages/core/src/agent/tool/definition.ts'
import { createToolExecutionInterceptor } from '../../packages/core/src/agent/tool/execution.ts'
import { nestedToolPort, type NestedToolResult } from '../../packages/core/src/agent/tool/nested.ts'
import type { ToolCallContext, ToolInterceptor } from '../../packages/core/src/agent/tool/pipeline.ts'
import { ToolRegistry } from '../../packages/core/src/agent/tool/registry.ts'
import { createSpanId, createTraceId } from '../../packages/core/src/agent/trace/trace.ts'
import { ToolCallId } from '../../packages/core/src/primitives/index.ts'
import { openOperationJournal, type OperationJournal } from '../../samples/durable-operations/journal.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function journal(): OperationJournal {
  const directory = mkdtempSync(join(tmpdir(), 'sdk-ptc-mutation-'))
  directories.push(directory)
  return openOperationJournal(join(directory, 'journal.sqlite'))
}

const identity = { tenant: 'tenant-a' }
// Host-owned operation identity: a program's child is scoped by its outer call.
const operationId = (call: ToolCallContext) => `${call.parentCallId ?? 'model'}/${call.callId}`

function setup(interceptors: ToolInterceptor[]) {
  const tools = new ToolRegistry()
  const effects = { count: 0 }
  const seen: NestedToolResult[] = []
  tools.register(defineTool({
    name: 'run_program', description: 'Program.', parameters: { type: 'object' },
    async execute(_args, context) {
      const port = nestedToolPort(context)!
      const first = await port.call('charge', { amount: 5 })
      seen.push(first)
      const second = await port.call('charge', { amount: 5 })
      seen.push(second)
      return 'done'
    },
  }))
  tools.register(defineTool({
    name: 'charge', description: 'Charge a card. State-changing.', parameters: { type: 'object' },
    execute: () => { effects.count++; return { receipt: `r-${String(effects.count)}` } },
  }))
  const run = (outer = 'outer-1') => scheduleToolCalls({
    calls: [{ callId: ToolCallId(outer), toolName: 'run_program', rawArguments: '{}' }],
    catalog: tools, history: new History(), position: { turn: 1, step: 1 }, signal: new AbortController().signal,
    parentTrace: { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null } as never,
    interceptors,
  }, { admissionLimit: 24, programs: new Map([['run_program', { allow: ['charge'], maxCalls: 5 }]]) })
  return { run, effects, seen }
}

describe('PTC-Q1: programs mutate only through the host hooks', () => {
  it('Q1-A/B: journaling everything makes a rerun of the same outer call reuse the program result', async () => {
    const store = journal()
    const { run, effects, seen } = setup([createToolExecutionInterceptor({ identity, operationId, store: store.store as never })])
    await run()
    expect(effects.count).toBe(2)
    expect(store.database.prepare('SELECT id FROM operations ORDER BY id').all().map(row => row.id))
      .toEqual(['model/outer-1', 'outer-1/outer-1:1', 'outer-1/outer-1:2'])
    await run()
    expect(effects.count).toBe(2)
    expect(seen).toHaveLength(2)
    store.close()
  })

  it('Q1-B: journaling only children lets a rerun of the program replay its children from the journal', async () => {
    const store = journal()
    const children = createToolExecutionInterceptor({ identity, operationId, store: store.store as never })
    // Host choice, through the same hook: the program itself is not journaled.
    const childrenOnly: ToolInterceptor = { name: 'journal-children', around: (call, next) => call.parentCallId === undefined ? next() : children.around!(call, next) }
    const { run, effects, seen } = setup([childrenOnly])
    await run()
    await run()
    expect(effects.count).toBe(2)
    expect(seen.map(result => result.ok ? (result.value as { receipt: string }).receipt : result.code)).toEqual(['r-1', 'r-2', 'r-1', 'r-2'])
    store.close()
  })

  it('Q1-A: an unknown child outcome latches the program and fails the turn', async () => {
    const store = journal()
    await store.store.claim({ operationId: 'outer-1/outer-1:1', toolName: 'charge', args: { amount: 5 }, identity }, new AbortController().signal)
    const { run, effects, seen } = setup([createToolExecutionInterceptor({ identity, operationId, store: store.store as never })])
    await expect(run()).rejects.toMatchObject({ code: 'OPERATION_OUTCOME_UNKNOWN' })
    expect(effects.count).toBe(0)
    expect(seen[1]).toMatchObject({ ok: false, code: 'PROGRAM_CLOSED' })
    store.close()
  })

  it('Q1-C/D: a policy sees parentCallId only on children and can refuse program mutations', async () => {
    const observed: (string | undefined)[] = []
    const policy: ToolInterceptor = {
      name: 'no-mutation-from-programs',
      async before(call) {
        observed.push(call.parentCallId)
        return call.parentCallId !== undefined && call.toolName === 'charge'
          ? { kind: 'deny', reason: 'programs may not charge cards' }
          : { kind: 'allow' }
      },
    }
    const { run, effects, seen } = setup([policy])
    await run()
    expect(effects.count).toBe(0)
    expect(seen[0]).toMatchObject({ ok: false, code: 'TOOL_DENIED' })
    expect(observed).toEqual([undefined, 'outer-1', 'outer-1'])
  })
})
