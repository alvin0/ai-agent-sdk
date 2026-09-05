import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const artifacts = join(packageRoot, 'artifacts')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const coreTarball = pack(join(workspaceRoot, 'packages', 'core'), artifacts)
const a2aTarball = pack(packageRoot, artifacts)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-a2a-pack-'))
try {
  const nodeConsumer = installFixture('node')
  const workerConsumer = installFixture('worker')
  run(process.execPath, ['smoke.mjs'], nodeConsumer)
  await testNegativeWorker(workerConsumer)
  process.stdout.write(`packed A2A Node/negative-Worker matrix passed: ${relative(workspaceRoot, a2aTarball)}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

function installFixture(name: string): string {
  const consumer = join(temporaryRoot, name)
  cpSync(join(packageRoot, 'fixtures', name), consumer, { recursive: true })
  run('npm', [
    'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
    coreTarball, a2aTarball,
  ], consumer)
  return consumer
}

function pack(root: string, destination: string): string {
  const output = run('npm', [
    'exec', '--yes', '--package=pnpm@11.25.0', '--',
    'pnpm', 'pack', '--pack-destination', destination,
  ], root)
  const tarball = output.split(/\r?\n/).map(line => line.trim()).findLast(line => line.endsWith('.tgz'))
  if (!tarball) throw new Error(`pnpm pack did not report a tarball for ${root}`)
  return resolve(root, tarball)
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

async function testNegativeWorker(consumer: string): Promise<void> {
  const port = await availablePort()
  const child = spawn(join(workspaceRoot, 'node_modules', '.bin', 'wrangler'), [
    'dev', '--config', 'wrangler.jsonc', '--ip', '127.0.0.1', '--port', String(port),
  ], { cwd: consumer, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  child.stderr?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  try {
    const base = `http://127.0.0.1:${port}`
    await poll(base, child)
    const runtimeResponse = await fetch(`${base}/runtime`)
    const runtime = await runtimeResponse.json() as Record<string, unknown>
    if (!runtimeResponse.ok || runtime.buffer !== 'undefined' || runtime.process !== 'undefined'
      || runtime.packageLoaded !== true) {
      throw new Error(`invalid strict Worker runtime evidence: ${JSON.stringify(runtime)}`)
    }
    const textResponse = await fetch(`${base}/text`)
    const text = await textResponse.json() as Record<string, unknown>
    if (!textResponse.ok || !JSON.stringify(text).includes('hello')) {
      throw new Error(`A2A text promotion guard failed: ${JSON.stringify(text)}`)
    }
    const binaryResponse = await fetch(`${base}/binary`)
    const binary = await binaryResponse.json() as Record<string, unknown>
    if (binaryResponse.status !== 500 || binary.guard !== 'expected-node-elevation'
      || binary.errorType !== 'TypeError' || binary.promotionCandidate === true) {
      throw new Error(`A2A binary guard no longer proves Node elevation: ${JSON.stringify(binary)}`)
    }
  } catch (error) {
    throw new Error(`A2A negative Worker fixture failed\n${output}`, { cause: error })
  } finally {
    await stop(child)
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not allocate fixture port')
  await new Promise<void>(done => server.close(() => done()))
  return address.port
}

async function poll(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* still starting */ }
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error('wrangler did not become ready within 20 seconds')
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(done => child.once('exit', () => done())),
    new Promise<void>(done => setTimeout(done, 5_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}
