import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const packageName = process.argv[2]
const PROTOCOL_IDS = new Map<string, string>([
  ['protocol-anthropic-messages', 'anthropic-messages'],
  ['protocol-responses', 'openai-responses'],
  ['protocol-gemini-interactions', 'gemini-interactions'],
  ['protocol-openai-chat-completions', 'openai-chat-completions'],
])
const expectedProtocol = packageName === undefined ? undefined : PROTOCOL_IDS.get(packageName)
if (packageName === undefined || expectedProtocol === undefined) {
  throw new Error(`expected one of ${[...PROTOCOL_IDS.keys()].join(', ')}`)
}
const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageRoot = join(workspaceRoot, 'packages', packageName)
const coreRoot = join(workspaceRoot, 'packages', 'core')
const artifacts = join(packageRoot, 'artifacts')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const coreTarball = pack(coreRoot, artifacts)
const protocolTarball = pack(packageRoot, artifacts)
const temporaryRoot = mkdtempSync(join(tmpdir(), `ai-agent-sdk-${packageName}-pack-`))
try {
  const consumers = new Map<string, string>()
  for (const name of ['standards', 'browser', 'worker']) {
    const consumer = join(temporaryRoot, name)
    cpSync(join(packageRoot, 'fixtures', name), consumer, { recursive: true })
    cpSync(join(packageRoot, 'fixtures', 'shared', 'smoke.mjs'), join(consumer, 'fixture.mjs'))
    run('npm', [
      'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
      coreTarball, protocolTarball,
    ], consumer)
    consumers.set(name, consumer)
  }

  run(process.execPath, ['smoke.mjs'], required(consumers, 'standards'))
  await testBrowser(required(consumers, 'browser'))
  await testWorker(required(consumers, 'worker'))
  process.stdout.write(`packed ${packageName} runtime matrix passed: ${relative(workspaceRoot, protocolTarball)}\n`)
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
    await page.waitForFunction(() => '__protocolFixture' in globalThis)
    assertFixture(await page.evaluate(() => (
      globalThis as typeof globalThis & { __protocolFixture: unknown }
    ).__protocolFixture), 'browser')
  } finally {
    await browser.close()
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()))
  }
}

async function testWorker(consumer: string): Promise<void> {
  const wrangler = join(workspaceRoot, 'node_modules', '.bin', 'wrangler')
  const child = spawn(wrangler, [
    'dev', '--local', '--config', 'wrangler.jsonc', '--ip', '127.0.0.1', '--port', '0', '--inspector-port', '0',
  ], { cwd: consumer, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let output = ''
  child.stdout?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  child.stderr?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  try {
    // Let the server retain its OS-assigned port. Read readiness from this child,
    // never probe an unreserved port that may belong to another process.
    const port = await readyPort(child)
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`Worker fixture returned HTTP ${response.status}`)
    assertFixture(await response.json(), 'worker')
  } catch (error) {
    throw new Error(`Worker packed fixture failed\n${output}`, { cause: error })
  } finally {
    await stop(child)
  }
}

function assertFixture(value: unknown, runtime: string): void {
  const result = value as Record<string, unknown>
  if (result.protocol !== expectedProtocol || result.model !== 'packed-model'
    || result.inputTokens !== 6 || result.outputTokens !== 2 || result.totalTokens !== 12
    || result.buffer !== 'undefined' || result.process !== 'undefined') {
    throw new Error(`${runtime} fixture returned invalid evidence: ${JSON.stringify(result)}`)
  }
}

async function readyPort(child: ChildProcess): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer)
      child.off('message', message)
      child.off('error', failed)
      child.off('exit', exited)
      if (error) reject(error)
      else resolvePromise(port!)
    }
    const failed = (error: Error) => finish(error)
    const exited = () => finish(new Error('wrangler exited before readiness'))
    const message = (raw: unknown) => {
      let value: { event?: unknown; ip?: unknown; port?: unknown }
      try { value = typeof raw === 'string' ? JSON.parse(raw) : raw as typeof value }
      catch { return }
      if (value?.event !== 'DEV_SERVER_READY') return
      if (value.ip !== '127.0.0.1' || typeof value.port !== 'number'
        || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
        finish(new Error('wrangler sent invalid readiness evidence'))
      } else finish(undefined, value.port)
    }
    const timer = setTimeout(() => finish(new Error('wrangler did not become ready within 20 seconds')), 20_000)
    child.on('message', message)
    child.once('error', failed)
    child.once('exit', exited)
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  await new Promise<void>((resolvePromise, reject) => {
    const finish = () => { clearTimeout(kill); clearTimeout(deadline); resolvePromise() }
    child.once('close', finish)
    const kill = setTimeout(() => child.kill('SIGKILL'), 5_000)
    const deadline = setTimeout(() => {
      child.off('close', finish)
      reject(new Error('wrangler did not close after SIGKILL'))
    }, 10_000)
    child.kill('SIGTERM')
  })
}
