import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const capability = process.argv[2]
const dependencyNames: Readonly<Record<string, readonly string[]>> = {
  'auth-node': ['core', 'provider-http', 'protocol-responses', 'provider-codex', 'auth-node'],
  'skill-filesystem': ['core', 'skill-filesystem'],
  'instructions-node': ['core', 'instructions-node'],
  'mcp-node': ['core', 'mcp', 'mcp-node'],
  'mcp-node-server': ['core', 'mcp-server', 'mcp-node-server'],
}
const dependencies = capability === undefined ? undefined : dependencyNames[capability]
if (capability === undefined || dependencies === undefined) {
  throw new TypeError(`unknown Node capability '${capability ?? ''}'`)
}

const packageRoot = join(workspaceRoot, 'packages', capability)
const artifacts = join(packageRoot, 'artifacts')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })
const tarballs = dependencies.map(name => pack(join(workspaceRoot, 'packages', name), artifacts))
const tarballByName = new Map(dependencies.map((name, index) => [name, tarballs[index]!]))
if (capability === 'auth-node') testAuthEnvOnly(tarballByName)
const temporaryRoot = mkdtempSync(join(tmpdir(), `ai-agent-sdk-${capability}-pack-`))
try {
  cpSync(join(packageRoot, 'fixtures', 'packed'), temporaryRoot, { recursive: true })
  run('npm', [
    'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', ...tarballs,
  ], temporaryRoot)
  run(process.execPath, ['smoke.mjs'], temporaryRoot)
  process.stdout.write(
    `packed ${capability} Node fixture passed: ${relative(workspaceRoot, tarballs.at(-1) ?? '')}\n`,
  )
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

function testAuthEnvOnly(packages: ReadonlyMap<string, string>): void {
  const temporary = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-auth-node-env-pack-'))
  try {
    cpSync(join(packageRoot, 'fixtures', 'env-only'), temporary, { recursive: true })
    run('npm', [
      'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
      required(packages, 'core'), required(packages, 'auth-node'),
    ], temporary)
    run(process.execPath, ['smoke.mjs'], temporary)
    const providerPath = join(temporary, 'node_modules', '@alvin0', 'ai-agent-sdk-provider-codex')
    if (existsSync(providerPath)) throw new Error('env-only auth closure installed provider-codex')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function required(packages: ReadonlyMap<string, string>, name: string): string {
  const value = packages.get(name)
  if (value === undefined) throw new Error(`missing packed dependency '${name}'`)
  return value
}

function pack(root: string, destination: string): string {
  const output = run('npm', [
    'exec', '--yes', '--package=pnpm@11.25.0', '--',
    'pnpm', 'pack', '--pack-destination', destination,
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
