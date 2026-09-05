import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { assertSingleInstalledPackage } from './contracts/installed-tree.mts'

const CAPABILITIES = Object.freeze([
  'provider', 'codex', 'oauth', 'mcp', 'observability',
] as const)
type Capability = typeof CAPABILITIES[number]
type ProbeCount = { starts: number; targets: number }

const workspaceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixtureRoot = join(workspaceRoot, 'scripts', 'fixtures', 'portable-no-follow')
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-portable-no-follow-'))
const artifacts = join(temporaryRoot, 'artifacts')
const consumer = join(temporaryRoot, 'consumer')
const probeState = new Map<string, Record<Capability, ProbeCount>>()

let server: Server | undefined
try {
  const tarballs = [
    'core',
    'provider-http',
    'protocol-responses',
    'provider-codex',
    'mcp',
    'observability-fetch',
  ].map(name => pack(join(workspaceRoot, 'packages', name), artifacts))
  cpSync(fixtureRoot, consumer, { recursive: true })
  run('npm', [
    'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
    ...tarballs,
  ], consumer)
  for (const packageName of [
    '@ai-agent-sdk/core',
    '@ai-agent-sdk/provider-http',
    '@ai-agent-sdk/protocol-responses',
    '@ai-agent-sdk/provider-codex',
    '@ai-agent-sdk/mcp',
    '@ai-agent-sdk/observability-fetch',
  ]) assertSingleInstalledPackage(consumer, packageName)

  server = createFixtureServer(consumer)
  const port = await listen(server)
  const origin = `http://127.0.0.1:${port}`

  const nodeOutput = await runChild(process.execPath, [
    'run.mjs', `${origin}/probe/node`,
  ], consumer)
  assertOutput(nodeOutput, 'node-no-follow:pass')

  const denoBinary = resolveDenoBinary()
  const denoOutput = await runChild(denoBinary, [
    'run',
    `--allow-read=${consumer}`,
    `--allow-net=127.0.0.1:${port}`,
    '--allow-env',
    '--node-modules-dir=manual',
    'run.mjs',
    `${origin}/probe/deno`,
  ], consumer)
  assertOutput(denoOutput, 'deno-no-follow:pass')

  await testBrowser(origin)
  await testWorker(origin)

  const denoVersion = run(denoBinary, ['--version'], consumer).split(/\r?\n/u)[0]
  process.stdout.write(
    `portable native no-follow matrix passed: Node, ${denoVersion}, Chromium, workerd; ${relative(workspaceRoot, consumer)}\n`,
  )
} finally {
  if (server !== undefined) await closeServer(server)
  rmSync(temporaryRoot, { recursive: true, force: true })
}

function pack(root: string, destination: string): string {
  const output = run('npm', [
    'exec', '--yes', '--package=pnpm@11.25.0', '--',
    'pnpm', 'pack', '--pack-destination', destination,
  ], root)
  const tarball = output.split(/\r?\n/u).map(line => line.trim())
    .findLast(line => line.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack did not report a tarball for ${root}`)
  return resolve(root, tarball)
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

async function runChild(command: string, args: readonly string[], cwd: string): Promise<string> {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })
  const exitCode = await new Promise<number | null>((done, reject) => {
    child.once('error', reject)
    child.once('exit', done)
  })
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${exitCode}\n${output}`)
  }
  return output
}

function assertOutput(output: string, marker: string): void {
  if (!output.includes(marker)) throw new Error(`missing '${marker}' in child output\n${output}`)
}

function resolveDenoBinary(): string {
  const configured = process.env.AI_AGENT_SDK_DENO_BIN
  if (configured !== undefined && configured.length > 0) {
    if (!existsSync(configured)) throw new Error(`AI_AGENT_SDK_DENO_BIN does not exist: ${configured}`)
    return configured
  }
  const verifiedFixture = join(workspaceRoot, '.temp', 'deno-official-v2.9.6', 'deno')
  if (existsSync(verifiedFixture)) return verifiedFixture
  const available = spawnSync('deno', ['--version'], { encoding: 'utf8' })
  if (available.status === 0) return 'deno'
  throw new Error(
    'Deno is required for the portable no-follow gate; set AI_AGENT_SDK_DENO_BIN to a verified binary',
  )
}

function createFixtureServer(root: string): Server {
  return createServer((request, response) => {
    void routeRequest(root, request.url ?? '/', response).catch(error => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(error instanceof Error ? error.stack : String(error))
    })
  })
}

