import { TeamResults } from '../../packages/core/src/agent/team/team-results.ts'
import { describe, expect, it, vi } from 'vitest'
import { AgentTeam, createManagedAgentTeam, defineAgent } from '../../packages/core/src/agent/index.ts'
import type { ManagedAgentTeam, ManagedAgentTeamOptions, ToolDefinition, ToolRegistry,
  ToolRunContext } from '../../packages/core/src/agent/index.ts'
import { ModelAdapter, ModelRegistry, ReasoningEffortId } from '../../packages/core/src/index.ts'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '../../packages/core/src/index.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class Controlled extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly starts = new Map<number, ReturnType<typeof deferred<void>>>()
  private readonly finishes = new Map<number, ReturnType<typeof deferred<string>>>()
  private workerRound = 0
  leadReply?: (options: GenerateOptions) => Promise<readonly StreamChunk[]>
  private gate<T>(map: Map<number, ReturnType<typeof deferred<T>>>, index: number) {
    let gate = map.get(index)
    if (gate === undefined) { gate = deferred<T>(); map.set(index, gate) }
    return gate
  }
  started(index: number) { return this.gate(this.starts, index).promise }
  finish(index: number, text = `result-${index}`) { this.gate(this.finishes, index).resolve(text) }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const effort = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: effort, name: effort }] } })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.tools?.some(tool => tool.name === 'spawn_agent') && this.leadReply !== undefined) {
      yield * await this.leadReply(options)
      return
    }
    let text = 'synthesis'
    if (!options.tools?.some(tool => tool.name === 'spawn_agent')) {
      const round = ++this.workerRound
      this.gate(this.starts, round).resolve()
      const signal = options.signal!
      const abort = deferred<string>()
      const onAbort = () => abort.resolve('')
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        signal.throwIfAborted()
        text = await Promise.race([this.gate(this.finishes, round).promise, abort.promise])
        signal.throwIfAborted()
        if (text === 'fail') throw new Error('worker failed')
      } finally { signal.removeEventListener('abort', onAbort) }
    }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: text === 'partial' ? 'max-tokens' : 'stop' } }
  }
}

function fixture(options: Partial<ManagedAgentTeamOptions> = {}) {
  const adapter = new Controlled()
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const team = createManagedAgentTeam({ registry, holdWaitMs: 100, workerTimeoutMs: 2000,
    team: { minWaitTimeoutMs: 10, waitTimeoutMs: 1000 },
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve it.' }),
    ...options,
  })
  return { adapter, team }
}

function tool(team: ManagedAgentTeam, name: string): ToolDefinition<any> {
  const controls = team.lead.options.tools as ToolRegistry
  return controls.get(name) ?? team.lead.options.team!.team.toolsFor('lead').find(tool => tool.name === name)!
}

function call(team: ManagedAgentTeam, name: string, args: unknown, signal = new AbortController().signal) {
  const definition = tool(team, name)
  return definition.execute(definition.parse!(args), { signal } as ToolRunContext)
}

function reports(team: ManagedAgentTeam, result: string) {
  return team.team.messages().filter(message => message.target === 'lead' && message.content.some(block =>
    block.type === 'text' && block.text.includes(result)))
}

