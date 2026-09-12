import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { assertSingleInstalledPackage } from './contracts/installed-tree.mts'

type ProviderPackageName =
  | 'provider-anthropic'
  | 'provider-openai'
  | 'provider-codex'
  | 'provider-copilot'
  | 'provider-gemini'

/**
 * The protocol packages each provider tarball needs installed beside it.
 *
 * Copilot is the only entry with two: it serves one route with two wire protocols
 * and picks between them per model, so both tarballs travel with it.
 */
const PROTOCOL_PACKAGES: Readonly<Record<ProviderPackageName, readonly string[]>> = {
  'provider-anthropic': ['protocol-anthropic-messages'],
  'provider-openai': ['protocol-responses'],
  'provider-codex': ['protocol-responses'],
  'provider-copilot': ['protocol-responses', 'protocol-openai-chat-completions'],
  'provider-gemini': ['protocol-gemini-interactions'],
}

const requestedPackage = process.argv[2]
if (requestedPackage === undefined
  || !Object.hasOwn(PROTOCOL_PACKAGES, requestedPackage)) {
  throw new Error(`expected one of ${Object.keys(PROTOCOL_PACKAGES).join(', ')}`)
}
const packageName = requestedPackage as ProviderPackageName
const protocolNames = PROTOCOL_PACKAGES[packageName]

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageRoot = join(workspaceRoot, 'packages', packageName)
const fixtureRoot = join(workspaceRoot, 'scripts', 'fixtures', 'packed-provider')
const artifacts = join(packageRoot, 'artifacts')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const tarballs = [
  pack(join(workspaceRoot, 'packages', 'core'), artifacts),
  pack(join(workspaceRoot, 'packages', 'provider-http'), artifacts),
  ...protocolNames.map(name => pack(join(workspaceRoot, 'packages', name), artifacts)),
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
    assertSingleInstalledPackage(consumer, '@alvin0/ai-agent-sdk-core')
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
    // The count each provider fixture declares — two events per credential
    // operation, and Copilot performs a second one for the token exchange.
    || typeof result.expectedCredentialEvents !== 'number'
    || result.expectedCredentialEvents < 2
    || result.credentialEvents !== result.expectedCredentialEvents || result.safeEvents !== true
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