async function routeRequest(
  root: string,
  rawUrl: string,
  response: import('node:http').ServerResponse,
): Promise<void> {
  const url = new URL(rawUrl, 'http://127.0.0.1')
  const stateMatch = /^\/probe\/([^/]+)\/state$/u.exec(url.pathname)
  if (stateMatch !== null) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(stateFor(decodeURIComponent(stateMatch[1] ?? ''))))
    return
  }
  const probeMatch = /^\/probe\/([^/]+)\/(provider|codex|oauth|mcp|observability)\/(.+)$/u
    .exec(url.pathname)
  if (probeMatch !== null) {
    const token = decodeURIComponent(probeMatch[1] ?? '')
    const capability = probeMatch[2] as Capability
    const suffix = probeMatch[3] ?? ''
    const expected = capability === 'codex'
      ? 'models'
      : capability === 'oauth'
        ? 'api/accounts/deviceauth/usercode'
        : 'start'
    const counts = stateFor(token)[capability]
    if (suffix === 'target') {
      counts.targets += 1
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('redirect target must never be contacted')
      return
    }
    if (suffix !== expected) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end(`unexpected ${capability} probe path: ${suffix}`)
      return
    }
    counts.starts += 1
    response.writeHead(307, {
      location: `/probe/${encodeURIComponent(token)}/${capability}/target`,
      'content-type': 'text/plain',
    })
    response.end('redirect refused by the SDK')
    return
  }
  serveStatic(root, url.pathname, response)
}

function stateFor(token: string): Record<Capability, ProbeCount> {
  const existing = probeState.get(token)
  if (existing !== undefined) return existing
  const created = Object.fromEntries(CAPABILITIES.map(name => [
    name, { starts: 0, targets: 0 },
  ])) as Record<Capability, ProbeCount>
  probeState.set(token, created)
  return created
}

function serveStatic(
  root: string,
  pathname: string,
  response: import('node:http').ServerResponse,
): void {
  const requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname)
  let target = resolve(root, `.${requested}`)
  if (!existsSync(target) && existsSync(`${target}.js`)) target = `${target}.js`
  if (!target.startsWith(`${resolve(root)}${sep}`) || !existsSync(target)) {
    response.writeHead(404).end()
    return
  }
  const extension = extname(target)
  const contentType = extension === '.js' || extension === '.mjs'
    ? 'text/javascript'
    : extension === '.json'
      ? 'application/json'
      : 'text/html'
  response.writeHead(200, { 'content-type': contentType })
  response.end(readFileSync(target))
}

async function listen(serverToStart: Server): Promise<number> {
  await new Promise<void>((done, reject) => {
    serverToStart.once('error', reject)
    serverToStart.listen(0, '127.0.0.1', done)
  })
  const address = serverToStart.address()
  if (address === null || typeof address === 'string') {
    throw new Error('portable no-follow fixture server has no TCP address')
  }
  return address.port
}

async function testBrowser(origin: string): Promise<void> {
  const chrome = existsSync('/usr/bin/google-chrome')
    ? realpathSync('/usr/bin/google-chrome')
    : undefined
  const browser = await chromium.launch({
    headless: true,
    ...(chrome === undefined ? {} : { executablePath: chrome }),
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    const requests: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('request', request => {
      if (request.url().includes('/probe/')) requests.push(`${request.method()} ${request.url()}`)
    })
    page.on('requestfailed', request => {
      errors.push(`request failed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })
    await page.goto(`${origin}/?endpoint=${encodeURIComponent(`${origin}/probe/browser`)}`)
    try {
      await page.waitForFunction(() => '__portableNoFollow' in globalThis, undefined, { timeout: 30_000 })
    } catch (error) {
      throw new Error(
        `browser no-follow fixture did not initialize: ${errors.join(' | ')}; requests=${requests.join(', ')}`,
        { cause: error },
      )
    }
  } finally {
    await browser.close()
  }
}

async function testWorker(origin: string): Promise<void> {
  const port = await availablePort()
  const child = spawn(join(workspaceRoot, 'node_modules', '.bin', 'wrangler'), [
    'dev', '--config', 'wrangler.jsonc', '--ip', '127.0.0.1', '--port', String(port),
  ], {
    cwd: consumer,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  child.stderr?.on('data', chunk => { output = `${output}${String(chunk)}`.slice(-16_384) })
  try {
    const endpoint = `${origin}/probe/workerd`
    const response = await pollWorker(
      `http://127.0.0.1:${port}/?endpoint=${encodeURIComponent(endpoint)}`,
      child,
    )
    const value = await response.json() as Record<string, unknown>
    if (value.mcpRejected !== true || value.providerRejected !== true) {
      throw new Error(`workerd returned invalid no-follow evidence: ${JSON.stringify(value)}`)
    }
  } catch (error) {
    throw new Error(`workerd portable no-follow fixture failed\n${output}`, { cause: error })
  } finally {
    await stop(child)
  }
}

async function availablePort(): Promise<number> {
  const temporaryServer = createServer()
  const port = await listen(temporaryServer)
  await closeServer(temporaryServer)
  return port
}

async function pollWorker(url: string, child: ChildProcess): Promise<Response> {
  const deadline = Date.now() + 30_000
  let lastFailure = ''
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited with ${child.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastFailure = `${response.status}: ${await response.text()}`.slice(-4_096)
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error(`wrangler did not return successful evidence within 30 seconds; ${lastFailure}`)
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

async function closeServer(serverToClose: Server): Promise<void> {
  await new Promise<void>((done, reject) => {
    serverToClose.close(error => error === undefined ? done() : reject(error))
  })
}