describe('lean managed model surface', () => {
  it('offers batch and single spawning with one reporting verb with compact JSON results', async () => {
    const { adapter, team } = fixture({ progressiveToolDisclosure: false })
    try {
      await team.run('work')
      expect(adapter.requests[0]!.tools!.map(tool => tool.name)).toEqual([
        'spawn_agent', 'spawn_agents', 'close_agent',
        'send_input', 'wait_agents', 'get_agent_result',
      ])
      expect(JSON.stringify(adapter.requests[0])).not.toMatch(/cancelRunning|list_agents|followup_task/)
      const spawn = await call(team, 'spawn_agent', { task: 'check it' })
      expect(spawn).toEqual({ target: 'worker_1', status: 'running' })
      await adapter.started(1)
      expect(adapter.requests[1]!.tools!.map(tool => tool.name)).toEqual(['send_input'])
      const rendered = tool(team, 'spawn_agent').render!(spawn!, { task: 'check it' })
      expect(rendered).toEqual([{ type: 'text', text: '{"target":"worker_1","status":"running"}' }])
      const waiting = call(team, 'wait_agents', {})
      adapter.finish(1)
      await team.awaitWorker('worker_1')
      expect(await waiting).toEqual({
        results: [{ target: 'worker_1', status: 'completed', result: 'result-1' }], timed_out: false,
      })
      expect(await call(team, 'close_agent', { target: 'worker_1' })).toEqual({ target: 'worker_1', closed: true })
      expect(await call(team, 'wait_agents', {})).toEqual({ results: [], timed_out: false })
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('queues each follow-up once and joins its results without duplicate notices', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      expect(await call(team, 'send_input', { target: 'worker', message: 'second' }))
        .toEqual({ target: 'worker', accepted: true })
      await call(team, 'send_input', { target: 'worker', message: 'queued/third/task' })
      const waiting = call(team, 'wait_agents', {})
      let quiet = false
      const joined = team.whenQuiet().then(() => { quiet = true })
      adapter.finish(1)
      await adapter.started(2)
      expect(quiet).toBe(false)
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('second')
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain('queued/third/task')
      adapter.finish(2)
      await adapter.started(3)
      expect(quiet).toBe(false)
      adapter.finish(3)
      await joined
      expect(await waiting).toEqual({ results: [1, 2, 3].map(index => ({ target: 'worker',
        status: 'completed', result: `result-${index}` })), timed_out: false })
      expect(reports(team, 'result-1')).toHaveLength(0)
      for (const result of ['result-2', 'result-3']) expect(reports(team, result)).toHaveLength(0)
      // A host-only join consumed all evidence, so no duplicate lead wake is due.
      expect(adapter.requests.filter(request => request.tools?.some(tool => tool.name === 'spawn_agent')))
        .toHaveLength(0)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('redirects a running worker and reports the new result without its old failure', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      await call(team, 'send_input', { target: 'worker', message: 'replacement', interrupt: true })
      await adapter.started(2)
      const waiting = call(team, 'wait_agents', {})
      adapter.finish(2)
      await team.whenQuiet()
      expect(await waiting).toEqual({
        results: [{ target: 'worker', status: 'completed', result: 'result-2' }], timed_out: false,
      })
      expect(reports(team, 'result-2')).toHaveLength(0)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('redirects a pending worker without waiting for its producer', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'producer', task: 'produce' })
      await adapter.started(1)
      await team.spawn({ name: 'worker', task: 'first', dependsOn: ['producer'] })
      await call(team, 'send_input', { target: 'worker', message: 'replacement', interrupt: true })
      await adapter.started(2)
      adapter.finish(2)
      expect(await call(team, 'wait_agents', { targets: ['worker'] })).toEqual({
        results: [{ target: 'worker', status: 'completed', result: 'result-2' }], timed_out: false,
      })
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it.each(['notice', 'wait'])('skips A delivered by %s and blocks for B without repeats', async delivery => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'A', task: 'first' })
      const firstWait = delivery === 'wait' ? call(team, 'wait_agents', {}) : undefined
      adapter.finish(1)
      await team.awaitWorker('A')
      if (firstWait !== undefined) {
        expect(await firstWait).toMatchObject({ results: [{ target: 'A', result: 'result-1' }] })
      }
      expect(reports(team, 'result-1')).toHaveLength(delivery === 'notice' ? 1 : 0)
      if (delivery === 'notice') await team.run('Read the completed result.')
      await team.spawn({ name: 'B', task: 'second' })
      await adapter.started(2)
      let returned = false
      const waiting = Promise.resolve(call(team, 'wait_agents', {})).then(result => { returned = true; return result })
      // A bounded wait proves the idle A cannot resolve an omitted-target wait.
      expect(await call(team, 'wait_agents', { targets: ['A'], timeout_ms: 10 }))
        .toEqual({ results: [], timed_out: false })
      expect(returned).toBe(false)
      adapter.finish(2)
      expect(await waiting).toEqual({ results: [{ target: 'B', status: 'completed', result: 'result-2' }],
        timed_out: false })
      await team.awaitWorker('B')
      expect(reports(team, 'result-2')).toHaveLength(0)
      expect(await call(team, 'wait_agents', { timeout_ms: 10 }))
        .toEqual({ results: [], timed_out: false })
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it.each(['steering', 'timeout'] as const)('keeps a result captured just before join %s', async interruption => {
    const { adapter, team } = fixture({ autoLeadCoordination: false })
    const deadline = new AbortController()
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms =>
      ms === 1000 ? deadline.signal : nativeTimeout(ms))
    const originalTake = TeamResults.prototype.take
    let claimed = false
    const takeSpy = vi.spyOn(TeamResults.prototype, 'take').mockImplementation(function (this: TeamResults,
      recipient, members, budget) {
      const results = originalTake.call(this, recipient, members, budget)
      if (!claimed && recipient === 'lead' && results.some(result => result.worker === 'B')) {
        claimed = true
        if (interruption === 'steering') team.steer('correction')
        else deadline.abort(new DOMException('wait expired', 'TimeoutError'))
      }
      return results
    })
    try {
      await team.spawn({ name: 'A', task: 'first' })
      await team.spawn({ name: 'B', task: 'second' })
      await adapter.started(2)
      const waiting = call(team, 'wait_agents', { targets: ['A', 'B'] })
      adapter.finish(2)
      expect(await waiting).toMatchObject({ results: [{ target: 'B', result: 'result-2' }],
        timed_out: interruption === 'timeout' })
      expect(claimed).toBe(true)
      await team.awaitWorker('B')
      expect(reports(team, 'result-2')).toHaveLength(0)
      expect(await call(team, 'wait_agents', { targets: ['B'] })).toEqual({ results: [], timed_out: false })
    } finally { takeSpy.mockRestore(); timeoutSpy.mockRestore(); await team.dispose(); await team.team.dispose() }
  })

  it('makes a closing held replacement terminal before releasing its dependent', async () => {
    const finishClose = deferred<void>()
    let delayClose = false
    class SlowCloseTeam extends AgentTeam {
      override async cancel(target: string, reason?: unknown) {
        await super.cancel(target, reason)
        if (target === 'held' && delayClose) await finishClose.promise
      }
    }
    const { adapter, team } = fixture({ team: new SlowCloseTeam() })
    try {
      await team.spawn({ name: 'producer', task: 'produce' })
      await adapter.started(1)
      await team.spawn({ name: 'held', task: 'original', dependsOn: ['producer'] })
      await team.spawn({ name: 'dependent', task: 'consume', dependsOn: ['held'] })
      await call(team, 'send_input', { target: 'held', message: 'replacement', interrupt: true })
      await adapter.started(2)
      const observed = team.awaitWorker('held').then(() => {
        expect(team.workers().find(worker => worker.name === 'held')?.status).toBe('closed')
      })
      delayClose = true
      const closing = team.closeWorker('held')
      await observed
      await adapter.started(3)
      expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('closed')
      finishClose.resolve()
      await closing
      adapter.finish(1)
      adapter.finish(3)
      await team.whenQuiet()
    } finally { finishClose.resolve(); await team.dispose(); await team.team.dispose() }
  })

  it.each(['result-2', 'fail'])('holds redirected-worker dependents until replacement settles (%s)', async result => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'producer', task: 'produce' })
      await adapter.started(1)
      await team.spawn({ name: 'held', task: 'original', dependsOn: ['producer'] })
      await team.spawn({ name: 'dependent', task: 'consume', dependsOn: ['held'] })
      await call(team, 'send_input', { target: 'held', message: 'replacement', interrupt: true })
      await adapter.started(2)
      expect(team.workers().find(worker => worker.name === 'dependent')!.status).toBe('pending')
      expect(await team.awaitWorker('held', { timeoutMs: 10 })).toBeUndefined()
      adapter.finish(1)
      await team.awaitWorker('producer')
      expect(team.workers().find(worker => worker.name === 'dependent')!.status).toBe('pending')
      adapter.finish(2, result)
      await adapter.started(3)
      expect(JSON.stringify(adapter.requests[2]!.messages)).toContain(result === 'fail' ? 'worker failed' : result)
      expect(JSON.stringify(adapter.requests[2]!.messages)).not.toContain('work redirected')
      if (result === 'fail') {
        expect(team.workers().find(worker => worker.name === 'held')).toMatchObject({ status: 'failed' })
      } else expect(await team.awaitWorker('held')).toMatchObject({ succeeded: true, text: result })
      adapter.finish(3)
      await team.whenQuiet()
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('keeps dependents held across a second redirect of replacement work', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'producer', task: 'produce' })
      await adapter.started(1)
      await team.spawn({ name: 'held', task: 'original', dependsOn: ['producer'] })
      await team.spawn({ name: 'dependent', task: 'consume', dependsOn: ['held'] })
      await call(team, 'send_input', { target: 'held', message: 'replacement one', interrupt: true })
      await adapter.started(2)
      await call(team, 'send_input', { target: 'held', message: 'replacement two', interrupt: true })
      await adapter.started(3)
      expect(team.workers().find(worker => worker.name === 'dependent')!.status).toBe('pending')
      adapter.finish(3)
      await adapter.started(4)
      expect(JSON.stringify(adapter.requests[3]!.messages)).toContain('result-3')
      expect(JSON.stringify(adapter.requests[3]!.messages)).not.toContain('work redirected')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('injects a fallback notice once and retains explicit pages when mailbox delivery fails', async () => {
    class NoNoticeTeam extends AgentTeam {
      override sendMessage(request: Parameters<AgentTeam['sendMessage']>[0]) {
        if (request.from === 'worker' && request.target === 'lead') return Promise.reject(new Error('mailbox unavailable'))
        return super.sendMessage(request)
      }
    }
    const { adapter, team } = fixture({ team: new NoNoticeTeam() })
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      adapter.finish(1)
      await team.awaitWorker('worker')
      expect(await call(team, 'wait_agents', {})).toEqual({ results: [], timed_out: false })
      const read = await call(team, 'get_agent_result', { target: 'worker' })
      expect(JSON.stringify(read)).toContain('result-1')
      await team.run('Read retained evidence')
      const notices = adapter.requests.at(-1)!.messages.filter(message => message.source.kind === 'app')
      expect(notices.filter(message => JSON.stringify(message.content).includes('result-1'))).toHaveLength(1)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('keeps remote peers available to the host but unreachable from every lean access level', async () => {
    const { adapter, team } = fixture()
    try {
      team.team.linkAgent({ name: 'remote', transport: { protocol: 'fixture', agentId: 'remote',
        send: async () => ({ kind: 'message', succeeded: true, text: 'remote result', contextId: 'remote' }),
      } })
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      const port = team.lead.options.team!.team
      for (const access of ['full', 'reporting'] as const) {
        const sending = port.toolsFor('worker', access).find(tool => tool.name === 'send_input')!
        await expect(sending.execute(sending.parse!({ target: 'remote', message: 'hello' }),
          { signal: new AbortController().signal } as ToolRunContext)).rejects.toThrow('unknown worker')
      }
      await expect(call(team, 'wait_agents', { targets: ['remote'] })).rejects.toThrow('unknown worker')
      await expect(call(team, 'get_agent_result', { target: 'remote' })).rejects.toThrow('unknown worker')
      expect(await team.team.followup('lead', 'remote', 'host task'))
        .toMatchObject({ result: { text: 'remote result' } })
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it.each(['host-first', 'model-first'])('binds concurrent host and model follow-ups to their own outcomes (%s)', async order => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      adapter.finish(1)
      await team.awaitWorker('worker')
      await call(team, 'wait_agents', { targets: ['worker'] })
      if (order === 'host-first') {
        await team.team.followup('lead', 'worker', 'host task')
        await adapter.started(2)
        await call(team, 'send_input', { target: 'worker', message: 'model task' })
        adapter.finish(2, 'host result')
        await adapter.started(3)
      } else {
        await call(team, 'send_input', { target: 'worker', message: 'model task' })
        await adapter.started(2)
        await team.team.followup('lead', 'worker', 'host task')
      }
      const waiting = call(team, 'wait_agents', {})
      const modelRound = order === 'host-first' ? 3 : 2
      adapter.finish(modelRound, 'model result')
      if (order === 'model-first') {
        await adapter.started(3)
        adapter.finish(3, 'host result')
      }
      const delivered = await waiting as { results: { result?: string }[] }
      expect(delivered.results).toEqual(expect.arrayContaining([expect.objectContaining({ result: 'model result' })]))
      await team.whenQuiet()
      const hostDelivered = delivered.results.filter(result => result.result === 'host result').length
      expect(hostDelivered + reports(team, 'host result').length).toBe(1)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it.each([false, true])('close cancels queued and active work (model cancellation allowed=%s)', async allowed => {
    const { adapter, team } = fixture({ allowModelWorkerCancellation: allowed })
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      await call(team, 'send_input', { target: 'worker', message: 'second' })
      const closed = await call(team, 'close_agent', { target: 'worker' })
      if (allowed) {
        expect(closed).toEqual({ target: 'worker', closed: true })
        await team.whenQuiet()
        expect(adapter.requests).toHaveLength(1)
      } else {
        expect(closed).toMatchObject({ target: 'worker', closed: false, status: 'running' })
        expect(await call(team, 'send_input', { target: 'worker', message: 'redirect', interrupt: true }))
          .toMatchObject({ accepted: false })
        adapter.finish(1)
        await adapter.started(2)
        adapter.finish(2)
        await team.whenQuiet()
      }
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('bounds waits, honors caller cancellation, and keeps host lifecycle states', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      expect(await call(team, 'wait_agents', { timeout_ms: 1 })).toEqual({ results: [], timed_out: true })
      const controller = new AbortController()
      const waiting = call(team, 'wait_agents', {}, controller.signal)
      controller.abort(new Error('user cancelled'))
      await expect(waiting).rejects.toThrow('user cancelled')
      expect(team.workers()[0]!.status).toBe('running')
      await team.closeWorker('worker')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('protects queued work after the original worker has completed', async () => {
    const { adapter, team } = fixture({ allowModelWorkerCancellation: false })
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      adapter.finish(1)
      await team.awaitWorker('worker')
      const sending = call(team, 'send_input', { target: 'worker', message: 'second' })
      expect(() => team.removeWorker('worker')).toThrow('cannot remove running')
      expect(await call(team, 'close_agent', { target: 'worker' })).toMatchObject({ closed: false })
      await sending
      await adapter.started(2)
      adapter.finish(2)
      await team.whenQuiet()
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('cancels an active follow-up on disposal and drops later queued work', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      adapter.finish(1)
      await team.awaitWorker('worker')
      await call(team, 'send_input', { target: 'worker', message: 'second' })
      await adapter.started(2)
      await call(team, 'send_input', { target: 'worker', message: 'queued/third/task' })
      await team.dispose()
      await team.whenQuiet()
      expect(adapter.requests).toHaveLength(2)
      expect(adapter.requests[1]!.signal!.aborted).toBe(true)
      expect(reports(team, 'result-2')).toHaveLength(0)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('returns failed follow-up results once without a duplicate notice', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      adapter.finish(1)
      await team.awaitWorker('worker')
      await call(team, 'wait_agents', { targets: ['worker'] })
      await call(team, 'send_input', { target: 'worker', message: 'second' })
      await adapter.started(2)
      const waiting = call(team, 'wait_agents', {})
      adapter.finish(2, 'fail')
      await team.whenQuiet()
      expect(await waiting).toMatchObject({
        results: [{ target: 'worker', status: 'failed', error: 'worker failed' }], timed_out: false,
      })
      expect(reports(team, 'worker failed')).toHaveLength(0)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('cancels a follow-up at its deadline before declaring the team quiet', async () => {
    const { adapter, team } = fixture({ workerTimeoutMs: 200 })
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      adapter.finish(1)
      await team.awaitWorker('worker')
      await call(team, 'wait_agents', { targets: ['worker'] })
      await call(team, 'send_input', { target: 'worker', message: 'second' })
      await adapter.started(2)
      const waiting = call(team, 'wait_agents', {})
      await team.whenQuiet()
      expect(adapter.requests[1]!.signal!.aborted).toBe(true)
      expect(await waiting).toMatchObject({
        results: [{ target: 'worker', status: 'failed' }], timed_out: false,
      })
      expect(team.team.members().find(member => member.name === 'worker')!.status).toBe('failed')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('labels failed worker text as partial_result and preserves host member outcomes', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      const waiting = call(team, 'wait_agents', {})
      adapter.finish(1, 'partial')
      const result = await waiting
      expect(result).toEqual({ results: [{ target: 'worker', status: 'failed',
        partial_result: 'partial', error: 'the model stopped at its output limit' }], timed_out: false })
      await team.awaitWorker('worker')
      expect(team.team.members().find(member => member.name === 'worker')!.outcome)
        .toEqual({ kind: 'failed', status: 'failed', text: 'partial',
          message: 'the model stopped at its output limit' })
      expect(team.workers()[0]!.result).toMatchObject({ text: 'partial', succeeded: false })
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('lets full workers message the lead and advertises host cancellation policy', async () => {
    const { adapter, team } = fixture({ workerTeamTools: 'full', allowModelWorkerCancellation: false })
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      const port = team.lead.options.team!.team
      const sending = port.toolsFor('worker', 'full').find(tool => tool.name === 'send_input')!
      expect(sending.description).toContain('protected by the host')
      expect(sending.description).not.toContain('Set interrupt=true')
      expect(sending.parameters).not.toHaveProperty('properties.interrupt')
      expect(adapter.requests[0]!.system).toContain('send_input queues worker tasks or sends context to the lead')
      expect(adapter.requests[0]!.system!.match(/worker 'worker'/g)).toHaveLength(1)
      await sending.execute(sending.parse!({ target: 'lead', message: 'progress' }),
        { signal: new AbortController().signal } as ToolRunContext)
      expect(reports(team, 'progress')).toHaveLength(1)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('bounds accepted inputs and releases their quota on settlement', async () => {
    const { adapter, team } = fixture({ maxPendingInputs: 1 })
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      await call(team, 'send_input', { target: 'worker', message: 'second' })
      await expect(call(team, 'send_input', { target: 'worker', message: 'queued/third/task' }))
        .rejects.toThrow('Wait for a worker result')
      adapter.finish(1)
      await adapter.started(2)
      adapter.finish(2)
      await team.whenQuiet()
      await call(team, 'send_input', { target: 'worker', message: 'queued/third/task' })
      await adapter.started(3)
      adapter.finish(3)
      await team.whenQuiet()
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('replaces active and queued follow-ups together on interrupt', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      adapter.finish(1)
      await team.awaitWorker('worker')
      await call(team, 'send_input', { target: 'worker', message: 'second' })
      await adapter.started(2)
      await call(team, 'send_input', { target: 'worker', message: 'queued/discard/task' })
      await call(team, 'send_input', { target: 'worker', message: 'replacement', interrupt: true })
      await adapter.started(3)
      expect(adapter.requests[1]!.signal!.aborted).toBe(true)
      expect(JSON.stringify(adapter.requests[2]!.messages)).not.toContain('queued/discard/task')
      adapter.finish(3)
      await team.whenQuiet()
      expect(reports(team, 'result-3')).toHaveLength(1)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it.each(['result-2', 'fail'])('releases ordinary input dependents on settlement (%s)', async result => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'producer', task: 'first', writes: ['src/shared'] })
      adapter.finish(1)
      await team.awaitWorker('producer')
      await call(team, 'send_input', { target: 'producer', message: 'follow-up' })
      await expect(team.spawn({ name: 'clash', task: 'conflict', writes: ['src/shared'] }))
        .rejects.toThrow('another running worker writes')
      await adapter.started(2)
      await team.spawn({ name: 'consumer', task: 'consume', writes: ['src/shared'], dependsOn: ['producer'] })
      expect(team.workers().find(worker => worker.name === 'consumer')?.status).toBe('pending')
      adapter.finish(2, result)
      await adapter.started(3)
      expect(JSON.stringify(adapter.requests[2]!.messages)).toContain(result === 'fail' ? 'worker failed' : result)
      expect(team.workers().find(worker => worker.name === 'producer')?.status)
        .toBe(result === 'fail' ? 'failed' : 'completed')
      adapter.finish(3)
      await team.whenQuiet()
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('returns early on steering while preserving the unfinished worker', async () => {
    const { adapter, team } = fixture({ autoLeadCoordination: false })
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      const waiting = call(team, 'wait_agents', {})
      team.steer('correction')
      expect(await waiting).toEqual({ results: [], timed_out: false, interrupted: true })
      expect(team.workers()[0]!.status).toBe('running')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it.each(['full', 'reporting', false] as const)('honors worker tool access %s', async access => {
    const { adapter, team } = fixture({ workerTeamTools: access })
    try {
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      const request = adapter.requests[0]!
      expect(request.tools?.map(tool => tool.name) ?? [])
        .toEqual(access === 'full' ? ['send_input', 'wait_agents', 'get_agent_result'] : access === 'reporting' ? ['send_input'] : [])
      if (access === false) expect(request.system).not.toMatch(/send_input|wait_agents/)
    } finally { await team.dispose(); await team.team.dispose() }
  })
})

describe('managed settlement delivery audit regressions', () => {
  const text = (value: string): readonly StreamChunk[] => [
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  it('delivers a settlement deferred during a lead turn after a queued follow-up restarts the worker', async () => {
    const { adapter, team } = fixture()
    const inTurn = deferred<void>()
    const release = deferred<void>()
    let first = true
    adapter.leadReply = async () => {
      if (first) { first = false; inTurn.resolve(); await release.promise }
      return text('lead-done')
    }
    try {
      const running = team.run('go')
      await inTurn.promise
      await team.spawn({ name: 'worker', task: 'first' })
      await adapter.started(1)
      await call(team, 'send_input', { target: 'worker', message: 'second' })
      adapter.finish(1, 'first-result')
      await adapter.started(2)
      release.resolve()
      await vi.waitFor(() => expect(team.lead.isRunning).toBe(false))
      adapter.finish(2, 'second-result')
      await running
      await team.whenQuiet()
      const leadInputs = JSON.stringify(adapter.requests
        .filter(request => request.tools?.some(tool => tool.name === 'spawn_agent'))
        .map(request => request.messages))
      expect(leadInputs).toContain('first-result')
      expect(leadInputs).toContain('second-result')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('cancels busy owned workers when the lead run rejects instead of waking the lead later', async () => {
    const { adapter, team } = fixture({ leadSessionOptions: { hooks: {
      onTurnEnd: () => { throw new Error('host hook failed') } } } })
    let worker = ''
    adapter.leadReply = async () => {
      worker = (await call(team, 'spawn_agent', { task: 'first' }) as { target: string }).target
      await adapter.started(1)
      return text('lead-done')
    }
    const leadRequests = () => adapter.requests.filter(request =>
      request.tools?.some(tool => tool.name === 'spawn_agent')).length
    try {
      await expect(team.run('go')).rejects.toThrow('host hook failed')
      const before = leadRequests()
      expect(team.workers().find(member => member.name === worker)?.status).not.toBe('running')
      adapter.finish(1, 'late-result')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(leadRequests()).toBe(before)
      expect(team.lead.isRunning).toBe(false)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('does not wake a yielded lead for a closed worker while other workers still run', async () => {
    const { adapter, team } = fixture()
    let round = 0
    adapter.leadReply = async () => {
      round++
      if (round === 1) {
        await call(team, 'spawn_agent', { task: 'a' })
        await call(team, 'spawn_agent', { task: 'b' })
        await adapter.started(2)
      }
      return text(`lead-${round}`)
    }
    try {
      const running = team.run('go')
      await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
      await vi.waitFor(() => expect(team.lead.isRunning).toBe(false))
      const leadTurns = round
      await call(team, 'close_agent', { target: 'worker_1' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(round).toBe(leadTurns)
      adapter.finish(2, 'b-result')
      await running
      expect(round).toBe(leadTurns + 1)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('returns results claimed by a cancelled wait to later delivery', async () => {
    const { adapter, team } = fixture()
    try {
      await team.spawn({ name: 'A', task: 'a' })
      await team.spawn({ name: 'B', task: 'b' })
      await adapter.started(2)
      const controller = new AbortController()
      const waiting = call(team, 'wait_agents', { targets: ['A', 'B'] }, controller.signal)
      adapter.finish(1, 'a-result')
      await team.awaitWorker('A')
      controller.abort(new Error('user cancelled'))
      await expect(waiting).rejects.toThrow('user cancelled')
      const later = JSON.stringify(await call(team, 'wait_agents', { targets: ['A'], timeout_ms: 10 }))
        + JSON.stringify(team.team.messages())
      expect(later).toContain('a-result')
      await team.closeWorker('B')
    } finally { await team.dispose(); await team.team.dispose() }
  })
})

describe('long-lived managed team retention', () => {
  it('keeps spawning after the audit mailbox fills', async () => {
    const { adapter, team } = fixture({ team: { minWaitTimeoutMs: 10, waitTimeoutMs: 1000, maxMessages: 3 } })
    try {
      for (let index = 1; index <= 5; index++) {
        await team.spawn({ name: `w${index}`, task: `task ${index}` })
        await adapter.started(index)
        adapter.finish(index)
        await team.awaitWorker(`w${index}`)
      }
      expect(team.team.messages().length).toBeLessThanOrEqual(3)
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('evicts the oldest delivered idle workers above maxRetainedWorkers and keeps their results', async () => {
    const { adapter, team } = fixture({ maxRetainedWorkers: 2 })
    try {
      for (let index = 1; index <= 3; index++) {
        await team.spawn({ name: `w${index}`, task: `task ${index}` })
        await adapter.started(index)
        adapter.finish(index, `result-${index}`)
        await call(team, 'wait_agents', { targets: [`w${index}`] })
      }
      await team.spawn({ name: 'w4', task: 'task 4' })
      expect(team.workers().map(worker => worker.name)).toEqual(['w3', 'w4'])
      expect(JSON.stringify(await call(team, 'get_agent_result', { target: 'w1' }))).toContain('result-1')
      await team.closeWorker('w4')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('never evicts a busy worker', async () => {
    const { adapter, team } = fixture({ maxRetainedWorkers: 1 })
    try {
      await team.spawn({ name: 'w1', task: 'task 1' })
      await adapter.started(1)
      await team.spawn({ name: 'w2', task: 'task 2' })
      expect(team.workers().map(worker => worker.name)).toEqual(['w1', 'w2'])
      await team.closeWorker('w1')
      await team.closeWorker('w2')
    } finally { await team.dispose(); await team.team.dispose() }
  })

  it('bounds the closed-member archive', () => {
    const results = new TeamResults()
    for (let index = 0; index < 300; index++) {
      results.archive({ name: `m${index}`, status: 'idle', outcome: { kind: 'completed', text: `${index}` } } as never)
    }
    expect(results.retained('m0')).toBeUndefined()
    expect(results.retained('m299')?.outcome?.text).toBe('299')
  })

  it('evicts the oldest audit records in evict-oldest mode and rejects by default', async () => {
    for (const mailboxOverflow of ['evict-oldest', undefined] as const) {
      const team = new AgentTeam({ maxMessages: 2, ...(mailboxOverflow === undefined ? {} : { mailboxOverflow }) })
      const sessions = ['a', 'b'].map(id => ({ definition: { id }, conversationId: id, isRunning: false,
        inject: () => 1, whenIdle: async () => {} }))
      for (const session of sessions) team.attach(session as never)
      const send = (message: string) => team.sendMessage({ from: 'a', target: 'b', message, delivery: 'quiet' })
      await send('oldest-audit-record')
      await send('second-audit-record')
      if (mailboxOverflow === undefined) await expect(send('third-audit-record')).rejects.toThrow(/2-message mailbox limit/)
      else {
        await send('third-audit-record')
        expect(JSON.stringify(team.messages())).not.toContain('oldest-audit-record')
        expect(team.messages()).toHaveLength(2)
      }
      await team.dispose()
    }
    expect(() => new AgentTeam({ mailboxOverflow: 'drop' as never })).toThrow('mailboxOverflow')
  })
})

describe('batch worker start races', () => {
  it('settles a worker closed before its start returned as cancelled', async () => {
    const { startBatchWorker } = await import('../../packages/core/src/agent/team/managed-batch-spawn.ts')
    const settled = vi.fn()
    const view = await startBatchWorker('gone', { settled } as never, {
      start: async () => ({ name: 'gone', status: 'running' }) as never,
      worker: () => undefined, cancelled: () => false, drain: () => {},
    })
    expect(settled).toHaveBeenCalledWith('gone', 'cancelled', false)
    expect(JSON.stringify(view)).not.toContain('Cannot read')
  })
})
