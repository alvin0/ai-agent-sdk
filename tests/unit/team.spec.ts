import { describe, expect, it } from 'vitest'
import { AgentTeam } from '../../packages/core/src/agent/team/index.ts'
import { AgentTeam as DeprecatedA2AAgentTeam } from '../../packages/core/src/agent/a2a/index.ts'
import type { TeamSessionPort } from '../../packages/core/src/agent/team/index.ts'
import { defineAgent } from '../../packages/core/src/agent/define/index.ts'
import { ModelAdapter, type GenerateOptions, type ResolvedModelInfo } from '../../packages/core/src/contract/index.ts'
import { ReasoningEffortId, ToolCallId } from '../../packages/core/src/primitives/index.ts'
import { ModelRegistry } from '../../packages/core/src/runtime/index.ts'
import type { StreamChunk } from '../../packages/core/src/stream/index.ts'

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

class BlockingAdapter extends ScriptedAdapter {
  private releaseFirst!: () => void
  private markFirstEntered!: () => void
  readonly firstEntered = new Promise<void>(resolve => { this.markFirstEntered = resolve })
  private readonly firstGate = new Promise<void>(resolve => { this.releaseFirst = resolve })

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.requests.length === 0) {
      this.markFirstEntered()
      await this.firstGate
    }
    yield * super.stream(options)
  }

  unblock(): void { this.releaseFirst() }
}

