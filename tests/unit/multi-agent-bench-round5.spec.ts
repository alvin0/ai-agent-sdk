import { describe, expect, it, vi } from 'vitest'
import { tasks } from '../../test-human/multi-agent-bench/tasks.ts'
import { Workspace, workspaceTools } from '../../test-human/multi-agent-bench/workspace.ts'
import { budgetInstructions, execute } from '../../test-human/multi-agent-bench/execute.ts'
import { Collector, defaultLimits } from '../../test-human/multi-agent-bench/metrics.ts'
import { parseArgs } from '../../test-human/multi-agent-bench/run.ts'
import * as completion from '../../test-human/multi-agent-bench/completion.ts'
import { settleCompletion, type CompletionTeam } from '../../test-human/multi-agent-bench/completion.ts'
import { solution, FakeAdapter } from '../../test-human/multi-agent-bench/fake.ts'
import { summarize } from '../../test-human/multi-agent-bench/analyze.ts'
import { extractionChecks } from '../../test-human/multi-agent-bench/volume-grade.ts'

const job = { arm: 'single' as const, task: 'code-change', rep: 1, provider: 'fake' as const,
  model: 'gpt-6-luna', timeoutMs: 1200000, workerTimeoutMs: 1200000 }

describe('Round 5 live-evidence calibration', () => {
  it('offers atomic exact edit batches on every task, preserving limits and concurrent changes', async () => {
    for (const task of tasks) {
      const workspace = await Workspace.create(task)
      try {
        expect(workspaceTools(workspace).some(tool => tool.name === 'edit_file')).toBe(true)
        await workspace.write('edit.txt', 'alpha beta duplicate duplicate')
        await expect(workspace.edit('edit.txt', [{ old: 'alpha', new: 'changed' },
          { old: 'duplicate', new: 'ambiguous' }])).rejects.toThrow('exactly once')
        expect(await workspace.readAll('edit.txt')).toBe('alpha beta duplicate duplicate')
        await expect(workspace.edit('edit.txt', [{ old: 'missing', new: 'x' }])).rejects.toThrow()
        await expect(workspace.edit('edit.txt', [{ old: '', new: 'x' }])).rejects.toThrow()
        await expect(workspace.edit('edit.txt', [{ old: 'alpha', new: 'x'.repeat(65537) }]))
          .rejects.toThrow('64 KiB')
        await Promise.all([workspace.edit('edit.txt', [{ old: 'alpha', new: 'A' }]),
          workspace.edit('edit.txt', [{ old: 'beta', new: 'B' }])])
        expect(await workspace.readAll('edit.txt')).toBe('A B duplicate duplicate')
        await expect(workspace.edit('../escape', [{ old: 'x', new: 'y' }])).rejects.toThrow('outside')
        for (const file of task.frozen ?? []) {
          const text = await workspace.readAll(file)
          await expect(workspace.edit(file, [{ old: text, new: 'changed' }])).rejects.toThrow('Frozen')
        }
      } finally { await workspace.close() }
    }
  })

  it('fits the migration edit output planning allowance and exercises all eight edits per file', async () => {
    const migration = tasks.find(t => t.id === 'migration')!
    const calls = solution(migration).filter(call => call.name === 'edit_file')
    expect(calls).toHaveLength(40)
    const budget = migration.outputBudget!
    expect(budget.estimatedTokens).toBeLessThanOrEqual(1200 * budget.tokensPerSecond * budget.maxTimeFraction)
    expect(Object.values(migration.files!).join(' ')).not.toContain('checkpoint: this operation belongs')
    const workspace = await Workspace.create(migration)
    try {
      for (const call of calls) {
        const args = call.args as { path: string; edits: { old: string; new: string }[] }
        expect(args.edits).toHaveLength(8)
        await workspace.edit(args.path, args.edits)
        expect(await workspace.readAll(args.path)).toBe(migration.repairs![args.path])
      }
      expect(await workspace.grade()).toMatchObject({ pass: true, score: 1 })
    } finally { await workspace.close() }
  })

  it('resolves per-task job and worker defaults and independent overrides', () => {
    const defaults = parseArgs(['--out', '/tmp/unused'])
    expect(defaults.perTaskTimeouts.migration).toEqual({ timeoutMs: 1200000,
      workerTimeoutMs: 1200000, orphanGraceMs: 30000 })
    expect(defaults.perTaskTimeouts.sequential?.timeoutMs).toBe(180000)
    const changed = parseArgs(['--out', '/tmp/unused', '--timeout-ms', '900',
      '--volume-timeout-ms', '1500', '--worker-timeout-ms', '800',
      '--volume-worker-timeout-ms', '1400', '--orphan-grace-ms', '50'])
    expect(changed.perTaskTimeouts.migration).toEqual({ timeoutMs: 1500, workerTimeoutMs: 1400, orphanGraceMs: 50 })
    expect(changed.perTaskTimeouts.sequential).toEqual({ timeoutMs: 900, workerTimeoutMs: 800, orphanGraceMs: 50 })
    expect(() => parseArgs(['--out', '/tmp/unused', '--volume-timeout-ms', '0'])).toThrow('positive')
    const prompt = budgetInstructions(job, defaultLimits)
    for (const text of ['1200 seconds', '1500000', '240 model calls', '320 tool calls',
      'Keep going until every file/document is covered; do not stop early.']) expect(prompt).toContain(text)
  })

  it('flags lead completion with an active follow-up even if the worker snapshot still says completed', async () => {
    let busy = true
    const team: CompletionTeam = { workers: () => [{ name: 'a', status: 'completed' }],
      team: { members: () => [{ name: 'lead', status: 'idle' },
        { name: 'a', status: busy ? 'running' : 'idle' }] },
      whenQuiet: async () => { busy = false } }
    expect(await settleCompletion(team, { completed: false, reason: { kind: 'completed' } },
      new AbortController().signal, 1000)).toEqual({ status: 'completed-orphans', orphanWorkers: 1,
      orphanWorkersAfterGrace: 0 })
    expect(await settleCompletion(team, { completed: true, reason: { kind: 'completed' } },
      new AbortController().signal, 1000)).toMatchObject({ status: 'completed', orphanWorkers: 0 })
    await expect(settleCompletion(team, { completed: false, reason: { kind: 'error' } },
      new AbortController().signal, 1000)).rejects.toThrow('Lead incomplete')
  })

  it('grades an injected orphan-completion finding normally through execute', async () => {
    const original = completion.settleCompletion
    const spy = vi.spyOn(completion, 'settleCompletion').mockImplementation(async (...args) => ({
      ...await original(...args), status: 'completed-orphans', orphanWorkers: 1,
    }))
    try {
      const { result } = await execute({ ...job, arm: 'team' })
      expect(result).toMatchObject({ status: 'completed-orphans', score: 1, pass: true,
        metrics: { orphanWorkers: 1, orphanWorkersAfterGrace: 0 } })
      expect(result.error).toBeUndefined()
    } finally { spy.mockRestore() }
  })

  it('bounds orphan settlement grace without turning its expiry into a harness failure', async () => {
    vi.useFakeTimers()
    try {
      const team: CompletionTeam = { workers: () => [{ name: 'a', status: 'pending' }],
        team: { members: () => [{ name: 'a', status: 'running' }] },
        whenQuiet: signal => new Promise((_, reject) => signal!.addEventListener('abort',
          () => reject(signal!.reason), { once: true })) }
      const result = settleCompletion(team, { completed: true, reason: { kind: 'completed' } },
        new AbortController().signal, 50)
      await vi.advanceTimersByTimeAsync(50)
      expect(await result).toMatchObject({ status: 'completed-orphans', orphanWorkers: 1,
        orphanWorkersAfterGrace: 1 })
      const controller = new AbortController()
      const aborted = settleCompletion(team, { completed: true, reason: { kind: 'completed' } },
        controller.signal, 50)
      const assertion = expect(aborted).rejects.toThrow('job timeout')
      controller.abort(new Error('job timeout'))
      await assertion
    } finally { vi.useRealTimers() }
  })

  it('preserves reported usage across an aborted call and flags lower bounds and orphans in analysis', () => {
    const collector = new Collector()
    const event = (phase: 'start' | 'end', data = {}) => ({ member: 'a', event: {
      name: 'sdk.model.call', phase, data } }) as Collector['events'][number]
    collector.events.push(event('start'), event('end', { coverage: 'complete', reported: {
      inputTokens: 100, cacheReadTokens: 1000, outputTokens: 20 } }), event('start'),
    event('end', { coverage: 'partial', status: 'aborted', reported: { outputTokens: 5 } }))
    collector.orphanWorkers = 1
    const metrics = collector.metrics(0)
    expect(metrics).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 1125,
      reportedTokens: 1125, costWeightedTokens: 225, reportedCostWeightedTokens: 225,
      usageComplete: false, usageIncomplete: true })
    expect(summarize([{ ...job, score: 1, pass: true, status: 'completed-orphans', metrics }]))
      .toMatchObject({ tokens: { mean: 1125 }, output: { mean: 25 }, costWeightedTokens: { mean: 225 },
        tokenLowerBoundRuns: 1, usageIncompleteRuns: 1, completedOrphanRuns: 1, orphanWorkers: 1 })
  })

  it('records real tool errors with tool names and bounded argument summaries through the SDK', async () => {
    let count = 0
    const original = FakeAdapter.prototype.stream
    const spy = vi.spyOn(FakeAdapter.prototype, 'stream').mockImplementation(
      async function* (this: FakeAdapter, options) {
      if (++count === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'bad' as never,
          name: 'read_file', arguments: JSON.stringify({ path: 'missing.cjs' }) } }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else yield* original.call(this, options)
      })
    try {
      const { result } = await execute(job)
      expect(result.metrics.errors.some(error => error.includes('tool read_file args=')
        && error.includes('missing.cjs') && error.includes('ENOENT'))).toBe(true)
      expect(result.metrics.errors.join(' ')).not.toContain('[object Object]')
    } finally { spy.mockRestore() }
  })

  it('grades latest corrections independently per report, including split severity inputs', () => {
    const task = tasks.find(t => t.id === 'extraction')!
    const expected = task.expected as Record<string, Record<string, unknown>>
    expect(Object.keys(expected)).toHaveLength(72)
    expect(Buffer.byteLength(Object.values(task.files!).join(''))).toBeGreaterThan(1000000)
    for (const [file, fields] of Object.entries(expected)) {
      const source = task.files![file]!, corrected = source.slice(source.indexOf('## Correction notice:'))
      expect(corrected).toContain(`accountable team is ${fields.owningTeam}`)
      expect(corrected).toContain(`${fields.ticket} is the sole approved follow-up`)
      const latest = (a: string, b: string) => source.lastIndexOf(a) > source.lastIndexOf(b)
      const impact = latest('Real customer requests failed', 'Only synthetic requests failed')
      const loss = latest('confirmed permanent loss', 'confirmed that no customer')
      const workaround = latest('An effective customer workaround', 'No effective customer workaround')
      expect(fields.customerImpact).toBe(impact)
      let severity = impact && !workaround ? 'SEV2' : 'SEV3'
      if (loss) severity = 'SEV1'
      expect(fields.severity).toBe(severity)
    }
    const partial = structuredClone(expected)
    delete partial[Object.keys(partial)[0]!]!.ticket
    expect(extractionChecks(task, partial).filter(Boolean)).toHaveLength(431)
  })
})
