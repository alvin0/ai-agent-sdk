import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tasks, checkCount, selectTasks } from '../../test-human/multi-agent-bench/tasks.ts'
import { Workspace, workspaceTools } from '../../test-human/multi-agent-bench/workspace.ts'
import { execute } from '../../test-human/multi-agent-bench/execute.ts'
import { Collector, tokenCounts } from '../../test-human/multi-agent-bench/metrics.ts'
import { auditChecks, extractionChecks } from '../../test-human/multi-agent-bench/volume-grade.ts'
import { compare, summarize } from '../../test-human/multi-agent-bench/analyze.ts'
import { FakeAdapter, solution } from '../../test-human/multi-agent-bench/fake.ts'
import type { GenerateOptions } from '../../packages/core/dist/index.js'

const task = (id: string) => tasks.find(task => task.id === id)!
const fraction = (checks: boolean[]) => checks.filter(Boolean).length / checks.length

describe('Round 4 reading-volume calibration', () => {
  it('generates reproducible, seed-dependent corpora with the intended partitions and reading volume', () => {
    const other = selectTasks('scaled', 123)
    expect(tasks.map(t => t.kind)).toEqual(['volume', 'volume', 'volume',
      'overhead', 'overhead', 'control', 'overhead', 'overhead'])
    for (const id of ['extraction', 'multi-module-audit', 'migration']) {
      expect(task(id).files).not.toEqual(other.find(t => t.id === id)!.files)
    }
    const reports = Object.entries(task('extraction').files!).filter(([name]) => name.startsWith('reports/'))
    expect(reports).toHaveLength(72)
    const onePage = reports.every(([, text]) => text.split(/\s+/).length >= 2000
      && Buffer.byteLength(text) < 16384)
    expect(onePage)
      .toBe(true)
    expect(Object.keys(task('multi-module-audit').files!).filter(name => name.endsWith('.cjs'))).toHaveLength(60)
    expect(Object.keys(task('migration').repairs!)).toHaveLength(40)
    expect(Object.keys(task('migration').moduleChecks!)).toHaveLength(5)
    // Corpus sizing proxies, not measured provider tokens. Both require many bounded read/write turns.
    const auditWords = Object.values(task('multi-module-audit').files!).join(' ').split(/\s+/).length
    expect(auditWords).toBeGreaterThan(100000)
    expect(Object.values(task('migration').files!).join(' ').split(/\s+/).length).toBeLessThan(10000)
    for (const id of ['multi-module-audit', 'migration']) {
      const reads = solution(task(id)).filter(call => call.name === 'read_file')
      expect(reads.length).toBeGreaterThanOrEqual(40)
      const words = Object.values(task(id).files!).join(' ').split(/\s+/).length
      if (id === 'multi-module-audit') expect(words * 2).toBeGreaterThanOrEqual(150000)
    }
  })

  it('grades perfect, half, missing and malformed incident answers per field', async () => {
    const extraction = task('extraction'), expected = extraction.expected as Record<string, Record<string, unknown>>
    expect(fraction(extractionChecks(extraction, expected))).toBe(1)
    const half = Object.fromEntries(Object.entries(expected).slice(0, 36))
    expect(fraction(extractionChecks(extraction, half))).toBe(0.5)
    const halfFields = Object.fromEntries(Object.entries(expected).map(([file, fields]) =>
      [file, Object.fromEntries(Object.entries(fields).slice(0, 3))]))
    expect(fraction(extractionChecks(extraction, halfFields))).toBe(0.5)
    expect(fraction(extractionChecks(extraction, { ...expected, unusedCategory: 0 }))).toBe(1)
    const workspace = await Workspace.create(extraction)
    try {
      for (const answer of ['{}', 'null', '[1,2]', 'broken JSON']) {
        await workspace.write('answer.json', answer)
        const grade = await workspace.grade()
        expect(grade.score).toBe(0)
        expect(grade.checks).toHaveLength(432)
      }
    } finally { await workspace.close() }
  })

  it('uses documented severity precedence and closure facts rather than distractors', () => {
    const extraction = task('extraction')
    const expected = extraction.expected as Record<string, Record<string, unknown>>
    for (const [file, fields] of Object.entries(expected)) {
      const source = extraction.files![file]!
      expect(source).toContain(`accountable team is ${fields.owningTeam}`)
      expect(source).toContain(`production failure boundary was ${fields.service}`)
      const clues: Record<string, string[]> = { configuration: ['wrong region', 'retired endpoint'],
        dependency: ['upstream provider', 'external gateway'], capacity: ['execution slots', 'resource limit'],
        deployment: ['released binary', 'serving binary'] }
      expect(clues[String(fields.rootCause)]!.some(clue => source.includes(clue))).toBe(true)
      expect(source).toContain(`${fields.ticket} is the sole approved follow-up`)
      let severity = 'SEV3'
      const latestLoss = source.lastIndexOf('confirmed permanent loss')
        > source.lastIndexOf('confirmed that no customer')
      const latestWorkaround = source.lastIndexOf('An effective customer workaround')
        > source.lastIndexOf('No effective customer workaround')
      if (fields.customerImpact && !latestWorkaround) severity = 'SEV2'
      if (latestLoss) severity = 'SEV1'
      expect(fields.severity).toBe(severity)
    }
    const severities = new Set(Object.values(expected).map(fields => fields.severity))
    expect(severities).toEqual(new Set(['SEV1', 'SEV2', 'SEV3']))
  })

  it('scores audits per finding with precision and recall, penalizing duplicates and false positives', async () => {
    const audit = task('multi-module-audit'), findings = audit.auditFindings!
    const perfect = auditChecks(audit, { findings })
    expect(fraction(perfect.checks)).toBe(1)
    expect(perfect).toMatchObject({ precision: 1, recall: 1 })
    expect(fraction(auditChecks(audit, { findings: findings.slice(0, findings.length / 2) }).checks)).toBe(0.5)
    const extras = [...findings, ...findings.map(f => ({ ...f, symbol: 'invented' }))]
    expect(auditChecks(audit, { findings: extras })).toMatchObject({ precision: 0.5, recall: 1 })
    expect(fraction(auditChecks(audit, { findings: [...findings, ...findings] }).checks)).toBe(0.75)
    const workspace = await Workspace.create(audit)
    try {
      await workspace.write('findings.json', JSON.stringify({ findings }))
      expect(await workspace.grade()).toMatchObject({ score: 1, precision: 1, recall: 1 })
      await workspace.write('findings.json', 'bad JSON')
      expect(await workspace.grade()).toMatchObject({ score: 0, precision: 0, recall: 0 })
    } finally { await workspace.close() }
  })

  it('validates every planted audit finding against executable calls and counts all violations', async () => {
    const audit = task('multi-module-audit')
    // Trusted generated fixtures only: record every actual call rather than trusting generator metadata.
    const actual: NonNullable<typeof audit.auditFindings> = []
    for (const [file, text] of Object.entries(audit.files!).filter(([file]) => file.endsWith('.cjs'))) {
      const exports: Record<string, (api: unknown) => void> = {}
      new Function('exports', text)(exports)
      for (const [symbol, fn] of Object.entries(exports)) fn({
        publish: (x: { audience: string; consent: boolean }) => {
          if (x.audience === 'external' && !x.consent) actual.push({ file, symbol, rule: 'external-consent' })
        },
        retry: (x: { mode: string; idempotencyKey: string }) => {
          if (x.mode === 'write' && !x.idempotencyKey) actual.push({ file, symbol, rule: 'write-key' })
        },
        remove: (x: { retention: string; archiveOnly: boolean }) => {
          if (x.retention === 'hold' && !x.archiveOnly) actual.push({ file, symbol, rule: 'legal-hold' })
        },
      })
    }
    expect(actual).toEqual(audit.auditFindings)
  })

  it('grades migration perfectly and halfway by file and package, isolating a broken module', async () => {
    const migration = task('migration'), workspace = await Workspace.create(migration)
    try {
      expect((await workspace.grade()).score).toBe(0)
      for (const [file, source] of Object.entries(migration.repairs!).slice(0, 20)) await workspace.write(file, source)
      const half = await workspace.grade()
      expect(half.score).toBe(0.5)
      expect(half.checks).toHaveLength(640)
      expect((await workspace.test(undefined, 'pkg-0')).every(Boolean)).toBe(true)
      expect((await workspace.test(undefined, 'pkg-4')).some(Boolean)).toBe(false)
      for (const [file, source] of Object.entries(migration.repairs!).slice(20)) await workspace.write(file, source)
      expect((await workspace.grade()).score).toBe(1)
      await workspace.write(Object.keys(migration.repairs!)[0]!, 'syntax error !!!!')
      expect((await workspace.grade()).score).toBeCloseTo(39 / 40)
      const shell = workspaceTools(workspace).find(tool => tool.name === 'shell')!
      const context = { signal: new AbortController().signal } as Parameters<typeof shell.execute>[1]
      await expect(shell.execute({ command: 'run bypass.cjs answer.json' }, context)).rejects.toThrow('Only test')
    } finally { await workspace.close() }
  }, 15000)

  it('keeps full grading denominators on absent artifacts and capped executions in both arms', async () => {
    for (const entry of tasks) {
      const workspace = await Workspace.create(entry)
      try { expect((await workspace.grade()).checks).toHaveLength(checkCount(entry)) }
      finally { await workspace.close() }
    }
    for (const arm of ['single', 'team'] as const) for (const id of ['extraction', 'migration', 'multi-module-audit']) {
      const { result } = await execute({ arm, task: id, provider: 'fake', model: 'gpt-6-luna',
        rep: 1, timeoutMs: 15000, maxTurns: 2 })
      expect(result.status).toBe('cap-hit')
      expect(result.checks).toHaveLength(checkCount(task(id)))
    }
  }, 30000)

  it('charges disjoint usage once, discounts only cache reads, and enforces the weighted cap', async () => {
    const reported = { inputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50, outputTokens: 20 }
    expect(tokenCounts(reported)).toEqual({ raw: 1170, weighted: 270, uncached: 150, cached: 1000 })
    expect(tokenCounts({ totalTokens: 200 })).toMatchObject({ raw: 200, weighted: 20 })
    const collector = new Collector({ maxTotalTokens: 500 })
    const capture = collector.options('lead').observation!.capture!
    const event = (phase: 'start' | 'end') => ({ name: 'sdk.model.call', phase,
      data: { reported, coverage: 'complete' } }) as unknown as Collector['events'][number]['event']
    await capture(event('start')); await capture(event('end'))
    expect(collector.controller.signal.aborted).toBe(false)
    expect(collector.metrics(0)).toMatchObject({ totalTokens: 1170, costWeightedTokens: 270,
      uncachedInputTokens: 150, cachedInputTokens: 1000, outputTokens: 20 })
    await capture(event('start')); await capture(event('end'))
    expect(collector.controller.signal.aborted).toBe(true)
    expect(collector.metrics(0).capHits.tokens).toBe(true)
    await capture(event('start'))
    expect(collector.metrics(0)).toMatchObject({ totalTokens: 2340, costWeightedTokens: 540, usageIncomplete: true,
      reportedTokens: 2340, reportedCostWeightedTokens: 540 })
  })

  it('preserves earned partial credit when an adapter errors after half the code changes', async () => {
    const original = FakeAdapter.prototype.stream
    let calls = 0
    const stream = vi.spyOn(FakeAdapter.prototype, 'stream').mockImplementation(
      async function* (this: FakeAdapter, options: GenerateOptions) {
        if (++calls === 6) throw new Error('offline injected adapter failure')
        yield* original.call(this, options)
      })
    try {
      const { result } = await execute({ arm: 'single', task: 'code-change', provider: 'fake',
        model: 'gpt-6-luna', rep: 1, timeoutMs: 15000 })
      expect(result.status).toBe('failed')
      expect(result.metrics.usageIncomplete).toBe(true)
      expect(result.metrics.totalTokens).toBeGreaterThan(0)
      expect(result.metrics.totalTokens).toBe(result.metrics.reportedTokens)
      expect(result.pass).toBe(false)
      expect(result.score).toBe(21 / 41) // Four repaired modules plus the preserved interface.
      expect(result.checks).toHaveLength(41)
    } finally { stream.mockRestore() }
  })

  it('reports partial usage lower bounds and aggregates per task kind in analysis', async () => {
    const metrics = { ...new Collector().metrics(10), totalTokens: null, costWeightedTokens: null,
      reportedTokens: 100, reportedCostWeightedTokens: 55 }
    const run = { task: 'extraction', kind: 'volume' as const, arm: 'single' as const,
      pass: false, score: 0.5, status: 'cap-hit', metrics }
    expect(summarize([run])).toMatchObject({ tokens: { mean: 100 }, costWeightedTokens: { mean: 55 },
      tokenLowerBoundRuns: 1, weightedLowerBoundRuns: 1 })
    const parent = await mkdtemp(join(tmpdir(), 'ma-round4-'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      for (const label of ['a', 'b']) {
        const root = join(parent, label); await mkdir(root)
        await writeFile(join(root, 'manifest.json'), JSON.stringify({ protocol: 'v4', label }))
        await writeFile(join(root, 'extraction.single.1.json'), JSON.stringify(run))
      }
      const result = await compare(join(parent, 'a'), join(parent, 'b'))
      expect(result.rows.find(row => row.task === 'kind:volume')?.a.n).toBe(1)
      expect(JSON.parse(await readFile(join(parent, 'b/comparison.json'), 'utf8')).rows).toHaveLength(3)
    } finally { log.mockRestore(); await rm(parent, { recursive: true, force: true }) }
  })
})
