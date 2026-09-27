import { describe, expect, it } from 'vitest'
import { History } from '../../packages/core/src/agent/history/history.ts'
import { createToolAdmission } from '../../packages/core/src/agent/loop/admission.ts'
import { scheduleToolCalls, type RunToolCallsOptions } from '../../packages/core/src/agent/loop/schedule.ts'
import type { AgentEvent, CheckpointContext } from '../../packages/core/src/agent/loop/events.ts'
import { createApprovalBroker } from '../../packages/core/src/agent/tool/approval.ts'
import { defineTool, type ToolDefinition } from '../../packages/core/src/agent/tool/definition.ts'
import { ToolError } from '../../packages/core/src/agent/tool/errors.ts'
import {
  nestedToolPort, NESTED_TOOL_ERROR_CODES, type NestedToolPort, type NestedToolResult, type ProgramGrant,
} from '../../packages/core/src/agent/tool/nested.ts'
import type { ToolInterceptor } from '../../packages/core/src/agent/tool/pipeline.ts'
import { ToolRegistry } from '../../packages/core/src/agent/tool/registry.ts'
import { ProgramResultStore } from '../../packages/core/src/agent/tool/program-results.ts'
import { createSpanId, createTraceId } from '../../packages/core/src/agent/trace/trace.ts'
import { ToolCallId } from '../../packages/core/src/primitives/index.ts'
import type { JsonValue } from '../../packages/core/src/primitives/index.ts'

const SENTINEL = 'NESTED_SENTINEL_7f3a'

type Script = (port: NestedToolPort) => Promise<JsonValue>

interface Fixture {
  readonly tools: ToolRegistry
  readonly bodies: Map<string, number>
  readonly seen: NestedToolResult[]
  readonly events: AgentEvent[]
  readonly history: History
  readonly checkpoints: CheckpointContext[]
  /** Unregister the granted `read_rows`, so a test can swap it mid-program. */
  readonly disposeRead: () => void
}

function fixture(script: Script, options: { exempt?: boolean; parallelProgram?: boolean; programTimeoutMs?: number } = {}): Fixture {
  const tools = new ToolRegistry()
  const bodies = new Map<string, number>()
  const seen: NestedToolResult[] = []
  const count = (name: string) => bodies.set(name, (bodies.get(name) ?? 0) + 1)
  tools.register(defineTool({
    name: 'run_program', description: 'Host program.', parameters: { type: 'object' },
    ...options.parallelProgram === true ? { isConcurrencySafe: () => true } : {},
    ...options.programTimeoutMs === undefined ? {} : { timeoutMs: options.programTimeoutMs },
    async execute(_args, context) {
      count('run_program')
      const port = nestedToolPort(context)
      if (port === undefined) return { port: 'missing' }
      const recording: NestedToolPort = {
        ...port,
        call: async (name, args, options) => { const result = await port.call(name, args, options); seen.push(result); return result },
      }
      return await script(recording)
    },
  }))
  const disposeRead = tools.register(readRows(count, options.exempt === true))
  tools.register(defineTool({
    name: 'write_row', description: 'Not granted.', parameters: { type: 'object' },
    execute() { count('write_row'); return { written: true } },
  }))
  return { tools, bodies, seen, events: [], history: new History(), checkpoints: [], disposeRead }
}

function readRows(count: (name: string) => void, exempt: boolean): ToolDefinition {
  return defineTool({
    name: 'read_rows', description: 'Read one page.', parameters: { type: 'object' },
    ...exempt ? { budgetExempt: true as const } : {},
    isConcurrencySafe: () => true,
    execute(args: unknown) {
      count('read_rows')
      const page = typeof args === 'object' && args !== null ? Reflect.get(args, 'page') : undefined
      return { id: `row-${String(page)}`, private: SENTINEL }
    },
    meta: () => ({ note: SENTINEL }),
  })
}

