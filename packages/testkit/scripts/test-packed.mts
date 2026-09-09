import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(packageRoot, '../..')
const artifacts = join(packageRoot, 'artifacts')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const coreTarball = pack(join(workspaceRoot, 'packages/core'))
const testkitTarball = pack(packageRoot)
const temporary = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-testkit-pack-'))
try {
  const provider = join(temporary, 'provider')
  cpSync(join(packageRoot, 'fixtures/provider'), provider, { recursive: true })
  cpSync(join(packageRoot, 'fixtures/consumer.mjs'), join(temporary, 'consumer.mjs'))
  writeFileSync(join(temporary, 'package.json'), `${JSON.stringify({
    name: 'provider-conformance-consumer', private: true, type: 'module',
  }, null, 2)}\n`)
  run('npm', ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
    coreTarball, testkitTarball, provider], temporary)
  const providerManifest = JSON.parse(readFileSync(
    join(temporary, 'node_modules/@fixture/independent-provider/package.json'), 'utf8',
  )) as { peerDependencies?: Record<string, string>; scripts?: Record<string, string> }
  if (providerManifest.peerDependencies?.['@alvin0/ai-agent-sdk-core'] !== '>=0.1.0 <0.2.0') {
    throw new Error('installed provider core peer range drifted')
  }
  if (Object.keys(providerManifest.scripts ?? {}).some(name => /^(?:pre|post)?install$/u.test(name))) {
    throw new Error('installed provider declares an install script')
  }
  const output = run(process.execPath, ['consumer.mjs'], temporary)
  const report = JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? '{}') as {
    status?: string; passed?: number; failed?: number
  }
  if (report.status !== 'passed' || report.passed !== 19 || report.failed !== 0) {
    throw new Error('packed provider conformance did not pass 19 checks')
  }
  const reportPath = join(artifacts, 'provider-conformance-report.json')
  writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    registryPublish: false,
    installScripts: false,
    providerCorePeer: providerManifest.peerDependencies['@alvin0/ai-agent-sdk-core'],
    report,
  }, null, 2)}\n`)
  process.stdout.write(`packed third-party provider conformance passed: ${relative(workspaceRoot, reportPath)}\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

function pack(root: string): string {
  const output = run('npm', ['exec', '--yes', '--package=pnpm@11.25.0', '--',
    'pnpm', 'pack', '--pack-destination', artifacts], root)
  const tarball = output.split(/\r?\n/u).map(line => line.trim()).findLast(line => line.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack produced no tarball for ${root}`)
  return resolve(root, tarball)
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}
