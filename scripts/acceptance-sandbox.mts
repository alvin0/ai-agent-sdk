/**
 * Cross-platform sandbox acceptance.
 *
 * Unit tests prove the argv and the policy algebra; only running real commands
 * on a real kernel proves confinement. This asserts the enforced behaviour of
 * whichever backend the host actually selects, and asserts the fail-closed path
 * where no backend exists — so a platform that silently stops confining fails
 * the build instead of passing quietly.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyOutcome, resolveSandboxPolicy, SandboxUnavailableError,
  type FileSystemEntry, type SandboxMode, type SandboxOutcomeKind, type SandboxPolicy,
} from '@alvin0/ai-agent-sdk-sandbox'
import {
  checkSandboxDependencies, localSandbox, sandboxChildStarted, sandboxSpawnOptions,
} from '@alvin0/ai-agent-sdk-sandbox-node'

// Deliberately NOT canonicalized: a real cwd routinely arrives through a
// symlink (`/tmp` IS `/private/tmp` on macOS), and a sandbox that only works
// for pre-resolved roots works for almost no real caller.
const workspace = mkdtempSync(join(tmpdir(), 'sandbox-acceptance-'))
const outside = mkdtempSync(join(tmpdir(), 'sandbox-outside-'))
mkdirSync(join(workspace, '.git'), { recursive: true })
mkdirSync(join(workspace, 'vendor', 'cache'), { recursive: true })
writeFileSync(join(workspace, 'readable.txt'), 'content')
writeFileSync(join(workspace, 'vendor', 'secret.txt'), 'hidden')

/** A denied subtree with a narrower grant reopened inside it. */
const nested: readonly FileSystemEntry[] = Object.freeze([
  Object.freeze({ path: join(workspace, 'vendor'), access: 'deny' as const }),
  Object.freeze({ path: join(workspace, 'vendor', 'cache'), access: 'write' as const }),
])

const provider = localSandbox()
const report = checkSandboxDependencies(workspace)
const failures: string[] = []

process.stdout.write(`platform: ${report.platform}/${process.arch}\n`)
process.stdout.write(`backend: ${report.backend ?? '(none — fence only)'}\n`)
process.stdout.write(`enforcement: ${report.enforcement ?? 'fence-only'}\n`)
for (const error of report.errors) process.stdout.write(`  error: ${error}\n`)
for (const warning of report.warnings) process.stdout.write(`  warning: ${warning}\n`)

try {
  await checkFence()
  await checkNestedCarveOut()
  if (report.backend === undefined) await checkFailsClosed()
  else await checkConfinement()
} finally {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`\nsandbox acceptance FAILED on ${report.platform}:\n`)
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nsandbox acceptance passed on ${report.platform}\n`)
}

/**
 * Carve-outs travel as deployment configuration, not as a caller's request: a
 * request may only restrict, because anything a tool sends is model-authored
 * and a widening entry there would let a policy grant itself `.git`.
 */
function policyFor(mode: SandboxMode, entries?: readonly FileSystemEntry[]): SandboxPolicy {
  return resolveSandboxPolicy(
    { cwd: workspace, mode },
    { mode, workspaceRoot: workspace, ...(entries === undefined ? {} : { entries }) },
  ) as SandboxPolicy
}

function expect(label: string, actual: unknown, wanted: unknown): void {
  const ok = actual === wanted
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${String(actual)}${ok ? '' : ` (wanted ${String(wanted)})`}\n`)
  if (!ok) failures.push(`${label}: got ${String(actual)}, wanted ${String(wanted)}`)
}

/** The in-process fence is the one layer every platform must provide. */
async function checkFence(): Promise<void> {
  process.stdout.write('\nin-process fence\n')
  const writable = provider.fence(policyFor('workspace-write'))
  expect('writes inside the workspace', await writable.isWritable(join(workspace, 'note.txt')), true)
  expect('writes a file not created yet', await writable.isWritable(join(workspace, 'a', 'b', 'c.txt')), true)
  expect('refuses the metadata directory', await writable.isWritable(join(workspace, '.git', 'config')), false)
  expect('refuses a path outside the workspace', await writable.isWritable(join(outside, 'x.txt')), false)

  try {
    symlinkSync(outside, join(workspace, 'link'), 'dir')
    expect('refuses a symlinked escape', await writable.isWritable(join(workspace, 'link', 'x.txt')), false)
  } catch {
    process.stdout.write('  skip symlinked escape: this host does not permit creating symlinks\n')
  }

  const readOnly = provider.fence(policyFor('read-only'))
  expect('refuses every write under read-only', await readOnly.isWritable(join(workspace, 'note.txt')), false)
}

