import { describe, expect, it } from 'vitest'
import { evaluationCases } from '../../test-human/evaluation/cases.ts'
import { arithmetic, gradeAnswer } from '../../test-human/evaluation/grading.ts'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { validateAttempts } from '../../test-human/evaluation/integrity.ts'

const cases = evaluationCases()
const task = (id: string) => cases.find(c => c.id === id)!
describe('neutral evaluation harness gates', () => {
  it('requires every frozen family/repeat/arm exactly once, not only a matching count', () => {
    const config = { repeats: 1, selected: [{ id: 'CODE-01', split: 'held-out', unsupported: null }] }
    const base = { id: 'CODE-01', split: 'held-out', repeat: 0, arm: 'BASE', status: 'passed' }
    const ptc = { ...base, arm: 'PTC' }
    expect(() => validateAttempts(config, [base, ptc], true)).not.toThrow()
    expect(() => validateAttempts(config, [base, base], true)).toThrow(/Duplicate/)
    expect(() => validateAttempts(config, [base, { ...ptc, id: 'OTHER-01' }], true)).toThrow(/Unexpected/)
    expect(() => validateAttempts(config, [base, { ...ptc, repeat: 1 }], true)).toThrow(/Unexpected/)
    expect(() => validateAttempts(config, [base, { ...ptc, status: 'unsupported' }], true)).toThrow(/Unexpected/)
    expect(() => validateAttempts(config, [base], true)).toThrow(/Incomplete/)
  })
  it('has 60 distinct families, ten domains, and family-disjoint 20/10/30 splits', () => {
    expect(new Set(cases.map(c => c.id)).size).toBe(60)
    expect(new Set(cases.map(c => c.domain)).size).toBe(10)
    for (const [split, count] of [['development', 20], ['calibration', 10], ['held-out', 30]]) {
      expect(cases.filter(c => c.split === split)).toHaveLength(count as number)
    }
    for (const domain of new Set(cases.map(c => c.domain))) {
      expect(cases.filter(c => c.domain === domain && c.split === 'held-out' && c.comparison === 'common').length).toBeGreaterThanOrEqual(2)
    }
  })
  it('accepts equivalent arithmetic without evaluating executable code', () => {
    expect(gradeAnswer(task('CODE-04'), JSON.stringify({ expression: 'p*q-p*q*d' })).status).toBe('passed')
    expect(gradeAnswer(task('CODE-04'), JSON.stringify({ expression: 'q+p*(1-d)' })).status).toBe('failed')
    for (const expression of ['process.exit()', 'q_ + p', '1..2', '1/0', 'q;globalThis.x=1']) {
      expect(() => arithmetic(expression, { q: 2, p: 10, d: 0 })).toThrow()
    }
    expect(arithmetic('.5 * p', { p: 10 })).toBe(5)
  })
  it('accepts different feasible schedules and rejects violated dependencies', () => {
    expect(gradeAnswer(task('PLAN-01'), '{"starts":{"A":1,"B":3}}').status).toBe('passed')
    expect(gradeAnswer(task('PLAN-01'), '{"starts":{"A":0,"B":0}}').status).toBe('failed')
  })
  it('checks factual fields, side effects, missing evidence, and private leakage independently', () => {
    expect(gradeAnswer(task('BASIC-02'), '{"name":"Aster","enabled":true,"tags":["blue","red"]}').status).toBe('passed')
    expect(gradeAnswer(task('BASIC-02'), '{"name":"Aster","enabled":false,"tags":["blue","red"]}').status).toBe('failed')
    expect(gradeAnswer(task('BASIC-02'), '{"name":"Aster"}').status).toBe('failed')
    expect(gradeAnswer(task('BIZ-03'), '{"status":"completed","operationId":"op-1"}', 1).status).toBe('failed')
    expect(gradeAnswer(task('LANG-06'), '{"answer":"PRIVATE_EVAL_SENTINEL"}').status).toBe('failed')
  })
  it('never grants automatic semantic passes to free-form prose', () => {
    expect(gradeAnswer(task('LANG-06'), '{"sentence":"Đã hoàn tất."}').status).toBe('needs-review')
    expect(gradeAnswer(task('LANG-06'), '{}').status).toBe('failed')
  })
})

