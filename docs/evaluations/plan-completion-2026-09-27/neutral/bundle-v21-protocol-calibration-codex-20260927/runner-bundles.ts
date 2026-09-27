/** Counterbalanced original-SDK versus final-bundle replay. */
import { fork, execFileSync, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { evaluationCasesV2 } from './cohort-v2.ts'
import { gradeAnswerV2, PATCH_ORACLE_IMAGE } from './grading-v2.ts'

const args = process.argv.slice(2)
const option = (name: string, fallback = '') => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1] ?? fallback }
const preparation = resolve(option('preparation', 'artifacts/plan-completion-hHIqY2'))
const provider = option('provider', 'codex') as 'codex' | 'zenmux'
const model = option('model', provider === 'codex' ? 'gpt-6-luna' : process.env.COMPLETIONS_MODEL ?? '')
const phase = option('phase', 'pilot')
const repeats = Number(option('repeats', phase === 'pilot' ? '1' : '5'))
const seed = Number(option('seed', '260926'))
const effort = option('effort', 'medium')
if (!['codex', 'zenmux'].includes(provider) || !['pilot', 'final', 'ablation'].includes(phase) || !model
  || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isSafeInteger(seed)) throw new Error('Invalid run configuration')
if (provider === 'zenmux' && !process.env.COMPLETIONS_API_KEY) throw new Error('Replication credentials missing')
const selected = option('case').split(',').filter(Boolean)
const ABLATION = ['CODE-05', 'DATA-04', 'DATA-05', 'DOC-05', 'HIST-04', 'OPS-04', 'BIZ-05', 'SUP-06', 'LANG-05', 'BASIC-06']
const cases = evaluationCasesV2(seed).filter(test => selected.length ? selected.includes(test.id)
  : phase === 'pilot' ? test.id.endsWith('-01') : phase === 'ablation' ? ABLATION.includes(test.id) : test.split === 'held-out')
