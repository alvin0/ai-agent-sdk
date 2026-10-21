import { describe, expect, it, vi } from 'vitest'
import { createSpanId, createTraceId, ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineAgent, History, ToolError, ToolRegistry, defineTool, runToolCalls } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolInterceptor } from '@alvin0/ai-agent-sdk-core/agent'

interface Scenario {
  readonly code: string
  readonly rawArguments?: string
  readonly execute?: () => unknown
  readonly timeoutMs?: number
  readonly interceptors?: readonly ToolInterceptor[]
  readonly maxResultTokens?: number
}

class SessionRenderingAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId('session-render-call'), name: 'run', arguments: '{}',
      } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'Done.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }
}

async function runScenario(scenario: Scenario, toolErrorRendering?: false | ((error: {
  readonly code: string; readonly message: string
}) => string)) {
  const registry = new ToolRegistry()
  registry.register(defineTool({
    name: 'run', description: 'Run a test tool.', parameters: { type: 'object' },
    execute: (scenario.execute ?? (() => 'unused')) as never,
    ...(scenario.timeoutMs === undefined ? {} : { timeoutMs: scenario.timeoutMs }),
  }))
  const history = new History()
  const parentTrace = {
    traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null,
  } as unknown as Parameters<typeof runToolCalls>[0]['parentTrace']
  const outcome = await runToolCalls({
    calls: [{ callId: ToolCallId(`call-${scenario.code.toLowerCase()}`), toolName: 'run',
      rawArguments: scenario.rawArguments ?? '{}' }],
    catalog: registry, history, position: { turn: 1, step: 1 },
    signal: new AbortController().signal, parentTrace,
    ...(scenario.interceptors === undefined ? {} : { interceptors: scenario.interceptors }),
    ...(scenario.maxResultTokens === undefined ? {} : { maxResultTokens: scenario.maxResultTokens }),
    ...(toolErrorRendering === undefined ? {} : { toolErrorRendering }),
  })
  return { result: outcome.results[0]!, history }
}

