import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ManagedAgentTeamOptions, TeamProgressEvent } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolRunContext } from '@alvin0/ai-agent-sdk-core/agent'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { ProgressScript, runProgressScenario } from '../../samples/multi-agent-offline/progress.ts'
import { captureSurface } from './team-surface-capture.ts'
import { createHash } from 'node:crypto'

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }) })

const teams: ReturnType<typeof createManagedAgentTeam>[] = []
afterEach(async () => {
  for (const team of teams.splice(0)) { await team.dispose(); await team.team.dispose() }
  await vi.advanceTimersByTimeAsync(0) // Flush timeout cleanup queued by completed team disposal.
  try { expect(vi.getTimerCount()).toBe(0) } finally { vi.useRealTimers() }
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

async function startManaged(f: ReturnType<typeof setup>) {
  const result = f.team.run('Spawn and report progress')
  void result.catch(() => undefined)
  await vi.waitFor(() => {
    expect(f.team.progressUpdates().active).toBe(true)
    expect(f.team.lead.isRunning).toBe(false)
  }, { interval: 1 })
  return { result }
}

describe('managed progress integration', () => {
  it('runs the requested offline story with zero extra calls/history during scheduled reporting', async () => {
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
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disables the tool in initial and disclosed catalogs', async () => {
    const f = setup({ progressUpdates: false })
    expect(f.team.lead.effectiveCatalog()?.has('progress_updates')).toBe(false)
    await f.team.spawn({ task: 'one check' })
    expect(f.team.lead.effectiveCatalog()?.has('progress_updates')).toBe(false)
    f.team.stopProgressUpdates()
    f.team.stopProgressUpdates('run-ended')
    expect(f.team.progressUpdates()).toEqual({ active: false, reportsSent: 0 })
    expect(f.events).toEqual([])
  })

  it('pins the entire initial system and tool surface to integration', async () => {
    const views = await captureSurface()
    expect(createHash('sha256').update(JSON.stringify(views[0])).digest('hex'))
      .toBe('36fe0d31ff7c25fc18882ebe0e138d127e5dc18572eaf4d21a86007e01dccbda')
    expect(views[0]!.tools.some(tool => tool.name === 'progress_updates')).toBe(false)
    expect(views[2]!.tools.some(tool => tool.name === 'progress_updates')).toBe(true)
    expect(views[1]!.tools.some(tool => tool.name === 'progress_updates')).toBe(false)
  })

  it.each([{}, { progressiveToolDisclosure: false }, { modelToolSurface: 'legacy' as const },
    { collaboration: true }, { maxDepth: 0 }, { progressiveToolDisclosure: false, maxDepth: 0 },
    { modelToolSurface: 'legacy' as const, maxDepth: 0 }])
  ('withholds progress from every initial catalog API in mode %j', async options => {
    const f = setup(options)
    const catalog = f.team.lead.effectiveCatalog()!
    expect(catalog.get('progress_updates')).toBeUndefined()
    expect(catalog.has('progress_updates')).toBe(false)
    expect(catalog.names()).not.toContain('progress_updates')
    expect(catalog.schemas().some(tool => tool.name === 'progress_updates')).toBe(false)
    if (options.maxDepth === 0) return
    await f.team.spawn({ task: 'one check' })
    expect(catalog.has('progress_updates')).toBe(true)
    expect(catalog.get('progress_updates')).toBeDefined()
    expect(catalog.names().at(-1)).toBe('progress_updates')
    expect(catalog.schemas().at(-1)?.name).toBe('progress_updates')
    f.adapter.finish()
    await f.team.awaitWorker('worker_1')
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
    await vi.waitFor(() => expect(f.team.progressUpdates().active).toBe(true), { interval: 1 })
    await vi.waitFor(() => expect(f.team.lead.isRunning).toBe(false), { interval: 1 })
    const count = f.adapter.leadCalls
    controller.abort(new Error('user interrupted'))
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'aborted' })
    await rejected
    expect(f.adapter.leadCalls).toBe(count)
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })

  it('stops on raw streaming invocation end after a provisional yield', async () => {
    const f = setup()
    const controller = new AbortController()
    const handle = f.team.lead.stream('Spawn and report progress', { signal: controller.signal })
    for await (const _ of handle) { /* host drains its lead stream */ }
    await handle.result
    expect(f.team.lead.lastOutcome()?.yielded).toBe(true)
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'run-ended' })
    controller.abort()
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
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
    const running = await startManaged(f)
    expect(f.team.progressUpdates()).toMatchObject({ active: true, targets: ['worker_1'], intervalMs: 20 })
    f.team.stopProgressUpdates()
    f.team.stopProgressUpdates()
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'host' })
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
    f.adapter.finish()
    await running.result
  })

  it('stops on managed disposal before the worker finishes', async () => {
    const f = setup()
    const running = await startManaged(f)
    const disposing = f.team.dispose()
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'closed' })
    await disposing
    await running.result.catch(() => undefined)
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  })

  it('stops with a distinct steered reason before resuming lead work', async () => {
    const f = setup()
    const running = await startManaged(f)
    expect(f.team.steer('Use the latest user requirements.')).toBe(true)
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason: 'steered' })
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
    f.adapter.finish()
    await running.result
  })

  it.each(['requested', 'settled', 'max-duration', 'max-reports', 'stalled', 'delivery-failed', 'replaced'] as const)
  ('clears all timers after managed %s termination', async reason => {
    const limits = { minIntervalMs: 10, maxIntervalMs: 100,
      ...(reason === 'max-duration' ? { maxDurationMs: 5 } : {}),
      ...(reason === 'max-reports' ? { maxReports: 1 } : {}),
    }
    const f = setup({ progressUpdates: limits })
    if (reason === 'delivery-failed') f.team.team.subscribe(event => {
      if (event.type === 'team-progress' && event.phase === 'report') throw new Error('broken UI')
    })
    const running = await startManaged(f)
    const tool = f.team.lead.effectiveCatalog()!.get('progress_updates')!
    if (reason === 'requested') await tool.execute(tool.parse!({ stop: true }), {} as ToolRunContext)
    else if (reason === 'replaced') expect(() => tool.parse!({ interval_ms: 'bad' })).toThrow()
    else if (reason === 'settled') { f.adapter.finish(); await running.result }
    else await vi.advanceTimersByTimeAsync(reason === 'max-duration' ? 5 : 60)
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason })
    expect(f.events.filter(event => event.phase === 'stopped')).toHaveLength(1)
    f.adapter.finish()
    await running.result
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['host', 'run-ended', 'aborted'] as const)('accepts host cancellation reason %s', async reason => {
    const f = setup()
    const running = await startManaged(f)
    f.team.stopProgressUpdates(reason)
    expect(f.team.progressUpdates()).toMatchObject({ active: false, reason })
    f.adapter.finish()
    await running.result
  })

  it.each(['settled', 'closed', 'requested', 'steered', 'replaced', 'max-duration', 'max-reports',
    'stalled', 'delivery-failed', 'unknown'] as const)('rejects runtime-only host stop reason %s', reason => {
    const f = setup()
    // @ts-expect-error Runtime lifecycle reasons are not accepted by the host API.
    expect(() => f.team.stopProgressUpdates(reason)).toThrow(/invalid host progress stop reason/)
  })

})