async function run(
  f: Fixture,
  extra: Partial<RunToolCallsOptions> & { limit?: number | 'unbounded'; grant?: Partial<ProgramGrant>; calls?: RunToolCallsOptions['calls']; programResults?: ProgramResultStore } = {},
) {
  const { limit, grant, calls, programResults, ...rest } = extra
  return await scheduleToolCalls({
    calls: calls ?? [{ callId: ToolCallId('outer'), toolName: 'run_program', rawArguments: '{}' }],
    catalog: f.tools, history: f.history, position: { turn: 1, step: 1 },
    signal: new AbortController().signal,
    parentTrace: { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null } as never,
    emit: async event => { f.events.push(event) },
    checkpoint: context => { f.checkpoints.push(context) },
    ...rest,
  }, {
    admissionLimit: limit ?? 24,
    programs: new Map([['run_program', { allow: ['read_rows'], maxCalls: 20, ...grant }]]),
    ...programResults === undefined ? {} : { programResults },
  })
}

async function loop(port: NestedToolPort, times: number, tool = 'read_rows'): Promise<JsonValue> {
  for (let page = 0; page < times; page++) {
    try { await port.call(tool, { page }) } catch { /* a guest that swallows everything */ }
  }
  return 'done'
}

describe('ToolAdmission', () => {
  it('spends budget only on confirm and returns released reservations', () => {
    const admission = createToolAdmission(2)
    const first = admission.reserve(false)!
    const second = admission.reserve(false)!
    expect(admission.reserve(false)).toBeUndefined()
    second.release()
    first.confirm()
    first.release()
    expect(admission.budgeted).toBe(1)
    const third = admission.reserve(false)!
    third.confirm()
    expect(admission.reserve(false)).toBeUndefined()
    expect(admission.reserve(true)).toBeDefined()
    expect(admission.budgeted).toBe(2)
  })

  it('never declines in unbounded mode', () => {
    const admission = createToolAdmission('unbounded')
    for (let index = 0; index < 100; index++) admission.reserve(false)!.confirm()
    expect(admission.budgeted).toBe(100)
  })
})

