import { describe, expect, it, vi } from 'vitest'
import {
  createAgentRuntime,
  createAssistantMessage,
  createTextMessage,
  defaultFailoverCooldownMs,
  failoverProviderPlugin,
  FAILOVER_POLICY,
  ModelAdapter,
  ModelError,
  normalizeModelFailure,
  withFailover,
  type FailoverEvent,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { codexPlugin, memoryCodexCredentialStore } from '@alvin0/ai-agent-sdk-provider-codex'

type Outcome = 'ok' | 'mid-stream' | { readonly code: string; readonly retryAfterMs?: number }

/** Replays one scripted outcome per call (the last repeats), recording each request. */
class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly name: string, private readonly outcomes: readonly Outcome[]) { super() }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const outcome = this.outcomes[Math.min(this.requests.length, this.outcomes.length - 1)]!
    this.requests.push(options)
    const name = this.name
    return (async function * () {
      if (typeof outcome === 'object') {
        throw new ModelError(`${name} failed`, outcome.code,
          outcome.retryAfterMs === undefined ? undefined : { providerRetryAfterMs: outcome.retryAfterMs })
      }
      yield { type: 'text-delta', index: 0, text: `from ${name}` }
      if (outcome === 'mid-stream') throw new ModelError(`${name} broke mid-stream`, 'SERVER')
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

const request: GenerateOptions = { provider: 'llm', model: 'model-x', messages: [createTextMessage('hi')] }

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function text(chunks: readonly StreamChunk[]): string {
  return chunks.flatMap(chunk => chunk.type === 'text-delta' ? [chunk.text] : []).join('')
}

function failureCode(chunks: readonly StreamChunk[]): string | undefined {
  const last = chunks.at(-1)
  return last?.type === 'finish' && last.reason.kind !== 'stop' && 'failure' in last.reason
    ? last.reason.failure.code : undefined
}

function setup(primary: readonly Outcome[], backup: readonly Outcome[], third?: readonly Outcome[]) {
  let clock = 1_000
  const events: FailoverEvent[] = []
  const a = new ScriptedAdapter('a', primary)
  const b = new ScriptedAdapter('b', backup)
  const c = third === undefined ? undefined : new ScriptedAdapter('c', third)
  const adapter = withFailover([
    { adapter: a, provider: 'acct-a' },
    { adapter: b, provider: 'acct-b', model: 'model-b' },
    ...c === undefined ? [] : [{ adapter: c, provider: 'api-c', id: 'api' }],
  ], { now: () => clock, onFailover: event => { events.push(event) } })
  return { adapter, a, b, c, events, advance: (ms: number) => { clock += ms } }
}

describe('withFailover', () => {
  it('moves a call to the next member, cools the failed one down, and returns to it afterwards', async () => {
    const { adapter, a, b, events, advance } = setup([{ code: 'AUTH' }, 'ok'], ['ok'])
    expect(text(await drain(adapter.stream(request)))).toBe('from b')
    // The backup is asked for its own model id under its own route.
    expect(b.requests[0]).toMatchObject({ provider: 'acct-b', model: 'model-b' })
    expect(events).toEqual([expect.objectContaining({ provider: 'llm', from: 'acct-a', to: 'acct-b',
      cooldownMs: FAILOVER_POLICY.authCooldownMs })])
    // While it cools down, calls go straight to the backup.
    expect(text(await drain(adapter.stream(request)))).toBe('from b')
    expect(a.requests).toHaveLength(1)
    advance(FAILOVER_POLICY.authCooldownMs)
    expect(text(await drain(adapter.stream(request)))).toBe('from a')
    expect(a.requests).toHaveLength(2)
  })

  it('uses the provider retry-after for a quota or rate limit, and the defaults otherwise', async () => {
    const { adapter, events } = setup([{ code: 'QUOTA', retryAfterMs: 3_600_000 }], [{ code: 'SERVER' }], ['ok'])
    expect(text(await drain(adapter.stream(request)))).toBe('from c')
    expect(events.map(event => [event.from, event.to, event.cooldownMs])).toEqual([
      ['acct-a', 'acct-b', 3_600_000], ['acct-b', 'api', FAILOVER_POLICY.transientCooldownMs]])
  })

  it('never re-runs a call that already streamed content, nor one no member could accept', async () => {
    const midStream = setup(['mid-stream'], ['ok'])
    const chunks: StreamChunk[] = []
    await (async () => { for await (const chunk of midStream.adapter.stream(request)) chunks.push(chunk) })()
      .catch(() => undefined)
    expect(midStream.b.requests).toHaveLength(0)
    // The content arrived once, from the member that streamed it.
    expect(text(chunks)).toBe('from a')

    const invalid = setup([{ code: 'INVALID_REQUEST' }], ['ok'])
    expect(failureCode(await drain(invalid.adapter.stream(request)))).toBe('INVALID_REQUEST')
    expect(invalid.b.requests).toHaveLength(0)
    expect(invalid.events).toHaveLength(0)
  })

  it('still tries every member when all are cooling down, soonest-recovering first', async () => {
    const { adapter, a, b, events } = setup([{ code: 'RATE_LIMIT', retryAfterMs: 60_000 }], [{ code: 'RATE_LIMIT', retryAfterMs: 1_000 }])
    expect(failureCode(await drain(adapter.stream(request)))).toBe('RATE_LIMIT')
    expect(events.at(-1)?.to).toBeUndefined()
    await drain(adapter.stream(request))
    expect([a.requests.length, b.requests.length]).toEqual([2, 2])
    expect(events.slice(2).map(event => event.from)).toEqual(['acct-b', 'acct-a'])
  })

  it('reports cancellation as aborted without moving on', async () => {
    const { adapter, b } = setup([{ code: 'ABORTED' }], ['ok'])
    const last = (await drain(adapter.stream(request))).at(-1)
    expect(last).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(b.requests).toHaveLength(0)
  })

  it('skips a later member that cannot accept the request, without cooling it down, and reports the first failure',
    async () => {
    const skipped = setup([{ code: 'QUOTA' }], [{ code: 'INVALID_REQUEST' }, 'ok'], ['ok'])
    expect(text(await drain(skipped.adapter.stream(request)))).toBe('from c')
    expect(skipped.events.map(event => event.from)).toEqual(['acct-a'])
    // Not cooled down: the next call tries it before the third member.
    expect(text(await drain(skipped.adapter.stream(request)))).toBe('from b')

    const reported = setup([{ code: 'QUOTA' }], [{ code: 'INVALID_REQUEST' }])
    expect(failureCode(await drain(reported.adapter.stream(request)))).toBe('QUOTA')
  })

  it('keeps the longest cooldown when concurrent calls trip one member', async () => {
    const { adapter, a, b, advance } = setup([{ code: 'QUOTA', retryAfterMs: 3_600_000 }, { code: 'RATE_LIMIT', retryAfterMs: 1_000 }],
      [{ code: 'SERVER' }, { code: 'SERVER' }, 'ok'])
    await drain(adapter.stream(request))
    // Every member cooling: the soonest-recovering (b) first, then a, whose short rate limit must not shorten its quota.
    await drain(adapter.stream(request))
    advance(11_000)
    expect(text(await drain(adapter.stream(request)))).toBe('from b')
    expect(a.requests).toHaveLength(2)
    expect(b.requests).toHaveLength(3)
  })

  it('does not let a success that started before a failure clear that failure\'s cooldown', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const a = new (class extends ModelAdapter {
      stream(): AsyncIterable<StreamChunk> {
        const call = ++calls
        return (async function * () {
          if (call === 1) await gate
          else throw new ModelError('a rejected', 'AUTH')
          yield { type: 'text-delta', index: 0, text: 'from a' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
    })()
    const b = new ScriptedAdapter('b', ['ok'])
    const adapter = withFailover([{ adapter: a, provider: 'a' }, { adapter: b, provider: 'b' }])
    const slow = drain(adapter.stream(request))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(text(await drain(adapter.stream(request)))).toBe('from b')
    release()
    expect(text(await slow)).toBe('from a')
    // a's credentials were rejected after the slow call started: it stays cooled down.
    expect(text(await drain(adapter.stream(request)))).toBe('from b')
    expect(calls).toBe(2)
  })

  it('does not start with a prepared member that another call cooled down in the meantime', async () => {
    const { adapter, a, b } = setup([{ code: 'AUTH' }, 'ok'], ['ok', 'ok'])
    const prepared = await adapter.prepareCall('llm', 'model-x')
    // Another call trips a before the prepared one streams.
    expect(text(await drain(adapter.stream(request)))).toBe('from b')
    expect(text(await drain(prepared.stream(request)))).toBe('from b')
    expect(a.requests).toHaveLength(1)
    expect(b.requests).toHaveLength(2)
  })

  it('returns a prepared call to the first member once it recovered before the call streamed', async () => {
    const { adapter, a, b, advance } = setup([{ code: 'AUTH' }, 'ok'], ['ok', 'ok'])
    expect(text(await drain(adapter.stream(request)))).toBe('from b')
    const prepared = await adapter.prepareCall('llm', 'model-x')
    advance(FAILOVER_POLICY.authCooldownMs)
    expect(text(await drain(prepared.stream(request)))).toBe('from a')
    expect([a.requests.length, b.requests.length]).toEqual([2, 1])
  })

  it('requires distinct member ids, which key each member\'s replay state', () => {
    const one = new ScriptedAdapter('a', ['ok']), two = new ScriptedAdapter('b', ['ok'])
    expect(() => withFailover([{ adapter: one, provider: 'codex' }, { adapter: two, provider: 'codex' }]))
      .toThrow(/distinct ids/)
    expect(() => withFailover([{ adapter: one, provider: 'codex', id: 'main' }, { adapter: two, provider: 'codex' }]))
      .not.toThrow()
  })

  it('names only an untried member as the next one when preparing fails', async () => {
    const broken = (name: string) => new (class extends ScriptedAdapter {
      override prepareCall(): never { throw new ModelError(`${name} down`, 'SERVER') }
    })(name, ['ok'])
    const events: FailoverEvent[] = []
    const adapter = withFailover(['a', 'b', 'c'].map(name => ({ adapter: broken(name), provider: name })),
      { onFailover: event => { events.push(event) } })
    await expect(adapter.prepareCall('llm', 'model-x')).rejects.toThrow(/a down/)
    expect(events.map(event => [event.from, event.to])).toEqual([['a', 'b'], ['b', 'c'], ['c', undefined]])
  })

  it('gives replay state back only to the member that produced it', async () => {
    class ReplayAdapter extends ScriptedAdapter {
      override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const inner = super.stream(options)
        return (async function * () {
          for await (const chunk of inner) {
            yield chunk.type === 'finish' ? { ...chunk, replayState: { response: 'state-a' } } : chunk
          }
        })()
      }
    }
    const a = new ReplayAdapter('a', ['ok', { code: 'AUTH' }, 'ok'])
    const b = new ScriptedAdapter('b', ['ok'])
    let clock = 0
    const adapter = withFailover([{ adapter: a, provider: 'acct-a' }, { adapter: b, provider: 'acct-b' }], { now: () => clock })
    const finish = (await drain(adapter.stream(request))).at(-1)
    const replayState = finish?.type === 'finish' ? finish.replayState : undefined
    expect(replayState).toBeDefined()
    const history: Message[] = [
      ...request.messages,
      createAssistantMessage({ content: [{ type: 'text', text: 'from a' }],
        source: { provider: 'llm', model: 'model-x', replayState } }),
      createTextMessage('more'),
    ]
    const sourceOf = (options: GenerateOptions) => options.messages[1]!.source as { replayState?: unknown }
    // a fails, b serves the call: b never sees a's state.
    await drain(adapter.stream({ ...request, messages: history }))
    expect(sourceOf(b.requests[0]!).replayState).toBeUndefined()
    expect(sourceOf(a.requests[1]!).replayState).toEqual({ response: 'state-a' })
    clock += FAILOVER_POLICY.authCooldownMs
    await drain(adapter.stream({ ...request, messages: history }))
    expect(sourceOf(a.requests[2]!).replayState).toEqual({ response: 'state-a' })
  })

  it('does not cool down a lock or conflict around credentials as a rejected login', () => {
    const cooldown = (code: string) => defaultFailoverCooldownMs(normalizeModelFailure(new ModelError('x', code)))
    expect(cooldown('CODEX_REAUTH_REQUIRED')).toBe(FAILOVER_POLICY.authCooldownMs)
    expect(cooldown('AUTH_STORE_LOCK_TIMEOUT')).toBe(FAILOVER_POLICY.transientCooldownMs)
    expect(cooldown('CREDENTIAL_CONFLICT')).toBe(FAILOVER_POLICY.transientCooldownMs)
  })

  it('stops listing or resolving models when the caller aborts', async () => {
    const failing = new (class extends ScriptedAdapter {
      override async listModels(): Promise<never> { throw new ModelError('aborted', 'ABORTED') }
      override async resolveModel(): Promise<never> { throw new ModelError('aborted', 'ABORTED') }
    })('a', ['ok'])
    const listed = vi.fn(async () => [{ id: 'm', name: 'm', provider: 'b' }])
    const backup = new (class extends ScriptedAdapter { override listModels = listed })('b', ['ok'])
    const adapter = withFailover([{ adapter: failing, provider: 'a' }, { adapter: backup, provider: 'b' }])
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.listModels('llm', controller.signal)).rejects.toThrow(/aborted/)
    await expect(adapter.resolveModel('llm', 'm', controller.signal)).rejects.toThrow(/aborted/)
    expect(listed).not.toHaveBeenCalled()
  })

  it('fails over when a member cannot even be prepared (e.g. missing credentials)', async () => {
    const broken = new (class extends ScriptedAdapter {
      override prepareCall(): never { throw new ModelError('no credentials', 'CODEX_REAUTH_REQUIRED') }
    })('a', ['ok'])
    const backup = new ScriptedAdapter('b', ['ok'])
    const events: FailoverEvent[] = []
    const adapter = withFailover([{ adapter: broken, provider: 'a' }, { adapter: backup, provider: 'b' }],
      { onFailover: event => { events.push(event) } })
    const prepared = await adapter.prepareCall('llm', 'model-x')
    expect(prepared.model).toMatchObject({ provider: 'llm', id: 'model-x' })
    expect(text(await drain(prepared.stream(request)))).toBe('from b')
    expect(events[0]).toMatchObject({ from: 'a', to: 'b', cooldownMs: FAILOVER_POLICY.authCooldownMs })
  })
})

describe('failoverProviderPlugin', () => {
  it('serves an agent route from private member plugins, switching accounts or providers on failure', async () => {
    const primary = new ScriptedAdapter('primary', [{ code: 'AUTH' }])
    const backup = new ScriptedAdapter('backup', ['ok'])
    const member = (id: string, adapter: ModelAdapter) => defineModelProviderPlugin({
      id, displayName: id, routes: [id], setup(registrar) { registrar.registerAdapter(adapter); return undefined },
    })
    const events: FailoverEvent[] = []
    const runtime = await createAgentRuntime({ providers: [failoverProviderPlugin({
      id: 'llm', defaultModel: 'model-x', onFailover: event => { events.push(event) },
      members: [{ plugin: member('codex-main', primary) }, { plugin: member('openai-api', backup), model: 'model-y' }],
    })] })
    try {
      // Member routes stay private: only the failover route is exposed.
      expect(runtime.providers().map(provider => provider.route)).toEqual(['llm'])
      const session = runtime.agent({ id: 'a', instructions: 'x', compaction: false, maxTurns: 1 }).createSession()
      const result = await session.run('hi')
      expect(result.text).toBe('from backup')
      expect(backup.requests[0]).toMatchObject({ provider: 'openai-api', model: 'model-y' })
      expect(events).toEqual([expect.objectContaining({ provider: 'llm', from: 'codex-main', to: 'openai-api' })])
    } finally { await runtime.close() }
  })

  it('reports a member cleanup failure after running the others, and rejects an async member setup', async () => {
    const order: string[] = []
    const member = (id: string, fail: boolean) => defineModelProviderPlugin({
      id, displayName: id, routes: [id], setup(registrar) {
        registrar.registerAdapter(new ScriptedAdapter(id, ['ok']))
        return () => {
          order.push(id)
          if (fail) throw new Error(`${id} cleanup failed`)
        }
      },
    })
    const runtime = await createAgentRuntime({ providers: [failoverProviderPlugin({
      id: 'llm', members: [{ plugin: member('first', true) }, { plugin: member('second', false) }],
    })] })
    // Both cleanups run; the failure is reported, not swallowed.
    expect((await runtime.close()).components).toEqual([
      expect.objectContaining({ kind: 'provider-registration', status: 'failed' })])
    expect(order).toEqual(['second', 'first'])

    let lateCleanup = 0
    const asyncMember = {
      id: 'async', displayName: 'async', routes: ['async'],
      setup: async () => () => { lateCleanup++ },
    } as unknown as Parameters<typeof failoverProviderPlugin>[0]['members'][number]['plugin']
    await expect(createAgentRuntime({ providers: [failoverProviderPlugin({ id: 'llm', members: [{ plugin: asyncMember }] })] }))
      .rejects.toThrow()
    await vi.waitFor(() => expect(lateCleanup).toBe(1))
  })

  it('keys members by plugin id when several plugins serve the same route', async () => {
    const member = (id: string, adapter: ModelAdapter) => defineModelProviderPlugin({
      id, displayName: id, routes: ['codex'], setup(registrar) { registrar.registerAdapter(adapter); return undefined },
    })
    const events: FailoverEvent[] = []
    const runtime = await createAgentRuntime({ providers: [failoverProviderPlugin({
      id: 'llm', defaultModel: 'model-x', onFailover: event => { events.push(event) },
      members: [{ plugin: member('codex-a', new ScriptedAdapter('a', [{ code: 'AUTH' }])) },
        { plugin: member('codex-b', new ScriptedAdapter('b', ['ok'])) }],
    })] })
    try {
      const session = runtime.agent({ id: 'a', instructions: 'x', compaction: false, maxTurns: 1 }).createSession()
      expect((await session.run('hi')).text).toBe('from b')
      expect(events).toEqual([expect.objectContaining({ from: 'codex-a', to: 'codex-b' })])
    } finally { await runtime.close() }
  })

  it('rejects members it cannot tell apart', () => {
    const plugin = defineModelProviderPlugin({ id: 'same', displayName: 'x', routes: ['same'], setup: () => undefined })
    expect(() => failoverProviderPlugin({ id: 'llm', members: [{ plugin }, { plugin }] })).toThrow(/distinct ids/)
    expect(() => failoverProviderPlugin({ id: 'llm', members: [] })).toThrow(/at least one member/)
  })
})

describe('failoverProviderPlugin over real Codex accounts', () => {
  const frames = [
    'data: {"type":"response.created","response":{"id":"r1"}}',
    'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
    'data: {"type":"response.output_text.delta","item_id":"i1","delta":"backup ok"}',
    'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message","content":[{"type":"output_text","text":"backup ok"}]}}',
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
  ]

  function jwt(payload: Record<string, unknown>): string {
    const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    return `e30.${encoded}.signature`
  }

  // Fixed once, so the token a store holds and the one the test matches are the same string.
  const expiresAt = Math.floor(Date.now() / 1_000) + 3_600
  const accessToken = (name: string) => jwt({ exp: expiresAt, sub: name })

  function account(name: string) {
    return memoryCodexCredentialStore({ tokens: {
      id_token: jwt({}), access_token: accessToken(name), refresh_token: `refresh-${name}`,
    } })
  }

  it.each([
    ['an exhausted usage limit', 429, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }, 'QUOTA'],
    ['rejected credentials', 401, { error: { message: 'token revoked' } }, 'AUTH'],
  ])('moves to the backup account on %s', async (_name, status, body, code) => {
    const calls: string[] = []
    const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('authorization') ?? ''
      const who = token === `Bearer ${accessToken('main')}` ? 'main' : 'backup'
      calls.push(who)
      return who === 'main'
        ? Response.json(body, { status })
        : new Response(`${frames.join('\n\n')}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof globalThis.fetch
    const models = [{ id: 'gpt-x', name: 'gpt-x' }]
    const events: FailoverEvent[] = []
    const runtime = await createAgentRuntime({ providers: [failoverProviderPlugin({
      id: 'codex', defaultModel: 'gpt-x', onFailover: event => { events.push(event) },
      members: [
        { plugin: codexPlugin({ id: 'codex-main', authStore: account('main'), fetch, models }) },
        { plugin: codexPlugin({ id: 'codex-backup', authStore: account('backup'), fetch, models }) },
      ],
    })] })
    try {
      const session = runtime.agent({ id: 'a', instructions: 'x', compaction: false, maxTurns: 1 }).createSession()
      expect((await session.run('hi')).text).toBe('backup ok')
      expect(events).toEqual([expect.objectContaining({ from: 'codex-main', to: 'codex-backup' })])
      expect(events[0]!.failure.code).toBe(code)
      // The main account cools down: the next call goes straight to the backup.
      await session.run('again')
      expect(calls).toEqual(['main', 'backup', 'backup'])
    } finally { await runtime.close() }
  })
})
