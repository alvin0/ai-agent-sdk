import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const workspaceRoot = resolve(packageRoot, '../..')
const artifacts = join(packageRoot, 'artifacts')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const coreTarball = pack(join(workspaceRoot, 'packages', 'core'), artifacts)
const browserTarball = pack(packageRoot, artifacts)
const otelTarball = pack(join(workspaceRoot, 'packages', 'observability-otel'), artifacts)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-observability-browser-pack-'))
try {
  const consumer = join(temporaryRoot, 'browser')
  cpSync(join(packageRoot, 'fixtures', 'browser'), consumer, { recursive: true })
  cpSync(join(packageRoot, 'fixtures', 'shared', 'smoke.mjs'), join(consumer, 'fixture.mjs'))
  run('npm', [
    'install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
    '@opentelemetry/api@1.9.1', coreTarball, browserTarball, otelTarball,
  ], consumer)
  if (existsSync(join(consumer, 'node_modules', '@opentelemetry', 'api-logs'))) {
    throw new Error('optional @opentelemetry/api-logs was installed without a logger')
  }
  await testBrowser(consumer)
  process.stdout.write(`packed observability-browser Chromium recovery passed: ${relative(workspaceRoot, browserTarball)}\n`)
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

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

async function testBrowser(consumer: string): Promise<void> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const requested = url.pathname === '/' ? '/index.html' : url.pathname
    let target = resolve(consumer, `.${requested}`)
    if (!existsSync(target) && existsSync(`${target}.js`)) target = `${target}.js`
    if (!target.startsWith(`${resolve(consumer)}${sep}`) || !existsSync(target)) {
      response.writeHead(404).end()
      return
    }
    const contentType = ['.js', '.mjs'].includes(extname(target)) ? 'text/javascript' : 'text/html'
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
    const context = await browser.newContext()
    const database = `ai-agent-sdk-packed-${Date.now()}`
    const crashPage = await context.newPage()
    const crashErrors: string[] = []
    crashPage.on('pageerror', error => crashErrors.push(error.message))
    crashPage.on('console', message => { if (message.type() === 'error') crashErrors.push(message.text()) })
    await crashPage.goto(`http://127.0.0.1:${address.port}/?phase=crash&database=${database}`)
    const crash = await fixtureResult(crashPage).catch(error => {
      throw new Error(`crash fixture did not initialize: ${crashErrors.join(' | ')}`, { cause: error })
    })
    if ((crash as Record<string, unknown>).staged !== true) throw new Error(`crash phase failed: ${JSON.stringify(crash)}`)
    await crashPage.close()

    const verifyPage = await context.newPage()
    const verifyErrors: string[] = []
    verifyPage.on('pageerror', error => verifyErrors.push(error.message))
    verifyPage.on('console', message => { if (message.type() === 'error') verifyErrors.push(message.text()) })
    await verifyPage.goto(`http://127.0.0.1:${address.port}/?phase=verify&database=${database}`)
    const value = await fixtureResult(verifyPage).catch(error => {
      throw new Error(`verify fixture did not initialize: ${verifyErrors.join(' | ')}`, { cause: error })
    }) as Record<string, unknown>
    if (value.error !== undefined || value.recoveredAfterPageClose !== 1 || value.duplicateRejected !== true
      || value.durable !== true || value.boundary !== 'local-durable' || value.acknowledgedEvents !== 1
      || value.remainingEvents !== 1 || JSON.stringify(value.retainedPriorities) !== '["critical","critical"]'
      || value.capacityBatches !== 0
      || value.runtimeInert !== true || value.runtimeDurable !== true
      || value.runtimeTerminalStored !== true || value.runtimeAcknowledged !== true
      || value.runtimeSpans !== true || value.optionalLogsAbsent !== true
      || value.quotaCode !== value.expectedQuotaCode || value.auditDurable !== true
      || value.blockedRejected !== true || value.lifecycleFlushes !== 2
      || value.buffer !== 'undefined' || value.process !== 'undefined') {
      throw new Error(`browser fixture returned invalid evidence: ${JSON.stringify(value)}`)
    }
    await context.close()
  } finally {
    await browser.close()
    await new Promise<void>(done => server.close(() => done()))
  }
}

async function fixtureResult(page: import('playwright').Page): Promise<unknown> {
  await page.waitForFunction(() => '__browserObservationFixture' in globalThis)
  return await page.evaluate(() => (
    globalThis as typeof globalThis & { __browserObservationFixture: unknown }
  ).__browserObservationFixture)
}
