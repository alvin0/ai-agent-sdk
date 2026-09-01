import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const artifacts = join(packageRoot, 'artifacts')
const packages = [
  'core', 'agent', 'provider-http', 'protocol-anthropic-messages', 'protocol-responses',
  'provider-anthropic', 'provider-openai', 'provider-codex', 'observability',
  'observability-fetch', 'observability-node', 'observability-otel', 'auth-node',
  'skill-filesystem', 'mcp', 'mcp-node', 'a2a', 'node',
]
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })
const tarballs = packages.map(name => pack(join(workspaceRoot, 'packages', name)))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-node-facade-pack-'))
try {
  cpSync(join(packageRoot, 'fixtures', 'packed'), temporaryRoot, { recursive: true })
  run('npm', [
    'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', ...tarballs,
  ], temporaryRoot)
  run(process.execPath, ['smoke.mjs'], temporaryRoot)
  process.stdout.write(
    `packed Node facade harness passed: ${relative(workspaceRoot, tarballs.at(-1) ?? '')}\n`,
  )
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

function pack(root: string): string {
  const output = run('npm', [
    'exec', '--yes', '--package=pnpm@11.25.0', '--',
    'pnpm', 'pack', '--pack-destination', artifacts,
  ], root)
  const tarball = output.split(/\r?\n/).map(line => line.trim()).findLast(line => line.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack did not report a tarball for ${root}`)
  return resolve(root, tarball)
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}