class AbortAwareAdapter extends ModelAdapter {
  private markEntered!: () => void
  readonly entered = new Promise<void>(resolve => { this.markEntered = resolve })

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.markEntered()
    const signal = options.signal
    if (signal === undefined) throw new Error('expected a cancellation signal')
    await new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    yield * textRound('unreachable')
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

function textRound(text: string): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolRound(id: string, name: string, args: unknown): StreamChunk[] {
  return [
    {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function setup(rounds: readonly (readonly StreamChunk[])[] = []) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return { adapter, registry }
}

function agent(id: string) {
  return defineAgent({ id, provider: 'test', model: 'scripted', instructions: `You are ${id}.` })
}

describe('local agent teams', () => {
  it('retains the deprecated A2A source barrel as an identity-preserving alias', () => {
    expect(DeprecatedA2AAgentTeam).toBe(AgentTeam)
  })

  it('records quiet messages with sender provenance without waking the target', async () => {
    const state = setup()
    const team = new AgentTeam({ id: 'ops-team' })
    agent('lead').createSession({ registry: state.registry, team: { team, role: 'lead' } })
    const worker = agent('worker').createSession({ registry: state.registry, team: { team } })
    const structuralPort: TeamSessionPort = worker
    expect(structuralPort.conversationId).toBe(worker.conversationId)

    const receipt = await team.sendMessage({
      from: 'lead', target: 'worker', message: 'Inspect the cache metrics.', delivery: 'quiet',
    })

    expect(receipt).toMatchObject({ status: 'accepted', delivery: 'quiet', target: 'worker' })
    expect(state.adapter.requests).toHaveLength(0)
    const delivered = worker.history.entries().at(-1)
    expect(delivered?.event.kind === 'user' && delivered.event.message.source).toMatchObject({
      kind: 'agent-message', teamId: 'ops-team', messageId: receipt.messageId,
      sender: 'lead', senderAgentId: 'lead',
    })
    expect(delivered?.event.kind === 'user' && delivered.event.message.content).toContainEqual({
      type: 'text', text: 'Inspect the cache metrics.',
    })

    const persisted = JSON.parse(JSON.stringify(worker.snapshot())) as ReturnType<typeof worker.snapshot>
    const persistedEntry = persisted.history.entries.at(-1)
    expect(persistedEntry?.event.kind === 'user'
      && persistedEntry.event.message.source).toMatchObject({
      kind: 'agent-message', messageId: receipt.messageId,
    })
  })

  it('wakes an idle target and processes already-recorded context exactly once', async () => {
    const state = setup([textRound('Cache metrics inspected.')])
    const team = new AgentTeam({ id: 'wake-team' })
    agent('lead').createSession({ registry: state.registry, team: { team } })
    agent('worker').createSession({ registry: state.registry, team: { team } })

    await team.followup('lead', 'worker', 'Inspect now.')
    await team.whenIdle('worker')

    expect(state.adapter.requests).toHaveLength(1)
    const peerMessages = state.adapter.requests[0]?.messages.filter(message =>
      message.source.kind === 'agent-message') ?? []
    expect(peerMessages).toHaveLength(1)
    expect(peerMessages[0]?.content).toContainEqual({ type: 'text', text: 'Inspect now.' })
    expect(team.members().find(member => member.name === 'worker')?.status).toBe('idle')
  })

  it('exposes quiet and wakeup messaging as bound model tools', async () => {
    const state = setup([
      toolRound('send-1', 'send_message', { target: 'worker', message: 'Here is the finding.' }),
      textRound('Finding sent.'),
    ])
    const team = new AgentTeam({ id: 'tool-team' })
    const lead = agent('lead').createSession({ registry: state.registry, team: { team } })
    const worker = agent('worker').createSession({ registry: state.registry, team: { team } })

    await lead.run('Tell the worker quietly.')

    expect(state.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual([
      'list_agents', 'send_message', 'followup_task', 'wait_agents',
    ])
    const workerEntry = worker.history.entries().at(-1)
    expect(workerEntry?.event.kind === 'user'
      && workerEntry.event.message.source).toMatchObject({
      kind: 'agent-message', sender: 'lead',
    })
    expect(team.messages()).toHaveLength(1)
    expect(state.adapter.requests).toHaveLength(2)
  })

  it('queues wakeup behind an active turn and guarantees a later request sees it', async () => {
    const adapter = new BlockingAdapter([textRound('Initial turn done.'), textRound('Follow-up done.')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const team = new AgentTeam({ id: 'active-team' })
    const lead = agent('lead').createSession({ registry, team: { team } })
    const worker = agent('worker').createSession({ registry, team: { team } })

    const active = worker.run('Start the original task.')
    await adapter.firstEntered
    await team.followup('lead', 'worker', 'New evidence arrived.')
    adapter.unblock()
    await active
    await team.whenIdle('worker')

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.messages.some(message => message.source.kind === 'agent-message')).toBe(false)
    expect(adapter.requests[1]?.messages.some(message => message.source.kind === 'agent-message')).toBe(true)
    expect(lead.isRunning).toBe(false)
  })

  it('wait_agents blocks for scheduled workers and forwards their run events', async () => {
    const adapter = new BlockingAdapter([textRound('Worker report complete.')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const events: string[] = []
    const team = new AgentTeam({
      id: 'wait-team',
      onAgentEvent: (member, event) => { events.push(`${member}:${event.type}`) },
    })
    agent('lead').createSession({ registry, team: { team } })
    agent('worker').createSession({ registry, team: { team } })

    await team.followup('lead', 'worker', 'Produce the report.')
    await adapter.firstEntered

    const waitTool = team.toolsFor('lead').find(tool => tool.name === 'wait_agents')
    expect(waitTool).toBeDefined()
    const args = waitTool?.parse?.({ targets: ['worker'] })
    let settled = false
    const waiting = Promise.resolve(waitTool?.execute(args, {
      turn: 1,
      step: 1,
      callId: ToolCallId('wait-1'),
      toolName: 'wait_agents',
      signal: new AbortController().signal,
      concludeTurn() {},
      addContext() {},
    })).then(result => {
      settled = true
      return result
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    adapter.unblock()

    await expect(waiting).resolves.toEqual([
      expect.objectContaining({ name: 'worker', status: 'idle' }),
    ])
    expect(events).toContain('worker:agent-start')
    expect(events).toContain('worker:agent-end')
  })

  it('rejects self-waits and wait-for cycles with a stable coordination error', async () => {
    const team = new AgentTeam({ id: 'cycle-team' })
    let releaseIdle!: () => void
    let running = true
    const blocked = new Promise<void>(resolve => { releaseIdle = () => { running = false; resolve() } })
    const port = (id: string): TeamSessionPort => ({
      definition: { id }, conversationId: `${id}-conversation`, get isRunning() { return running },
      inject: () => 1, whenIdle: () => blocked, runPending: async () => undefined,
    })
    team.attach(port('agent-a'), { name: 'a' })
    team.attach(port('agent-b'), { name: 'b' })
    team.attach(port('agent-c'), { name: 'c' })
    const context = (id: string) => ({
      turn: 1, step: 1, callId: ToolCallId(id), toolName: 'wait_agents',
      signal: new AbortController().signal, concludeTurn() {}, addContext() {},
    })
    const waitA = team.toolsFor('a').find(tool => tool.name === 'wait_agents')!
    const waitB = team.toolsFor('b').find(tool => tool.name === 'wait_agents')!
    const waitC = team.toolsFor('c').find(tool => tool.name === 'wait_agents')!
    await expect(waitA.execute(waitA.parse?.({ targets: ['a'] }), context('self')))
      .rejects.toMatchObject({ code: 'TEAM_WAIT_CYCLE' })
    const aWaitsForB = Promise.resolve(waitA.execute(waitA.parse?.({ targets: ['b'] }), context('a-b')))
    await Promise.resolve()
    await expect(waitB.execute(waitB.parse?.({ targets: ['a'] }), context('b-a')))
      .rejects.toMatchObject({ code: 'TEAM_WAIT_CYCLE' })
    const bWaitsForC = Promise.resolve(waitB.execute(waitB.parse?.({ targets: ['c'] }), context('b-c')))
    await Promise.resolve()
    await expect(waitC.execute(waitC.parse?.({ targets: ['a'] }), context('c-a')))
      .rejects.toMatchObject({ code: 'TEAM_WAIT_CYCLE' })
    releaseIdle()
    await expect(aWaitsForB).resolves.toEqual([expect.objectContaining({ name: 'b' })])
    await expect(bWaitsForC).resolves.toEqual([expect.objectContaining({ name: 'c' })])
  })

  it('rejects ambiguous addressing, self messages, and oversized content', async () => {
    const state = setup()
    const team = new AgentTeam({ id: 'bounded-team', maxMessageBytes: 100 })
    agent('lead').createSession({ registry: state.registry, team: { team } })
    agent('worker').createSession({ registry: state.registry, team: { team } })

    await expect(team.sendMessage({ from: 'lead', target: 'missing', message: 'hello' }))
      .rejects.toThrow("unknown A2A member 'missing'")
    await expect(team.sendMessage({ from: 'lead', target: 'lead', message: 'hello' }))
      .rejects.toThrow(/cannot message itself/)
    await expect(team.sendMessage({ from: 'lead', target: 'worker', message: 'x'.repeat(200) }))
      .rejects.toThrow(/100-byte limit/)
  })

  it('returns deeply immutable detached audit snapshots', async () => {
    const state = setup()
    const team = new AgentTeam({ id: 'immutable-team' })
    agent('lead').createSession({ registry: state.registry, team: { team } })
    agent('worker').createSession({ registry: state.registry, team: { team } })

    await team.sendMessage({
      from: 'lead', target: 'worker', delivery: 'quiet',
      message: [{ type: 'image', source: { kind: 'url', url: 'https://safe.example/image.png' } }],
    })
    const snapshot = team.messages()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0]?.content)).toBe(true)
    expect(Object.isFrozen(snapshot[0]?.content[1])).toBe(true)
    expect(() => {
      const image = snapshot[0]?.content[1] as any
      image.source.url = 'https://attacker.example/tampered.png'
    }).toThrow()
    expect((team.messages()[0]?.content[1] as any).source.url)
      .toBe('https://safe.example/image.png')
  })

  it('enforces mailbox count and byte quotas before delivery', async () => {
    const state = setup()
    const countBounded = new AgentTeam({ id: 'count-bounded', maxMessages: 1 })
    agent('count_lead').createSession({ registry: state.registry, team: { team: countBounded } })
    const countWorker = agent('count_worker').createSession({
      registry: state.registry, team: { team: countBounded },
    })
    await countBounded.sendMessage({ from: 'count_lead', target: 'count_worker', message: 'first' })
    await expect(countBounded.sendMessage({
      from: 'count_lead', target: 'count_worker', message: 'second',
    })).rejects.toThrow(/1-message mailbox limit/)
    expect(countWorker.history.entries()).toHaveLength(1)

    const byteBounded = new AgentTeam({ id: 'byte-bounded', maxMailboxBytes: 1 })
    agent('byte_lead').createSession({ registry: state.registry, team: { team: byteBounded } })
    const byteWorker = agent('byte_worker').createSession({
      registry: state.registry, team: { team: byteBounded },
    })
    await expect(byteBounded.sendMessage({
      from: 'byte_lead', target: 'byte_worker', message: 'never delivered',
    })).rejects.toThrow(/1-byte mailbox limit/)
    expect(byteWorker.history.entries()).toHaveLength(0)
  })

  it('reserves mailbox quota across concurrent remote dispatches', async () => {
    const state = setup()
    const team = new AgentTeam({ id: 'reservation-team', maxMessages: 1 })
    agent('lead').createSession({ registry: state.registry, team: { team } })
    let release!: () => void
    let entered!: () => void
    const remoteEntered = new Promise<void>(resolve => { entered = resolve })
    const remoteGate = new Promise<void>(resolve => { release = resolve })
    team.linkAgent({
      name: 'remote',
      transport: {
        protocol: 'test', agentId: 'remote-agent',
        async send() {
          entered()
          await remoteGate
          return { kind: 'message', succeeded: true, text: 'ok', contextId: 'ctx' }
        },
      },
    })

    const first = team.followup('lead', 'remote', 'first')
    await remoteEntered
    await expect(team.followup('lead', 'remote', 'second'))
      .rejects.toThrow(/1-message mailbox limit/)
    release()
    await first
    expect(team.messages()).toHaveLength(1)
  })

  it('rejects oversized custom linked-transport results', async () => {
    const state = setup()
    const team = new AgentTeam({ id: 'result-bounded', maxLinkedResultBytes: 64 })
    agent('lead').createSession({ registry: state.registry, team: { team } })
    team.linkAgent({
      name: 'remote',
      transport: {
        protocol: 'test', agentId: 'remote-agent',
        async send() {
          return {
            kind: 'message', succeeded: true, text: 'x'.repeat(200), contextId: 'context',
          }
        },
      },
    })
    await expect(team.followup('lead', 'remote', 'work'))
      .rejects.toThrow(/64-byte limit/)
    expect(team.messages()).toEqual([])
    expect(team.members().find(member => member.name === 'remote')?.status).toBe('failed')
  })

  it('bounds a custom linked transport that ignores cancellation', async () => {
    const state = setup()
    const team = new AgentTeam({ id: 'remote-timeout', operationTimeoutMs: 10 })
    agent('lead').createSession({ registry: state.registry, team: { team } })
    team.linkAgent({
      name: 'remote',
      transport: {
        protocol: 'test', agentId: 'remote-agent',
        send: async () => await new Promise<never>(() => {}),
      },
    })
    const started = Date.now()
    await expect(team.followup('lead', 'remote', 'work')).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(250)
    await expect(team.whenIdle('remote')).resolves.toBeUndefined()
  })

  it('closes the idle race when work is scheduled during an idle wait', async () => {
    const adapter = new BlockingAdapter([textRound('Scheduled work done.')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const team = new AgentTeam({ id: 'idle-race-team' })
    agent('lead').createSession({ registry, team: { team } })
    agent('worker').createSession({ registry, team: { team } })

    let settled = false
    const waiting = team.whenIdle('worker').then(() => { settled = true })
    await team.followup('lead', 'worker', 'Work scheduled in the race window.')
    await adapter.firstEntered
    await Promise.resolve()
    expect(settled).toBe(false)
    adapter.unblock()
    await waiting
    expect(adapter.requests).toHaveLength(1)
  })

  it('cancels team-owned runs and permanently disposes the control plane', async () => {
    const adapter = new AbortAwareAdapter()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const events: string[] = []
    const team = new AgentTeam({
      id: 'lifecycle-team',
      onEvent: event => { events.push(event.type) },
    })
    agent('lead').createSession({ registry, team: { team } })
    agent('worker').createSession({ registry, team: { team } })

    await team.followup('lead', 'worker', 'Long-running work.')
    await adapter.entered
    await team.dispose(new Error('host shutdown'))

    expect(events).toContain('member-run-cancelled')
    expect(events.at(-1)).toBe('team-disposed')
    expect(team.members()).toEqual([])
    expect(team.messages()).toEqual([])
    await expect(team.sendMessage({ from: 'lead', target: 'worker', message: 'too late' }))
      .rejects.toThrow(/disposed/)
  })

  it('reports teardown timeout when a local wake task ignores cancellation', async () => {
    const team = new AgentTeam({ id: 'uncooperative-local', disposeTimeoutMs: 10 })
    const idle = (id: string): TeamSessionPort => ({
      definition: { id }, conversationId: `${id}-conversation`, isRunning: false,
      inject: () => 1, whenIdle: async () => undefined, runPending: async () => undefined,
    })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const stuck: TeamSessionPort = {
      ...idle('stuck'),
      runPending: () => { entered(); return new Promise(() => undefined) },
    }
    team.attach(idle('lead'), { name: 'lead' })
    team.attach(stuck, { name: 'stuck' })
    await team.followup('lead', 'stuck', 'never settles')
    await started
    await expect(team.cancel('stuck')).rejects.toMatchObject({ code: 'TEAM_CANCELLATION_TIMEOUT' })
    await expect(team.dispose()).rejects.toMatchObject({ code: 'TEAM_DISPOSE_TIMEOUT' })
  })

  it('bounds disposal when a linked transport ignores cancellation', async () => {
    const state = setup()
    const team = new AgentTeam({ id: 'stuck-team', disposeTimeoutMs: 10 })
    agent('lead').createSession({ registry: state.registry, team: { team } })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    team.linkAgent({
      name: 'stuck',
      transport: {
        protocol: 'test', agentId: 'stuck-agent',
        async send() {
          entered()
          return new Promise(() => {})
        },
      },
    })
    const pending = team.followup('lead', 'stuck', 'never settles')
    void pending.catch(() => undefined)
    await started
    const disposing = Date.now()
    await expect(team.dispose()).resolves.toBeUndefined()
    expect(Date.now() - disposing).toBeLessThan(250)
  })
})
