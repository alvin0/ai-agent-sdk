import { describe, expect, it } from 'vitest'
import {
  History, ToolRegistry, defineTool, requestRetryHook, runAgent,
  type AgentRunEvent, type RequestErrorContext,
} from '@alvin0/ai-agent-sdk-core/agent'
import {
  ModelAdapter, ModelRegistry, ToolCallId, createTextMessage, resolveRetryPolicy,
  type GenerateOptions, type ResolvedModelInfo, type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'

class Scripted extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
}

const failed = (code = 'SERVER', providerRetryAfterMs?: number): StreamChunk[] => [{ type: 'finish', reason: {
  kind: 'error',
  failure: { code, message: 'down', ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs } },
} }]
const text = (value: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const call = (id: string, arguments_ = '{}'): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0,
    block: { type: 'tool-call', id: ToolCallId(id), name: 'echo', arguments: arguments_ } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

type Hook = (context: RequestErrorContext) => Promise<'retry' | 'fail'> | 'retry' | 'fail'

async function run(rounds: readonly (readonly StreamChunk[])[], onRequestError: Hook) {
  const adapter = new Scripted(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('Question') })
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: {} }, execute: () => ({ ok: true }),
  }))
  const events: AgentRunEvent[] = []
  const config = { provider: 'test', model: 'm' }
  const options = { mode: 'basic' as const, registry, history, tools, config, maxTurns: 10, hooks: { onRequestError } }
  for await (const event of runAgent(options)) {
    events.push(event)
  }
  return { adapter, end: events.at(-1) }
}

const serverDown: RequestErrorContext['failure'] = { code: 'SERVER', message: 'down' }

function context(consecutiveFailures: number, retries: number, failure = serverDown,
  signal = new AbortController().signal): RequestErrorContext {
  return {
    turn: 1, step: 1, failure, consecutiveFailures, retries, signal,
    snapshot: new History().snapshot(), emit: async () => undefined,
  }
}

describe('request-error context', () => {
  it('counts failures in a row, resets them on a successful request, and counts every granted retry', async () => {
    const seen: [number, number][] = []
    const { adapter, end } = await run([failed(), call('c1'), failed(), failed(), text('Answer.')], (ctx) => {
      seen.push([ctx.consecutiveFailures, ctx.retries])
      return 'retry'
    })
    expect(seen).toEqual([[1, 0], [1, 1], [2, 2]])
    expect(adapter.requests).toHaveLength(5)
    expect(end).toMatchObject({ type: 'agent-end', outcome: { text: 'Answer.' } })
  })

  it('does not count a retry the hook declined', async () => {
    const seen: [number, number][] = []
    await run([failed(), failed()], (ctx) => {
      seen.push([ctx.consecutiveFailures, ctx.retries])
      return ctx.consecutiveFailures === 1 ? 'retry' : 'fail'
    })
    expect(seen).toEqual([[1, 0], [2, 1]])
  })
})

