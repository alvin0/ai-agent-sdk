import { describe, expect, it } from 'vitest'
import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, RuntimeAgentRunEvent, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import {
  defineTool, EXPERIMENTAL_NESTED_TOOL_ERROR_CODES, experimentalNestedToolPort,
  type ExperimentalNestedToolPort, type ExperimentalNestedToolResult, type ToolInterceptor,
} from '@alvin0/ai-agent-sdk-core/agent'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import type { JsonValue } from '@alvin0/ai-agent-sdk-core/tools'

const SENTINEL = 'NESTED/RUNTIME/SENTINEL'

type Program = (port: ExperimentalNestedToolPort) => Promise<JsonValue>

/** A model that calls the program once, then answers. Records every request. */
class ScriptedProgramModel extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 32_000 } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('outer'), name: 'run_program', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function runProgram(program: Program, options: {
  grant?: boolean; maxToolCalls?: number; exempt?: boolean; interceptors?: ToolInterceptor[]; maxCalls?: number
} = {}) {
  const model = new ScriptedProgramModel()
  const plugin = defineModelProviderPlugin({
    id: 'fixture', routes: ['fixture'], displayName: 'Scripted program model',
    setup(registrar) { registrar.registerAdapter(model) },
  })
  const runtime = await createAgentRuntime({ providers: [plugin] })
  const bodies = { read: 0, program: 0 }
  const seen: ExperimentalNestedToolResult[] = []
  const checkpoints: unknown[] = []
  const events: RuntimeAgentRunEvent[] = []
  try {
    const programTool = defineTool({
      name: 'run_program', description: 'Run a host program.', parameters: { type: 'object' },
      async execute(_args, context) {
        bodies.program++
        const port = experimentalNestedToolPort(context)
        if (port === undefined) return { port: 'missing' }
        return await program({ ...port, call: async (name, args) => {
          const result = await port.call(name, args)
          seen.push(result)
          return result
        } })
      },
    })
    const read = defineTool({
      name: 'read_rows', description: 'Read one page.', parameters: { type: 'object' },
      ...options.exempt === true ? { budgetExempt: true as const } : {},
      execute(args: unknown, context) {
        bodies.read++
        context.addContext(SENTINEL)
        const page = typeof args === 'object' && args !== null ? Reflect.get(args, 'page') : undefined
        return { id: `row-${String(page)}`, private: SENTINEL }
      },
      meta: () => ({ note: SENTINEL }),
    })
    const agent = runtime.agent({
      id: 'program-host', instructions: 'Use the program.', model: { provider: 'fixture', id: 'scripted' },
      tools: [programTool, read], maxToolCalls: options.maxToolCalls ?? 24, maxTurns: 8, compaction: false,
    })
    const session = agent.createSession({
      hooks: { checkpoint(context) { checkpoints.push(context) } },
      ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
      ...options.grant === false ? {} : {
        experimentalPrograms: [{ tool: 'run_program', allow: ['read_rows'], maxCalls: options.maxCalls ?? 20 }],
      },
    })
    let failure: unknown
    let result: Awaited<ReturnType<typeof session.run>> | undefined
    try {
      result = await session.run('Start.', { includeTraceEvents: true, onEvent(event) { events.push(event) } })
    } catch (error) { failure = error }
    return { bodies, seen, checkpoints, events, requests: model.requests, result, failure }
  } finally {
    await runtime.close()
  }
}

async function loop(port: ExperimentalNestedToolPort, times: number): Promise<JsonValue> {
  for (let page = 0; page < times; page++) {
    try { await port.call('read_rows', { page }) } catch { /* swallow */ }
  }
  return 'done'
}

