import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { ReasoningEffortId } from '../../../packages/core/src/primitives/brand.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import type { LinkedAgentResult, LinkedAgentSendInput } from '../../../packages/core/src/agent/team/types.ts'
import { defineTool } from '../../../packages/core/src/agent/tool/definition.ts'
import { AgentTeam } from '../../../packages/core/src/agent/team/team.ts'

class TeamAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = `answer:${options.model}`
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id, name: id,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }
}

class BlockingTeamAdapter extends ModelAdapter {
  private enter!: () => void
  readonly entered = new Promise<void>(resolve => { this.enter = resolve })
  aborts = 0
  onAbort: (() => void) | undefined
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.enter()
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return }
      options.signal?.addEventListener('abort', () => {
        this.aborts++
        this.onAbort?.()
        reject(options.signal?.reason)
      }, { once: true })
    })
  }
}

class FollowupTeamAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  private enter!: () => void
  readonly firstEntered = new Promise<void>(resolve => { this.enter = resolve })
  private releaseFirst!: () => void
  private readonly firstGate = new Promise<void>(resolve => { this.releaseFirst = resolve })
  release(): void { this.releaseFirst() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) { this.enter(); await this.firstGate }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class UncooperativeTeamAdapter extends ModelAdapter {
  private enter!: () => void
  readonly entered = new Promise<void>(resolve => { this.enter = resolve })
  private releaseGate!: () => void
  private readonly gate = new Promise<void>(resolve => { this.releaseGate = resolve })
  continued = false
  release(): void { this.releaseGate() }
  async * stream(): AsyncIterable<StreamChunk> {
    this.enter()
    await this.gate
    this.continued = true
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return { kind: 'model-provider-plugin', apiVersion: 1, id: 'team-provider', family: 'team-family',
    displayName: 'Team Provider', routes: ['team'], defaultModel: { provider: 'team', id: 'fallback' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['team'], adapter) } }
}

function agents(runtime: Awaited<ReturnType<typeof createRuntimeCompositionOwner>>) {
  return {
    lead: runtime.agent({ id: 'lead-agent', model: { provider: 'team', id: 'lead-model' },
      instructions: 'Lead.', compaction: false }),
    worker: runtime.agent({ id: 'worker-agent', model: { provider: 'team', id: 'worker-model' },
      instructions: 'Worker.', compaction: false }),
  }
}

