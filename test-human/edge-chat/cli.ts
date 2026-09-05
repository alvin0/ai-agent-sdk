#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { HumanArtifactRecorder, type HumanArtifactInvariant } from '../artifacts.ts'
import { stripCommandSeparators } from '../cli-args.ts'

interface Config {
  readonly runId: string
  readonly resultsRoot: string
  readonly headful: boolean
  readonly dryRun: boolean
  readonly help: boolean
  readonly parallel: number
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2))
  if (config.help) { process.stdout.write(`${help()}\n`); return }
  const artifact = new HumanArtifactRecorder({
    harness: 'edge-chat', runId: config.runId, resultsRoot: config.resultsRoot,
  })
  if (config.dryRun) {
    const summary = await artifact.finish({
      status: 'dry-run',
      config: { ...config },
      invariants: [{ name: 'Edge browser acceptance plan is valid', passed: true }],
    })
    process.stdout.write(`Edge Chat dry-run ${summary.status}: ${artifact.summaryPath}\n`)
    return
  }
  let worker: ChildProcess | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    worker = startWorker(port, artifact)
    await waitForHealth(origin, worker)
    artifact.record('worker-ready', { origin, runtime: 'workerd' })

    const api = await exerciseApi(origin, config.parallel, artifact)
    browser = await chromium.launch({ headless: !config.headful })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const consoleErrors: string[] = []
    page.on('console', message => {
      safeRecord(artifact, 'browser-console', { level: message.type(), text: message.text() })
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', error => consoleErrors.push(error.message))
    await page.goto(origin, { waitUntil: 'networkidle' })
    await page.getByTestId('prompt').fill('Xin chào Edge')
    await page.getByTestId('send').click()
    await page.locator('[data-role="assistant"]').last().getByText(/phản hồi streaming/u).waitFor()
    await page.getByTestId('prompt').fill('19 * 23')
    await page.getByTestId('send').click()
    await page.locator('[data-role="assistant"]').last().getByText(/437/u).waitFor()
    await page.getByTestId('deep-search-toggle').click()
    const deepSearchEnabled = await page.getByTestId('deep-search-toggle').getAttribute('aria-pressed')
    await page.getByTestId('prompt').fill('Phân tích cách xây chat streaming và giữ conversation state trên Edge runtime')
    await page.getByTestId('send').click()
    const researchMessage = page.locator('[data-role="assistant"]').last()
    await researchMessage.getByRole('heading', { name: 'Báo cáo deep search' }).waitFor()
    const browserResearchTools = await researchMessage.locator('.tool-item').count()
    const browserProgressItems = await researchMessage.locator('.agent-progress-item').count()
    const markdownHeadingCount = await researchMessage.locator('.markdown h2, .markdown h3').count()
    const rawMarkdownVisible = (await researchMessage.locator('.markdown').textContent())?.includes('##') === true
    const browserAudits = researchMessage.locator('.tool-item[data-tool="audit_research"]')
    const browserAuditCount = await browserAudits.count()
    const browserFirstAudit = await browserAudits.first().textContent()
    const browserFinalAudit = await browserAudits.last().textContent()
    const browserSourceLinks = await researchMessage.locator('.tool-sources a').count()
    await mkdir(artifact.directory, { recursive: true, mode: 0o700 })
    const researchScreenshot = join(artifact.directory, 'edge-chat-deep-search-process.png')
    await page.evaluate(() => {
      const browserDocument = Reflect.get(globalThis, 'document') as {
        querySelector(selector: string): { style: { height: string; overflow: string; display: string }; removeAttribute(name: string): void } | null
      }
      const main = browserDocument.querySelector('.main')
      const messages = browserDocument.querySelector('.messages')
      const composer = browserDocument.querySelector('.composer-wrap')
      if (main !== null) { main.style.height = 'auto'; main.style.overflow = 'visible' }
      if (messages !== null) messages.style.overflow = 'visible'
      if (composer !== null) composer.style.display = 'none'
    })
    await researchMessage.screenshot({ path: researchScreenshot })
    await page.evaluate(() => {
      const browserDocument = Reflect.get(globalThis, 'document') as {
        querySelector(selector: string): { removeAttribute(name: string): void } | null
      }
      for (const selector of ['.main', '.messages', '.composer-wrap']) {
        browserDocument.querySelector(selector)?.removeAttribute('style')
      }
    })
    const beforeReload = await page.locator('.message').count()
    await page.reload({ waitUntil: 'networkidle' })
    const afterReload = await page.locator('.message').count()
    const persistedResearchTools = await page.locator('[data-role="assistant"]').last().locator('.tool-item').count()
    const persistedProgressItems = await page.locator('[data-role="assistant"]').last().locator('.agent-progress-item').count()
    const persistedMode = await page.getByTestId('deep-search-toggle').getAttribute('aria-pressed')
    const desktopScreenshot = join(artifact.directory, 'edge-chat-desktop.png')
    await page.screenshot({ path: desktopScreenshot, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    const mobileScreenshot = join(artifact.directory, 'edge-chat-mobile.png')
    await page.screenshot({ path: mobileScreenshot, fullPage: true })
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.getByTestId('prompt').fill('[slow] prove cancellation')
    await page.getByTestId('send').click()
    await page.locator('[data-role="assistant"]').last().waitFor()
    const busyBeforeReset = await page.getByTestId('send').isDisabled()
    await page.getByTestId('new-chat').click()
    await page.waitForTimeout(100)
    const afterReset = await page.locator('.message').count()
    const invariants: HumanArtifactInvariant[] = [
      { name: 'Worker identifies Web Standards runtime', passed: api.health.runtime === 'web-standards' },
      { name: 'SSE streams more than one text delta', passed: api.deltaCount > 1, detail: `${api.deltaCount} deltas` },
      { name: 'SSE envelopes have version, run ID, monotonic sequence, and one terminal', passed: api.protocolValid },
      { name: 'Edge agent executes a host tool loop', passed: api.toolCalls === 1 && api.toolResults === 1 },
      { name: 'Deep search reads sources across multiple tool rounds', passed: api.researchToolCalls === 6 && api.researchToolResults === 6 },
      { name: 'Every deep-search tool succeeds before audit/report', passed: api.researchAllSucceeded },
      { name: 'Deep search audits insufficient then sufficient coverage', passed: api.auditTransition && api.reportAfterFinalAudit },
      { name: 'Deep-search mode activates agent instructions without prompt keywords', passed: api.researchMode === 'deep-search' && deepSearchEnabled === 'true' },
      { name: 'Browser exposes every search/read/audit tool process', passed: browserResearchTools === 6 && browserAuditCount === 2 && browserSourceLinks >= 2 },
      { name: 'Browser separates adaptive agent progress from tool calls', passed: browserProgressItems === 6 },
      { name: 'Final report is rendered as Markdown instead of raw syntax', passed: markdownHeadingCount >= 3 && !rawMarkdownVisible },
      { name: 'Browser explains failed and passed audit gates', passed: /Chưa đủ/u.test(browserFirstAudit ?? '') && /Đạt/u.test(browserFinalAudit ?? '') },
      { name: 'Concurrent isolated conversations complete', passed: api.concurrentPassed === config.parallel, detail: `${api.concurrentPassed}/${config.parallel}` },
      { name: 'Invalid API input is rejected', passed: api.invalidStatus === 400 },
      { name: 'Missing usage fails visibly with a terminal accounting code', passed: api.missingUsageVisible },
      { name: 'Required observation degradation fails visibly without leaking exporter errors', passed: api.observationDegradationVisible },
      { name: 'Browser persists mode, progress, and tool timeline across reload', passed: beforeReload === afterReload && afterReload === 6 && persistedResearchTools === 6 && persistedProgressItems === 6 && persistedMode === 'true' },
      { name: 'New chat aborts an active stream and resets transcript', passed: busyBeforeReset && afterReset === 0 },
      { name: 'Browser emits no console or page errors', passed: consoleErrors.length === 0, detail: consoleErrors.join('; ') },
    ]
    artifact.record('browser-evidence', {
      browserResearchTools, browserProgressItems, browserAuditCount, browserSourceLinks, markdownHeadingCount, rawMarkdownVisible,
      beforeReload, afterReload, persistedResearchTools, persistedProgressItems, persistedMode, busyBeforeReset, afterReset, consoleErrors: consoleErrors.length,
      screenshots: [researchScreenshot, desktopScreenshot, mobileScreenshot],
    })
    const passed = invariants.every(invariant => invariant.passed)
    const summary = await artifact.finish({
      status: passed ? 'passed' : 'failed', config: { ...config }, invariants,
      metrics: {
        apiDeltas: api.deltaCount,
        researchToolCalls: api.researchToolCalls,
        researchAudits: 2,
        concurrentRequests: config.parallel,
        browserMessages: afterReload,
      },
    })
    process.stdout.write(`Edge Chat ${summary.status}: ${artifact.summaryPath}\n`)
    if (!passed) process.exitCode = 1
  } catch (error: unknown) {
    const summary = await artifact.finish({
      status: 'failed', config: { ...config },
      invariants: [{ name: 'Edge Chat acceptance completes', passed: false }], error,
    })
    process.stderr.write(`Edge Chat failed: ${error instanceof Error ? error.message : String(error)}\nArtifact: ${summary.artifact.directory}\n`)
    process.exitCode = 1
  } finally {
    await browser?.close()
    await stopWorker(worker)
  }
}

async function exerciseApi(origin: string, parallel: number, artifact: HumanArtifactRecorder) {
  const healthResponse = await fetch(`${origin}/health`)
  const health = await healthResponse.json() as { runtime?: string }
  const math = await streamChat(origin, 'api-math', '19 nhân 23')
  artifact.record('api-stream', math)
  const research = await streamChat(
    origin,
    'api-research',
    'Phân tích cách xây chat streaming và giữ conversation state trên Edge runtime',
    'deep-search',
  )
  artifact.record('api-deep-search', research)
  const researchCalls = research.events.filter(event => event.type === 'tool-call')
  const researchResults = research.events.filter(event => event.type === 'tool-result')
  const audits = researchResults.filter(event => field(event.data, 'name') === 'audit_research')
  const firstAudit = field(field(audits[0]?.data, 'meta'), 'sufficient')
  const finalAudit = field(field(audits[1]?.data, 'meta'), 'sufficient')
  const finalAuditIndex = audits[1] === undefined ? -1 : research.events.indexOf(audits[1])
  const doneIndex = research.events.findIndex(event => event.type === 'complete')
  const researchMode = field(research.events.find(event => event.type === 'start')?.data, 'mode')
  const concurrent = await Promise.all(Array.from({ length: parallel }, (_, index) => (
    streamChat(origin, `parallel-${index}`, `hello ${index}`)
  )))
  const invalidStatus = (await fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json',
  })).status
  const missing = await streamChat(origin, 'missing-usage', '[missing-usage]')
  const degraded = await streamChat(origin, 'degraded-observation', 'observation probe')
  const allStreams = [math, research, ...concurrent, missing, degraded]
  return {
    health,
    deltaCount: math.events.filter(event => event.type === 'delta').length,
    toolCalls: math.events.filter(event => event.type === 'tool-call').length,
    toolResults: math.events.filter(event => event.type === 'tool-result').length,
    researchToolCalls: researchCalls.length,
    researchToolResults: researchResults.length,
    researchAllSucceeded: researchResults.every(event => field(event.data, 'isError') === false),
    auditTransition: firstAudit === false && finalAudit === true,
    reportAfterFinalAudit: finalAuditIndex >= 0 && doneIndex > finalAuditIndex,
    researchMode,
    protocolValid: allStreams.every(result => result.protocolValid),
    missingUsageVisible: missing.events.at(-1)?.type === 'failed'
      && field(missing.events.at(-1)?.data, 'code') === 'USAGE_REQUIRED',
    observationDegradationVisible: degraded.events.at(-1)?.type === 'failed'
      && field(degraded.events.at(-1)?.data, 'code') === 'OBSERVATION_DEGRADED'
      && !JSON.stringify(degraded.events).includes('PRIVATE/EDGE_EXPORTER_FAILURE'),
    concurrentPassed: concurrent.filter(result => result.events.some(event => event.type === 'complete')).length,
    invalidStatus,
  }
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, name) : undefined
}