describe('experimental programs through AgentRuntime', () => {
  it('PTC-A02: a root limit of 3 runs the outer call and exactly two children', async () => {
    const run = await runProgram(port => loop(port, 10), { maxToolCalls: 3 })
    expect(run.failure).toBeUndefined()
    expect(run.bodies).toEqual({ read: 2, program: 1 })
    expect(run.seen.slice(2).every(r => !r.ok && r.code === EXPERIMENTAL_NESTED_TOOL_ERROR_CODES.BUDGET_EXHAUSTED)).toBe(true)
  })

  it('PTC-A03: budget-exempt children still stop at the program cap', async () => {
    const run = await runProgram(port => loop(port, 10), { maxToolCalls: 3, exempt: true, maxCalls: 3 })
    expect(run.bodies.read).toBe(3)
    expect(run.seen.at(-1)).toMatchObject({ ok: false, code: EXPERIMENTAL_NESTED_TOOL_ERROR_CODES.CALL_CAP })
  })

  it('PTC-A04: value, meta and added context of a child never reach the model, history or events', async () => {
    const redact: ToolInterceptor = {
      name: 'redact',
      async after(call) {
        return call.toolName === 'read_rows'
          ? { kind: 'replace', content: [{ type: 'text', text: 'redacted' }], meta: { redacted: true } }
          : { kind: 'accept' }
      },
    }
    const redacted = await runProgram(async port => (await port.call('read_rows', { page: 1 })) as never, { interceptors: [redact] })
    expect(redacted.seen[0]).toMatchObject({ ok: false, code: EXPERIMENTAL_NESTED_TOOL_ERROR_CODES.STRUCTURED_OUTPUT_UNAVAILABLE })
    // Accepted child: the value reaches the program; meta and added context still never reach anyone else.
    const accepted = await runProgram(async port => {
      const result = await port.call('read_rows', { page: 1 })
      return result.ok ? { id: Reflect.get(result.value as object, 'id') as string } : 'failed'
    })
    expect(accepted.seen[0]).toMatchObject({ ok: true, value: { id: 'row-1' } })
    for (const run of [redacted, accepted]) {
      expect(run.failure).toBeUndefined()
      expect(JSON.stringify(run.events)).not.toContain(SENTINEL)
      expect(JSON.stringify(run.requests.map(request => request.messages))).not.toContain(SENTINEL)
      expect(JSON.stringify(run.result?.report)).not.toContain(SENTINEL)
    }
  })

  it('PTC-A06/A11: a throwing child interceptor fails the turn even when the program catches it', async () => {
    const failing: ToolInterceptor = {
      name: 'claim',
      async before(call) {
        if (call.toolName === 'read_rows') throw new Error('claim store unavailable')
        return { kind: 'allow' }
      },
    }
    const run = await runProgram(async port => {
      const first = await port.call('read_rows', { page: 0 })
      const second = await port.call('read_rows', { page: 1 })
      return [first.ok, second.ok ? 'reopened' : second.code]
    }, { interceptors: [failing] })
    expect(run.bodies.read).toBe(0)
    expect(run.seen[1]).toMatchObject({ ok: false, code: EXPERIMENTAL_NESTED_TOOL_ERROR_CODES.CLOSED })
    expect(run.failure).toBeDefined()
  })

  it('D7 and trace: child checkpoints carry parentCallId and child spans nest under the outer span', async () => {
    const run = await runProgram(async port => (await port.call('read_rows', { page: 0 })) as never)
    expect(run.checkpoints).toContainEqual(expect.objectContaining({ parentCallId: 'outer', call: expect.objectContaining({ callId: 'outer:1' }) }))
    expect(run.events.filter(event => event.type === 'tool-call')).toHaveLength(1)
    const serialized = JSON.stringify(run.events)
    expect(serialized).toContain('sdk.tool.parent_call_id')
  })

  it('PTC-A14: without a grant the tool gets no port and the run is unchanged', async () => {
    const run = await runProgram(async port => (await port.call('read_rows', {})) as never, { grant: false })
    expect(run.failure).toBeUndefined()
    expect(run.bodies).toEqual({ read: 0, program: 1 })
    expect(JSON.stringify(run.requests.at(-1)?.messages)).toContain('missing')
  })

  it('rejects malformed grants when the session is created', async () => {
    const plugin = defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'x', setup(registrar) { registrar.registerAdapter(new ScriptedProgramModel()) } })
    const runtime = await createAgentRuntime({ providers: [plugin] })
    try {
      const agent = runtime.agent({ id: 'a', instructions: 'x', model: { provider: 'fixture', id: 'scripted' }, maxTurns: 2, compaction: false })
      expect(() => agent.createSession({ experimentalPrograms: [{ tool: 'p', allow: ['r'], maxCalls: 0 }] })).toThrow(RangeError)
    } finally { await runtime.close() }
  })
})

describe('experimental program grants are validated when the session is created', () => {
  it('refuses a program that grants itself or another program', async () => {
    const plugin = defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'x', setup(registrar) { registrar.registerAdapter(new ScriptedProgramModel()) } })
    const runtime = await createAgentRuntime({ providers: [plugin] })
    try {
      const agent = runtime.agent({ id: 'a', instructions: 'x', model: { provider: 'fixture', id: 'scripted' }, maxTurns: 2, compaction: false })
      expect(() => agent.createSession({ experimentalPrograms: [{ tool: 'p', allow: ['p'], maxCalls: 1 }] })).toThrow(RangeError)
      expect(() => agent.createSession({ experimentalPrograms: [
        { tool: 'p', allow: ['q'], maxCalls: 1 }, { tool: 'q', allow: ['r'], maxCalls: 1 },
      ] })).toThrow(/may not call program/)
    } finally { await runtime.close() }
  })
})
