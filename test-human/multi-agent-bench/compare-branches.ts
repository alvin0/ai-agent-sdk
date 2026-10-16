/** Copy one frozen harness into explicitly listed worktrees; build, run, compare. */
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, treeHash } from './run.ts'

type Command = (command: string, args: string[], cwd: string) => Promise<number>
const command: Command = (command, args, cwd) => new Promise((accept, reject) => {
  const child = spawn(command, args, { cwd, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code, signal) => signal ? reject(new Error(`Command killed: ${signal}`)) : accept(code ?? 1))
})

function worktree(label: string | undefined, root: string | undefined) {
  if (!label || !/^[\w-]+$/.test(label) || !root || root.startsWith('--')) {
    throw new Error('Use --worktree <unique-label> <directory> (at least two)')
  }
  return { label, root: resolve(root) }
}

function inputs(args: string[]) {
  const worktrees: { label: string; root: string }[] = [], shared: string[] = []
  for (let i = 0; i < args.length;) {
    if (args[i] === '--worktree') {
      worktrees.push(worktree(args[i + 1], args[i + 2])); i += 3
    } else {
      if (!args[i + 1]) throw new Error('Missing option value')
      shared.push(args[i]!, args[i + 1]!); i += 2
    }
  }
  if (worktrees.length < 2 || new Set(worktrees.map(w => w.label)).size !== worktrees.length) {
    throw new Error('At least two worktrees with unique labels required; first is baseline')
  }
  if (shared.includes('--label')) throw new Error('Labels come from --worktree')
  return { worktrees, shared }
}

function options(args: string[]) {
  const { worktrees, shared } = inputs(args)
  const config = parseArgs(shared)
  if (config.provider === 'codex' && !('codexAuth' in config)) {
    throw new Error('Supply --codex-auth or AI_AGENT_SDK_CODEX_AUTH for live comparison')
  }
  // Resolve paths once, before changing the command cwd to each destination.
  const runArgs = shared.filter((_, i) => shared[i - i % 2] !== '--out' && shared[i - i % 2] !== '--codex-auth')
  if ('codexAuth' in config) runArgs.push('--codex-auth', config.codexAuth)
  return { worktrees, config, runArgs }
}

async function destinations(worktrees: { root: string }[], out: string, source: string) {
  const roots = await Promise.all(worktrees.map(w => realpath(w.root)))
  if (new Set(roots).size !== roots.length) throw new Error('Worktree directories must be distinct')
  // Validate all destinations before making any changes. Never overwrite result evidence.
  for (const root of roots) {
    await stat(join(root, '.git'))
    await stat(join(root, 'package.json'))
  }
  if ([source, ...roots].some(root => out === root || root.startsWith(out + '/'))) {
    throw new Error('Output must not contain the harness or any worktree')
  }
  if ([source, ...roots.map(root => join(root, 'test-human/multi-agent-bench'))]
    .some(bench => out === resolve(bench) || out.startsWith(resolve(bench) + '/'))) {
    throw new Error('Keep result directories outside the bench so harness hashes remain stable')
  }
  await mkdir(dirname(out), { recursive: true })
  await mkdir(out, { recursive: false })
  return roots
}

async function copyHarness(roots: string[], source: string, frozen: string) {
  for (const root of roots) {
    const destination = join(root, 'test-human/multi-agent-bench')
    if (await realpath(destination).catch(() => '') === await realpath(source)) continue
    await mkdir(dirname(destination), { recursive: true })
    const staging = await mkdtemp(join(dirname(destination), '.ma-bench-copy-'))
    try {
      await cp(join(frozen, 'bench'), staging, { recursive: true })
      await rm(destination, { recursive: true, force: true })
      await rename(staging, destination)
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
}

async function runWorktree(
  root: string, label: string, run: { out: string; args: string[]; hash: string }, invoke: Command,
) {
  const { out, args, hash } = run
  const bench = join(root, 'test-human/multi-agent-bench')
  if (await stat(join(root, 'node_modules')).catch(() => undefined) === undefined) {
    if (await invoke('pnpm', ['install', '--frozen-lockfile'], root)) throw new Error(`Install failed: ${label}`)
  }
  if (await invoke('pnpm', ['workspace:build'], root)) throw new Error(`Build failed: ${label}`)
  if (await treeHash(bench) !== hash) throw new Error(`Harness changed: ${label}`)
  const code = await invoke(process.execPath, [join(bench, 'run.ts'), ...args,
    '--label', label, '--out', out], root)
  if (await treeHash(bench) !== hash) throw new Error(`Harness changed during suite: ${label}`)
  return code
}

export async function compareBranches(args: string[], invoke: Command = command): Promise<number> {
  const { worktrees, config, runArgs } = options(args)
  const source = fileURLToPath(new URL('.', import.meta.url))
  const roots = await destinations(worktrees, config.out, source)
  const frozen = await mkdtemp(join(tmpdir(), 'ma-bench-harness-'))
  let failed = false
  try {
    await cp(source, join(frozen, 'bench'), { recursive: true })
    const expectedHash = await treeHash(join(frozen, 'bench'))
    await copyHarness(roots, source, frozen)
    for (const [index, worktree] of worktrees.entries()) {
      const code = await runWorktree(roots[index]!, worktree.label,
        { out: join(config.out, worktree.label), args: runArgs, hash: expectedHash }, invoke)
      failed ||= code !== 0
    }
    for (const [index, worktree] of worktrees.entries()) {
      const code = await invoke(process.execPath, [join(roots[index]!, 'test-human/multi-agent-bench/analyze.ts'),
        join(config.out, worktrees[0]!.label), join(config.out, worktree.label),
        '--out', join(config.out, `${worktree.label}.comparison.json`)], roots[index]!)
      failed ||= code !== 0
    }
    return failed ? 1 : 0
  } finally { await rm(frozen, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await compareBranches(process.argv.slice(2))
}