describe('nested admission (PTC architecture gate, deterministic)', () => {
  it.each(['null-prototype', 'throwing-code'] as const)('settles a fatal host rejection with an unreadable %s error', async kind => {
    const reason: unknown = kind === 'null-prototype' ? Object.create(null)
      : Object.defineProperty(new Error('failed'), 'code', { get() { throw new Error('code getter failed') } })
    const f = fixture(async port => {
      try { await port.call('read_rows', {}) } catch { /* swallowed */ }
      const next = await port.call('read_rows', {})
      return next.ok ? 'reopened' : next.code
    })
    await expect(run(f, { interceptors: [{ name: 'fatal', async around(call, next) {
      if (call.toolName === 'read_rows') throw reason
      return await next()
    } }] })).rejects.toMatchObject({ code: 'TOOL_FAILED' })
    expect(f.seen.at(-1)).toMatchObject({ ok: false, code: NESTED_TOOL_ERROR_CODES.CLOSED })
  })

  it('fails the outer program when a retained-result authority check throws, even if caught', async () => {
    let broken = false
    const f = fixture(async port => {
      const saved = await port.call('read_rows', {}, { retain: true })
      expect(saved).toMatchObject({ ok: true, handle: expect.any(String) })
      broken = true
      try { port.load(saved.ok ? saved.handle! : '') } catch { /* swallowed */ }
      return 'done'
    })
    const original = f.tools.get.bind(f.tools)
    f.tools.get = name => {
      if (broken && name === 'read_rows') throw new Error('catalog unavailable')
      return original(name)
    }
    await expect(run(f, { programResults: new ProgramResultStore() })).rejects.toMatchObject({ code: 'TOOL_FAILED' })
    expect(f.bodies.get('read_rows')).toBe(1)
  })

  it('cannot swallow an observation failure and report a successful program', async () => {
    const f = fixture(async port => {
      try { await port.call('read_rows', {}) } catch { /* guest swallows host failure */ }
      return 'done'
    })
    await expect(run(f, { emit: async event => {
      if (event.type === 'span-start' && event.attributes?.['sdk.tool.parent_call_id'] === 'outer') throw new Error('observer failed')
    } })).rejects.toMatchObject({ code: 'TOOL_FAILED' })
    expect(f.bodies.get('read_rows') ?? 0).toBe(0)
  })

  it.each([undefined, null])('latches a fatal interceptor rejection even if its reason is %s', async reason => {
    const f = fixture(async port => {
      try { await port.call('read_rows', {}) } catch { /* swallowed */ }
      const next = await port.call('read_rows', {})
      return next.ok ? 'reopened' : next.code
    })
    await expect(run(f, { interceptors: [{ name: 'fatal', async around(call, next) {
      if (call.toolName === 'read_rows') throw reason
      return await next()
    } }] })).rejects.toMatchObject({ code: 'TOOL_FAILED' })
    expect(f.seen.at(-1)).toMatchObject({ ok: false, code: NESTED_TOOL_ERROR_CODES.CLOSED })
    expect(f.bodies.get('read_rows') ?? 0).toBe(0)
  })

  it('reserves the in-flight port before synchronous observation callbacks can reenter it', async () => {
    let activePort: NestedToolPort | undefined
    let reentered: Promise<NestedToolResult> | undefined
    const f = fixture(async port => {
      activePort = port
      const first = await port.call('read_rows', { page: 1 })
      return { first: first.ok, second: await reentered! } as JsonValue
    })
    const outcome = await run(f, { emit: async event => {
      if (event.type === 'span-start' && event.attributes?.['sdk.tool.parent_call_id'] === 'outer' && reentered === undefined) {
        // Guard the observer itself against recursively observing its own reentry.
        reentered = Promise.resolve({ ok: false, code: 'placeholder', message: '' })
        reentered = activePort!.call('read_rows', { page: 2 })
      }
    } })
    expect(f.bodies.get('read_rows')).toBe(1)
    expect(outcome.budgeted).toBe(2)
    expect(await reentered).toMatchObject({ ok: false, code: NESTED_TOOL_ERROR_CODES.CALL_IN_FLIGHT })
  })

  it('does not charge a model call whose checkpoint cancels before dispatch', async () => {
    const f = fixture(async () => 'unused')
    const controller = new AbortController()
    const outcome = await run(f, {
      calls: [{ callId: ToolCallId('direct'), toolName: 'read_rows', rawArguments: '{}' }],
      signal: controller.signal,
      checkpoint: () => { controller.abort(new Error('cancelled at checkpoint')) },
    })
    expect(f.bodies.get('read_rows') ?? 0).toBe(0)
    expect(outcome.budgeted).toBe(0)
    expect(outcome.dispatched).toBe(0)
  })

  it.each(['model', 'nested'] as const)('bounds a non-cooperative %s checkpoint without late dispatch', async mode => {
    const f = fixture(async port => { await port.call('read_rows', {}); return 'done' })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const running = run(f, {
      maxDurationMs: 20, teardownTimeoutMs: 20,
      ...(mode === 'model' ? { calls: [{ callId: ToolCallId('direct'), toolName: 'read_rows', rawArguments: '{}' }] } : {}),
      checkpoint: context => context.kind === 'before-tool-dispatch' && context.call.toolName === 'read_rows' ? held : undefined,
    }).then(value => ({ value }), error => ({ error }))
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([running, new Promise<'wedged'>(resolve => { watchdog = setTimeout(() => resolve('wedged'), 250) })])
      expect(result).not.toBe('wedged')
      expect(result).toMatchObject({ error: { code: 'TOOL_TEARDOWN_TIMEOUT' } })
    } finally {
      clearTimeout(watchdog)
      release()
      await running
    }
    expect(f.bodies.get('read_rows') ?? 0).toBe(0)
  })

  it('cancels a running child when the outer tool reaches its own timeout', async () => {
    const f = fixture(async port => (await port.call('read_rows', {})) as never, { programTimeoutMs: 30 })
    f.disposeRead()
    let childCancelled = false
    f.tools.register(defineTool({
      name: 'read_rows', description: 'Wait for cancellation.', parameters: { type: 'object' },
      async execute(_args, context) {
        await new Promise<void>(resolve => {
          if (context.signal.aborted) resolve()
          else context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        childCancelled = true
        return 'cancelled'
      },
    }))
    const outcome = await run(f, { maxDurationMs: 1_000, teardownTimeoutMs: 100 })
    expect(childCancelled).toBe(true)
    expect(outcome.results[0]).toMatchObject({ isError: true, error: { code: 'TOOL_TIMEOUT' } })
  })

  it('bounds a policy refusal before returning it to the program', async () => {
    const f = fixture(async port => (await port.call('read_rows', {})) as never)
    await run(f, { maxResultBytes: 1_024, interceptors: [{ name: 'deny', async before(call) {
      return call.toolName === 'read_rows' ? { kind: 'deny', reason: 'x'.repeat(4_096) } : { kind: 'allow' }
    } }] })
    expect(f.seen[0]).toMatchObject({ ok: false, code: 'INVALID_TOOL_RESULT' })
  })

  it('refuses lossy or executable arguments before policy and dispatch', async () => {
    let getterCalls = 0
    let serializationCalls = 0
    const accessor = Object.defineProperty({}, 'page', { enumerable: true, get() { getterCalls++; return 1 } })
    const values = [{ page: undefined }, { page: NaN }, { page: new Date() }, [, 1], accessor,
      { toJSON() { serializationCalls++; return { page: 1 } } }]
    const f = fixture(async port => {
      for (const value of values) await port.call('read_rows', value as never)
      return 'done'
    })
    await run(f)
    expect(f.bodies.get('read_rows')).toBeUndefined()
    expect(f.seen.every(result => !result.ok && result.code === NESTED_TOOL_ERROR_CODES.INVALID_ARGUMENTS)).toBe(true)
    expect(getterCalls).toBe(0)
    expect(serializationCalls).toBe(0)
  })
  it('PTC-A02: children spend the same root budget as the outer call', async () => {
    const f = fixture(port => loop(port, 10))
    const outcome = await run(f, { limit: 3 })
    expect(f.bodies.get('read_rows')).toBe(2)
    expect(outcome.budgeted).toBe(3)
    expect(f.seen.slice(2).every(r => !r.ok && r.code === NESTED_TOOL_ERROR_CODES.BUDGET_EXHAUSTED)).toBe(true)
  })

  it('PTC-A03: the program cap stops a loop over a budget-exempt tool', async () => {
    const f = fixture(port => loop(port, 10), { exempt: true })
    const outcome = await run(f, { limit: 3, grant: { maxCalls: 3 } })
    expect(f.bodies.get('read_rows')).toBe(3)
    expect(outcome.budgeted).toBe(1)
    expect(f.seen.slice(3).every(r => !r.ok && r.code === NESTED_TOOL_ERROR_CODES.CALL_CAP)).toBe(true)
  })

  it('PTC-A01: tools outside the grant never run, including ones registered later', async () => {
    let lateTools: ToolRegistry | undefined
    const f = fixture(async port => {
      await port.call('write_row', {})
      lateTools?.register(defineTool({ name: 'late', description: 'Late.', parameters: { type: 'object' }, execute: () => 'late' }))
      await port.call('late', {})
      return 'done'
    })
    lateTools = f.tools
    await run(f)
    expect(f.bodies.get('write_row')).toBeUndefined()
    expect(f.seen.map(r => r.ok ? 'ok' : r.code)).toEqual([NESTED_TOOL_ERROR_CODES.NOT_ALLOWED, NESTED_TOOL_ERROR_CODES.NOT_ALLOWED])
  })

  it('PTC-A01: a granted name registered after the program started is stale, not callable', async () => {
    const f: Fixture = fixture(async port => {
      f.disposeRead()
      f.tools.register(defineTool({ name: 'read_rows', description: 'Replacement.', parameters: { type: 'object' }, execute: () => 'swapped' }))
      return (await port.call('read_rows', { page: 1 })) as never
    })
    await run(f)
    expect(f.seen[0]).toMatchObject({ ok: false, code: NESTED_TOOL_ERROR_CODES.STALE_CATALOG })
  })

  it('PTC-A04: post-policy replacement removes the value; nothing leaks to events or history', async () => {
    const f = fixture(async port => (await port.call('read_rows', { page: 0 })) as never)
    const policy: ToolInterceptor = {
      name: 'redact',
      async after(call) {
        return call.toolName === 'read_rows'
          ? { kind: 'replace', content: [{ type: 'text', text: 'redacted' }] }
          : { kind: 'accept' }
      },
    }
    const outcome = await run(f, { interceptors: [policy] })
    expect(f.seen[0]).toMatchObject({ ok: false, code: NESTED_TOOL_ERROR_CODES.STRUCTURED_OUTPUT_UNAVAILABLE })
    expect(JSON.stringify(f.events)).not.toContain(SENTINEL)
    expect(JSON.stringify(f.history.snapshot())).not.toContain(SENTINEL)
    expect(JSON.stringify(outcome.results)).not.toContain(SENTINEL)
  })

  it('children never enter history or public tool-call events', async () => {
    const f = fixture(async port => (await port.call('read_rows', { page: 4 })) as never)
    const outcome = await run(f)
    expect(f.seen[0]).toMatchObject({ ok: true, value: { id: 'row-4' } })
    const entries = f.history.snapshot().entries
    expect(entries.filter(entry => entry.event.kind === 'tool-call')).toHaveLength(1)
    expect(entries.filter(entry => entry.event.kind === 'tool-result')).toHaveLength(1)
    expect(f.events.filter(event => event.type === 'tool-call')).toHaveLength(1)
    const childSpan = f.events.find(event => event.type === 'span-start' && event.attributes?.['sdk.tool.parent_call_id'] === 'outer')
    const outerSpan = f.events.find(event => event.type === 'span-start' && event.attributes?.['gen_ai.tool.call.id'] === 'outer')
    expect(childSpan?.type === 'span-start' && outerSpan?.type === 'span-start' && childSpan.trace.parentSpanId === outerSpan.trace.spanId).toBe(true)
    expect(outcome.results[0]?.isError).toBe(false)
  })

  it('D7: child checkpoints carry the outer call id', async () => {
    const f = fixture(async port => (await port.call('read_rows', { page: 0 })) as never)
    await run(f)
    const child = f.checkpoints.find(context => context.kind === 'before-tool-dispatch' && context.parentCallId !== undefined)
    expect(child).toMatchObject({ parentCallId: 'outer', call: { callId: 'outer:1', toolName: 'read_rows' } })
  })

  it('PTC-A05: an exclusive program beside a parallel sibling completes; a parallel program is refused', async () => {
    const f = fixture(port => loop(port, 2))
    const outcome = await run(f, { calls: [
      { callId: ToolCallId('outer'), toolName: 'run_program', rawArguments: '{}' },
      { callId: ToolCallId('sibling'), toolName: 'read_rows', rawArguments: '{"page":9}' },
    ] })
    expect(outcome.results).toHaveLength(2)
    expect(f.bodies.get('read_rows')).toBe(3)

    const parallel = fixture(port => loop(port, 1), { parallelProgram: true })
    const refused = await run(parallel)
    expect(refused.results[0]).toMatchObject({ isError: true, error: { code: NESTED_TOOL_ERROR_CODES.CONFIGURATION } })
    expect(parallel.bodies.get('run_program')).toBeUndefined()
  })

  it('PTC-A11/A06: a fatal child latches the port and fails the outer call, even if the program catches it', async () => {
    const f = fixture(async port => {
      await port.call('read_rows', { page: 0 })
      const after = await port.call('read_rows', { page: 1 })
      return after.ok ? 'reopened' : after.code
    })
    const fatal: ToolInterceptor = {
      name: 'fatal',
      async around(call, next) {
        if (call.toolName === 'read_rows') throw ToolError.fatal('backend lost', 'OUTCOME_UNKNOWN')
        return await next()
      },
    }
    await expect(run(f, { interceptors: [fatal] })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(f.bodies.get('read_rows')).toBeUndefined()
    expect(f.seen[1]).toMatchObject({ ok: false, code: NESTED_TOOL_ERROR_CODES.CLOSED })
  })

  it('PTC-A07: cancelling while a child waits for approval settles the waiter and never runs the body', async () => {
    const approvals = createApprovalBroker()
    const controller = new AbortController()
    const f = fixture(async port => (await port.call('read_rows', { page: 0 })) as never)
    const ask: ToolInterceptor = { name: 'ask', async before(call) { return call.toolName === 'read_rows' ? { kind: 'ask' } : { kind: 'allow' } } }
    const pending = run(f, { approvals, interceptors: [ask], signal: controller.signal, teardownTimeoutMs: 500 })
    await new Promise(resolve => setTimeout(resolve, 20))
    const waiting = approvals.pending()
    expect(waiting).toHaveLength(1)
    controller.abort(new Error('user cancelled'))
    const outcome = await pending
    expect(approvals.pending()).toHaveLength(0)
    approvals.resolve(waiting[0]!.approvalRequestId, 'allow')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.bodies.get('read_rows')).toBeUndefined()
    expect(outcome.results[0]?.isError).toBe(true)
  })

  it('PTC-A13: a grant that changes during approval does not dispatch the stale tool', async () => {
    const approvals = createApprovalBroker()
    const f = fixture(async port => (await port.call('read_rows', { page: 0 })) as never)
    const ask: ToolInterceptor = { name: 'ask', async before(call) { return call.toolName === 'read_rows' ? { kind: 'ask' } : { kind: 'allow' } } }
    const pending = run(f, { approvals, interceptors: [ask] })
    await new Promise(resolve => setTimeout(resolve, 20))
    f.disposeRead()
    f.tools.register(defineTool({ name: 'read_rows', description: 'Swapped.', parameters: { type: 'object' }, execute: () => 'swapped' }))
    approvals.resolve(approvals.pending()[0]!.approvalRequestId, 'allow')
    await pending
    expect(f.bodies.get('read_rows')).toBeUndefined()
    expect(f.seen[0]).toMatchObject({ ok: false, code: NESTED_TOOL_ERROR_CODES.STALE_CATALOG })
  })

  it('PTC-A14: without a grant no port exists and scheduling is unchanged', async () => {
    const f = fixture(async port => (await port.call('read_rows', {})) as never)
    const outcome = await scheduleToolCalls({
      calls: [{ callId: ToolCallId('outer'), toolName: 'run_program', rawArguments: '{}' }],
      catalog: f.tools, history: f.history, position: { turn: 1, step: 1 },
      signal: new AbortController().signal,
      parentTrace: { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null } as never,
    })
    expect(outcome.results[0]).toMatchObject({ isError: false, value: { port: 'missing' } })
    expect(outcome.budgeted).toBe(1)
  })

  it('refuses a program granted another program', async () => {
    const f = fixture(port => loop(port, 1))
    await expect(scheduleToolCalls({
      calls: [], catalog: f.tools, history: f.history, position: { turn: 1, step: 1 },
      signal: new AbortController().signal,
      parentTrace: { traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null } as never,
    }, { programs: new Map([
      ['run_program', { allow: ['other_program'], maxCalls: 1 }],
      ['other_program', { allow: ['read_rows'], maxCalls: 1 }],
    ]) })).rejects.toThrow(RangeError)
  })
})
