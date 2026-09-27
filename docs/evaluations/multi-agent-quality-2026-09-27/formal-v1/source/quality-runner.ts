import { fork, type ChildProcess } from 'node:child_process'
import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
const args = process.argv.slice(2)
const option = (key: string) => { const at = args.indexOf(`--${key}`); return at < 0 ? undefined : args[at + 1] }
const output = resolve(option('output') ?? '')
if (!option('output') || !option('baseline') || !option('candidate')) throw new Error('new --output, --baseline and --candidate required')
await mkdir(output)
const pilot = args.includes('--pilot')
const fixtures = JSON.parse(await readFile(resolve('test-human/multi-agent/fixtures-v1.json'), 'utf8')) as { id: string; family: string; language: string; expected: Record<string, unknown>; [key: string]: unknown }[]
const protocol = JSON.parse(await readFile(resolve('test-human/multi-agent/live-protocol-quality-v2.json'), 'utf8')) as { models: { provider: string; id: string; effort: string | null }[]; repeats: number; [key: string]: unknown }
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
async function treeHashes(root: string) {
  const entries: Record<string, string> = {}
  async function visit(path: string) { for (const item of await readdir(path, { withFileTypes: true })) { const file = resolve(path, item.name); if (item.isDirectory()) await visit(file); else if (item.isFile()) entries[relative(root, file)] = hash(await readFile(file)) } }
  for (const item of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
    if (item.isDirectory()) await visit(resolve(root, 'packages', item.name, 'dist'))
  }
  return entries
}
if (!option('reference')) throw new Error('--reference (immutable current SDK) required')
const arms = { BASE: resolve(option('baseline')!), REFERENCE: resolve(option('reference')!), CANDIDATE: resolve(option('candidate')!) }
const bundleHashes = Object.fromEntries(await Promise.all(Object.entries(arms).map(async ([name,root]) => [name,await treeHashes(root)])))
await writeFile(resolve(output, 'loaded-sdk-hashes.json'), JSON.stringify(bundleHashes, null, 2), { flag: 'wx' })
const sourceHashes = Object.fromEntries(await Promise.all(['fixtures-v1.json', 'live-protocol-quality-v2.json', 'live-worker.ts', 'quality-runner.ts'].map(async file => [file, hash(await readFile(resolve('test-human/multi-agent', file)))])))
await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ protocol, pilot, arms, sourceHashes, startedAt: new Date().toISOString(), plannedAttempts: pilot ? 12 : 216,
  liveSurface: 'public ManagedAgentTeam with host-controlled scheduling and real provider-backed producer/consumer sessions; not autonomous lead planning or production corpus',
  usage: 'canonical sdk.agent.run end observations across all sessions, model end observations retained; synthetic failure calls remain labeled and missing totals remain unknown',
  taskClarification: 'required original producer addresses appended equally; expected aggregate answers never supplied to SDK/model',
}, null, 2), { flag: 'wx' })
class Worker {
  readonly process: ChildProcess
  readonly ready: Promise<unknown>
  private sequence = 0
  private pending = new Map<number, (value: unknown) => void>()
  constructor(root: string) {
    this.process = fork(resolve('test-human/multi-agent/live-worker.ts'), ['--sdk-root', root], { execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    this.ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('worker readiness timeout')), 30000)
      this.process.on('message', (message: unknown) => {
        const value = message as { ready?: boolean; requestId?: number; result?: unknown }
        if (value.ready) { clearTimeout(timer); resolveReady(value) }
        else if (value.requestId !== undefined) { this.pending.get(value.requestId)?.(value.result ?? value); this.pending.delete(value.requestId) }
      })
      this.process.once('exit', () => { clearTimeout(timer); reject(new Error('worker exited')); for (const settle of this.pending.values()) settle({ status: 'worker-exited' }); this.pending.clear() })
    })
  }
  async run(job: unknown): Promise<unknown> {
    await this.ready
    const requestId = ++this.sequence
    return new Promise(resolveResult => {
      const timer = setTimeout(() => { this.pending.delete(requestId); this.process.kill(); resolveResult({ status: 'host-timeout' }) }, 195000)
      this.pending.set(requestId, value => { clearTimeout(timer); resolveResult(value) })
      this.process.send({ ...(job as object), requestId })
    })
  }
  async close() { if (this.process.connected) { await this.run({ type: 'close' }); this.process.kill() } }
}
function grade(raw: unknown, expected: Record<string, unknown>) {
  const result = raw as { text?: string; status?: string }
  let actual: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse((result.text ?? '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) actual = parsed as Record<string, unknown>
  } catch { /* invalid output retained */ }
  const ids = (value: unknown) => Array.isArray(value) && value.every(v => typeof v === 'string') ? [...value].sort().join('|') : null
  const identity = actual !== undefined && ids(actual.sourceIds) === ids(expected.sourceIds)
  const numbers = ['totalObserved', 'totalBaseline', 'changePercent'].every(key => expected[key] === null ? actual?.[key] === null : typeof actual?.[key] === 'number' && Math.abs((actual[key] as number) - (expected[key] as number)) < 1e-6)
  const correct = result.status === 'completed' && actual !== null && actual !== undefined && Object.keys(actual).sort().join('|') === Object.keys(expected).sort().join('|') && actual.status === expected.status && identity && numbers
  return { correct, exactSourceIdentity: identity, falseCompletion: actual?.status === 'completed' && !correct, ...(actual === undefined ? {} : { actual }) }
}
await Promise.all(protocol.models.map(async model => {
  const workers = { BASE: new Worker(arms.BASE), REFERENCE: new Worker(arms.REFERENCE), CANDIDATE: new Worker(arms.CANDIDATE) }
  try {
    await writeFile(resolve(output, `ready-${model.provider}.json`), JSON.stringify(await Promise.all(Object.values(workers).map(w => w.ready)), null, 2), { flag: 'wx' })
    const cohort = pilot ? fixtures.filter(test => test.family === 'late-dependency') : fixtures
    for (let repeat = 0; repeat < (pilot ? 1 : protocol.repeats); repeat++) {
      for (const [index, test] of cohort.entries()) {
        const permutations: (keyof typeof arms)[][] = [ ['BASE','REFERENCE','CANDIDATE'], ['REFERENCE','CANDIDATE','BASE'], ['CANDIDATE','BASE','REFERENCE'], ['BASE','CANDIDATE','REFERENCE'], ['CANDIDATE','REFERENCE','BASE'], ['REFERENCE','BASE','CANDIDATE'] ]
        const order = permutations[(index + repeat * 2) % permutations.length]!
        for (const arm of order) {
          const { expected, ...fixture } = test
          await appendFile(resolve(output, 'attempts.jsonl'), JSON.stringify({ id: test.id, family: test.family, repeat, arm, provider: model.provider, startedAt: new Date().toISOString() }) + '\n')
          const result = await workers[arm].run({ type: 'run', fixture, provider: model.provider, model: model.id, effort: model.effort, repeat, arm })
          const row = { id: test.id, family: test.family, language: test.language, repeat, arm, provider: model.provider, model: model.id, order, result, grade: grade(result, expected) }
          await appendFile(resolve(output, 'runs.jsonl'), JSON.stringify(row) + '\n')
          console.log(JSON.stringify({ id: test.id, repeat, arm, provider: model.provider, correct: row.grade.correct, status: (result as { status?: string }).status }))
        }
      }
    }
  } finally { await Promise.all(Object.values(workers).map(w => w.close())) }
}))
const finalHashes = Object.fromEntries(await Promise.all(Object.entries(arms).map(async ([name,root]) => [name,await treeHashes(root)])))
if (JSON.stringify(finalHashes) !== JSON.stringify(bundleHashes)) throw new Error('Loaded SDK files changed during cohort; retain invalid evidence')
await writeFile(resolve(output, 'complete.json'), JSON.stringify({ completedAt: new Date().toISOString(), loadedBundlesUnchanged: true }), { flag: 'wx' })
