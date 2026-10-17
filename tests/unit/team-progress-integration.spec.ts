import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ManagedAgentTeamOptions, TeamProgressEvent } from '@alvin0/ai-agent-sdk-core/agent'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { ProgressScript, runProgressScenario } from '../../samples/multi-agent-offline/progress.ts'
import { captureSurface } from './team-surface-capture.ts'
import { createHash } from 'node:crypto'

const teams: ReturnType<typeof createManagedAgentTeam>[] = []
afterEach(async () => {
  for (const team of teams.splice(0)) { await team.dispose(); await team.team.dispose() }
  vi.useRealTimers()
})

class GatedProgress extends ProgressScript {
  failLead = false
  private release!: () => void
  private readonly gate = new Promise<void>(resolve => { this.release = resolve })
  finish(): void { this.release() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if ((options.system ?? '').includes('You are managed worker')) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(options.signal?.reason)
        options.signal?.addEventListener('abort', abort, { once: true })
        void this.gate.then(() => { options.signal?.removeEventListener('abort', abort); resolve() })
        if (options.signal?.aborted) abort()
      })
      this.workerCalls = 2
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Verified.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else if (this.failLead && this.leadCalls === 2) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNAVAILABLE', message: 'lead failed' } } }
    } else yield* super.stream(options)
  }
}

function setup(options: Partial<ManagedAgentTeamOptions> = {}) {
  const adapter = new GatedProgress()
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const events: TeamProgressEvent[] = []
  const team = createManagedAgentTeam({ registry,
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted',
      mode: 'basic', instructions: 'Verify evidence.', maxTurns: 5 }),
    workerFactory: () => defineAgent({ id: 'worker', provider: 'test', model: 'scripted',
      instructions: 'Verify evidence.', maxTurns: 1 }),
    progressUpdates: { minIntervalMs: 10, maxIntervalMs: 100 },
    team: { onEvent: event => { if (event.type === 'team-progress') events.push(event) } }, ...options })
  teams.push(team)
  return { team, events, adapter }
}

describe('managed progress integration', () => {
  it('runs the requested offline story with zero extra calls/history during scheduled reporting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    let result: Awaited<ReturnType<typeof runProgressScenario>> | undefined
    const running = runProgressScenario(2).then(value => { result = value })
    await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 1000, interval: 20 })
    await running
    if (result === undefined) throw new Error('Missing scenario result')
    expect(result.reports.filter(event => event.phase === 'report')).toHaveLength(2)
    expect(result.reports.at(-1)?.reason).toBe('settled')
    expect(result.leadCallsWhileReporting).toBe(3)
    expect(result.totalLeadCalls).toBe(4)
    expect(result.reports[0]!.members[0]).toMatchObject({ lastTool: 'read_file',
      argumentHint: 'notes/cache.txt', status: 'running', modelCalls: 1 })
    expect(result.reports.at(-1)!.members[0]!.usage).toBeDefined()
  })

  it('disables the tool in initial and disclosed catalogs', async () => {
    const f = setup({ progressUpdates: false })
    expect(f.team.lead.effectiveCatalog()?.has('progress_updates')).toBe(false)
    await f.team.spawn({ task: 'one check' })
    expect(f.team.lead.effectiveCatalog()?.has('progress_updates')).toBe(false)
  })

  it('pins the entire initial system and tool surface to integration', async () => {
    const views = await captureSurface()
    expect(createHash('sha256').update(JSON.stringify(views[0])).digest('hex'))
      .toBe('36fe0d31ff7c25fc18882ebe0e138d127e5dc18572eaf4d21a86007e01dccbda')
    expect(views[0]!.tools.some(tool => tool.name === 'progress_updates')).toBe(false)
    expect(views[2]!.tools.some(tool => tool.name === 'progress_updates')).toBe(true)
    expect(views[1]!.tools.some(tool => tool.name === 'progress_updates')).toBe(false)
  })

  it('stops a schedule when a non-coordinating managed invocation ends', async () => {
    const f = setup({ autoLeadCoordination: false })
    await f.team.run('Spawn and report progress')
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'run-ended' })
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })

  it('stops a raw lead session at its normal run boundary', async () => {
    const f = setup({ autoLeadCoordination: false })
    await f.team.lead.run('Spawn and report progress')
    await f.team.lead.whenIdle()
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'run-ended' })
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })

  it('stops immediately when the invocation is aborted while yielded', async () => {
    const f = setup()
    const controller = new AbortController()
    const running = f.team.run('Spawn and report progress', { signal: controller.signal })
    const rejected = expect(running).rejects.toThrow('user interrupted')
    await vi.waitFor(() => expect(f.team.progressUpdates().active).toBe(true))
    await vi.waitFor(() => expect(f.team.lead.isRunning).toBe(false))
    const count = f.adapter.leadCalls
    controller.abort(new Error('user interrupted'))
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'aborted' })
    await rejected
    expect(f.adapter.leadCalls).toBe(count)
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })

  it('stops on raw streaming invocation abort after a provisional yield', async () => {
    const f = setup()
    const controller = new AbortController()
    const handle = f.team.lead.stream('Spawn and report progress', { signal: controller.signal })
    for await (const _ of handle) { /* host drains its lead stream */ }
    await handle.result
    expect(f.team.progressUpdates().active).toBe(true)
    controller.abort()
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'aborted' })
  })

  it('stops if the host abandons the lead stream after scheduling', async () => {
    const f = setup()
    const handle = f.team.lead.stream('Spawn and report progress')
    for await (const _ of handle) {
      if (f.team.progressUpdates().active) break
    }
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'aborted' })
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })

  it('stops on lead failure with outstanding workers', async () => {
    const f = setup()
    f.adapter.failLead = true
    await f.team.lead.run('Spawn and report progress')
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'run-ended' })
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })

  it('lets the host stop and inspect a yielded schedule idempotently', async () => {
    const f = setup()
    await f.team.lead.run('Spawn and report progress')
    expect(f.team.progressUpdates()).toMatchObject({ active: true, targets: ['worker_1'], intervalMs: 20 })
    f.team.stopProgressUpdates()
    f.team.stopProgressUpdates()
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'host' })
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })

  it('stops on managed disposal before the worker finishes', async () => {
    const f = setup()
    await f.team.lead.run('Spawn and report progress')
    const disposing = f.team.dispose()
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'closed' })
    await disposing
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })
})
