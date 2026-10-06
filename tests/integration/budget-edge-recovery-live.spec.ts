/**
 * Explicit, paid OpenAI Responses integration checks for the budget-edge fixes.
 * Every generation reaches gpt-6-luna through the production provider. A fetch
 * decorator injects errors/empty replies/usage AFTER consuming the real reply;
 * these faults are simulated, not claims about OpenAI's actual responses.
 *
 * Run: node --env-file=.env node_modules/vitest/vitest.mjs run
 *   --config vitest.integration.config.ts tests/integration/budget-edge-recovery-live.spec.ts
 * Keys stay in memory; evidence contains only counters, usage and outcomes.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ModelAdapter, ModelRegistry, ReasoningEffortId, createTextMessage, withRetry,
  type GenerateOptions, type ModelInvocationContext, type ResolvedModelInfo, type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import { History, ToolRegistry, defineTool, runAgent, type AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const MODEL = 'gpt-6-luna'
const TOKEN_BUDGET = 100_000
const OUTPUT = resolve(`.temp/live-budget-audit/${new Date().toISOString().replace(/[:.]/g, '-')}`)
type Kind = 'forced' | 'structured'
type Fault = 'none' | 'failed' | 'failed-budget' | 'empty' | 'empty-budget' | 'reasoning-failed'
interface CallEvidence {
  index: number
  model: string
  status?: number
  fault: Fault
  actualTokens: number
  actualTextChars: number
  actualToolCalls: string[]
}

class LiveFaultAdapter extends ModelAdapter {
  readonly calls: CallEvidence[] = []
  private readonly inner: ModelAdapter
  constructor(private readonly kind: Kind | 'plain', private readonly faults: readonly Fault[]) {
    super()
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is required; load .env with --env-file=.env')
    this.inner = openAiAdapter({ apiKey, models: [{ id: MODEL }], defaultMaxTokens: 1024,
      requestTimeoutMs: 60_000, streamIdleTimeoutMs: 60_000,
      transformRequest: body => {
        const payload = body as Record<string, unknown>
        // Force the work-step boundary using the real model's echo tool call.
        if (this.calls.length === 1 && kind === 'forced') {
          payload.tool_choice = { type: 'function', name: 'echo' }
          payload.parallel_tool_calls = false
        } else if (this.calls.length === 1) payload.tool_choice = 'none'
        return payload
      },
      fetch: async (input, init) => {
        const payload = JSON.parse(String(init?.body)) as { model: string }
        expect(payload.model).toBe(MODEL)
        const response = await globalThis.fetch(input, init)
        const call = this.calls.at(-1)!
        call.status = response.status
        if (!response.ok) return response
        const wire = await response.text()
        const events = wire.split(/\r?\n\r?\n/).flatMap(frame => {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
          return data && data !== '[DONE]' ? [JSON.parse(data) as Record<string, unknown>] : []
        })
        const completed = events.find(event => event.type === 'response.completed')
        const terminal = completed?.response as Record<string, unknown> | undefined
        expect(terminal).toBeDefined()
        const usage = terminal!.usage as { total_tokens: number }
        call.actualTokens = usage.total_tokens
        call.actualTextChars = events.reduce((sum, event) => sum + (event.type === 'response.output_text.delta' ? String(event.delta).length : 0), 0)
        call.actualToolCalls = events.filter(event => event.type === 'response.output_item.done').flatMap(event => {
          const item = event.item as { type: string; name?: string }
          return item.type === 'function_call' ? [item.name!] : []
        })
        expect(call.actualTokens).toBeGreaterThan(0)
        if (call.fault === 'none') return new Response(wire, { status: response.status, headers: response.headers })
        const failed = call.fault.includes('failed')
        const replacement: Record<string, unknown>[] = events.filter(event => event.type === 'response.created' || event.type === 'response.in_progress')
        if (call.fault === 'reasoning-failed') {
          replacement.push({ type: 'response.output_item.added', item: { id: 'injected_reasoning', type: 'reasoning' } },
            { type: 'response.reasoning_summary_text.delta', item_id: 'injected_reasoning', delta: 'Injected reasoning prefix.', summary_index: 0 })
        }
        replacement.push({ type: failed ? 'response.failed' : 'response.completed', response: {
          ...terminal, status: failed ? 'failed' : 'completed', output: [],
          ...failed ? { error: { code: 'server_error', message: 'Injected transient stream failure' } } : {},
          ...call.fault.endsWith('-budget') ? { usage: { input_tokens: TOKEN_BUDGET - 1, output_tokens: 1, total_tokens: TOKEN_BUDGET } } : {},
          // A disconnect during reasoning precedes the authoritative usage event.
          ...call.fault === 'reasoning-failed' ? { usage: null } : {},
        } })
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        headers.delete('content-encoding')
        return new Response(replacement.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers })
      },
    })
  }
  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfo> {
    return this.inner.resolveModel(provider, model, signal)
  }
  async * stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    const fault = this.faults[this.calls.length] ?? 'none'
    const evidence: CallEvidence = { index: this.calls.length + 1, model: MODEL, fault,
      actualTokens: 0, actualTextChars: 0, actualToolCalls: [] }
    this.calls.push(evidence)
    const chunks: StreamChunk[] = []
    for await (const chunk of this.inner.stream(options, context)) {
      chunks.push(chunk)
    }
    expect(evidence.status).toBe(200)
    expect(evidence.actualTokens).toBeGreaterThan(0)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: {
      kind: fault.includes('failed') ? 'error' : this.kind === 'forced' && evidence.index === 1 ? 'tool-calls' : 'stop',
    } })
    yield* chunks
  }
}

async function scenario(name: string, kind: Kind | 'plain', faults: readonly Fault[],
  check: (result: { adapter: LiveFaultAdapter; events: AgentRunEvent[]; history: History; retries: number }) => void,
  options: { budget?: boolean; cancel?: boolean; prefixRetry?: boolean } = {}): Promise<void> {
  const adapter = new LiveFaultAdapter(kind, faults)
  const controller = new AbortController()
  const registry = new ModelRegistry()
  registry.registerAdapter(['openai'], options.prefixRetry ? withRetry(adapter, {
    bufferReasoningPrefix: true,
    policy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1 } },
  }) : adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage(kind === 'forced'
    ? 'Call echo once to verify the fixture, then answer briefly that verification succeeded.'
    : 'Reply briefly that verification succeeded. Do not call tools.') })
  const tools = new ToolRegistry()
  tools.register(defineTool({ name: 'echo', description: 'Verify a harmless local fixture.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => ({ verified: true }) }))
  const events: AgentRunEvent[] = []
  let retries = 0
  let passed = false
  try {
    for await (const event of runAgent({ mode: 'basic', registry, history, tools,
      config: { provider: 'openai', model: MODEL, reasoningEffort: ReasoningEffortId('low') }, maxTurns: kind === 'forced' ? 1 : 4,
      signal: controller.signal,
      ...options.budget ? { bounds: { maxTotalTokens: TOKEN_BUDGET } } : {},
      ...kind === 'structured' ? { outputFormat: { type: 'json_schema', name: 'verification', schema: {
        type: 'object', properties: { verified: { type: 'boolean' } }, required: ['verified'], additionalProperties: false,
      } } } : {},
      hooks: { onRequestError: () => {
        retries++
        if (options.cancel) { controller.abort(new Error('Injected cancellation in retry hook')); throw controller.signal.reason }
        return 'retry'
      } },
    })) events.push(event)
    check({ adapter, events, history, retries })
    passed = true
  } finally {
    mkdirSync(OUTPUT, { recursive: true })
    const end = events.at(-1)
    writeFileSync(join(OUTPUT, `${name}.json`), JSON.stringify({ model: MODEL, passed,
      endpoint: 'https://api.openai.com/v1/responses', injectedAt: 'HTTP SSE response before production parser',
      calls: adapter.calls, retries, terminal: end?.type === 'agent-end' ? end.outcome : end?.type }, null, 2))
    console.info(JSON.stringify({ scenario: name, passed, model: MODEL, liveRequests: adapter.calls.length,
      actualTokens: adapter.calls.reduce((sum, call) => sum + call.actualTokens, 0), report: join(OUTPUT, `${name}.json`) }))
  }
}

describe.skipIf(!process.env.OPENAI_API_KEY)('gpt-6-luna budget-edge live fault injection', () => {
  it('completes a real unmodified response', async () => {
    await scenario('normal', 'plain', [], ({ adapter, events }) => {
      expect(adapter.calls).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: { completed: true } })
    })
  })
  it.each(['forced', 'structured'] as const)('retries a transient %s finalizer', async kind => {
    await scenario(`${kind}-retry`, kind, ['none', 'failed', 'none'], ({ adapter, events, retries }) => {
      expect(adapter.calls).toHaveLength(3)
      expect(retries).toBe(1)
      expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: { text: expect.any(String) } })
      const end = events.at(-1)
      expect(end?.type === 'agent-end' && end.outcome.text.trim().length).toBeGreaterThan(0)
      if (kind === 'structured') {
        expect(end).toMatchObject({ outcome: { completed: true } })
        expect(end?.type === 'agent-end' && JSON.parse(end.outcome.text)).toEqual({ verified: true })
      } else expect(end).toMatchObject({ outcome: { reason: { kind: 'budget-exhausted', forcedFinalAnswer: true } } })
    })
  })
  it.each(['forced', 'structured'] as const)('does not retry a %s finalizer after spending its token budget', async kind => {
    await scenario(`${kind}-budget`, kind, ['none', 'failed-budget'], ({ adapter, events, retries }) => {
      expect(adapter.calls).toHaveLength(2)
      expect(retries).toBe(0)
      expect(events.at(-1)).toMatchObject({ type: 'agent-end' })
      const end = events.at(-1)
      expect(end?.type === 'agent-end' && end.outcome.usageReport?.budgetTokens).toBeGreaterThanOrEqual(TOKEN_BUDGET)
    }, { budget: true })
  })
  it.each(['forced', 'structured'] as const)('preserves cancellation in a %s retry hook', async kind => {
    await scenario(`${kind}-abort`, kind, ['none', 'failed'], ({ adapter, events, history, retries }) => {
      expect(adapter.calls).toHaveLength(2)
      expect(retries).toBe(1)
      expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: { reason: { kind: 'aborted' } } })
      expect(history.messages().at(-1)?.source).toEqual({ kind: 'app', producer: 'turn-interrupted' })
    }, { cancel: true })
  })
  it('stops empty finalizer retries when the token budget is spent', async () => {
    await scenario('empty-budget', 'forced', ['none', 'empty-budget'], ({ adapter, events }) => {
      expect(adapter.calls).toHaveLength(2)
      expect(events.at(-1)).toMatchObject({ outcome: { text: '', reason: { kind: 'budget-exhausted', forcedFinalAnswer: false } } })
    }, { budget: true })
  })
  it('reports no forced answer after two empty finalizers', async () => {
    await scenario('empty-twice', 'forced', ['none', 'empty', 'empty'], ({ adapter, events }) => {
      expect(adapter.calls).toHaveLength(3)
      expect(events.at(-1)).toMatchObject({ outcome: { text: '', reason: { kind: 'budget-exhausted', forcedFinalAnswer: false } } })
    })
  })
  it('recovers from one empty finalizer with a real answer', async () => {
    await scenario('empty-recovery', 'forced', ['none', 'empty', 'none'], ({ adapter, events }) => {
      expect(adapter.calls).toHaveLength(3)
      expect(events.at(-1)).toMatchObject({ outcome: { reason: { kind: 'budget-exhausted', forcedFinalAnswer: true } } })
    })
  })
  it('retries a failed reasoning prefix without leaking it into the final stream', async () => {
    await scenario('reasoning-recovery', 'plain', ['reasoning-failed', 'none'], ({ adapter, events }) => {
      expect(adapter.calls).toHaveLength(2)
      expect(JSON.stringify(events)).not.toContain('Injected reasoning prefix.')
      expect(events.at(-1)).toMatchObject({ outcome: { completed: true } })
    }, { prefixRetry: true })
  })
})
