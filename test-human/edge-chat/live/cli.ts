#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { chromium } from 'playwright'
import { HumanArtifactRecorder, type HumanArtifactInvariant } from '../../artifacts.ts'
import { stripCommandSeparators } from '../../cli-args.ts'
import { startCodexRelay, type CodexRelay } from './relay.ts'
import { foundryBenchmarkInvariants, isFoundryBenchmark } from './foundry-benchmark.ts'

interface CliConfig {
  readonly runId: string
  readonly resultsRoot: string
  readonly authFile: string
  readonly model: string
  readonly prompt: string
  readonly promptSource: string
  readonly promptSha256: string
  readonly effort: string
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly maxTotalTokens: number
  readonly timeoutMs: number
  readonly headful: boolean
  readonly dryRun: boolean
}

interface SseEvent { readonly type: string; readonly data: Record<string, unknown> }

const DEFAULT_PROMPT = `Viết báo cáo quyết định kiến trúc cập nhật cho một đội đang xây ứng dụng chat AI trên Edge runtime bằng Web Standards. So sánh streaming, huỷ request, giới hạn runtime, lưu conversation state bền vững và khả năng web search giữa ít nhất ba nền tảng hoặc nguồn độc lập. Đọc kỹ tài liệu gốc, tìm các điểm khác nhau hoặc thông tin có thể đã cũ, giải thích trade-off và đưa khuyến nghị có trích dẫn. Nếu bằng chứng chưa đủ, tiếp tục tìm và đọc trước khi kết luận.`

await main()