describe('request-error context on the loop\'s other paths', () => {
  async function runWith(rounds: readonly (readonly StreamChunk[])[], hook: Hook, extra: Record<string, unknown> = {},
    history = new History()) {
    const adapter = new Scripted(rounds)
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    history.append({ kind: 'user', message: createTextMessage('Question') })
    const tools = new ToolRegistry()
    tools.register(defineTool({
      name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: {} }, execute: () => ({ ok: true }),
    }))
    const config = { provider: 'test', model: 'm' }
    const events: AgentRunEvent[] = []
    const hooks = { onRequestError: hook }
    const options = { mode: 'basic', registry, history, tools, config, maxTurns: 10, hooks, ...extra }
    for await (const event of runAgent(options as never)) events.push(event)
    return { adapter, end: events.at(-1), history }
  }
  const recorder = (decide: (ctx: RequestErrorContext) => 'retry' | 'fail' = () => 'retry') => {
    const seen: [number, number][] = []
    const hook = (ctx: RequestErrorContext) => { seen.push([ctx.consecutiveFailures, ctx.retries]); return decide(ctx) }
    return { seen, hook }
  }

  it('counts the forced final answer\'s failures after a successful tool round', async () => {
    const { seen, hook } = recorder()
    const { end } = await runWith([call('c1'), failed(), failed(), text('Forced.')], hook, { maxTurns: 1 })
    expect(seen).toEqual([[1, 0], [2, 1]])
    expect(end).toMatchObject({ outcome: { text: 'Forced.' } })
  })

  it('counts the structured-output finalizer\'s failures after the process round', async () => {
    const { seen, hook } = recorder()
    const { end } = await runWith([text('Evidence gathered.'), failed(), text('{"ok":true}')], hook,
      { outputFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } } })
    expect(seen).toEqual([[1, 0]])
    expect(end).toMatchObject({ outcome: { text: '{"ok":true}' } })
  })

  it('starts both counts over in the next turn of the same conversation', async () => {
    const { seen, hook } = recorder()
    const first = await runWith([failed(), failed(), text('One.')], hook)
    await runWith([failed(), text('Two.')], hook, {}, first.history)
    expect(seen).toEqual([[1, 0], [2, 1], [1, 0]])
  })

  it('keeps counting past the free-retry allowance, where retries start to cost steps', async () => {
    const { seen, hook } = recorder()
    const rounds = [...Array.from({ length: 10 }, () => failed()), text('Finally.')]
    const { end } = await runWith(rounds, hook, { maxTurns: 20 })
    expect(seen).toEqual(Array.from({ length: 10 }, (_, index) => [index + 1, index]))
    expect(end).toMatchObject({ outcome: { text: 'Finally.' } })
  })

  it('reserves room for the forced answer and its retry when requests cost more than the reserve', async () => {
    // Late in a long run every request carries the whole context. With a fixed
    // 50-token reserve and 150-token requests the forced answer used to start
    // past the wall (or overshoot it), so its transient failure had no retry
    // and a fully spent run ended with nothing for the person.
    const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 140, outputTokens: 10, totalTokens: 150 } }
    const withUsage = (round: readonly StreamChunk[]) => [...round.slice(0, -1), usage, round.at(-1)!]
    const { seen, hook } = recorder()
    const work = Array.from({ length: 5 }, (_, index) => withUsage(call(`c${index}`, JSON.stringify({ page: index }))))
    const rounds = [...work, failed(), withUsage(text('Answer.'))]
    const { adapter, end } = await runWith(rounds, hook,
      { maxTurns: 50, bounds: { maxTotalTokens: 1_000, finalReportReserveTokens: 50 } })
    expect(seen).toEqual([[1, 0]])
    expect(adapter.requests.at(-1)?.toolChoice).toBe('none')
    expect(end).toMatchObject({ outcome: { text: 'Answer.',
      reason: { kind: 'budget-exhausted', budget: 'tokens', forcedFinalAnswer: true, trigger: 'report-reserve' } } })
  })

  it('does not count a retry the step budget refused to run', async () => {
    // Past the free allowance every retry costs a step; with none left the
    // loop declines the hook's retry, and the turn ends on the failure.
    const { seen, hook } = recorder()
    const { adapter } = await runWith(Array.from({ length: 12 }, () => failed()), hook, { maxTurns: 2 })
    expect(seen.at(-1)?.[1]).toBe(adapter.requests.length - 1)
  })
})