describe('retained evaluation analysis', () => {
  const withFixture = (run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'neutral-analysis-'))
    const rows = [{ id: 'CODE-04', split: 'held-out', repeat: 0, status: 'passed', elapsedMs: 20 },
      { id: 'CODE-05', split: 'held-out', repeat: 0, status: 'passed', elapsedMs: 10 },
      { id: 'DATA-04', split: 'held-out', repeat: 0, status: 'failed', elapsedMs: 30 }]
    const files = { 'manifest.json': JSON.stringify({ phase: 'baseline', repeats: 1, selected: rows.map(r => ({ id: r.id, split: r.split, unsupported: null })) }),
      'runs.jsonl': rows.map(r => JSON.stringify(r)).join('\n') + '\n' }
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    writeFileSync(join(dir, 'SHA256SUMS.json'), JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]))))
    try { run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  const analyze = (dir: string, after?: string) => spawnSync(process.execPath, ['--experimental-strip-types', resolve('test-human/evaluation/analyze.ts'), dir, ...(after ? [after] : [])], { encoding: 'utf8' })
  it('weights domains equally and reports absent usage explicitly', () => withFixture(dir => {
    expect(analyze(dir).status).toBe(0)
    const result = JSON.parse(readFileSync(join(dir, 'analysis.json'), 'utf8'))
    expect(result.overall.autoPassRate).toBe(2 / 3)
    expect(result.macro.equalDomainAutoPassRate).toBe(.5)
    expect(result.overall.runsWithoutUsage).toBe(3)
  }))
  it('rejects altered attempt records instead of silently changing the baseline', () => withFixture(dir => {
    writeFileSync(join(dir, 'runs.jsonl'), '')
    const result = analyze(dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Integrity mismatch')
    expect(existsSync(join(dir, 'analysis.json'))).toBe(false)
  }))
  it('rejects a checksum list that omits the attempt records', () => withFixture(dir => {
    const integrity = JSON.parse(readFileSync(join(dir, 'SHA256SUMS.json'), 'utf8'))
    delete integrity['runs.jsonl']
    writeFileSync(join(dir, 'SHA256SUMS.json'), JSON.stringify(integrity))
    const result = analyze(dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Missing integrity entry: runs.jsonl')
  }))
  it('does not call paired usage authoritative when a history turn lacks usage', () => withFixture(dir => {
    const row = { id: 'CODE-04', split: 'held-out', repeat: 0, status: 'passed', elapsedMs: 20,
      usage: { authoritative: true, reported: { totalTokens: 10 } }, history: [{ usage: { authoritative: false } }] }
    const files = {
      'manifest.json': JSON.stringify({ repeats: 1, selected: [{ id: row.id, split: row.split, unsupported: null }] }),
      'runs.jsonl': ['BASE', 'PTC'].map(arm => JSON.stringify({ ...row, arm })).join('\n') + '\n',
      'fixtures.json': JSON.stringify([{ id: row.id, prompt: 'Fixture', resources: {} }]),
    }
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    writeFileSync(join(dir, 'SHA256SUMS.json'), JSON.stringify(Object.fromEntries(Object.entries(files)
      .map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]))))
    const report = spawnSync(process.execPath, ['--experimental-strip-types', resolve('test-human/evaluation/analyze-paired.ts'), dir], { encoding: 'utf8' })
    expect(report.status, report.stderr).toBe(0)
    expect(JSON.parse(report.stdout).arms.PTC.usageAuthoritative).toBe(false)
    expect(JSON.parse(report.stdout).arms.BASE.usageAuthoritative).toBe(false)
  }))
  it('refuses to overwrite an existing analysis', () => withFixture(dir => {
    expect(analyze(dir).status).toBe(0)
    expect(analyze(dir).status).not.toBe(0)
  }))
  it('pairs repeats and resamples families within equally weighted domains', () => withFixture(before => withFixture(after => {
    const runs = readFileSync(join(after, 'runs.jsonl'), 'utf8').replace('"status":"failed"', '"status":"passed"')
    writeFileSync(join(after, 'runs.jsonl'), runs)
    const integrity = JSON.parse(readFileSync(join(after, 'SHA256SUMS.json'), 'utf8'))
    integrity['runs.jsonl'] = createHash('sha256').update(runs).digest('hex')
    writeFileSync(join(after, 'SHA256SUMS.json'), JSON.stringify(integrity))
    const result = analyze(before, after)
    expect(result.status).toBe(0)
    const report = JSON.parse(readFileSync(JSON.parse(result.stdout).output, 'utf8'))
    expect(report.comparison.pairs).toHaveLength(3)
    expect(report.comparison.qualityDelta).toBe(.5)
    expect(report.comparison.familyBootstrap95).toEqual([.5, .5])
  })))
  it('rejects comparing different models even when all attempt records are intact', () => withFixture(before => withFixture(after => {
    const manifest = JSON.parse(readFileSync(join(after, 'manifest.json'), 'utf8'))
    manifest.model = 'different-model'
    const content = JSON.stringify(manifest)
    writeFileSync(join(after, 'manifest.json'), content)
    const integrity = JSON.parse(readFileSync(join(after, 'SHA256SUMS.json'), 'utf8'))
    integrity['manifest.json'] = createHash('sha256').update(content).digest('hex')
    writeFileSync(join(after, 'SHA256SUMS.json'), JSON.stringify(integrity))
    const result = analyze(before, after)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unpaired configuration: model')
  })))
})