async function main(): Promise<void> {
  const config = await parseArgs(process.argv.slice(2))
  const artifact = new HumanArtifactRecorder({
    harness: 'edge-chat-live', runId: config.runId, resultsRoot: config.resultsRoot,
  })
  if (config.dryRun) {
    const summary = await artifact.finish({ status: 'dry-run', config: publicConfig(config),
      invariants: [{ name: 'Live Edge deep-research plan is valid', passed: true }] })
    process.stdout.write(`Edge live dry-run: ${summary.artifact.directory}\n`)
    return
  }
  const temporary = mkdtempSync(join(tmpdir(), 'ai-agent-sdk-edge-live-'))
  let worker: ChildProcess | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let relay: CodexRelay | undefined
  try {
    const authText = await readFile(config.authFile, 'utf8')
    const credentials = parseCredential(authText)
    const encoded = Buffer.from(authText, 'utf8').toString('base64url')
    const configPath = join(temporary, 'wrangler.jsonc')
    const environmentPath = join(temporary, '.dev.vars')
    const relaySecret = randomBytes(32).toString('base64url')
    relay = await startCodexRelay(relaySecret)
    await writeFile(configPath, `${JSON.stringify({
      name: 'ai-agent-sdk-edge-chat-live',
      main: resolve('test-human/edge-chat/live/worker.ts'),
      compatibility_date: '2026-08-01', workers_dev: false,
    }, null, 2)}\n`, { mode: 0o600 })
    await writeFile(environmentPath,
      `CODEX_AUTH_BASE64=${encoded}\nEDGE_CHAT_MODEL=${config.model}\n`
      + `EDGE_CHAT_REASONING_EFFORT=${config.effort}\n`
      + `EDGE_CHAT_MAX_TURNS=${config.maxTurns}\n`
      + `EDGE_CHAT_MAX_TOOL_CALLS=${config.maxToolCalls}\n`
      + `EDGE_CHAT_MAX_TOTAL_TOKENS=${config.maxTotalTokens}\n`
      + `CODEX_RELAY_ORIGIN=${relay.origin}\nCODEX_RELAY_SECRET=${relaySecret}\n`, { mode: 0o600 })
    const port = await availablePort()
    const origin = `http://127.0.0.1:${port}`
    worker = startWorker(port, configPath, environmentPath, artifact)
    await waitForHealth(origin, worker)
    artifact.record('worker-ready', {
      origin, runtime: 'workerd', provider: 'codex-live', transport: 'bounded-loopback-relay',
    })

    browser = await chromium.launch({ headless: !config.headful })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const browserErrors: string[] = []
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
    page.on('pageerror', error => browserErrors.push(error.message))
    await page.goto(origin, { waitUntil: 'networkidle' })
    await page.getByTestId('deep-search-toggle').click()
    await page.getByTestId('prompt').fill(config.prompt)
    const responseStarted = page.waitForResponse(response => (
      response.url() === `${origin}/api/chat` && response.request().method() === 'POST'
    ), { timeout: 60_000 })
    await page.getByTestId('send').click()
    const response = await responseStarted
    const firstProgress = page.locator('.tool-item, .agent-progress-item').first()
    const progressOutcome = await Promise.race([
      firstProgress.waitFor({ timeout: 240_000 }).then(() => 'progress' as const),
      page.waitForFunction(
        browserHasTerminalEvent,
        undefined,
        { timeout: 240_000 },
      ).then(() => 'terminal' as const),
    ])
    const sawProgress = progressOutcome === 'progress'
    if (sawProgress && await page.locator('.tool-item').count() === 0) {
      await Promise.race([
        page.locator('.tool-item').first().waitFor({ timeout: 60_000 }).catch(() => undefined),
        page.waitForFunction(browserHasTerminalEvent, undefined, { timeout: 60_000 })
          .catch(() => undefined),
      ])
    }
    if (sawProgress) await page.waitForTimeout(750)
    const processScreenshotTools = await page.locator('.tool-item').count()
    await writeScreenshot(page, join(artifact.directory, 'edge-live-process.png'))
    await page.waitForFunction(
      browserHasTerminalEvent,
      undefined,
      { timeout: config.timeoutMs },
    )
    const events = await page.evaluate(
      () => Reflect.get(globalThis, '__EDGE_CHAT_EVENTS__'),
    ) as readonly SseEvent[]
    await page.waitForTimeout(100)
    await writeScreenshot(page, join(artifact.directory, 'edge-live-final.png'))
    const close = await fetch(`${origin}/api/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: conversationIdFrom(events) }),
    }).then(async result => await result.json()) as Record<string, unknown>

    const terminal = events.findLast(event => ['complete', 'failed', 'aborted'].includes(event.type))
    const evidence = objectField(terminal?.data, 'evidence')
    const receipts = arrayField(evidence, 'receipts')
    const audits = arrayField(evidence, 'audits')
    const report = objectField(terminal?.data, 'report')
    const terminalCode = stringField(terminal?.data, 'code')
    const terminalStage = stringField(terminal?.data, 'stage')
    const reportErrors = arrayField(report, 'errors')
    const usage = objectField(report, 'usage')
    const coverage = objectField(usage, 'coverage')
    const reportedUsage = objectField(usage, 'reported')
    const finalText = stringField(terminal?.data, 'text') ?? ''
    const finalAudit = audits.at(-1)
    const nativeSearchCalls = uniqueCallCount(events, 'native-tool', 'web-search')
    const readCalls = uniqueCallCount(events, 'tool-result', 'read_web_page', 'completed')
    const auditCalls = uniqueCallCount(events, 'tool-result', 'audit_research_evidence', 'completed')
    const domains = new Set(receipts.flatMap(item => {
      const domain = stringField(item, 'domain')
      return domain === undefined ? [] : [domain]
    }))
    const citedUrls = new Set([...finalText.matchAll(/https:\/\/[^\s)\]]+/gu)].map(match => match[0]))
    const renderedTools = await page.locator('.tool-item').count()
    const renderedProgress = await page.locator('.agent-progress-item').count()
    const progressTexts = await page.locator('.agent-progress-item').allTextContents()
    const tinyProgressRows = progressTexts.filter(text => text.trim().length <= 3).length
    const finalBody = page.locator('[data-role="assistant"] .body').last()
    const renderedFinalChars = (await finalBody.textContent() ?? '').trim().length
    const finalBodyInViewport = await page
      .locator('#messages, [data-role="assistant"] .body').evaluateAll(nodes => {
      const scroller = nodes[0]
      const body = nodes.at(-1)
      if (scroller === undefined || body === undefined || scroller === body) return false
      const bodyRect = body.getBoundingClientRect()
      const scrollerRect = scroller.getBoundingClientRect()
      return bodyRect.bottom > scrollerRect.top && bodyRect.top < scrollerRect.bottom
    })
    const eventPayload = JSON.stringify(events)
    const leakedCredential = [...credentials, relaySecret]
      .some(secret => eventPayload.includes(secret))
    const relaySnapshot = relay.snapshot()

    await writeFile(join(artifact.directory, 'report.md'), finalText, { mode: 0o600 })
    await writeFile(join(artifact.directory, 'research-evidence.json'), `${JSON.stringify({
      receipts, audits,
    }, null, 2)}\n`, { mode: 0o600 })
    await writeFile(join(artifact.directory, 'review.json'), `${JSON.stringify({
      schemaVersion: 1, decision: 'pending-independent-review', reviewer: null,
      reviewedAt: null, majorClaimsSupported: null, contradictionsExplained: null,
      missingTopicsDisclosed: null, followUpAddressesPriorGaps: null, notes: '',
    }, null, 2)}\n`, { mode: 0o600 })
    artifact.record('live-stream-evidence', { events, close })
    artifact.record('terminal-support', {
      status: terminal?.type ?? 'missing', code: terminalCode ?? null,
      stage: terminalStage ?? null,
      reportStatus: stringField(report, 'status') ?? null,
      errorCodes: reportErrors.map(error => ({
        code: stringField(error, 'code') ?? null, stage: stringField(error, 'stage') ?? null,
      })),
    })
    artifact.record('relay-evidence', relaySnapshot)
    artifact.record('browser-evidence', {
      sawProgress, processScreenshotTools, renderedTools, renderedProgress,
      screenshots: ['edge-live-process.png', 'edge-live-final.png'], browserErrors,
    })
    await browser.close()
    browser = undefined
    await stopWorker(worker)
    worker = undefined
    await relay.close()
    relay = undefined

    const invariants: HumanArtifactInvariant[] = [
      { name: 'Authenticated provider runs inside strict workerd', passed: response.ok() && events[0]?.data.provider === 'codex-live' },
      { name: 'Test-only relay performs bounded real upstream transport',
        passed: relaySnapshot.requests > 0 && relaySnapshot.successfulResponses > 0
          && relaySnapshot.upstreamFailures === 0 },
      { name: 'SSE has one support-safe terminal event', passed: terminal !== undefined
        && events.filter(event => ['complete', 'failed', 'aborted'].includes(event.type)).length === 1
        && terminal === events.at(-1),
        ...(terminal?.type === 'failed'
          ? { detail: `${terminalCode ?? 'unknown'} at ${terminalStage ?? 'unknown'}` }
          : {}) },
      { name: 'Agent performs at least three provider-native searches', passed: nativeSearchCalls >= 3,
        detail: `${nativeSearchCalls} calls` },
      { name: 'Host records at least six successful page reads', passed: receipts.length >= 6 && readCalls >= 6,
        detail: `${receipts.length} receipts` },
      { name: 'Read evidence crosses at least three independent domains', passed: domains.size >= 3,
        detail: `${domains.size} domains` },
      { name: 'Agent submits provenance audit after reading', passed: auditCalls >= 1 && audits.length >= 1 },
      { name: 'Final audit passes integrity/coverage floors but remains reviewer-gated',
        passed: booleanField(finalAudit, 'eligibleForIndependentReview') === true
          && booleanField(finalAudit, 'requiresIndependentReview') === true },
      { name: 'Final Markdown report is substantial and cites read sources',
        passed: finalText.length >= 4_000 && citedUrls.size >= 6,
        detail: `${finalText.length} chars, ${citedUrls.size} URLs` },
      { name: 'Browser displays live agent/tool process', passed: sawProgress
        && processScreenshotTools > 0
        && renderedTools >= nativeSearchCalls + readCalls + auditCalls && renderedTools > 0,
        detail: `${processScreenshotTools} process-screenshot tools, ${renderedTools} final tool rows, ${renderedProgress} progress rows` },
      { name: 'Browser coalesces streamed commentary into readable progress rows',
        passed: renderedProgress <= 40
          && tinyProgressRows <= Math.max(1, Math.floor(renderedProgress / 10)),
        detail: `${renderedProgress} rows, ${tinyProgressRows} tiny rows` },
      { name: 'Browser keeps the completed Markdown report in the message viewport',
        passed: finalText.length >= 4_000 && renderedFinalChars >= 2_000 && finalBodyInViewport,
        detail: `${renderedFinalChars} rendered chars, visible=${String(finalBodyInViewport)}` },
      { name: 'Every model call reports authoritative usage', passed: report?.status === 'success'
        && numberField(coverage, 'missing') === 0 && numberField(coverage, 'complete')! > 0 },
      { name: 'Credential never appears in SSE or artifacts', passed: !leakedCredential },
      { name: 'Runtime closes without unsettled work', passed: close.closed === true
        && close.state === 'closed' && close.unsettledRuns === 0 },
      { name: 'Browser emits no console/page error', passed: browserErrors.length === 0 },
      { name: 'Independent semantic decision is explicitly separate', passed: true,
        detail: 'review.json remains pending-independent-review' },
      ...(isFoundryBenchmark(config.promptSource) ? foundryBenchmarkInvariants(finalText) : []),
    ]
    const passed = invariants.every(invariant => invariant.passed)
    const summary = await artifact.finish({ status: passed ? 'passed' : 'failed',
      config: publicConfig(config),
      invariants, metrics: { events: events.length, nativeSearchCalls, readCalls,
        receipts: receipts.length, domains: domains.size, auditCalls, audits: audits.length,
        reportChars: finalText.length, citedUrls: citedUrls.size, processScreenshotTools,
        renderedTools, renderedProgress,
        tinyProgressRows, renderedFinalChars, finalBodyInViewport,
        terminalCode: terminalCode ?? null, terminalStage: terminalStage ?? null,
        usage: {
          inputTokens: numberField(reportedUsage, 'inputTokens') ?? null,
          outputTokens: numberField(reportedUsage, 'outputTokens') ?? null,
          totalTokens: numberField(reportedUsage, 'totalTokens') ?? null,
          authoritative: booleanField(usage, 'authoritative') ?? null,
          completeModelCalls: numberField(coverage, 'complete') ?? null,
          missingModelCalls: numberField(coverage, 'missing') ?? null,
        },
        reportErrorCodes: reportErrors.map(error => stringField(error, 'code') ?? 'unknown'),
        relay: relaySnapshot } })
    process.stdout.write(`Edge live ${summary.status}: ${summary.artifact.directory}\n`)
    if (!passed) process.exitCode = 1
  } catch (error) {
    if (browser !== undefined) {
      await browser.close().catch(() => undefined)
      browser = undefined
    }
    if (worker !== undefined) {
      await stopWorker(worker).catch(() => undefined)
      worker = undefined
    }
    if (relay !== undefined) {
      await relay.close().catch(() => undefined)
      relay = undefined
    }
    const summary = await artifact.finish({ status: 'failed',
      config: publicConfig(config),
      invariants: [{ name: 'Authenticated Edge research completes', passed: false }], error })
    process.stderr.write(`Edge live failed: ${error instanceof Error ? error.message : String(error)}\nArtifact: ${summary.artifact.directory}\n`)
    process.exitCode = 1
  } finally {
    await browser?.close()
    await stopWorker(worker)
    await relay?.close()
    await rm(temporary, { recursive: true, force: true })
  }
}

function parseCredential(text: string): readonly string[] {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object') throw new TypeError('Codex credential file is invalid')
  const tokens = Reflect.get(value, 'tokens')
  if (tokens === null || typeof tokens !== 'object') throw new TypeError('Codex tokens are missing')
  const secrets = ['access_token', 'id_token', 'refresh_token'].flatMap(key => {
    const secret = Reflect.get(tokens, key)
    return typeof secret === 'string' && secret.length > 0 ? [secret] : []
  })
  if (secrets.length < 3) throw new TypeError('Codex tokens are incomplete')
  return secrets
}

function conversationIdFrom(events: readonly SseEvent[]): string {
  const start = events.find(event => event.type === 'start')
  const explicit = stringField(start?.data, 'conversationId')
  if (explicit !== undefined) return explicit
  return 'live-edge-research'
}

function uniqueCallCount(
  events: readonly SseEvent[], type: string, name: string, status?: string,
): number {
  return new Set(events.filter(event => event.type === type
    && event.data.name === name && (status === undefined || event.data.status === status))
    .flatMap(event => typeof event.data.callId === 'string' ? [event.data.callId] : [])).size
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const selected = Reflect.get(value, key)
  return selected !== null && typeof selected === 'object' && !Array.isArray(selected)
    ? selected as Record<string, unknown> : undefined
}
function arrayField(value: unknown, key: string): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== 'object') return []
  const selected = Reflect.get(value, key)
  return Array.isArray(selected)
    ? selected.filter(item => item !== null && typeof item === 'object') as Record<string, unknown>[] : []
}
function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const selected = Reflect.get(value, key)
  return typeof selected === 'string' ? selected : undefined
}
function numberField(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const selected = Reflect.get(value, key)
  return typeof selected === 'number' ? selected : undefined
}
function booleanField(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const selected = Reflect.get(value, key)
  return typeof selected === 'boolean' ? selected : undefined
}

function browserHasTerminalEvent(): boolean {
  const value: unknown = Reflect.get(globalThis, '__EDGE_CHAT_EVENTS__')
  return Array.isArray(value) && value.some(event => event !== null && typeof event === 'object'
    && ['complete', 'failed', 'aborted'].includes(String(Reflect.get(event, 'type'))))
}

async function writeScreenshot(page: import('playwright').Page, path: string): Promise<void> {
  await page.screenshot({ path, fullPage: true })
}

function startWorker(
  port: number, configPath: string, environmentPath: string, artifact: HumanArtifactRecorder,
): ChildProcess {
  const child = spawn(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    'exec', 'wrangler', 'dev', '--config', configPath, '--env-file', environmentPath,
    '--port', String(port), '--ip', '127.0.0.1', '--local', '--log-level', 'warn',
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
  const record = (channel: string, chunk: unknown): void => {
    const value = String(chunk)
    artifact.record('worker-log', { channel, chars: value.length,
      sha256: createHash('sha256').update(value).digest('hex') })
  }
  child.stdout?.on('data', chunk => record('stdout', chunk))
  child.stderr?.on('data', chunk => record('stderr', chunk))
  return child
}

async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited during startup (${child.exitCode})`)
    try { if ((await fetch(`${origin}/health`)).ok) return } catch { /* starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('live Edge worker did not become ready')
}

async function stopWorker(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise())),
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); reject(new Error('port allocation failed')); return }
      server.close(error => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

async function parseArgs(argv: readonly string[]): Promise<CliConfig> {
  const input = stripCommandSeparators(argv)
  const values = new Map<string, string>()
  const switches = new Set<string>()
  for (let index = 0; index < input.length; index++) {
    const token = input[index]
    if (token === '--headful' || token === '--dry-run') { switches.add(token); continue }
    if (![
      '--run-id', '--results-root', '--auth-file', '--model', '--prompt', '--prompt-file',
      '--effort', '--max-turns', '--max-tool-calls', '--max-total-tokens', '--timeout-ms',
    ].includes(token ?? '')) {
      throw new Error(`unknown option: ${token}`)
    }
    const value = input[++index]
    if (value === undefined) throw new Error(`${token} requires a value`)
    values.set(token!, value)
  }
  const runId = values.get('--run-id') ?? `run-${new Date().toISOString().replace(/[:.]/gu, '-')}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) throw new TypeError('run id is invalid')
  const model = values.get('--model') ?? 'gpt-5.6-luna'
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(model)) throw new TypeError('model is invalid')
  if (values.has('--prompt') && values.has('--prompt-file')) {
    throw new TypeError('--prompt and --prompt-file are mutually exclusive')
  }
  const promptFile = values.get('--prompt-file')
  const prompt = promptFile === undefined
    ? values.get('--prompt') ?? DEFAULT_PROMPT
    : (await readFile(resolve(promptFile), 'utf8')).trim()
  if (prompt.length === 0 || prompt.length > 32_000) {
    throw new TypeError('prompt must contain between 1 and 32000 characters')
  }
  const effort = values.get('--effort') ?? 'medium'
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new TypeError('reasoning effort is invalid')
  }
  return {
    runId, resultsRoot: resolve(values.get('--results-root') ?? 'test-human/results/edge-chat-live'),
    authFile: resolve(values.get('--auth-file')
      ?? process.env.AI_AGENT_SDK_CODEX_AUTH
      ?? '.providers/.codex/auth.json'),
    model, prompt,
    promptSource: promptFile === undefined
      ? values.has('--prompt') ? 'inline' : 'default'
      : resolve(promptFile),
    promptSha256: createHash('sha256').update(prompt).digest('hex'),
    effort,
    maxTurns: integerOption(values, '--max-turns', 28, 4, 96),
    maxToolCalls: integerOption(values, '--max-tool-calls', 40, 4, 160),
    maxTotalTokens: integerOption(values, '--max-total-tokens', 300_000, 32_000, 1_500_000),
    timeoutMs: integerOption(values, '--timeout-ms', 10 * 60_000, 60_000, 30 * 60_000),
    headful: switches.has('--headful'), dryRun: switches.has('--dry-run'),
  }
}

function integerOption(
  values: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = values.get(name)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function publicConfig(config: CliConfig): Record<string, unknown> {
  return {
    model: config.model, effort: config.effort, promptChars: config.prompt.length,
    promptSource: config.promptSource, promptSha256: config.promptSha256,
    maxTurns: config.maxTurns, maxToolCalls: config.maxToolCalls,
    maxTotalTokens: config.maxTotalTokens, timeoutMs: config.timeoutMs,
    headful: config.headful,
  }
}
