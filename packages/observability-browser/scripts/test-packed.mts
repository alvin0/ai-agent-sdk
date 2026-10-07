import { runPackedCommand as run } from '../../../scripts/packed-command.mts'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'

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
  process.stdout.write(
    `packed observability-browser Chromium recovery passed: ${relative(workspaceRoot, browserTarball)}\n`,
  )
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


async function testBrowser(consumer: string): Promise<void> {
  const server = fixtureServer(consumer)
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('browser fixture server has no TCP address')
  const chrome = existsSync('/usr/bin/google-chrome') ? realpathSync('/usr/bin/google-chrome') : undefined
  const browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) })
  try {
    await runBrowserPhases(browser, address.port)
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

function fixtureServer(consumer: string) {
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
  return server
}

async function runBrowserPhases(browser: Browser, port: number) {
    const context = await browser.newContext()
    const database = `ai-agent-sdk-packed-${Date.now()}`
    const crashPage = await context.newPage()
    const crashErrors: string[] = []
    crashPage.on('pageerror', error => crashErrors.push(error.message))
    crashPage.on('console', message => { if (message.type() === 'error') crashErrors.push(message.text()) })
    await crashPage.goto(`http://127.0.0.1:${port}/?phase=crash&database=${database}`)
    const crash = await fixtureResult(crashPage).catch(error => {
      throw new Error(`crash fixture did not initialize: ${crashErrors.join(' | ')}`, { cause: error })
    })
    if ((crash as Record<string, unknown>).staged !== true) {
      throw new Error(`crash phase failed: ${JSON.stringify(crash)}`)
    }
    await crashPage.close()

    const verifyPage = await context.newPage()
    const verifyErrors: string[] = []
    verifyPage.on('pageerror', error => verifyErrors.push(error.message))
    verifyPage.on('console', message => { if (message.type() === 'error') verifyErrors.push(message.text()) })
    await verifyPage.goto(`http://127.0.0.1:${port}/?phase=verify&database=${database}`)
    const value = await fixtureResult(verifyPage).catch(error => {
      throw new Error(`verify fixture did not initialize: ${verifyErrors.join(' | ')}`, { cause: error })
    }) as Record<string, unknown>
    assertVerification(value)
    await context.close()
}

function assertVerification(value: Record<string, unknown>) {
  const expected = {
    error: undefined, recoveredAfterPageClose: 1, duplicateRejected: true, durable: true,
    boundary: 'local-durable', acknowledgedEvents: 1, remainingEvents: 1, capacityBatches: 0,
    runtimeInert: true, runtimeDurable: true, runtimeTerminalStored: true, runtimeAcknowledged: true,
    runtimeSpans: true, optionalLogsAbsent: true, quotaCode: value.expectedQuotaCode, auditDurable: true,
    blockedRejected: true, lifecycleFlushes: 2, buffer: 'undefined', process: 'undefined',
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) {
      throw new Error(`browser fixture returned invalid evidence: ${JSON.stringify(value)}`)
    }
  }
  if (JSON.stringify(value.retainedPriorities) !== '["critical","critical"]') {
    throw new Error(`browser fixture returned invalid evidence: ${JSON.stringify(value)}`)
  }
}
