import { fork, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { collabAvailable, repoRoot, type Arm, type Job, type Result } from './execute.ts'
import { fixtureRoot, selectTasks, defaultSeed, type Suite } from './tasks.ts'
import { defaultLimits, type Limits } from './metrics.ts'

function options(args: string[]) {
  const values = new Map<string, string>()
  const allowed = ['arms', 'tasks', 'reps', 'provider', 'model', 'out', 'concurrency', 'timeout-ms',
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

export function parseArgs(args: string[]) {
  const opts = options(args)
  if (!opts.get('out')) throw new Error('--out is required and must be a new directory')
  const selected = selection(opts)
  const perTaskLimits = Object.fromEntries(selectTasks(selected.suite, selected.seed)
    .filter(task => selected.ids.includes(task.id)).map(task => [task.id, taskLimits(task, opts)]))
  return { ...providerModel(opts), ...selected, perTaskLimits, out: resolve(opts.get('out')!),
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

async function runChild(job: Job): Promise<{ result: Result; audit: unknown }> {
  const parent = await mkdtemp(join(tmpdir(), 'ma-bench-job-'))
  try { return await childResult(job, parent) }
  finally { await rm(parent, { recursive: true, force: true }) }
}
function childResult(job: Job, parent: string): Promise<{ result: Result; audit: unknown }> {
  return new Promise((accept, reject) => {
    const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [], {
      env: { ...process.env, MA_BENCH_TEMP: parent },
      execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = '', settled = false
    child.stderr?.on('data', chunk => { stderr += String(chunk).slice(0, 16000 - stderr.length) })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, job.timeoutMs + 15000)
    child.once('message', (message: { result?: Result; audit?: unknown; fatal?: string }) => {
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

export async function main(args = process.argv.slice(2)) {
  const config = parseArgs(args)
  const collab = collabAvailable()
  const skippedArms = !collab && config.arms.includes('collab') ? ['collab'] : []
  const arms = config.arms.filter(arm => arm !== 'collab' || collab)
  const jobs: Job[] = config.ids.flatMap((task, taskIndex) =>
    Array.from({ length: config.reps }, (_, rep) => {
      const order = (taskIndex + rep) % 2 ? [...arms].reverse() : arms
      return order.map(arm => ({ arm, task, rep: rep + 1,
        provider: config.provider, model: config.model, timeoutMs: config.timeoutMs,
        suite: config.suite, seed: config.seed,
        ...config.perTaskLimits[task]!,
        ...('codexAuth' in config ? { codexAuth: config.codexAuth } : {}) }))
    }).flat())
  await mkdir(dirname(config.out), { recursive: true })
  await mkdir(config.out, { recursive: false })
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot }).trim()
  await writeFile(join(config.out, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...config, arms,
    skippedArms, collaborationDetected: collab, startedAt: new Date().toISOString(), node: process.version,
    commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']),
    fixtureHash: await treeHash(fixtureRoot), harnessHash: await treeHash(fileURLToPath(new URL('.', import.meta.url))),
    coreBundleHash: await treeHash(join(repoRoot, 'packages/core/dist')), synthetic: config.provider === 'fake',
    protocol: 'autonomous-v3', repetitionsBelowMergeGate: config.reps < 3 }, null, 2))
  let next = 0, failures = 0
  const consume = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!
      const id = `${job.task}.${job.arm}.${job.rep}`
      try {
        const { result, audit } = await runChild(job)
        await writeFile(join(config.out, `${id}.json`), JSON.stringify(result, null, 2))
        await writeFile(join(config.out, `${id}.audit.json`), JSON.stringify(audit, null, 2))
        console.log(`${id}: ${result.status} score=${result.score} tokens=${result.metrics.totalTokens}`)
        if (result.status !== 'completed') failures++
      } catch (error) {
        failures++
        await writeFile(join(config.out, `${id}.fatal.json`), JSON.stringify({ ...job, status: 'infrastructure-error',
          error: String(error), metrics: null, score: 0, pass: false }, null, 2))
        console.error(`${id}: ${String(error)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(config.concurrency, jobs.length) }, consume))
  return failures ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