const arms = phase === 'ablation' ? ['OFF'] as const : ['BASE', 'CANDIDATE'] as const
const runId = option('run-id', `bundle-v2-${provider}-${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
if (!/^[A-Za-z0-9_-]+$/.test(runId) || cases.length === 0) throw new Error('Invalid run ID/cohort')
const dir = resolve('artifacts/neutral-evaluation', runId)
await mkdir(dir) // Refuse overwrites and best-of reruns.
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const identity = JSON.parse(await readFile(resolve(preparation, 'preparation.json'), 'utf8')) as Record<string, unknown>
const expectedAttempts = cases.reduce((sum, test) => sum + (test.unsupported ? 1 : repeats) * arms.length, 0)
const tokenCeiling = Number(option('token-ceiling', phase === 'pilot' ? '1000000' : '8000000'))
if (!Number.isSafeInteger(tokenCeiling) || tokenCeiling <= 0) throw new Error('Invalid token ceiling')
const manifest = { schemaVersion: 2, cohort: 'neutral-v2.1-matched-en-vi', comparisonKind: phase === 'ablation' ? 'final-sdk-feature-off-ablation' : 'original-sdk-versus-final-bundle',
  runId, phase, provider, model, effort: provider === 'codex' ? effort : null, seed, repeats, arms, expectedAttempts,
  preparation: identity, startedAt: new Date().toISOString(), node: process.version,
  exposure: 'author-exposed frozen regression cohort; family-disjoint split; not blind',
  languageProtocol: 'matched en/vi variants within each family; source-language quotes and IDs unchanged; variants are not independent families',
  candidatePolicy: 'PTC enabled only on preregistered DATA-01..04/BIZ-01..02 target families; async sample; all other tasks use ordinary tools',
  allowedCapabilities: 'Identical host-enforced read-only authority in both arms. perform_operation remains exposed as an adversarial control; blocked attempts are reported separately from effects. Real mutations/restart are evaluated by the durable L1 harness.',
  order: 'pairs alternate arm order by repeat plus variant index; repeat rotates family schedule; one in-flight request per provider',
  limits: { maxTurns: 12, maxToolCalls: 24, timeoutMs: 120000, maxTotalTokens: 40000, maxToolResultTokens: 2048, maxToolResultBytes: 8192 },
  stopPolicy: { tokenCeiling, maxAttempts: expectedAttempts, retries: 0, killSwitch: resolve(dir, 'STOP'), unknownUsageReserve: 40000 },
  pricing: { currencyConclusion: 'not evaluated', reason: 'Codex subscription and ZenMux billing tariffs are not configured in the host. Token ceilings bound usage; tokens are not a USD price.', snapshotAt: new Date().toISOString() },
  gates: { primary: 'equal-domain macro paired task success', nonInferiorityMargin: .05, zeroNewDeterministicViolations: true,
    efficiency: 'only after quality pass, report all attempts and paired success separately; currency gate inconclusive without tariffs', bootstrap: '4000 stratified family draws; preserve all paired languages/repeats within family', sampleExpansion: 'none; inconclusive rather than rerun until success' },
  selected: cases.map(test => ({ id: test.id, variantId: test.variantId, familyId: test.familyId, domain: test.domain, split: test.split, language: test.language, comparison: test.comparison, unsupported: test.unsupported ?? null, ptcTarget: test.ptcTarget })) }
await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' })
await writeFile(resolve(dir, 'fixtures.json'), JSON.stringify(cases, null, 2), { flag: 'wx' })
for (const file of ['cases.ts', 'grading.ts', 'cohort-v2.ts', 'grading-v2.ts', 'runner-bundles.ts', 'bundle-worker.ts']) await copyFile(resolve('test-human/evaluation', file), resolve(dir, file))
execFileSync('docker', ['image', 'inspect', PATCH_ORACLE_IMAGE], { stdio: 'ignore' })

class Worker {
  readonly child: ChildProcess
  private sequence = 0
  private pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>()
  readonly ready: Promise<Record<string, unknown>>
  constructor(root: string) {
    this.child = fork(resolve('test-human/evaluation/bundle-worker.ts'), ['--sdk-root', root], { execArgv: ['--env-file=.env', '--experimental-strip-types'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.child.kill(); reject(new Error('Bundle startup timeout')) }, 20000)
      this.child.once('error', reject)
      const onReady = (message: unknown) => { if (message && typeof message === 'object' && Reflect.get(message, 'ready') === true) { clearTimeout(timer); this.child.off('message', onReady); resolve(message as Record<string, unknown>) } }
      this.child.on('message', onReady)
      this.child.once('exit', () => { clearTimeout(timer); reject(new Error('Bundle worker exited before ready')) })
    })
    this.child.on('message', (message: { requestId?: number; result?: Record<string, unknown>; closed?: boolean }) => {
      if (message.requestId === undefined) return
      const pending = this.pending.get(message.requestId)
      this.pending.delete(message.requestId)
      pending?.resolve(message.result ?? { closed: message.closed })
    })
    this.child.on('exit', () => { for (const pending of this.pending.values()) pending.reject(new Error('Bundle worker exited')); this.pending.clear() })
  }
  request(job: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); this.child.kill(); reject(new Error('Bundle request deadline')) }, job.type === 'close' ? 10000 : 600000)
      this.pending.set(requestId, { resolve(value) { clearTimeout(timer); resolve(value) }, reject(error) { clearTimeout(timer); reject(error) } })
      this.child.send({ ...job, requestId }, error => { if (error) { this.pending.get(requestId)?.reject(error); this.pending.delete(requestId) } })
    })
  }
  async close() {
    if (this.child.connected) await this.request({ type: 'close' })
    if (this.child.exitCode === null) await new Promise<void>(resolve => { this.child.once('exit', () => resolve()); setTimeout(() => { this.child.kill(); resolve() }, 10000).unref() })
  }
}

const baseline = phase === 'ablation' ? undefined : new Worker(resolve(preparation, 'baseline-sdk'))
const candidate = new Worker(resolve(preparation, 'candidate-sdk'))
const records: Record<string, unknown>[] = []
let consumedTokens = 0, stopping = false
process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })
const usageTokens = (record: Record<string, unknown>) => {
  const usages = [...(record.history as { usage?: { reported?: { totalTokens?: number }; authoritative?: boolean } }[] ?? []).map(row => row.usage), record.usage as { reported?: { totalTokens?: number }; authoritative?: boolean } | undefined]
  return usages.reduce((sum, usage) => sum + (usage?.reported?.totalTokens ?? 0), 0)
}
try {
  const identities = { baseline: baseline ? await baseline.ready : null, candidate: await candidate.ready }
  await writeFile(resolve(dir, 'loaded-bundles.json'), JSON.stringify(identities, null, 2), { flag: 'wx' })
  for (let repeat = 0; repeat < repeats; repeat++) {
    const schedule = [...cases.slice(repeat % cases.length), ...cases.slice(0, repeat % cases.length)]
    for (const [index, test] of schedule.entries()) {
      const order = (index + repeat) % 2 ? [...arms].reverse() : [...arms]
      // Stop before the pair; never selectively stop/retry an arm after its result.
      try { await access(resolve(dir, 'STOP')); stopping = true } catch { /* no stop file */ }
      if (stopping || consumedTokens + 40000 * order.length > tokenCeiling) throw new Error('Preregistered stop reached; partial evidence retained')
      if (test.unsupported && repeat > 0) continue
      for (const [position, arm] of order.entries()) {
        const startedAt = new Date().toISOString()
        let result: Record<string, unknown>
        if (test.unsupported) result = { status: 'unsupported', reason: test.unsupported }
        else {
          const worker = arm === 'BASE' ? baseline! : candidate
          // Oracles are kept in the coordinator; only task input goes to the worker.
          const input = { ...test, expected: {} }
          try { result = await worker.request({ type: 'run', test: input, arm, provider, model, effort, repeat }) }
          catch { result = { runtimeStatus: 'worker-error', errorType: 'WorkerTransportError' } }
          if (result.runtimeStatus === 'success') {
            const grade = await gradeAnswerV2(test, String(result.text), Number(result.effects ?? 0), { privateDataLeaked: result.privateDataLeaked !== false, compactionSucceeded: result.compactionSucceeded === true, revisionChangedDuringRun: result.revisionChangedDuringRun === true })
            result = { ...result, grade, status: grade.status }
          } else result = { ...result, status: String(result.runtimeStatus).includes('error') ? 'runtime-error' : 'runtime-failed' }
        }
        const record = { id: test.id, variantId: test.variantId, familyId: test.familyId, domain: test.domain, language: test.language, split: test.split, comparison: test.comparison, arm, repeat, pairId: `${test.variantId}:${repeat}`, position, provider, model, startedAt, finishedAt: new Date().toISOString(), ...result }
        records.push(record)
        if (!test.unsupported) consumedTokens += usageTokens(result) || 40000
        await appendFile(resolve(dir, 'runs.jsonl'), JSON.stringify(record) + '\n')
        console.log(JSON.stringify({ id: test.variantId, arm, repeat, status: result.status, ms: Math.round(Number(result.elapsedMs ?? 0)), consumedTokens }))
      }
    }
  }
} finally {
  await Promise.allSettled([baseline?.close(), candidate.close()])
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ records: records.length, expectedAttempts, consumedTokens, completed: records.length === expectedAttempts, finishedAt: new Date().toISOString() }, null, 2), { flag: 'wx' })
  const sums: Record<string, string> = {}
  for (const file of ['manifest.json', 'fixtures.json', 'runs.jsonl', 'summary.json', 'loaded-bundles.json', 'cases.ts', 'grading.ts', 'cohort-v2.ts', 'grading-v2.ts', 'runner-bundles.ts', 'bundle-worker.ts']) {
    try { sums[file] = hash(await readFile(resolve(dir, file))) } catch { /* incomplete run stays incomplete */ }
  }
  await writeFile(resolve(dir, 'SHA256SUMS.json'), JSON.stringify(sums, null, 2), { flag: 'wx' })
  console.log(`Retained: ${dir}`)
}
