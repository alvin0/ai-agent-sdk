import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter, ModelRegistry, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { createManagedAgentTeam, defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { TeamProgressEvent } from '@alvin0/ai-agent-sdk-core/agent'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function call(name: string, args: unknown): StreamChunk[] {
  return [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(crypto.randomUUID()),
    name, arguments: JSON.stringify(args) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function answer(text: string): StreamChunk[] {
  return [{ type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

class TwoWaves extends ModelAdapter {
  leadCalls = 0
  workerCalls = 0
  readonly workers = [gate(), gate()]
  readonly leadGap = gate()
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if ((options.system ?? '').includes('You are managed worker')) {
      const wave = this.workerCalls++
      await this.workers[wave]!.promise
      yield* answer(`Verified wave ${wave + 1}.`)
      return
    }
    this.leadCalls++
    if (this.leadCalls === 1) yield* call('spawn_agent', { task: 'Verify the first module.' })
    else if (this.leadCalls === 2) yield* call('progress_updates', { interval_ms: 20 })
    else if (this.leadCalls === 4) {
      await this.leadGap.promise
      yield* call('spawn_agent', { task: 'Verify the second module.' })
    } else yield* answer(this.leadCalls < 6 ? 'Waiting for evidence.' : 'Both modules verified.')
  }
}

interface Scenario {
  team: ReturnType<typeof createManagedAgentTeam>
  adapter: TwoWaves
  events: TeamProgressEvent[]
}
const reports = (s: Scenario) => s.events.filter(event => event.phase === 'report')
async function expectNoLeadWake(s: Scenario) {
  const calls = s.adapter.leadCalls
  const history = JSON.stringify(s.team.lead.history.entries())
  await vi.advanceTimersByTimeAsync(20)
  expect(s.adapter.leadCalls).toBe(calls)
  expect(JSON.stringify(s.team.lead.history.entries())).toBe(history)
}
async function firstWave(s: Scenario) {
  await vi.waitFor(() => {
    expect(s.team.progressUpdates().active).toBe(true)
    expect(s.team.lead.isRunning).toBe(false)
  }, { interval: 1 })
  await expectNoLeadWake(s)
  expect(reports(s)).toHaveLength(1)
  s.adapter.workers[0]!.release()
  await vi.waitFor(() => {
    expect(s.adapter.leadCalls).toBe(4)
    expect(s.team.lead.isRunning).toBe(true)
    expect(s.team.workers().map(worker => worker.status)).toEqual(['completed'])
  }, { interval: 1 })
  await vi.advanceTimersByTimeAsync(100) // Beyond the watchdog window, while only lead work runs.
  expect(reports(s)).toHaveLength(1)
  expect(s.team.progressUpdates().active).toBe(true)
}
async function secondWave(s: Scenario) {
  s.adapter.leadGap.release()
  await vi.waitFor(() => {
    expect(s.adapter.workerCalls).toBe(2)
    expect(s.team.lead.isRunning).toBe(false)
  }, { interval: 1 })
  await expectNoLeadWake(s)
  expect(reports(s)).toHaveLength(2)
  expect(reports(s)[1]!.targets).toEqual(['worker_1', 'worker_2'])
  expect(reports(s)[1]!.members.some(member => member.name === 'worker_2' && member.activeRuns > 0)).toBe(true)
  s.adapter.workers[1]!.release()
}

function setup() {
  const adapter = new TwoWaves()
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const events: TeamProgressEvent[] = []
  const timersAtStop: number[] = []
  const team = createManagedAgentTeam({ registry,
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', mode: 'basic',
      instructions: 'Verify evidence in two waves.', maxTurns: 8 }),
    progressUpdates: { minIntervalMs: 20, stalledIntervals: 2 },
    team: { onEvent: event => {
      if (event.type !== 'team-progress') return
      events.push(event)
      if (event.phase === 'stopped') timersAtStop.push(vi.getTimerCount())
    } },
  })
  return { team, adapter, events, timersAtStop }
}

describe('managed progress across spawn waves', () => {
  it('schedules once across yield, synthesis, a quiet lead gap and a second spawn wave', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const s = setup()
    const { team, adapter, events, timersAtStop } = s
    const result = team.run('Verify modules; update me every 20 milliseconds.')
    void result.catch(() => undefined)
    try {
      await firstWave(s)
      await secondWave(s)
      await result
      await vi.advanceTimersByTimeAsync(0)
      expect(events.filter(event => event.phase === 'stopped').map(event => event.reason)).toEqual(['settled'])
      expect(new Set(events.map(event => event.scheduleId))).toEqual(new Set([1]))
      expect(adapter.leadCalls).toBe(6)
      expect(timersAtStop).toEqual([0])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      adapter.leadGap.release()
      for (const worker of adapter.workers) worker.release()
      await team.dispose()
      await team.team.dispose()
      await result.catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)
      try { expect(vi.getTimerCount()).toBe(0) } finally { vi.useRealTimers() }
    }
  })
})
