/**
 * Differential policy fuzzing.
 *
 * Hand-written cases test what their author already suspected. The classes of
 * defect that actually reached this package — layer ordering, canonicalization,
 * a nested override, mount ordering, a dangling link — are ones nobody wrote a
 * case for. So: generate policies and targets, then require that the three
 * things which must agree do agree.
 *
 * The oracle is the contract algebra. The fence must match it, and the kernel
 * backend must match the fence: a boundary where the in-process check and the
 * profile disagree is a boundary with a hole, whichever of them is right.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accessInLayers, classifyOutcome, confiningPolicy, containsPath, grantLayers,
  normalizePath, pathDepth, resolveSandboxPolicy,
  type FileSystemAccess, type FileSystemEntry, type GrantLayer, type SandboxPolicy,
} from '@alvin0/ai-agent-sdk-sandbox'
import {
  checkSandboxDependencies, localSandbox, sandboxSpawnOptions,
} from '@alvin0/ai-agent-sdk-sandbox-node'

const argv = process.argv.slice(2)
const option = (name: string, fallback: number): number => {
  const hit = argv.find(entry => entry.startsWith(`--${name}=`))
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3))
}
const ALGEBRA_CASES = option('algebra', 5_000)
const BACKEND_CASES = option('backend', 250)
const SEED = option('seed', Date.now() % 2 ** 31)

/** Deterministic generator, so a failing case can be replayed from its seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 2 ** 32
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'fuzz-ws-'))
const outside = mkdtempSync(join(tmpdir(), 'fuzz-out-'))
writeFileSync(join(outside, 'target.txt'), 'OUTSIDE')

/** Names chosen for the shapes that have broken path handling before. */
const SEGMENTS = ['a', 'b', 'deep', 'with space', 'tài-liệu', 'UPPER', '.hidden', 'x.y']

const nodes: string[] = [workspace]
for (const first of SEGMENTS) {
  const level1 = join(workspace, first)
  mkdirSync(level1, { recursive: true })
  nodes.push(level1)
  for (const second of SEGMENTS.slice(0, 4)) {
    const level2 = join(level1, second)
    mkdirSync(level2, { recursive: true })
    writeFileSync(join(level2, 'file.txt'), 'x')
    nodes.push(level2, join(level2, 'file.txt'))
  }
}
// The shapes a path boundary has to survive, alongside the ordinary ones.
symlinkSync(outside, join(workspace, 'link-out'), 'dir')
symlinkSync(join(workspace, 'a'), join(workspace, 'link-in'), 'dir')
symlinkSync(join(outside, 'never-created.txt'), join(workspace, 'link-dangling'))
symlinkSync(join(workspace, 'link-in'), join(workspace, 'link-chain'), 'dir')
linkSync(join(outside, 'target.txt'), join(workspace, 'hardlink.txt'))
const SPECIAL = ['link-out/x.txt', 'link-in/x.txt', 'link-dangling', 'link-chain/x.txt',
  'hardlink.txt', 'missing/deep/x.txt', 'a/../b/x.txt']

// Only an existing file can answer a read, so the read phase draws from these
// rather than from the write phase's targets, most of which are yet to exist.
const files = nodes.filter(node => node.endsWith('file.txt'))
files.push(join(workspace, 'hardlink.txt'), join(workspace, 'link-in', 'a', 'file.txt'))

const ACCESS: readonly FileSystemAccess[] = ['write', 'read', 'deny']
// Probing matters here: without it the first rung in the chain is taken even
// where it cannot start, and every case would report a runner failure rather
// than a decision.
const provider = localSandbox({ tempRoots: [] })
const report = checkSandboxDependencies(workspace)

/** One generated policy: a random set of nested carve-outs under the workspace. */
function makePolicy(random: () => number): SandboxPolicy {
  const count = Math.floor(random() * 5)
  const entries: FileSystemEntry[] = []
  for (let index = 0; index < count; index++) {
    const path = nodes[Math.floor(random() * nodes.length)] ?? workspace
    const access = ACCESS[Math.floor(random() * ACCESS.length)] ?? 'read'
    entries.push({ path, access })
  }
  const resolved = resolveSandboxPolicy(
    { cwd: workspace },
    { mode: 'workspace-write', workspaceRoot: workspace, entries },
  )
  return confiningPolicy(resolved) as SandboxPolicy
}

/** One generated target: an ordinary path, or one of the awkward shapes. */
function makeTarget(random: () => number): string {
  if (random() < 0.35) {
    return join(workspace, SPECIAL[Math.floor(random() * SPECIAL.length)] ?? 'a/x.txt')
  }
  const base = nodes[Math.floor(random() * nodes.length)] ?? workspace
  return random() < 0.5 ? join(base, 'generated.txt') : base
}

