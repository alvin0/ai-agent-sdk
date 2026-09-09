import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const artifacts = join(packageRoot, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const runArtifacts = mkdtempSync(join(artifacts, 'core-packed-'))

const packed = run('npm', ['pack', '--json', '--pack-destination', runArtifacts], packageRoot)
const parsed = JSON.parse(packed) as unknown
const record = Array.isArray(parsed)
  ? parsed[0] as { filename: string }
  : Object.values(parsed as Record<string, { filename: string }>)[0]
if (!record?.filename) throw new Error('npm pack did not report a tarball filename')
const tarball = join(runArtifacts, record.filename)

const temporaryRoot = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-core-pack-'))
try {
  const consumers = new Map<string, string>()
  for (const name of ['standards', 'node', 'browser', 'worker', 'types']) {
    const consumer = join(temporaryRoot, name)
    cpSync(join(packageRoot, 'fixtures', name), consumer, { recursive: true })
    cpSync(join(packageRoot, 'fixtures', 'shared'), join(consumer, 'shared'), { recursive: true })
    run('npm', ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', tarball], consumer)
    consumers.set(name, consumer)
  }

  run(process.execPath, ['smoke.mjs'], required(consumers, 'standards'))
  run(process.execPath, ['smoke.mjs'], required(consumers, 'node'))
  run(process.execPath, [join(workspaceRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    required(consumers, 'types'))
  await testBrowser(required(consumers, 'browser'))
  await testWorker(required(consumers, 'worker'))
  process.stdout.write(`packed core runtime matrix passed: ${relative(workspaceRoot, tarball)}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
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
    const contentType = extname(target) === '.js' ? 'text/javascript' : 'text/html'
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
    await page.waitForFunction(() => '__coreFixture' in globalThis)
    const result = await page.evaluate(() => (globalThis as typeof globalThis & { __coreFixture: unknown }).__coreFixture)
    assertFixture(result, 5, 'browser')
  } finally {
    await browser.close()
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  }
}

async function testWorker(consumer: string): Promise<void> {
  const port = await availablePort()
  const wrangler = join(workspaceRoot, 'node_modules', '.bin', 'wrangler')
  const child = spawn(wrangler, ['dev', '--config', 'wrangler.jsonc', '--ip', '127.0.0.1', '--port', String(port)], {
    cwd: consumer,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  child.stderr?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  try {
    const response = await poll(`http://127.0.0.1:${port}`, child)
    assertFixture(await response.json(), 7, 'worker')
  } catch (error) {
    throw new Error(`Worker packed fixture failed\n${output}`, { cause: error })
  } finally {
    await stop(child)
  }
}

function assertFixture(value: unknown, totalTokens: number, runtime: string): void {
  const result = value as { traceId?: unknown; status?: unknown; totalTokens?: unknown; buffer?: unknown; process?: unknown;
    overflow?: { settled?: unknown; authoritative?: unknown; errorCode?: unknown; attempts?: unknown };
    topology?: { providers?: unknown; catalogs?: unknown };
    logic?: { admission?: unknown; completion?: unknown; cancellation?: unknown; compaction?: unknown } }
  const expectedProviders = [
    { route: 'route-a', pluginId: 'account-a', family: 'openai' },
    { route: 'route-b', pluginId: 'account-b', family: 'openai' },
  ]
  const expectedCatalogs = [
    { route: 'route-a', pluginId: 'account-a', family: 'openai', model: 'model-a' },
    { route: 'route-b', pluginId: 'account-b', family: 'openai', model: 'model-b' },
  ]
  if (typeof result.traceId !== 'string' || !/^[0-9a-f]{32}$/.test(result.traceId)
    || result.status !== 'success' || result.totalTokens !== totalTokens
    || result.buffer !== 'undefined' || result.process !== 'undefined'
    || result.overflow?.settled !== true || result.overflow.authoritative !== false
    || result.overflow.errorCode !== 'USAGE_COUNTER_OVERFLOW' || result.overflow.attempts !== 1
    || result.logic?.admission !== true || result.logic.completion !== true || result.logic.cancellation !== true
    || result.logic.compaction !== true
    || JSON.stringify(result.topology?.providers) !== JSON.stringify(expectedProviders)
    || JSON.stringify(result.topology?.catalogs) !== JSON.stringify(expectedCatalogs)) {
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