describe('tool error rendering', () => {
  it.each([
    ['thrown tool error', { code: 'CUSTOM_FAILURE',
      execute: () => { throw ToolError.respondToModel('The tool could not finish.', 'CUSTOM_FAILURE') } }],
    ['validation error', { code: 'MALFORMED_ARGUMENTS', rawArguments: '{' }],
    ['interceptor denial', { code: 'TOOL_DENIED',
      interceptors: [{ name: 'policy', before: () => Promise.resolve({
        kind: 'deny' as const, reason: 'workspace policy denied this call.',
      }) }] }],
    ['ask denied', { code: 'TOOL_DENIED',
      interceptors: [{ name: 'approval', before: () => Promise.resolve({ kind: 'ask' as const }) }] }],
    ['timeout', { code: 'TOOL_TIMEOUT', timeoutMs: 1,
      execute: async () => await new Promise(resolve => setTimeout(resolve, 8)) }],
  ] as const)('adds the stable code to %s results', async (_label, scenario) => {
    const { result, history } = await runScenario(scenario)
    if (!result.isError) throw new Error('expected a tool failure')
    expect(result.error.code).toBe(scenario.code)
    expect(result.content).toEqual([{ type: 'text', text: `[${scenario.code}] ${result.error.message}` }])
    const toolResult = history.entries().at(-1)?.event
    expect(toolResult).toMatchObject({ kind: 'tool-result', result: { isError: true, error: { code: scenario.code } } })
    const modelBlock = toolResult?.kind === 'tool-result' ? toolResult.message.content[0] : undefined
    expect(modelBlock).toMatchObject({ type: 'tool-result', content: result.content, isError: true })
  })

  it('supports custom safe rendering and a compatibility opt-out', async () => {
    const scenario = {
      code: 'REMOTE_FAILURE',
      execute: () => { throw ToolError.respondToModel('private service text', 'REMOTE_FAILURE') },
    }
    const renderer = vi.fn(({ code }: { readonly code: string; readonly message: string }) => `Call failed (${code}).`)
    const custom = await runScenario(scenario, renderer)
    expect(renderer).toHaveBeenCalledWith({ code: scenario.code, message: 'private service text' })
    expect(custom.result.content).toEqual([{ type: 'text', text: 'Call failed (REMOTE_FAILURE).' }])
    expect(custom.result.content[0]?.type === 'text' ? custom.result.content[0].text : '')
      .not.toContain('private service text')

    const legacy = await runScenario(scenario, false)
    expect(legacy.result.content).toEqual([{ type: 'text', text: 'Error: private service text' }])
  })

  it('falls back to the compact code rendering if a custom renderer throws', async () => {
    const scenario = {
      code: 'CUSTOM_FAILURE',
      execute: () => { throw ToolError.respondToModel('safe failure', 'CUSTOM_FAILURE') },
    }
    const result = await runScenario(scenario, () => { throw new Error('do not expose this') })
    expect(result.result.content).toEqual([{ type: 'text', text: '[CUSTOM_FAILURE] safe failure' }])
    expect(JSON.stringify(result.result)).not.toContain('do not expose this')
  })

  it('falls back to the compact code rendering if a custom renderer returns blank text', async () => {
    const scenario = {
      code: 'CUSTOM_FAILURE',
      execute: () => { throw ToolError.respondToModel('safe failure', 'CUSTOM_FAILURE') },
    }
    for (const blank of ['', '  \n']) {
      const result = await runScenario(scenario, () => blank)
      expect(result.result.content).toEqual([{ type: 'text', text: '[CUSTOM_FAILURE] safe failure' }])
    }
  })

  it('forwards the session compatibility setting through high-level tool rounds', async () => {
    const adapter = new SessionRenderingAdapter()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const agent = defineAgent({ id: 'tool-error-session', provider: 'test', model: 'scripted',
      instructions: 'Use the tool and finish.', tools: [defineTool({
        name: 'run', description: 'Run a failing operation.', parameters: { type: 'object' },
        execute: () => { throw ToolError.respondToModel('safe failure', 'REMOTE_FAILURE') },
      })] })
    const session = agent.createSession({ registry, compaction: false, toolErrorRendering: false })

    await expect(session.run('Run it.')).resolves.toMatchObject({ text: 'Done.' })
    const result = adapter.requests[1]?.messages.flatMap(message => message.content)
      .find(block => block.type === 'tool-result')
    expect(result).toMatchObject({ type: 'tool-result', content: [{ type: 'text', text: 'Error: safe failure' }] })
  })

  it('keeps interceptor-authored error content as written', async () => {
    const feedback = [
      { type: 'text' as const, text: 'Blocked by policy.' },
      { type: 'text' as const, text: 'Ask the operator for access.' },
    ]
    const { result } = await runScenario({ code: 'TOOL_DENIED', execute: () => 'raw', interceptors: [{
      name: 'policy', after: () => Promise.resolve({ kind: 'block' as const, feedback }),
    }] })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual(feedback)
  })

  it('bounds the rendered error text to the result budget', async () => {
    const { result } = await runScenario({
      code: 'TOOL_FAILED', maxResultTokens: 100,
      execute: () => { throw ToolError.respondToModel(`log ${'x'.repeat(200_000)}`) },
    })
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text.startsWith('[TOOL_FAILED] log')).toBe(true)
    expect(text.length).toBeLessThan(5_000)
    expect(result.meta).toMatchObject({ outputTruncated: { budget: 100 } })
  })

  it('records a matching tool-result when a result cannot be detached', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'run', description: 'Run a test tool.', parameters: { type: 'object' },
      execute: () => 'ok',
    }))
    const history = new History()
    const callId = ToolCallId('call-undetachable')
    const parentTrace = {
      traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null,
    } as unknown as Parameters<typeof runToolCalls>[0]['parentTrace']
    await expect(runToolCalls({
      calls: [{ callId, toolName: 'run', rawArguments: '{}' }],
      catalog: registry, history, position: { turn: 1, step: 1 },
      signal: new AbortController().signal, parentTrace,
      interceptors: [{ name: 'meta', after: () => Promise.resolve({
        kind: 'replace' as const, content: [{ type: 'text' as const, text: 'ok' }],
        meta: { size: 1n } as never,
      }) }],
    })).rejects.toMatchObject({ code: 'INVALID_TOOL_RESULT' })
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'tool-result', callId, result: { isError: true, error: { code: 'INVALID_TOOL_RESULT' } },
    })
  })

  it('bounds fatal error text recorded after the call fails', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'run', description: 'Run a test tool.', parameters: { type: 'object' },
      execute: () => { throw ToolError.fatal(`dump ${'x'.repeat(200_000)}`, 'BROKEN_CONTRACT') },
    }))
    const history = new History()
    const parentTrace = {
      traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null,
    } as unknown as Parameters<typeof runToolCalls>[0]['parentTrace']
    await expect(runToolCalls({
      calls: [{ callId: ToolCallId('call-fatal-dump'), toolName: 'run', rawArguments: '{}' }],
      catalog: registry, history, position: { turn: 1, step: 1 }, maxResultTokens: 100,
      signal: new AbortController().signal, parentTrace,
    })).rejects.toMatchObject({ code: 'BROKEN_CONTRACT' })
    const event = history.entries().at(-1)?.event
    if (event?.kind !== 'tool-result') throw new Error('expected a tool-result entry')
    const text = event.result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text.startsWith('[BROKEN_CONTRACT] dump')).toBe(true)
    expect(text.length).toBeLessThan(5_000)
  })

  it('ends the tool span once when the context append fails after publication', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'run', description: 'Run a test tool.', parameters: { type: 'object' },
      execute: (_args, context) => { context.addContext('more context'); return 'ok' },
    }))
    const events: { type: string }[] = []
    const parentTrace = {
      traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null,
    } as unknown as Parameters<typeof runToolCalls>[0]['parentTrace']
    await expect(runToolCalls({
      calls: [{ callId: ToolCallId('call-context-overflow'), toolName: 'run', rawArguments: '{}' }],
      catalog: registry, history: new History({ maxEntries: 2 }), position: { turn: 1, step: 1 },
      signal: new AbortController().signal, parentTrace, emit: event => { events.push(event); return Promise.resolve() },
    })).rejects.toThrow(/entry limit/)
    expect(events.filter(event => event.type === 'span-end')).toHaveLength(1)
  })
})
