import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

type ProviderPackageName = 'provider-anthropic' | 'provider-openai' | 'provider-codex'

const requestedPackage = process.argv[2]
if (requestedPackage !== 'provider-anthropic'
  && requestedPackage !== 'provider-openai'
  && requestedPackage !== 'provider-codex') {
  throw new Error('expected provider-anthropic, provider-openai, or provider-codex')
}
const packageName: ProviderPackageName = requestedPackage
const protocolName = packageName === 'provider-anthropic'
  ? 'protocol-anthropic-messages'
  : 'protocol-responses'

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageRoot = join(workspaceRoot, 'packages', packageName)
const fixtureRoot = join(workspaceRoot, 'scripts', 'fixtures', 'packed-provider')
const artifacts = join(packageRoot, 'artifacts')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const tarballs = [
  pack(join(workspaceRoot, 'packages', 'core'), artifacts),
  pack(join(workspaceRoot, 'packages', 'provider-http'), artifacts),
  pack(join(workspaceRoot, 'packages', protocolName), artifacts),
  pack(packageRoot, artifacts),
]
const temporaryRoot = mkdtempSync(join(tmpdir(), `ai-agent-sdk-${packageName}-pack-`))
try {
  const consumers = new Map<string, string>()
  for (const runtime of ['standards', 'browser', 'worker']) {
    const consumer = join(temporaryRoot, runtime)
    cpSync(join(fixtureRoot, runtime), consumer, { recursive: true })
    cpSync(join(fixtureRoot, 'shared', 'smoke.mjs'), join(consumer, 'fixture.mjs'))
    cpSync(join(packageRoot, 'fixtures', 'shared', 'provider.mjs'), join(consumer, 'provider.mjs'))
    run('npm', [
      'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', ...tarballs,
    ], consumer)
    consumers.set(runtime, consumer)
  }

  run(process.execPath, ['smoke.mjs'], required(consumers, 'standards'))
  await testBrowser(required(consumers, 'browser'))
  await testWorker(required(consumers, 'worker'))
  process.stdout.write(`packed ${packageName} runtime matrix passed: ${relative(workspaceRoot, tarballs.at(-1) ?? '')}\n`)
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
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
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
    const contentType = extname(target) === '.js' || extname(target) === '.mjs' ? 'text/javascript' : 'text/html'
    response.writeHead(200, { 'content-type': contentType }).end(readFileSync(target))
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('browser fixture server has no TCP address')
  const chrome = existsSync('/usr/bin/google-chrome') ? realpathSync('/usr/bin/google-chrome') : undefined
  const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.waitForFunction(() => '__providerFixture' in globalThis)
    assertFixture(await page.evaluate(() => (
      globalThis as typeof globalThis & { __providerFixture: unknown }
    ).__providerFixture), 'browser')
  } finally {
    await browser.close()
    await new Promise<void>(done => server.close(() => done()))
  }
}

async function testWorker(consumer: string): Promise<void> {
  const port = await availablePort()
  const child = spawn(join(workspaceRoot, 'node_modules', '.bin', 'wrangler'), [
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
  if (result.provider !== packageName.replace('provider-', '')
    || result.text !== 'packed provider completed' || result.totalTokens !== 12
    || result.attempts !== 1 || result.dispatchState !== 'sent'
    || result.credentialEvents !== 2 || result.safeEvents !== true
    || result.buffer !== 'undefined' || result.process !== 'undefined') {
    throw new Error(`${runtime} fixture returned invalid evidence: ${JSON.stringify(result)}`)
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

async function poll(url: string, child: ChildProcess): Promise<Response> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch { /* server is still starting */ }
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