describe('runtime-owned Universal agent teams', () => {
  it('prevalidates every member atomically before creating or attaching sessions', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new TeamAdapter())] })
    const local = agents(runtime)
    const events = vi.fn()
    expect(() => runtime.team({ id: 'duplicates', onEvent: events, members: [
      { name: 'same', agent: local.lead }, { name: 'same', agent: local.worker },
    ] })).toThrow(expect.objectContaining({ code: 'TEAM_MEMBER_CONFLICT', conflict: {
      namespace: 'team-member-name', key: '[redacted]', firstIndex: 0, secondIndex: 1,
    } }))
    expect(() => runtime.team({ id: 'two-leads', onEvent: events, members: [
      { name: 'one', agent: local.lead, role: 'lead' },
      { name: 'two', agent: local.worker, role: 'lead' },
    ] })).toThrow(/more than one lead/)
    expect(events).not.toHaveBeenCalled()

    const colliding = runtime.agent({ id: 'colliding-agent', model: { provider: 'team', id: 'collision' },
      instructions: 'Collide.', compaction: false, tools: [defineTool({ name: 'list_agents',
        description: 'Conflicts with the team catalog.', parameters: { type: 'object' }, execute: () => ({}) })] })
    expect(() => runtime.team({ id: 'catalog-conflict', onEvent: events, members: [
      { name: 'first', agent: local.lead }, { name: 'second', agent: colliding },
    ] })).toThrow(expect.objectContaining({ code: 'TOOL_NAME_CONFLICT', conflict: {
      namespace: 'tool-name', key: '[redacted]', firstIndex: 0, secondIndex: 1,
    } }))
    expect(events).not.toHaveBeenCalled()

    const foreignRuntime = await createRuntimeCompositionOwner({ providers: [provider(new TeamAdapter())] })
    const foreign = agents(foreignRuntime).lead
    expect(() => runtime.team({ id: 'foreign', members: [{ name: 'foreign', agent: foreign }] }))
      .toThrow(expect.objectContaining({ code: 'TEAM_AGENT_OWNERSHIP_INVALID' }))
    expect(runtime.team({ id: 'valid-after-failures', members: [
      { name: 'lead', agent: local.lead }, { name: 'worker', agent: local.worker },
    ] }).memberNames).toEqual(['lead', 'worker'])
    await runtime.close()
    await foreignRuntime.close()
  })

  it('preserves each member model and exposes local session/message progress', async () => {
    const adapter = new TeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const local = agents(runtime), events: unknown[] = []
    const team = runtime.team({ id: 'local-team', onEvent: event => events.push(event), members: [
      { name: 'lead', agent: local.lead, role: 'lead' },
      { name: 'worker', agent: local.worker, instructions: 'Inspect carefully.' },
    ] })
    await expect(team.run('lead', 'start')).resolves.toMatchObject({ text: 'answer:lead-model' })
    await expect(team.run('worker', 'work')).resolves.toMatchObject({ text: 'answer:worker-model' })
    expect(adapter.requests.map(request => request.model)).toEqual(['lead-model', 'worker-model'])
    const sent = await team.sendMessage({ from: 'lead', target: 'worker', message: 'Check the result.' })
    expect(sent).toMatchObject({ status: 'accepted', target: 'worker' })
    expect(team.session('worker').snapshot().history.entries.at(-1)?.event).toMatchObject({ kind: 'user' })
    expect(events).toEqual(expect.arrayContaining([
      { type: 'member-attached', member: 'lead' },
      { type: 'member-attached', member: 'worker' },
      { type: 'message-accepted', messageId: sent.messageId, target: 'worker' },
    ]))
    await runtime.close()
  })

  it('captures a borrowed transport method/receiver once and supplies a runtime logger', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new TeamAdapter())] })
    const local = agents(runtime)
    const original = vi.fn(function(this: { prefix: string }, input: LinkedAgentSendInput): Promise<LinkedAgentResult> {
      expect(input.logger).toBeDefined()
      return Promise.resolve({ kind: 'message', succeeded: true, text: `${this.prefix}:${input.sender}`,
        contextId: 'remote-context' })
    })
    const replacement = vi.fn(async (): Promise<LinkedAgentResult> => ({ kind: 'message', succeeded: false,
      text: 'replacement', contextId: 'replacement' }))
    const close = vi.fn()
    const transport = { protocol: 'test-link', agentId: 'remote-id', prefix: 'initial', send: original, close }
    const team = runtime.team({ id: 'linked-team', members: [{ name: 'lead', agent: local.lead }] })
    const unlink = team.linkAgent({ name: 'remote', transport })
    transport.send = replacement
    transport.prefix = 'mutated'
    await expect(team.sendMessage({ from: 'lead', target: 'remote', message: 'Go', delivery: 'wakeup' }))
      .resolves.toMatchObject({ result: { text: 'mutated:lead' } })
    expect(() => team.session('remote')).toThrow(expect.objectContaining({ code: 'TEAM_OPTIONS_INVALID' }))
    expect(() => team.run('remote', 'must not dispatch locally'))
      .toThrow(expect.objectContaining({ code: 'TEAM_OPTIONS_INVALID' }))
    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    unlink(); unlink()
    const removeOnClose = team.linkAgent({ name: 'remote-on-close', transport })
    await team.close()
    expect(() => removeOnClose()).not.toThrow()
    expect(close).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('closes early idempotently and retains one closed component in runtime reporting', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new TeamAdapter())] })
    const local = agents(runtime), events: unknown[] = []
    const team = runtime.team({ id: 'early-team', onEvent: event => events.push(event),
      members: [{ name: 'lead', agent: local.lead }] })
    const first = team.close(), second = team.close()
    expect(second).toBe(first)
    await first
    expect(() => team.session('lead')).toThrow(expect.objectContaining({ code: 'TEAM_CLOSED' }))
    expect(events.filter(event => (event as { type?: string }).type === 'team-closed')).toHaveLength(1)
    const registrations = Reflect.get(runtime, 'teams') as readonly object[]
    expect(registrations).toHaveLength(0)
    expect(registrations.reduce((count, registration) => {
      const sessions: unknown = Reflect.get(registration, 'sessions')
      return count + (sessions instanceof Map ? sessions.size : 0)
    }, 0)).toBe(0)
    const report = await runtime.close()
    expect(report.components).toContainEqual({ kind: 'agent-team', id: 'early-team', status: 'closed' })
  })

  it('bounds closed-team tombstones across repeated create-close churn', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new TeamAdapter())] })
    const local = agents(runtime)
    for (let index = 0; index < 1_030; index++) {
      await runtime.team({ id: `churn-${index}`, members: [{ name: 'lead', agent: local.lead }] }).close()
    }

    expect(Reflect.get(runtime, 'teams')).toHaveLength(0)
    expect(Reflect.get(runtime, 'closedTeams')).toHaveLength(1_024)
    const report = await runtime.close()
    const teamReports = report.components.filter(component => component.kind === 'agent-team')
    expect(teamReports).toHaveLength(1_024)
    expect(teamReports).not.toContainEqual({ kind: 'agent-team', id: 'churn-0', status: 'closed' })
    expect(teamReports).toContainEqual({ kind: 'agent-team', id: 'churn-1029', status: 'closed' })
  })

  it('cancels an active linked send through team-operation before closing providers', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new TeamAdapter())] })
    const local = agents(runtime)
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const team = runtime.team({ id: 'closing-team', members: [{ name: 'lead', agent: local.lead }] })
    team.linkAgent({ name: 'remote', transport: { protocol: 'blocked', agentId: 'remote',
      send: async input => {
        entered()
        await new Promise<void>((_resolve, reject) => {
          if (input.signal?.aborted) { reject(new Error('private close')); return }
          input.signal?.addEventListener('abort', () => reject(new Error('private close')), { once: true })
        })
        throw new Error('unreachable')
      } } })
    const sending = team.sendMessage({ from: 'lead', target: 'remote', message: 'wait', delivery: 'wakeup' })
    void sending.catch(() => undefined)
    await started
    const report = await runtime.close()
    await expect(sending).rejects.toBeDefined()
    expect(report.operations.find(row => row.kind === 'team-operation')).toMatchObject({
      // The public send and the physical transport callback are separate leases.
      activeAtClose: 2, aborted: 2, settled: 2, unsettled: 0,
    })
    expect(report.components[0]).toMatchObject({ kind: 'agent-team', id: 'closing-team', status: 'closed' })
  })

  it('cancels and drains a direct local team run before team close resolves', async () => {
    const adapter = new BlockingTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const local = agents(runtime)
    const team = runtime.team({ id: 'direct-run-close', members: [{ name: 'lead', agent: local.lead }] })
    const retained = team.session('lead')
    const running = team.run('lead', 'wait')
    await adapter.entered
    let runSettled = false
    void running.finally(() => { runSettled = true }).catch(() => undefined)
    await expect(team.close()).resolves.toBeUndefined()
    expect(runSettled).toBe(true)
    await expect(running).rejects.toMatchObject({ report: { status: 'aborted' } })
    expect(() => retained.stream('after close')).toThrow(expect.objectContaining({ code: 'TEAM_CLOSED' }))
    await expect(retained.run('after close')).rejects.toMatchObject({ code: 'TEAM_CLOSED' })
    expect(() => retained.inject('after close')).toThrow(expect.objectContaining({ code: 'TEAM_CLOSED' }))
    expect(() => retained.reset()).toThrow(expect.objectContaining({ code: 'TEAM_CLOSED' }))
    await runtime.close()
  })

  it('cancels and drains a run started through a retained team session', async () => {
    const adapter = new BlockingTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const local = agents(runtime)
    const team = runtime.team({ id: 'session-run-close', members: [{ name: 'lead', agent: local.lead }] })
    const retained = team.session('lead')
    const running = retained.run('wait')
    await adapter.entered
    await expect(team.close()).resolves.toBeUndefined()
    await expect(running).rejects.toMatchObject({ report: { status: 'aborted' } })
    expect(adapter.aborts).toBe(1)
    await runtime.close()
  })

  it('shares one close promise when an abort handler reenters team.close', async () => {
    const adapter = new BlockingTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const team = runtime.team({ id: 'reentrant-close', members: [{ name: 'worker', agent: agents(runtime).worker }] })
    let nested: Promise<void> | undefined
    adapter.onAbort = () => { nested = team.close() }
    const running = team.run('worker', 'wait').catch(() => undefined)
    await adapter.entered
    const closing = team.close()
    await closing
    await running
    await runtime.close()
    expect(nested).toBe(closing)
  })

  it('starts team disposal even when runtime quiescence exhausts the close deadline', async () => {
    const dispose = vi.spyOn(AgentTeam.prototype, 'dispose')
    const adapter = new UncooperativeTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ closeTimeoutMs: 10, providers: [provider(adapter)] })
    const events: unknown[] = []
    const team = runtime.team({ id: 'expired-close', onEvent: event => events.push(event),
      members: [{ name: 'worker', agent: agents(runtime).worker }] })
    const running = team.run('worker', 'wait').catch(() => undefined)
    await adapter.entered
    await runtime.close()
    expect(dispose).toHaveBeenCalled()
    dispose.mockRestore()
    const eventsAtClose = [...events]
    adapter.release()
    await running
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(eventsAtClose)
  })

  it('accepts a wakeup follow-up while the target session is running', async () => {
    const adapter = new FollowupTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const local = agents(runtime)
    const team = runtime.team({ id: 'active-followup', members: [
      { name: 'lead', agent: local.lead }, { name: 'worker', agent: local.worker },
    ] })
    const worker = team.session('worker')
    const running = worker.run('first task')
    await adapter.firstEntered
    await expect(team.sendMessage({ from: 'lead', target: 'worker', message: 'new evidence', delivery: 'wakeup' }))
      .resolves.toMatchObject({ status: 'accepted', target: 'worker' })
    adapter.release()
    await running
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    await worker.whenIdle()
    expect(adapter.requests[1]?.messages.some(message => message.source.kind === 'agent-message')).toBe(true)
    await team.close()
    await runtime.close()
  })

  it('cancels manual compaction when its team closes', async () => {
    const adapter = new BlockingTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const agent = runtime.agent({ id: 'compact-member', instructions: 'Compact',
      compaction: {} })
    const team = runtime.team({ id: 'compact-close', members: [{ name: 'worker', agent }] })
    const session = team.session('worker')
    session.inject('old context '.repeat(1_000))
    session.inject('latest message')
    const compacting = session.compact()
    const rejected = expect(compacting).rejects.toBeDefined()
    await adapter.entered
    await team.close()
    await rejected
    expect(adapter.aborts).toBe(1)
    expect(session.isRunning).toBe(false)
    await runtime.close()
  })

  it('bounds close while a retained-session run ignores cancellation', async () => {
    vi.useFakeTimers()
    const adapter = new UncooperativeTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const team = runtime.team({ id: 'bounded-close', members: [{ name: 'worker', agent: agents(runtime).worker }] })
    const running = team.session('worker').run('wait').catch(() => undefined)
    await adapter.entered
    try {
      const closing = team.close()
      const rejected = expect(closing).rejects.toMatchObject({ code: 'TEAM_DISPOSE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(30_001)
      await rejected
      expect(team.close()).toBe(closing)
    } finally {
      adapter.release()
      await running
      await runtime.close()
      vi.useRealTimers()
    }
  })

  it('allows callers to abort the close wait while cleanup continues', async () => {
    const adapter = new UncooperativeTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const events: unknown[] = []
    const team = runtime.team({ id: 'abort-close', onEvent: event => events.push(event),
      members: [{ name: 'worker', agent: agents(runtime).worker }] })
    const running = team.session('worker').run('wait').catch(() => undefined)
    await adapter.entered
    const caller = new AbortController()
    const closing = team.close({ signal: caller.signal })
    caller.abort()
    await expect(closing).rejects.toMatchObject({ code: 'TEAM_CLOSE_ABORTED' })
    try {
      expect(events).not.toContainEqual({ type: 'team-closed', teamId: 'abort-close' })
    } finally { adapter.release(); await running }
    const report = await runtime.close()
    expect(report.components).toContainEqual({ kind: 'agent-team', id: 'abort-close', status: 'closed' })
    expect(events.filter(event => (event as { type?: string }).type === 'team-closed')).toHaveLength(1)
  })

  it('tracks wakeup work as an agent-run lease during runtime close', async () => {
    const adapter = new BlockingTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const local = agents(runtime)
    const team = runtime.team({ id: 'tracked-wakeup', members: [
      { name: 'lead', agent: local.lead }, { name: 'worker', agent: local.worker },
    ] })
    await team.sendMessage({ from: 'lead', target: 'worker', message: 'wake', delivery: 'wakeup' })
    await adapter.entered
    const report = await runtime.close()
    expect(report.operations.find(row => row.kind === 'agent-run')).toMatchObject({
      activeAtClose: 1, aborted: 1, settled: 1, unsettled: 0,
    })
  })

  it('reports an uncooperative wakeup as unsettled at the shared runtime deadline', async () => {
    const adapter = new UncooperativeTeamAdapter()
    const runtime = await createRuntimeCompositionOwner({ closeTimeoutMs: 10, providers: [provider(adapter)] })
    const local = agents(runtime)
    const team = runtime.team({ id: 'unsettled-wakeup', members: [
      { name: 'lead', agent: local.lead }, { name: 'worker', agent: local.worker },
    ] })
    await team.sendMessage({ from: 'lead', target: 'worker', message: 'wake', delivery: 'wakeup' })
    await adapter.entered
    const report = await runtime.close()
    expect(report.operations.find(row => row.kind === 'agent-run')).toMatchObject({
      activeAtClose: 1, aborted: 1, settled: 0, unsettled: 1,
    })
    expect(report.components).toContainEqual(expect.objectContaining({
      kind: 'agent-team', id: 'unsettled-wakeup', status: 'timed-out',
    }))
    adapter.release()
    await vi.waitFor(() => expect(adapter.continued).toBe(true))
  })

  it('enforces configured message count and byte bounds before retention', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new TeamAdapter())] })
    const local = agents(runtime)
    const team = runtime.team({ id: 'bounded-team', maxMessages: 1, maxMessageBytes: 128, members: [
      { name: 'lead', agent: local.lead }, { name: 'worker', agent: local.worker },
    ] })
    await team.sendMessage({ from: 'lead', target: 'worker', message: 'one' })
    await expect(team.sendMessage({ from: 'lead', target: 'worker', message: 'two' })).rejects.toThrow(/message mailbox limit/)
    await runtime.close()
  })

  it('rejects an invalid message signal before operation admission or delivery', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new TeamAdapter())] })
    const local = agents(runtime)
    const team = runtime.team({ id: 'invalid-signal-team', members: [
      { name: 'lead', agent: local.lead }, { name: 'worker', agent: local.worker },
    ] })
    expect(() => team.sendMessage({ from: 'lead', target: 'worker', message: 'no', signal: {} as AbortSignal }))
      .toThrow(TypeError)
    expect(runtime.operations.activeCount).toBe(0)
    await runtime.close()
  })
})