interface Failure {
  readonly seed: number
  readonly index: number
  readonly kind: string
  readonly target: string
  readonly entries: readonly FileSystemEntry[]
  readonly detail: string
}
const failures: Failure[] = []

// ---- Phase 1: the layer algebra against an independent reference ---------
// No filesystem involved, so the oracle is exact: the access in force at a path
// is whatever the last layer containing it said, and a layer that changes
// nothing must not survive the collapse.
{
  const random = makeRandom(SEED)
  for (let index = 0; index < ALGEBRA_CASES; index++) {
    const entries = syntheticEntries(random)
    const policy = confiningPolicy(resolveSandboxPolicy(
      { cwd: '/repo' }, { mode: 'workspace-write', workspaceRoot: '/repo', entries },
    )) as SandboxPolicy
    const layers = grantLayers(policy, { protectSubpaths: false })
    const target = syntheticPath(random)

    const reference = referenceAccess(target, layers)
    const actual = accessInLayers(target, layers)
    if (reference !== actual) {
      failures.push({
        seed: SEED, index, kind: 'layer-algebra', target, entries,
        detail: `accessInLayers=${actual} reference=${reference}`,
      })
    }
    // Collapsing drops layers that change nothing; it must change no decision.
    // The reference orders layers the way the contract specifies — by path
    // specificity, not by the order they were written — because that ordering
    // IS the contract, and comparing against input order would only restate
    // the input.
    if (referenceAccess(target, orderedReference(entries)) !== actual) {
      failures.push({
        seed: SEED, index, kind: 'collapse-changed-a-decision', target, entries,
        detail: `collapsed=${actual} uncollapsed=${referenceAccess(target, orderedReference(entries))}`,
      })
    }
  }
}

// ---- Phase 2: the fence against the kernel backend -----------------------
// Same policy, same path, two enforcement layers. Only a policy denial counts:
// a write into a directory that does not exist fails for its own reasons, and
// calling that a disagreement would drown the real ones.
if (report.backend !== undefined) {
  const random = makeRandom(SEED ^ 0x5bf0_3635)
  for (let index = 0; index < BACKEND_CASES; index++) {
    const policy = makePolicy(random)
    const target = makeTarget(random)
    const fence = provider.fence(policy)
    const permitted = await fence.isWritable(target)
    const outcome = await backendWrites(policy, target)

    if (!permitted && outcome.kind === 'success') {
      failures.push({
        seed: SEED, index, kind: 'BACKEND-ALLOWS-WHAT-FENCE-DENIES', target,
        entries: policy.entries ?? [], detail: outcome.detail,
      })
    }
    if (permitted && outcome.kind === 'denied') {
      failures.push({
        seed: SEED, index, kind: 'BACKEND-DENIES-WHAT-FENCE-ALLOWS', target,
        entries: policy.entries ?? [], detail: outcome.detail,
      })
    }
    if (outcome.kind === 'runner-failure') {
      failures.push({
        seed: SEED, index, kind: 'runner-failure', target,
        entries: policy.entries ?? [], detail: outcome.detail,
      })
    }

    // Reads are the other half of the boundary, and the half a write-only fuzz
    // never sees. A deny layer has to hide the content from the kernel profile
    // too, and a grant reopened beneath one has to hand it back — the two
    // failures a mask that only ever narrows writes would both pass.
    const readTarget = files[Math.floor(random() * files.length)] ?? workspace
    const readable = await fence.isReadable(readTarget)
    const read = await backendReads(policy, readTarget)

    if (!readable && read.kind === 'success') {
      failures.push({
        seed: SEED, index, kind: 'BACKEND-READS-WHAT-FENCE-HIDES', target: readTarget,
        entries: policy.entries ?? [], detail: read.detail,
      })
    }
    if (readable && read.kind === 'denied') {
      failures.push({
        seed: SEED, index, kind: 'BACKEND-HIDES-WHAT-FENCE-READS', target: readTarget,
        entries: policy.entries ?? [], detail: read.detail,
      })
    }
  }
}

