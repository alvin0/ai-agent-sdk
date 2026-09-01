/** Host preparation for a reproducible Signal Desk live-agent run. */

import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readSignalDeskWorkspaceMarker } from './seed.ts'
import {
  failedSignalDeskCommandResult,
  runSignalDeskCommand,
  type SignalDeskCommandRequest,
  type SignalDeskCommandResult,
  type SignalDeskCommandRunner,
} from './verify.ts'

const DEFAULT_INSTALL_TIMEOUT_MS = 180_000
const DEFAULT_BROWSER_TIMEOUT_MS = 300_000
const DEFAULT_OUTPUT_CHARS = 64_000

export interface PrepareSignalDeskWorkspaceOptions {
  readonly workspace: string
  readonly commandRunner?: SignalDeskCommandRunner
  readonly installTimeoutMs?: number
  readonly browserTimeoutMs?: number
  readonly maxOutputChars?: number
  readonly signal?: AbortSignal
  readonly onCommandStart?: (request: SignalDeskCommandRequest) => void
  readonly onCommandEnd?: (result: SignalDeskCommandResult) => void
}

export interface SignalDeskPreparationReport {
  readonly schemaVersion: 1
  readonly workspace: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  /** Browser acquisition is deliberately excluded from this release gate. */
  readonly passed: boolean
  readonly dependenciesReady: boolean
  readonly browserInstallAttempted: boolean
  readonly browserReady: boolean
  readonly warnings: readonly string[]
  readonly commands: readonly SignalDeskCommandResult[]
}

/**
 * Install the pinned fixture dependencies, then best-effort acquire Chromium.
 *
 * A failed dependency install fails preparation. A failed Chromium download is
 * reported as a warning so transient network/cache state cannot masquerade as
 * an SDK or agent-understanding failure; the final E2E command remains the
 * authoritative acceptance check.
 */
export async function prepareSignalDeskWorkspace(
  options: PrepareSignalDeskWorkspaceOptions,
): Promise<SignalDeskPreparationReport> {
  const started = Date.now()
  const workspace = resolve(options.workspace)
  await readSignalDeskWorkspaceMarker(workspace)
  const runner = options.commandRunner ?? runSignalDeskCommand
  const maxOutputChars = boundedInteger(
    options.maxOutputChars,
    DEFAULT_OUTPUT_CHARS,
    4_096,
    1_000_000,
    'maxOutputChars',
  )
  const installTimeoutMs = boundedInteger(
    options.installTimeoutMs,
    DEFAULT_INSTALL_TIMEOUT_MS,
    1_000,
    300_000,
    'installTimeoutMs',
  )
  const browserTimeoutMs = boundedInteger(
    options.browserTimeoutMs,
    DEFAULT_BROWSER_TIMEOUT_MS,
    1_000,
    600_000,
    'browserTimeoutMs',
  )
  const env: NodeJS.ProcessEnv = Object.freeze({
    ...process.env,
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: '120000',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  })
  const hasPackageLock = (await stat(join(workspace, 'package-lock.json')).catch(() => undefined))
    ?.isFile() === true
  const installRequest = commandRequest(
    'install',
    hasPackageLock
      ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    workspace,
    installTimeoutMs,
    maxOutputChars,
    env,
    options.signal,
  )
  const commands: SignalDeskCommandResult[] = []
  const install = await execute(installRequest, runner, options)
  commands.push(install)
  const dependenciesReady = commandPassed(install)

  let browserInstallAttempted = false
  let browserReady = false
  const warnings: string[] = []
  if (dependenciesReady && options.signal?.aborted !== true) {
    browserInstallAttempted = true
    const browserRequest = commandRequest(
      'browser-install',
      ['exec', '--', 'playwright', 'install', 'chromium'],
      workspace,
      browserTimeoutMs,
      maxOutputChars,
      env,
      options.signal,
    )
    const browser = await execute(browserRequest, runner, options)
    commands.push(browser)
    browserReady = commandPassed(browser)
    if (!browserReady) {
      warnings.push(
        `Chromium preparation did not complete (exit=${browser.exitCode ?? 'spawn-error'}); final E2E verification will decide acceptance.`,
      )
    }
  } else if (!dependenciesReady) {
    warnings.push('Chromium preparation was skipped because dependency installation failed.')
  } else {
    warnings.push('Chromium preparation was skipped because the run was aborted.')
  }

  const finished = Date.now()
  return Object.freeze({
    schemaVersion: 1,
    workspace,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    passed: dependenciesReady,
    dependenciesReady,
    browserInstallAttempted,
    browserReady,
    warnings: Object.freeze(warnings),
    commands: Object.freeze(commands.map(command => Object.freeze({ ...command }))),
  })
}

export function formatSignalDeskPreparationSummary(
  report: SignalDeskPreparationReport,
): string {
  return [
    `Signal Desk preparation: ${report.passed ? 'READY' : 'FAILED'}`,
    `Dependencies: ${report.dependenciesReady ? 'ready' : 'failed'}`,
    `Chromium: ${report.browserReady ? 'ready' : report.browserInstallAttempted ? 'warning' : 'skipped'}`,
    ...report.warnings.map(warning => `Warning: ${warning}`),
  ].join('\n')
}

async function execute(
  request: SignalDeskCommandRequest,
  runner: SignalDeskCommandRunner,
  options: Pick<
    PrepareSignalDeskWorkspaceOptions,
    'onCommandStart' | 'onCommandEnd'
  >,
): Promise<SignalDeskCommandResult> {
  options.onCommandStart?.(request)
  let result: SignalDeskCommandResult
  try {
    result = await runner(request)
  } catch (error) {
    result = failedSignalDeskCommandResult(request, error)
  }
  options.onCommandEnd?.(result)
  return result
}

function commandRequest(
  name: SignalDeskCommandRequest['name'],
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): SignalDeskCommandRequest {
  return Object.freeze({
    name,
    command: 'npm',
    args: Object.freeze([...args]),
    cwd,
    timeoutMs,
    maxOutputChars,
    env,
    ...(signal === undefined ? {} : { signal }),
  })
}

function commandPassed(result: SignalDeskCommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.aborted
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return selected
}
