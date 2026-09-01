import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const artifacts = join(packageRoot, 'artifacts')
const packageNames = [
  'core', 'agent', 'provider-http', 'protocol-anthropic-messages', 'protocol-responses',
  'provider-anthropic', 'provider-openai', 'provider-codex', 'observability',
  'observability-fetch', 'observability-browser', 'observability-node', 'observability-otel',
  'auth-node', 'skill-filesystem', 'mcp', 'mcp-node', 'a2a', 'node', 'sdk',
]

rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })
const tarballs = new Map(packageNames.map(name => [name, pack(join(workspaceRoot, 'packages', name))]))
const rootOnlyNames = [
  'core', 'agent', 'provider-http', 'protocol-anthropic-messages', 'protocol-responses', 'sdk',
]

runFixture('root-only', rootOnlyNames, false)
runFixture('compatibility', packageNames, true)
process.stdout.write(`packed compatibility fixtures passed: ${relative(
  workspaceRoot, tarballs.get('sdk') ?? '',
)}\n`)

function runFixture(name: string, names: readonly string[], checkTypes: boolean): void {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `ai-agent-sdk-${name}-pack-`))
  try {
    cpSync(join(packageRoot, 'fixtures', name), temporaryRoot, { recursive: true })
    run('npm', [
      'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
      ...names.map(packageName => requiredTarball(packageName)),
    ], temporaryRoot)
    run(process.execPath, ['smoke.mjs'], temporaryRoot)
    if (checkTypes) {
      run(process.execPath, [
        resolve(workspaceRoot, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json',
      ], temporaryRoot)
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function requiredTarball(name: string): string {
  const tarball = tarballs.get(name)
  if (tarball === undefined) throw new Error(`missing tarball for ${name}`)
  return tarball
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