process.stdout.write(
  `seed ${SEED} | ${ALGEBRA_CASES} algebra cases | `
  + `${report.backend === undefined ? 0 : BACKEND_CASES} backend cases on ${report.backend ?? 'none'}\n`,
)
if (failures.length === 0) {
  process.stdout.write('no disagreement\n')
} else {
  process.stdout.write(`${failures.length} disagreement(s):\n`)
  for (const failure of failures.slice(0, 10)) {
    process.stdout.write(`- [${failure.kind}] ${failure.target}\n`)
    process.stdout.write(`    ${failure.detail}\n`)
    process.stdout.write(`    entries: ${JSON.stringify(failure.entries)}\n`)
    process.stdout.write(`    replay: --seed=${String(failure.seed)}\n`)
  }
  process.exitCode = 1
}
rmSync(workspace, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })

/**
 * Every layer the policy implies, ordered but NOT collapsed. Independent of
 * `grantLayers` only in that it keeps the redundant layers, which is the one
 * thing under test here.
 */
function orderedReference(entries: readonly FileSystemEntry[]): readonly GrantLayer[] {
  const layers: GrantLayer[] = [
    { path: '/repo', access: 'write', origin: 'mode' },
    ...entries.map(entry => ({ path: normalizePath(entry.path), access: entry.access, origin: 'entry' as const })),
  ]
  // A stable sort, so equal-depth entries keep the order they were written in.
  return layers
    .map((layer, position) => ({ layer, position }))
    .sort((left, right) =>
      pathDepth(left.layer.path) - pathDepth(right.layer.path)
      || originRank(left.layer.origin) - originRank(right.layer.origin)
      || left.layer.path.localeCompare(right.layer.path)
      || left.position - right.position)
    .map(entry => entry.layer)
}

function originRank(origin: GrantLayer['origin']): number {
  return origin === 'mode' ? 0 : origin === 'protected' ? 1 : 2
}

/** Layers over a small synthetic tree, so nesting and ties occur often. */
function syntheticEntries(random: () => number): readonly FileSystemEntry[] {
  const paths = ['/repo', '/repo/a', '/repo/a/b', '/repo/a/b/c', '/repo/a/b/c/d',
    '/repo/x', '/repo/x/y', '/repo/a/z', '/other']
  const count = Math.floor(random() * 6)
  const entries: FileSystemEntry[] = []
  for (let index = 0; index < count; index++) {
    entries.push({
      path: paths[Math.floor(random() * paths.length)] ?? '/repo',
      access: ACCESS[Math.floor(random() * ACCESS.length)] ?? 'read',
    })
  }
  return entries
}

/** A path somewhere in or around that synthetic tree. */
function syntheticPath(random: () => number): string {
  const paths = ['/repo/file', '/repo/a/file', '/repo/a/b/file', '/repo/a/b/c/file',
    '/repo/a/b/c/d/file', '/repo/x/y/file', '/repo/a/z/file', '/other/file', '/elsewhere']
  return paths[Math.floor(random() * paths.length)] ?? '/repo/file'
}

/**
 * The reference the algebra has to match: scan every layer in order and keep
 * the last one that contains the path. Deliberately naive — its only job is to
 * be obviously correct.
 */
function referenceAccess(target: string, layers: readonly GrantLayer[]): FileSystemAccess {
  let effective: FileSystemAccess = 'read'
  for (const layer of layers) if (containsPath(layer.path, target)) effective = layer.access
  return effective
}

/** Attempt the read under the kernel profile and classify what came back. */
async function backendReads(
  policy: SandboxPolicy, target: string,
): Promise<{ kind: string; detail: string }> {
  return runConfined(policy, `require('node:fs').readFileSync(${JSON.stringify(target)})`)
}

/** Attempt the write under the kernel profile and classify what came back. */
async function backendWrites(
  policy: SandboxPolicy, target: string,
): Promise<{ kind: string; detail: string }> {
  return runConfined(policy, `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'fuzz')`)
}

/** One confined attempt, read through the backend's own denial dialect. */
async function runConfined(
  policy: SandboxPolicy, code: string,
): Promise<{ kind: string; detail: string }> {
  const confined = await provider.confine([process.execPath, '-e', code], policy)
  const options = sandboxSpawnOptions(confined)
  const result = spawnSync(confined.argv[0] ?? '', confined.argv.slice(1), {
    cwd: workspace, encoding: 'utf8', timeout: 20_000,
    stdio: [...options.stdio], env: { ...options.env },
  })
  const kind = classifyOutcome(
    { exitCode: result.status ?? 1, stderr: result.stderr ?? '', signal: result.signal },
    confined,
  ).kind
  const line = (result.stderr ?? '').split('\n').map(entry => entry.trim()).find(entry => entry !== '')
  return { kind, detail: `${kind} | ${(line ?? '(no stderr)').slice(0, 110)}` }
}
