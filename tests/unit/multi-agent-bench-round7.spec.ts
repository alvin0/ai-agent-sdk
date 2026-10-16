import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { createManagedAgentTeam } from '../../packages/core/dist/agent.js'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '../../packages/core/dist/index.js'
import { budgetInstructions, execute, type Job } from '../../test-human/multi-agent-bench/execute.ts'
import { FakeAdapter } from '../../test-human/multi-agent-bench/fake.ts'
import { defaultLimits } from '../../test-human/multi-agent-bench/metrics.ts'
import { DelegationCollector } from '../../test-human/multi-agent-bench/delegation.ts'
import { compare, mergeGateDelta, parseAnalysisArgs, summarize } from '../../test-human/multi-agent-bench/analyze.ts'
import { parseArgs } from '../../test-human/multi-agent-bench/run.ts'
import { validateResumeTeamOptions } from '../../test-human/multi-agent-bench/team-options.ts'

const exec = promisify(execFile)
const job: Job = { provider: 'fake', model: 'gpt-6-luna', task: 'code-change', suite: 'smoke',
  arm: 'team', rep: 1, timeoutMs: 10000 }

describe('Round 7 team options and delegation evidence', () => {
  it.each(['null', '[]', '1', 'true', '"fork"', '{invalid'])('rejects non-object JSON: %s', json => {
    expect(() => parseArgs(['--out', '/tmp/r7', '--team-options', json])).toThrow()
  })

  it('passes unknown knobs and maxWorkers after defaults to an older SDK unchanged', async () => {
    const knobs = { maxWorkers: 1, maxDepth: 2, maxQueued: 8, defaultSpawnContext: 'fork',
      progressiveToolDisclosure: false, team: { waitTimeoutMs: 1000, minWaitTimeoutMs: 1 } }
    const factory = vi.fn(createManagedAgentTeam)
    const { result } = await execute({ ...job, teamOptions: knobs }, undefined, { teamFactory: factory })
    expect(factory.mock.calls[0]![0]).toMatchObject({ ...knobs, workerTeamTools: 'full', workerTimeoutMs: 10000 })
    expect(result).toMatchObject({ pass: true, teamOptions: knobs,
      effectiveTeamOptions: { ...knobs, maxWorkers: 1, workerTimeoutMs: 10000, workerTeamTools: 'full' },
      metrics: { spawnAttempts: 1, spawns: 1, spawnsAccepted: 1, spawnsRejected: 0,
        delegated: true, maxConcurrentWorkers: 1, freshSpawns: 0, forkSpawns: 1 } })
    // Actual resolved context, rather than the requested knob alone, establishes the metric.
    expect(result.metrics.contextUnknownSpawns).toBe(0)
    expect(budgetInstructions({ ...job, teamOptions: { workerTimeoutMs: 6000 } }, defaultLimits))
      .toContain('6 seconds per worker')
  })

  it('counts real rejected dispatches, resolved fork context and per-member disjoint usage buckets', async () => {
    class SpawnTwice extends FakeAdapter {
      leadCalls = 0
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (!options.system?.includes('Bench session: lead')) {
          for await (const chunk of super.stream(options)) {
            yield chunk.type === 'usage' ? { type: 'usage', usage: {
              inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 5, outputTokens: 20,
            } } : chunk
          }
          return
        }
        const index = this.leadCalls++
        if (index < 2) yield { type: 'block-end', index: 0, block: { type: 'tool-call',
          id: ToolCallId(`spawn-${index}`), name: 'spawn_agent',
          arguments: JSON.stringify({ name: `helper${index}`,
            task: 'Implement the workspace task.', context: 'fork' }) } }
        else yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
        yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 7, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: index < 2 ? 'tool-calls' : 'stop' } }
      }
    }
    const { result } = await execute({ ...job, teamOptions: { maxWorkers: 1, holdWaitMs: 10 } }, undefined,
      { adapterFactory: (_job, task) => new SpawnTwice(task) })
    expect(result).toMatchObject({ pass: true, metrics: { spawnAttempts: 2, spawns: 1,
      spawnsAccepted: 1, spawnsRejected: 1, forkSpawns: 1, freshSpawns: 0, delegated: true } })
    expect(Object.values(result.metrics.spawnRejectionReasons!)).toEqual([1])
    const usage = result.metrics.memberUsage!
    expect(usage.lead.calls).toBe(result.metrics.leadModelCalls)
    expect(usage.workers.calls).toBe(result.metrics.totalModelCalls - result.metrics.leadModelCalls)
    expect(usage.lead.cachedInputTokens).toBe(usage.lead.calls * 7)
    expect(usage.workers).toEqual({ calls: usage.workers.calls, inputTokens: usage.workers.calls * 100,
      cachedInputTokens: usage.workers.calls * 30, cacheWriteTokens: usage.workers.calls * 5,
      outputTokens: usage.workers.calls * 20 })
    expect(usage.byMember.helper0).toEqual(usage.workers)
    expect(usage.lead.inputTokens + usage.workers.inputTokens).toBe(result.metrics.inputTokens)
    expect(usage.lead.cachedInputTokens + usage.workers.cachedInputTokens).toBe(result.metrics.cacheReadTokens)
    expect(usage.lead.outputTokens + usage.workers.outputTokens).toBe(result.metrics.outputTokens)
  })

  it('reports a non-delegating team and a single run without inventing workers', async () => {
    for (const arm of ['single', 'team'] as const) {
      const { result } = await execute({ ...job, arm, task: 'sequential' })
      expect(result.metrics).toMatchObject({ delegated: false, spawnAttempts: 0, spawnsAccepted: 0,
        spawnsRejected: 0, maxConcurrentWorkers: 0, forkSpawns: 0, freshSpawns: 0 })
      expect(result.metrics.memberUsage!.workers.calls).toBe(0)
    }
  })

  it('distinguishes attached/queued workers from active runs and handles repeated names', () => {
    const collector = new DelegationCollector()
    collector.resolved('a', 'fork')
    collector.teamEvent({ type: 'member-attached', member: { name: 'a' } })
    collector.resolved('b', 'fresh')
    collector.teamEvent({ type: 'member-attached', member: { name: 'b' } })
    expect(collector.metrics(2).maxConcurrentWorkers).toBe(0)
    collector.running('a'); collector.running('a'); collector.running('b'); collector.running('lead')
    collector.settled('a'); collector.settled('b')
    collector.resolved('a', 'fresh')
    collector.teamEvent({ type: 'member-attached', member: { name: 'a' } })
    collector.running('a')
    expect(collector.metrics(3)).toMatchObject({ maxConcurrentWorkers: 2, forkSpawns: 1, freshSpawns: 2 })
  })

  it('counts batch attempts and preserves unknown accepted context', () => {
    const collector = new DelegationCollector()
    collector.dispatch('lead', { toolName: 'spawn_agents', callId: 'batch',
      args: JSON.stringify({ agents: [{ task: 'a' }, { task: 'b' }] }) })
    collector.teamEvent({ type: 'member-attached', member: { name: 'a' } })
    collector.rejected('lead', { toolName: 'spawn_agents', callId: 'batch' }, 'capacity')
    expect(collector.metrics(1)).toMatchObject({ spawnAttempts: 2, spawnsRejected: 1,
      contextUnknownSpawns: 1, forkSpawns: 0, freshSpawns: 0 })
  })

  it('reads explicit partial batch refusals from successful tool results without counting failed workers', () => {
    const collector = new DelegationCollector()
    const call = { toolName: 'spawn_agents', callId: 'batch' }
    collector.dispatch('lead', { ...call, args: { agents: [{ task: 'a' }, { task: 'b' }, { task: 'c' }] } })
    collector.toolResult('lead', call, { content: [{ type: 'text', text: JSON.stringify({ results: [
      { name: 'a', status: 'running' }, { name: 'b', status: 'rejected', reason: 'queue full' },
      { name: 'c', status: 'failed' },
    ] }) }] })
    collector.toolResult('lead', call, { content: [{ type: 'text', text: JSON.stringify({ results: [
      { name: 'a', status: 'running' }, { name: 'b', status: 'rejected', reason: 'queue full' },
      { name: 'c', status: 'failed' },
    ] }) }] })
    expect(collector.metrics(2)).toMatchObject({ spawnAttempts: 3, spawnsRejected: 1,
      spawnRejectionReasons: { 'queue full': 1 } })
    collector.toolResult('lead', { ...call, callId: 'other' }, { content: [{ type: 'text', text: '{unknown' }] })
    expect(collector.metrics(2).spawnsRejected).toBe(1)
  })

  it('compares resume options structurally without allowing overrides', () => {
    expect(() => validateResumeTeamOptions({ maxWorkers: 2, extra: { a: 1, b: 2 } },
      { extra: { b: 2, a: 1 }, maxWorkers: 2 })).not.toThrow()
    expect(() => validateResumeTeamOptions({ maxWorkers: 2 })).not.toThrow()
    expect(() => validateResumeTeamOptions({ maxWorkers: 2 }, { maxWorkers: 3 })).toThrow('saved manifest')
    expect(() => validateResumeTeamOptions({}, { maxWorkers: 4 })).toThrow('saved manifest')
  })

  it('stores options in the manifest/results, reuses them on resume and rejects different JSON', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ma-r7-resume-')), out = join(parent, 'results')
    const script = resolve('test-human/multi-agent-bench/run.ts')
    const knobs = { maxWorkers: 1, maxDepth: 2 }
    try {
      await exec(process.execPath, [script, '--provider', 'fake', '--suite', 'smoke', '--tasks', 'code-change',
        '--arms', 'team', '--reps', '1', '--team-options', JSON.stringify(knobs), '--out', out])
      const manifestText = await readFile(join(out, 'manifest.json'), 'utf8')
      expect(JSON.parse(manifestText)).toMatchObject({ protocol: 'autonomous-v7', teamOptions: knobs,
        effectiveTeamOptions: { 'code-change': { maxWorkers: 1, maxDepth: 2, workerTimeoutMs: 180000 } } })
      const path = join(out, 'code-change.team.1.json'), before = await readFile(path, 'utf8')
      const audit = await readFile(join(out, 'code-change.team.1.audit.json'), 'utf8')
      expect(JSON.parse(before).effectiveTeamOptions.maxDepth).toBe(2)
      await rm(path) // Missing cells must be reconstructed from saved team options.
      await exec(process.execPath, [script, '--resume', out])
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ teamOptions: knobs,
        effectiveTeamOptions: { maxWorkers: 1, maxDepth: 2 } })
      const { stdout } = await exec(process.execPath, [script, '--resume', out,
        '--team-options', '{"maxDepth":2,"maxWorkers":1}'])
      expect(stdout).toContain('resumed/skipped')
      await expect(exec(process.execPath, [script, '--resume', out,
        '--team-options', '{"maxWorkers":3}'])).rejects.toThrow('saved manifest')
      expect(await readFile(join(out, 'manifest.json'), 'utf8')).toBe(manifestText)
      expect(JSON.parse(audit).teamEvents.length).toBeGreaterThan(0)
      expect(JSON.parse(audit).delegation.teamEvents).toBeUndefined()
    } finally { await rm(parent, { recursive: true, force: true }) }
  }, 60000)

  it('parses explicit analysis destinations and rejects incomplete or unknown options', () => {
    expect(parseAnalysisArgs(['a', 'b'])).toEqual({ dirA: resolve('a'), dirB: resolve('b'), out: undefined })
    expect(parseAnalysisArgs(['a', 'b', '--out', 'report.json']).out).toBe(resolve('report.json'))
    for (const args of [[], ['a'], ['a', 'b', '--out'], ['a', 'b', '--unknown', 'x']]) {
      expect(() => parseAnalysisArgs(args)).toThrow('Usage: analyze.ts')
    }
  })

  it('splits legacy delegation scores and flags losses greater than one run in analysis JSON', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ma-r7-analysis-'))
    const { result } = await execute({ ...job, task: 'sequential' })
    const a = join(parent, 'a'), b = join(parent, 'b')
    const { mkdir } = await import('node:fs/promises')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      for (const dir of [a, b]) {
        await mkdir(dir)
        await writeFile(join(dir, 'manifest.json'), JSON.stringify({ protocol: 'test', reps: 3,
          arms: ['single', 'team'], ids: ['sequential'], teamOptions: dir === a ? {} : { maxDepth: 2 } }))
        for (let rep = 1; rep <= 3; rep++) {
          const metrics = { ...result.metrics, spawns: Number(rep === 3 || (dir === a && rep === 2)) }
          delete metrics.delegated // Older results only have spawns.
          const pass = dir === a || rep === 3
          await writeFile(join(dir, `sequential.team.${rep}.json`), JSON.stringify({ ...result,
            rep, score: Number(pass), pass, metrics }))
        }
      }
      const summary = (scores: number[]) => summarize(scores.map(score => ({ ...result, score, pass: score === 1 })))
      const gateRow = { task: 'sequential', arm: 'team', deltaPercent: {}, a: summary([1, 1, 1]) }
      expect(mergeGateDelta({ ...gateRow, b: summary([0, 1, 1]) }).regressionMoreThanOneRun).toBe(false)
      expect(mergeGateDelta({ ...gateRow, b: summary([1, 1]) }).regressionMoreThanOneRun).toBeNull()
      await assertReadOnlyAnalysis(a, b)
      const out = join(parent, 'comparison.json')
      const comparison = await compare(a, b, out)
      expect(comparison.comparable).toBe(true) // Team options are the intended A/B variable.
      expect(comparison.rows.find(row => row.task === 'sequential' && row.arm === 'team')).toMatchObject({
        a: { delegationRate: 2 / 3, delegated: { n: 2, score: { mean: 1 } }, nonDelegated: { n: 1 } },
        b: { delegationRate: 1 / 3, delegated: { n: 1, score: { mean: 1 } },
          nonDelegated: { n: 2, score: { mean: 0 } } } })
      expect(comparison.mergeGate[0]).toMatchObject({ scoreRunDelta: -2, passRunDelta: -2,
        regressionMoreThanOneRun: true })
      expect(log.mock.calls.some(call => String(call[0]).includes('REGRESSION'))).toBe(true)
      expect(JSON.parse(await readFile(out, 'utf8')).mergeGate).toEqual(comparison.mergeGate)
      expect(summarize([{ ...result, metrics: null }])).toMatchObject({ delegationRate: null,
        delegationUnknownRuns: 1 })
    } finally { log.mockRestore(); await rm(parent, { recursive: true, force: true }) }
  })
})

async function assertReadOnlyAnalysis(a: string, b: string) {
  const originalInput = 'preserved input artifact'
  await writeFile(join(b, 'comparison.json'), originalInput)
  const noOutput = await compare(a, b)
  expect(await readFile(join(b, 'comparison.json'), 'utf8')).toBe(originalInput)
  expect(noOutput.mergeGate).toHaveLength(1)
  expect(noOutput.mergeGate.every(row => row.arm === 'team')).toBe(true)
  const run = JSON.parse(await readFile(join(b, 'sequential.team.3.json'), 'utf8'))
  await writeFile(join(b, 'sequential.single.3.json'), JSON.stringify({ ...run, arm: 'single' }))
  expect((await compare(a, b)).mergeGate).toEqual(noOutput.mergeGate)
}
