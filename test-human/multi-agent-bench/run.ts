import { fork, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { collabAvailable, repoRoot, type Arm, type Job, type Result } from './execute.ts'
import { fixtureRoot, selectTasks, defaultSeed, type Suite } from './tasks.ts'
import { attachPermits, isPermitMessage } from './inflight.ts'
import { runCell } from './cells.ts'
import { Semaphore, retryPolicy, maxRunAttempts } from './reliability.ts'
import { taskTiming } from './timing.ts'
import { defaultLimits, type Limits } from './metrics.ts'

function options(args: string[]) {
  const values = new Map<string, string>()
  const allowed = ['resume', 'max-inflight-model-calls', 'arms', 'tasks', 'reps', 'provider', 'model', 'out',
    'concurrency', 'timeout-ms',
    'worker-timeout-ms', 'volume-timeout-ms', 'volume-worker-timeout-ms', 'orphan-grace-ms',
    'max-total-tokens', 'max-turns', 'max-tool-calls', 'suite', 'seed', 'codex-auth', 'label']
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, ''), value = args[i + 1]
    if (!key || !allowed.includes(key) || !value || value.startsWith('--')) throw new Error('Invalid CLI arguments')
    if (values.has(key)) throw new Error(`Duplicate option: ${key}`)
    values.set(key, value)
  }
  return values
}
const positive = (value: string, name: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`)
  return number
}
function selection(opts: Map<string, string>) {
  const arms = [...new Set((opts.get('arms') ?? 'single,team').split(','))] as Arm[]
  if (arms.some(arm => !['single', 'team', 'collab'].includes(arm))) throw new Error('Unknown arm')
  const suite = opts.get('suite') ?? 'scaled'
  if (suite !== 'smoke' && suite !== 'scaled') throw new Error('Suite must be smoke or scaled')
  const seed = positive(opts.get('seed') ?? String(defaultSeed), 'seed')
  const tasks = selectTasks(suite, seed)
  const selected = opts.get('tasks') ?? 'all'
  const ids = selected === 'all' ? tasks.map(task => task.id) : [...new Set(selected.split(','))]
  if (ids.some(id => !tasks.some(task => task.id === id))) throw new Error('Unknown task')
  return { arms, ids, suite: suite as Suite, seed }
}
function approvedModel(model: string) {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-([\w.-]+))?$/.exec(model)
  if (!version) return false
  if (Number(version[1]) > 6) return true
  if (Number(version[1]) !== 6) return false
  return Number(version[2] ?? '0') > 0 || ['luna', 'sol', 'astra'].includes(version[3] ?? '')
}
function providerModel(opts: Map<string, string>) {
  const provider = opts.get('provider') ?? 'codex'
  if (provider !== 'codex' && provider !== 'fake') throw new Error('Provider must be codex or fake')
  const model = opts.get('model') ?? 'gpt-6-luna'
  if (provider === 'codex' && !approvedModel(model)) throw new Error('Model must be gpt-6-luna or newer; no fallback')
  return { provider: provider as Job['provider'], model }
}
function credentialPath(opts: Map<string, string>) {
  const path = opts.get('codex-auth') ?? process.env.AI_AGENT_SDK_CODEX_AUTH
  return path ? { codexAuth: resolve(path) } : {}
}
export function taskLimits(task: { limits?: Partial<Limits> }, opts: Map<string, string>): Limits {
  const limits = { ...defaultLimits, ...task.limits }
  for (const [flag, key] of [['max-total-tokens', 'maxTotalTokens'], ['max-turns', 'maxTurns'],
    ['max-tool-calls', 'maxToolCalls']] as const) {
    if (opts.has(flag)) limits[key] = positive(opts.get(flag)!, flag)
  }
  return limits
}

function validateDestination(opts: Map<string, string>) {
  if (opts.has('out') === opts.has('resume')) {
    throw new Error('Use --out (new directory) or --resume (existing directory)')
  }
  if (opts.has('resume') && [...opts.keys()].some(key => !['resume', 'codex-auth'].includes(key))) {
    throw new Error('--resume uses the saved manifest; only --codex-auth may be overridden')
  }
}
function destination(opts: Map<string, string>) {
  return { out: resolve((opts.get('out') ?? opts.get('resume'))!), resume: opts.has('resume') }
}

export function parseArgs(args: string[]) {
  const opts = options(args)
  validateDestination(opts)
  const selected = selection(opts)
  const perTaskLimits = Object.fromEntries(selectTasks(selected.suite, selected.seed)
    .filter(task => selected.ids.includes(task.id)).map(task => [task.id, taskLimits(task, opts)]))
  const perTaskTimeouts = Object.fromEntries(selectTasks(selected.suite, selected.seed)
    .filter(task => selected.ids.includes(task.id)).map(task => [task.id, taskTiming(task, opts)]))
  const perTaskOutputBudget = Object.fromEntries(selectTasks(selected.suite, selected.seed)
    .filter(task => selected.ids.includes(task.id) && task.outputBudget).map(task => [task.id, task.outputBudget]))
  return { ...providerModel(opts), ...selected, perTaskLimits, perTaskTimeouts, perTaskOutputBudget,
    ...destination(opts),
    maxInflightModelCalls: positive(opts.get('max-inflight-model-calls') ?? '4', 'max-inflight-model-calls'),
    reps: positive(opts.get('reps') ?? '3', 'reps'),
    concurrency: positive(opts.get('concurrency') ?? '1', 'concurrency'),
    timeoutMs: positive(opts.get('timeout-ms') ?? '180000', 'timeout-ms'),
    maxTotalTokens: positive(opts.get('max-total-tokens') ?? String(defaultLimits.maxTotalTokens), 'max-total-tokens'),
    maxTurns: positive(opts.get('max-turns') ?? String(defaultLimits.maxTurns), 'max-turns'),
    maxToolCalls: positive(opts.get('max-tool-calls') ?? String(defaultLimits.maxToolCalls), 'max-tool-calls'),
    label: opts.get('label') ?? 'unlabelled',
    ...credentialPath(opts) }
}

export async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(directory: string) {
    for (const entry of (await readdir(join(root, directory), { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else { hash.update(path); hash.update(await readFile(join(root, path))) }
    }
  }
  await visit('.')
  return hash.digest('hex')
}

async function runChild(job: Job, semaphore: Semaphore): Promise<{ result: Result; audit: unknown }> {
  const parent = await mkdtemp(join(tmpdir(), 'ma-bench-job-'))
  try { return await childResult(job, parent, semaphore) }
  finally { await rm(parent, { recursive: true, force: true }) }
}
function childResult(job: Job, parent: string, semaphore: Semaphore): Promise<{ result: Result; audit: unknown }> {
  return new Promise((accept, reject) => {
    const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [], {
      env: { ...process.env, MA_BENCH_TEMP: parent },
      execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    attachPermits(child, semaphore)
    let stderr = '', settled = false
    child.stderr?.on('data', chunk => { stderr += String(chunk).slice(0, 16000 - stderr.length) })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, job.timeoutMs + 15000)
    child.on('message', (message: { result?: Result; audit?: unknown; fatal?: string }) => {
      if (isPermitMessage(message)) return
      if (!message.result) { reject(new Error(message.fatal ?? 'Worker returned no result')); return }
      settled = true
      clearTimeout(timer)
      child.once('exit', () => accept({ result: message.result!, audit: message.audit }))
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (!settled) reject(new Error(`Benchmark child exited ${code}/${signal}: ${stderr}`))
    })
    child.send(job)
  })
}

async function configuration(args: string[]) {
  let config = parseArgs(args)
  const resume = config.resume
  const saved = resume ? JSON.parse(await readFile(join(config.out, 'manifest.json'), 'utf8')) : undefined
  if (saved) {
    if (saved.protocol !== 'autonomous-v6') throw new Error('Resume requires a Round 6 manifest')
    config = { ...saved, out: config.out, resume: true,
      ...('codexAuth' in config ? { codexAuth: config.codexAuth } : {}) }
    providerModel(new Map([['provider', config.provider], ['model', config.model]]))
  }
  return { config, resume, saved }
}
function validateResume(saved: Record<string, unknown> | undefined, hashes: Record<string, string>,
  commit: string, features: { arms: Arm[]; collab: boolean }) {
  if (!saved) return
  if (Object.entries(hashes).some(([key, value]) => saved[key] !== value)
    || saved.commit !== commit || JSON.stringify(saved.arms) !== JSON.stringify(features.arms)
    || saved.collaborationDetected !== features.collab) {
    throw new Error('Resume source/core/fixtures or collaboration support differs from the saved manifest')
  }
}

export async function main(args = process.argv.slice(2)) {
  const { config, resume, saved } = await configuration(args)
  const semaphore = new Semaphore(config.maxInflightModelCalls)
  const collab = collabAvailable()
  const skippedArms = !collab && config.arms.includes('collab') ? ['collab'] : []
  const arms = config.arms.filter(arm => arm !== 'collab' || collab)
  const jobs: Job[] = config.ids.flatMap((task, taskIndex) =>
    Array.from({ length: config.reps }, (_, rep) => {
      const order = (taskIndex + rep) % 2 ? [...arms].reverse() : arms
      return order.map(arm => ({ arm, task, rep: rep + 1,
        provider: config.provider, model: config.model, ...config.perTaskTimeouts[task]!,
        suite: config.suite, seed: config.seed,
        ...config.perTaskLimits[task]!,
        ...('codexAuth' in config ? { codexAuth: config.codexAuth } : {}) }))
    }).flat())
  await mkdir(dirname(config.out), { recursive: true })
  if (!resume) await mkdir(config.out, { recursive: false })
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot }).trim()
  const hashes = { fixtureHash: await treeHash(fixtureRoot),
    harnessHash: await treeHash(fileURLToPath(new URL('.', import.meta.url))),
    coreBundleHash: await treeHash(join(repoRoot, 'packages/core/dist')) }
  validateResume(saved, hashes, git(['rev-parse', 'HEAD']), { arms, collab })
  if (!resume) await writeFile(join(config.out, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...config, arms,
    skippedArms, collaborationDetected: collab, startedAt: new Date().toISOString(), node: process.version,
    commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']),
    ...hashes, synthetic: config.provider === 'fake', retryPolicy, maxRunAttempts,
    protocol: 'autonomous-v6', tokenAccounting: 'uncached+cacheWrite+output+0.1*cacheRead',
    repetitionsBelowMergeGate: config.reps < 3 }, null, 2))
  let next = 0, failures = 0
  const consume = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!
      const id = `${job.task}.${job.arm}.${job.rep}`
      const { result, skipped } = await runCell(job, config.out, job => runChild(job, semaphore), resume)
      console.log(`${id}: ${skipped ? 'resumed/skipped ' : ''}${result.status} score=${result.score} `
        + `raw=${result.metrics?.totalTokens} weighted=${result.metrics?.costWeightedTokens} `
        + `attempts=${result.attempts?.length ?? 1}`)
      if (!['completed', 'completed-orphans'].includes(result.status)) failures++
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.concurrency, jobs.length) }, consume))
  return failures ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