async function streamChat(origin: string, conversationId: string, message: string, mode: 'auto' | 'deep-search' = 'auto') {
  const response = await fetch(`${origin}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, message, mode }),
  })
  if (!response.ok || response.body === null) throw new Error(`chat request failed with HTTP ${response.status}`)
  const payload = await response.text()
  const events = payload.split(/\r?\n\r?\n/u).filter(Boolean).map(frame => {
    const event = /^event:\s*(.+)$/mu.exec(frame)?.[1] ?? 'message'
    const data = /^data:\s*(.+)$/mu.exec(frame)?.[1] ?? '{}'
    return { type: event, data: JSON.parse(data) as unknown }
  })
  const terminal = events.filter(item => ['complete', 'failed', 'aborted'].includes(item.type))
  const runIds = new Set(events.map(item => field(item.data, 'runId')))
  const protocolValid = terminal.length === 1 && terminal[0] === events.at(-1)
    && runIds.size === 1 && !runIds.has(undefined)
    && events.every((item, index) => field(item.data, 'schemaVersion') === 1
      && field(item.data, 'type') === item.type && field(item.data, 'sequence') === index + 1)
  return { status: response.status, events, protocolValid }
}

function startWorker(port: number, artifact: HumanArtifactRecorder): ChildProcess {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const child = spawn(command, [
    'exec', 'wrangler', 'dev', '--config', 'test-human/edge-chat/wrangler.jsonc',
    '--port', String(port), '--ip', '127.0.0.1', '--local', '--log-level', 'warn',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
  child.stdout?.on('data', chunk => safeRecord(artifact, 'worker-stdout', { text: String(chunk) }))
  child.stderr?.on('data', chunk => safeRecord(artifact, 'worker-stderr', { text: String(chunk) }))
  return child
}

async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited before readiness (${child.exitCode})`)
    try {
      const response = await fetch(`${origin}/health`)
      if (response.ok) return
    } catch { /* worker is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('wrangler did not become ready within 30 seconds')
}

async function stopWorker(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, 3_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('failed to allocate port')); return }
      server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

function parseArgs(argv: readonly string[]): Config {
  const input = stripCommandSeparators(argv)
  let runId = defaultRunId()
  let resultsRoot = resolve('test-human/results/edge-chat')
  let parallel = 8
  let headful = false
  let dryRun = false
  let showHelp = false
  for (let index = 0; index < input.length; index++) {
    const token = input[index]
    if (token === '--headful') headful = true
    else if (token === '--dry-run') dryRun = true
    else if (token === '--help' || token === '-h') showHelp = true
    else if (token === '--run-id') runId = required(input[++index], token)
    else if (token === '--results-root') resultsRoot = resolve(required(input[++index], token))
    else if (token === '--parallel') parallel = positiveInteger(required(input[++index], token), token)
    else throw new Error(`unknown edge-chat option: ${token}`)
  }
  if (runId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error('--run-id must be a safe path segment')
  return { runId, resultsRoot, parallel, headful, dryRun, help: showHelp }
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw new Error(`${flag} must be an integer from 1 to 64`)
  return value
}

function help(): string {
  return `Edge Chat human acceptance harness

Usage: pnpm human:edge-chat [--headful] [--parallel 8] [--dry-run]

Starts a real workerd runtime, exercises the SSE API under concurrency, then
drives the ChatGPT-like UI with Playwright and writes screenshots plus a
support-safe summary/events artifact under test-human/results/edge-chat.`
}

function defaultRunId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}`
}

function safeRecord(artifact: HumanArtifactRecorder, kind: string, data: unknown): void {
  try { artifact.record(kind, data) } catch { /* asynchronous cleanup may happen after artifact finalization */ }
}

void main()
