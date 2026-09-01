import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const coreRoot = join(workspaceRoot, 'packages', 'core')
const artifacts = join(packageRoot, 'artifacts')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const coreTarball = pack(coreRoot, artifacts)
const agentTarball = pack(packageRoot, artifacts)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-agent-pack-'))
try {
  const consumers = new Map<string, string>()
  for (const name of ['standards', 'browser', 'worker']) {
    const consumer = join(temporaryRoot, name)
    cpSync(join(packageRoot, 'fixtures', name), consumer, { recursive: true })
    cpSync(join(packageRoot, 'fixtures', 'shared', 'smoke.mjs'), join(consumer, 'fixture.mjs'))
    run('npm', [
      'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
      coreTarball, agentTarball,
    ], consumer)
    consumers.set(name, consumer)
  }

  run(process.execPath, ['smoke.mjs'], required(consumers, 'standards'))
  await testBrowser(required(consumers, 'browser'))
  await testWorker(required(consumers, 'worker'))
  process.stdout.write(`packed agent runtime matrix passed: ${relative(workspaceRoot, agentTarball)}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
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

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)
  if (!value) throw new Error(`missing ${key} fixture`)
  return value
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

async function testBrowser(consumer: string): Promise<void> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const requested = url.pathname === '/' ? '/index.html' : url.pathname
    const target = resolve(consumer, `.${requested}`)
    if (!target.startsWith(`${resolve(consumer)}${sep}`) || !existsSync(target)) {
      response.writeHead(404).end()
      return
    }
    const contentType = extname(target) === '.js' || extname(target) === '.mjs'
      ? 'text/javascript'
      : 'text/html'
    response.writeHead(200, { 'content-type': contentType }).end(readFileSync(target))
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('browser fixture server has no TCP address')
  const chrome = existsSync('/usr/bin/google-chrome') ? realpathSync('/usr/bin/google-chrome') : undefined
  const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.waitForFunction(() => '__agentFixture' in globalThis)
    const result = await page.evaluate(() => (
      globalThis as typeof globalThis & { __agentFixture: unknown }
    ).__agentFixture)
    assertFixture(result, 'browser')
  } finally {
    await browser.close()
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  }
}

async function testWorker(consumer: string): Promise<void> {
  const port = await availablePort()
  const wrangler = join(workspaceRoot, 'node_modules', '.bin', 'wrangler')
  const child = spawn(wrangler, [
    'dev', '--config', 'wrangler.jsonc', '--ip', '127.0.0.1', '--port', String(port),
  ], { cwd: consumer, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  child.stderr?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  try {
    const response = await poll(`http://127.0.0.1:${port}`, child)
    assertFixture(await response.json(), 'worker')
  } catch (error) {
    throw new Error(`Worker packed fixture failed\n${output}`, { cause: error })
  } finally {
    await stop(child)
  }
}

function assertFixture(value: unknown, runtime: string): void {
  const result = value as Record<string, unknown>
  if (result.text !== 'packed agent completed' || result.totalTokens !== 23
    || result.toolCalls !== 1 || result.teamMembers !== 1
    || result.compaction !== 'completed' || result.adapterCalls !== 3
    || result.buffer !== 'undefined' || result.process !== 'undefined') {
    throw new Error(`${runtime} fixture returned invalid evidence: ${JSON.stringify(result)}`)
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not allocate fixture port')
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  return address.port
}

async function poll(url: string, child: ChildProcess): Promise<Response> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch { /* server is still starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('wrangler did not become ready within 20 seconds')
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise())),
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}