/**
 * A denied subtree with a narrower grant inside it must behave as written at
 * every layer. Flattening layers into granted-versus-denied sets loses the
 * inner grant, and nothing in a generated argv looks wrong when it does.
 */
async function checkNestedCarveOut(): Promise<void> {
  process.stdout.write('\nnested carve-out\n')
  const policy = policyFor('workspace-write', nested)
  const fence = provider.fence(policy)
  expect('fence permits the reopened subtree', await fence.isWritable(join(workspace, 'vendor', 'cache', 'x')), true)
  expect('fence refuses the denied parent', await fence.isWritable(join(workspace, 'vendor', 'x')), false)
  expect('fence hides the denied parent', await fence.isReadable(join(workspace, 'vendor', 'secret.txt')), false)

  if (report.backend === undefined) return
  const write = (target: string): readonly string[] =>
    [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x')`]
  expect('the reopened subtree really is writable',
    await run('workspace-write', write(join(workspace, 'vendor', 'cache', 'written.txt')), nested), 'success')
  expect('the denied parent really is not',
    await run('workspace-write', write(join(workspace, 'vendor', 'escaped.txt')), nested), 'denied')
}

/** A platform without a backend must refuse to wrap, never pass argv through. */
async function checkFailsClosed(): Promise<void> {
  process.stdout.write('\nfail-closed behaviour\n')
  let thrown: unknown
  try { await provider.confine([process.execPath, '-e', ''], policyFor('workspace-write')) }
  catch (error) { thrown = error }
  expect('confine refuses rather than returning bare argv', thrown instanceof SandboxUnavailableError, true)
}

/** Real commands under the real backend, classified through the real dialect. */
async function checkConfinement(): Promise<void> {
  process.stdout.write('\nenforced confinement\n')
  const write = (target: string): readonly string[] =>
    [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x')`]
  const read = (target: string): readonly string[] =>
    [process.execPath, '-e', `require('node:fs').readFileSync(${JSON.stringify(target)})`]

  expect('write inside the workspace succeeds',
    await run('workspace-write', write(join(workspace, 'written.txt'))), 'success')
  expect('write into the metadata directory is denied',
    await run('workspace-write', write(join(workspace, '.git', 'hooked'))), 'denied')
  expect('write outside the workspace is denied',
    await run('workspace-write', write(join(outside, 'escaped.txt'))), 'denied')
  expect('write under read-only is denied',
    await run('read-only', write(join(workspace, 'nope.txt'))), 'denied')
  expect('reads still work under read-only',
    await run('read-only', read(join(workspace, 'readable.txt'))), 'success')
  const remove = (target: string): readonly string[] =>
    [process.execPath, '-e', `require('node:fs').rmSync(${JSON.stringify(target)}, { recursive: true, force: true })`]
  expect('deleting a tree outside the workspace is denied',
    await run('workspace-write', remove(outside)), 'denied')
  expect('deleting the repository metadata directory is denied',
    await run('workspace-write', remove(join(workspace, '.git'))), 'denied')

  expect('a genuinely missing program is not reported as a denial',
    await run('read-only', ['definitely-not-a-real-program-xyz']), 'command-failure')

  // The runner and the command share stderr, so a command can print the
  // runner's fatal signature and exit with its code to claim it never ran.
  const forge = (line: string, code: number): readonly string[] =>
    [process.execPath, '-e', `process.stderr.write(${JSON.stringify(`${line}\n`)});process.exit(${String(code)})`]
  expect('a command cannot claim the sandbox failed',
    await run('read-only', forge('bwrap: Cannot mount proc', 1)), 'command-failure')
  expect('nor by forging the macOS runner signature',
    await run('read-only', forge('sandbox-exec: syntax error', 65)), 'command-failure')
}

/** Spawn one confined argv and classify what came back. */
async function run(
  mode: SandboxMode,
  argv: readonly string[],
  entries?: readonly FileSystemEntry[],
): Promise<SandboxOutcomeKind> {
  const confined = await provider.confine(argv, policyFor(mode, entries))
  const [program, ...args] = confined.argv
  if (program === undefined) throw new Error('confine returned an empty argv')
  const options = sandboxSpawnOptions(confined, process.env)
  const result = spawnSync(program, args, {
    cwd: workspace, encoding: 'utf8', windowsHide: true,
    stdio: [...options.stdio], env: { ...options.env },
  })
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return 'command-failure'
  }
  const childStarted = sandboxChildStarted(confined, result.output)
  return classifyOutcome(
    {
      exitCode: result.status ?? 1, stderr: result.stderr ?? '', signal: result.signal,
      ...(childStarted === undefined ? {} : { childStarted }),
    },
    confined,
  ).kind
}