describe('requestRetryHook', () => {
  const noWait = { wait: async () => undefined, random: () => 0.5 }

  it('gives each outage its own budget and caps the turn across outages', async () => {
    const hook = requestRetryHook({ policy: { mode: 'normal', maxRetries: 2 }, maxRetriesPerTurn: 3, ...noWait })
    expect(await hook(context(1, 0))).toBe('retry')
    expect(await hook(context(2, 1))).toBe('retry')
    expect(await hook(context(3, 2))).toBe('fail')
    // A success in between restores the outage budget, until the turn cap.
    expect(await hook(context(1, 2))).toBe('retry')
    expect(await hook(context(1, 3))).toBe('fail')
  })

  it('defaults the turn cap to three outages of the policy', async () => {
    const hook = requestRetryHook({ policy: { mode: 'normal', maxRetries: 2 }, ...noWait })
    expect(await hook(context(1, 5))).toBe('retry')
    expect(await hook(context(1, 6))).toBe('fail')
  })

  it('retries only the policy\'s codes and never an aborted request', async () => {
    const hook = requestRetryHook(noWait)
    expect(await hook(context(1, 0, { code: 'INVALID_REQUEST', message: 'bad' }))).toBe('fail')
    const aborted = new AbortController()
    aborted.abort()
    expect(await hook(context(1, 0, undefined, aborted.signal))).toBe('fail')
  })

  it('backs off exponentially, waits out a provider delay it accepts, and refuses a longer one', async () => {
    const waits: number[] = []
    const backoff = { initialDelayMs: 1_000, maxDelayMs: 8_000, jitterRatio: 0 }
    const wait = async (ms: number) => { waits.push(ms) }
    const hook = requestRetryHook({ policy: { mode: 'normal', maxRetries: 5, backoff }, wait })
    for (let failures = 1; failures <= 5; failures++) await hook(context(failures, failures - 1))
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 8_000])
    const rateLimited = (providerRetryAfterMs: number) =>
      context(1, 0, { code: 'RATE_LIMIT', message: 'slow', providerRetryAfterMs })
    expect(await hook(rateLimited(6_000))).toBe('retry')
    expect(waits.at(-1)).toBe(6_000)
    expect(await hook(rateLimited(60_000))).toBe('fail')
    // A short retry-after is a floor under the backoff, not a replacement for it.
    const retryAfterOne = context(4, 3, { code: 'SERVER', message: 'overloaded', providerRetryAfterMs: 1_000 })
    expect(await hook(retryAfterOne)).toBe('retry')
    expect(waits.at(-1)).toBe(8_000)
  })

  it('never retries what the loop decided, even under an always policy', async () => {
    const hook = requestRetryHook({ policy: { mode: 'always' }, ...noWait })
    for (const code of ['STEP_REJECTED', 'CHECKPOINT_FAILED', 'INVALID_TOOL_CALL']) {
      expect(await hook(context(1, 0, { code, message: 'decided' }))).toBe('fail')
    }
    expect(await hook(context(1, 0, { code: 'AUTH', message: 'provider said no' }))).toBe('retry')
  })

  it('fails rather than wait past a deadline', async () => {
    const hook = requestRetryHook({ policy: { mode: 'normal', backoff: { initialDelayMs: 1_000, jitterRatio: 0 } },
      deadlineAt: () => Date.now() + 500, ...noWait })
    expect(await hook(context(1, 0))).toBe('fail')
  })

  it('ends a real wait early on abort and reports fail', async () => {
    const controller = new AbortController()
    const backoff = { initialDelayMs: 60_000, maxDelayMs: 60_000 }
    const hook = requestRetryHook({ policy: { mode: 'normal', backoff } })
    const decision = hook(context(1, 0, undefined, controller.signal))
    controller.abort()
    expect(await decision).toBe('fail')
  })

  it('accepts a resolved policy and rejects an invalid turn cap', () => {
    const resolved = resolveRetryPolicy({ mode: 'normal', maxRetries: 1 }, 'test')
    expect(() => requestRetryHook({ policy: resolved })).not.toThrow()
    expect(() => requestRetryHook({ maxRetriesPerTurn: -1 })).toThrow(/maxRetriesPerTurn/)
  })

  it('drives a real run: a flapping provider is retried per outage, a stuck one given up on', async () => {
    const hook = requestRetryHook({ policy: { mode: 'normal', maxRetries: 1 }, ...noWait })
    const recovered = await run([failed(), call('c1'), failed(), text('Answer.')], hook)
    expect(recovered.end).toMatchObject({ outcome: { text: 'Answer.' } })
    const persistent = await run([failed(), failed(), text('Never.')], hook)
    expect(persistent.adapter.requests).toHaveLength(2)
    expect(persistent.end).toMatchObject({ outcome: { reason: { kind: 'error' } } })
  })
})
