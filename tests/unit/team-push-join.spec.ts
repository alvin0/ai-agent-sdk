import { describe, expect, it, vi } from 'vitest'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ManagedAgentTeam } from '@alvin0/ai-agent-sdk-core/agent'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { GatedTeam, create, tool } from './team-push-join.fixture.ts'

describe('event-driven managed settlement', () => {
  it.each(['basic', 'deep'] as const)('yields without polling in %s mode and joins before returning', async mode => {
    const adapter = new GatedTeam(['a', 'b'])
    const team = create(adapter, { lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', mode,
      instructions: 'Research and synthesize.', maxTurns: 6 }) })
    let returned = false
    const running = team.run('Research and synthesize').then(result => { returned = true; return result })
    await vi.waitFor(() => expect(team.lead.isRunning).toBe(false))
    expect(adapter.started.size).toBe(2)
    expect(adapter.leadRequests).toHaveLength(2)
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(adapter.leadRequests).toHaveLength(2)
    expect(returned).toBe(false)
    vi.useRealTimers()
    adapter.gates.get('a')!.resolve()
    await team.awaitWorker('a')
    await team.team.whenIdle('lead')
    expect(returned).toBe(false)
    adapter.gates.get('b')!.resolve()
    expect((await running).text).toBe('synthesis')
    expect(adapter.leadRequests).toHaveLength(mode === 'basic' ? 4 : 5)
    expect(await tool(team, 'wait_agents', { targets: ['a', 'b'] })).toMatchObject({ results: [], timedOut: false })
  })

  it('joins every target, returns results directly once, and suppresses push duplicates', async () => {
    const adapter = new GatedTeam(['a', 'b'])
    adapter.join = true
    const team = create(adapter)
    const running = team.run('Join both')
    await vi.waitFor(() => expect(adapter.leadRequests).toHaveLength(2))
    adapter.gates.get('a')!.resolve()
    await team.awaitWorker('a')
    expect(adapter.leadRequests).toHaveLength(2)
    adapter.gates.get('b')!.resolve()
    expect((await running).text).toBe('synthesis')
    const toolMessages = adapter.leadRequests.at(-1)!.messages.filter(message => message.source.kind === 'tool')
    const payload = JSON.stringify(toolMessages)
    expect(payload).toContain('a finding 1')
    expect(payload).toContain('b finding 1')
    expect(team.lead.history.messages().filter(message => message.source.kind === 'app'
      && message.source.producer === 'managed-team-settlement')).toHaveLength(0)
    expect((await tool(team, 'wait_agents', { targets: ['a', 'b'] })).results).toEqual([])
  })

  it('keeps discovery small and pages retained output explicitly', async () => {
    const adapter = new GatedTeam()
    adapter.workerText = 'finding'.repeat(2_000)
    const team = create(adapter)
    await team.spawn({ name: 'w', task: 'Research' })
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    const listed = await tool(team, 'list_agents', {})
    expect(JSON.stringify(listed)).not.toContain('w findingfindingfinding')
    expect(listed.every((member: object) => !('outcome' in member))).toBe(true)
    const notices = team.lead.history.messages().filter(message => message.source.kind === 'app'
      && message.source.producer === 'managed-team-settlement')
    expect(notices).toHaveLength(1)
    expect(JSON.stringify(notices[0]).length).toBeLessThan(9_000)
    const first = await tool(team, 'get_agent_result', { target: 'w' })
    expect(first.page.nextOffset).toBe(6144)
    const second = await tool(team, 'get_agent_result', { target: 'w', offset: first.page.nextOffset, maxBytes: 16384 })
    expect(first.result.text + second.result.text).toBe(`w ${adapter.workerText} 1`)
    expect((await tool(team, 'wait_agents', { targets: ['w'] })).results).toEqual([])
  })

  it('releases finished slots while retaining records and follow-up support', async () => {
    const adapter = new GatedTeam(['a', 'b'])
    const team = create(adapter, { maxWorkers: 1 })
    await team.spawn({ name: 'a', task: 'First' })
    adapter.gates.get('a')!.resolve()
    await team.awaitWorker('a')
    await team.spawn({ name: 'b', task: 'Second' })
    expect(team.workers().map(worker => worker.name)).toEqual(['a', 'b'])
    const before = team.team.messages().length
    await expect(team.team.followup('lead', 'a', 'Too early')).rejects.toThrow(/1-worker limit/)
    expect(team.team.messages()).toHaveLength(before)
    adapter.gates.get('b')!.resolve()
    await team.awaitWorker('b')
    await team.team.followup('lead', 'a', 'Check again')
    await team.team.whenIdle('a')
    const workerA = (worker: { name: string }) => worker.name === 'a'
    await vi.waitFor(() => expect(team.workers().find(workerA)?.result?.text).toBe('a finding 2'))
    expect((await tool(team, 'get_agent_result', { target: 'a' })).result.text).toBe('a finding 2')
  })

  it('does not lose synthesis when the last result arrives at an exhausted turn boundary', async () => {
    const adapter = new GatedTeam()
    let team!: ManagedAgentTeam
    team = create(adapter, {
      lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', mode: 'basic', maxTurns: 2,
        instructions: 'Research and synthesize.' }),
      leadSessionOptions: { hooks: { onTurnEnd: async () => {
        adapter.gates.get('w')!.resolve()
        await team.awaitWorker('w')
      } } },
    })
    expect((await team.run('Research')).text).toBe('synthesis')
    expect(adapter.leadRequests).toHaveLength(3)
  })

  it('returns partial join results at timeout and delivers the remaining result later', async () => {
    const adapter = new GatedTeam(['a', 'b'])
    adapter.join = true
    const team = create(adapter, { team: { waitTimeoutMs: 500, minWaitTimeoutMs: 10 } })
    const running = team.run('Research')
    await vi.waitFor(() => expect(adapter.leadRequests).toHaveLength(2))
    adapter.gates.get('a')!.resolve()
    await team.awaitWorker('a')
    await vi.waitFor(() => expect(adapter.leadRequests).toHaveLength(3))
    const joined = JSON.stringify(adapter.leadRequests.at(-1)!.messages)
    expect(joined).toContain('a finding 1')
    expect(joined).toContain('timedOut')
    expect(joined).not.toContain('b finding 1')
    adapter.gates.get('b')!.resolve()
    await running
    const notices = team.lead.history.messages().filter(message => message.source.kind === 'app'
      && message.source.producer === 'managed-team-settlement')
    expect(JSON.stringify(notices)).not.toContain('a finding 1')
    expect(JSON.stringify(notices)).toContain('b finding 1')
  })

  it('honors caller cancellation while the managed run is yielded', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter)
    const controller = new AbortController()
    const running = team.run('Research', { signal: controller.signal })
    await vi.waitFor(() => expect(team.lead.isRunning).toBe(false))
    controller.abort(new Error('Caller cancelled'))
    await expect(running).rejects.toThrow('Caller cancelled')
    expect(team.workers()).toEqual([])
    expect(adapter.leadRequests).toHaveLength(2)
  })

  it('permits host-driven fire-and-forget only when automatic coordination is disabled', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter, { autoLeadCoordination: false })
    expect((await team.run('Research')).text).toBe('yield')
    expect(team.workers()[0]?.status).toBe('running')
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    await team.team.whenIdle('lead')
    expect(adapter.leadRequests).toHaveLength(2)
  })

  it('preserves structured results and bounds large structured settlement payloads', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter)
    await team.spawn({ name: 'w', task: 'Research' })
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    team.team.recordOutcome('w', { kind: 'completed', text: 'finding', structured: { ids: [1, 2] } })
    const joined = await tool(team, 'wait_agents', { targets: ['w'] })
    expect(joined.results[0].structured).toEqual({ ids: [1, 2] })
    const structured = { detail: 'x'.repeat(10_000) }
    team.team.recordOutcome('w', { kind: 'completed', text: 'finding', structured })
    const bounded = await tool(team, 'wait_agents', { targets: ['w'] })
    expect(bounded.results[0].structuredTruncated).toBe(true)
    expect(JSON.stringify(bounded).length).toBeLessThan(9_000)
    const page = await tool(team, 'get_agent_result', { target: 'w', field: 'structured', maxBytes: 16384 })
    expect(JSON.parse(page.result.structuredPreview)).toEqual(structured)
  })

  it('reports cancellation once and still synthesizes after the final worker is cancelled', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter)
    const running = team.run('Research')
    await vi.waitFor(() => expect(adapter.leadRequests).toHaveLength(2))
    expect(await team.closeWorker('w')).toBe('running')
    await running
    const messages = JSON.stringify(adapter.leadRequests.at(-1)!.messages)
    expect(messages).toContain('cancelled')
    expect(adapter.leadRequests).toHaveLength(3)
    expect((await tool(team, 'get_agent_result', { target: 'w' })).result.status).toBe('cancelled')
  })

  it('distinguishes a worker deadline from a failure', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter, { workerTimeoutMs: 100 })
    await team.run('Research')
    expect(JSON.stringify(adapter.leadRequests.at(-1)!.messages)).toContain('timeout')
    expect(team.workers()[0]?.status).toBe('failed')
    expect(adapter.leadRequests).toHaveLength(3)
  })

  it('rejects a failed synthesis instead of returning the earlier yielded answer', async () => {
    class FailedSynthesis extends GatedTeam {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (this.leadRequests.length >= 2 && options.tools?.some(tool => tool.name === 'spawn_agent')) {
          yield { type: 'finish', reason: { kind: 'error',
            failure: { code: 'UNAVAILABLE', message: 'Synthesis failed' } } }
        } else yield* super.stream(options)
      }
    }
    const adapter = new FailedSynthesis()
    const team = create(adapter)
    const running = team.run('Research')
    const rejected = expect(running).rejects.toThrow('Lead synthesis failed: Synthesis failed')
    await vi.waitFor(() => expect(team.lead.isRunning).toBe(false))
    expect(team.lead.lastOutcome()?.yielded).toBe(true)
    expect(team.lead.lastOutcome()?.completed).toBe(false)
    adapter.gates.get('w')!.resolve()
    await rejected
    expect(team.lead.lastOutcome()?.reason.kind).toBe('error')
  })
})
