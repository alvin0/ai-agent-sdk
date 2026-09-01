/** Host-owned acceptance checks for the Signal Desk multi-skill task. */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, opendir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  readSignalDeskWorkspaceMarker,
  SIGNAL_DESK_WORKSPACE_MARKER,
  type SignalDeskBaseline,
} from './seed.ts'

const GENERATED_DIRECTORIES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])
const MAX_SCANNED_FILES = 4_096
const MAX_STATIC_TEXT_BYTES = 2 * 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_CHARS = 64_000
const PROTECTED_BASELINE_FILES = Object.freeze([
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'src/domain/history.spec.ts',
  'src/store/persistence.spec.ts',
])

export type SignalDeskCommandName =
  | 'install'
  | 'browser-install'
  | 'regression'
  | 'unit'
  | 'build'
  | 'e2e'
  | 'host-e2e'

export interface SignalDeskVerificationCheck {
  readonly id: string
  readonly name: string
  readonly passed: boolean
  readonly required: boolean
  readonly detail?: string
}

export interface SignalDeskFileChanges {
  readonly modified: readonly string[]
  readonly added: readonly string[]
  readonly deleted: readonly string[]
}

export interface SignalDeskCommandRequest {
  readonly name: SignalDeskCommandName
  readonly command: 'npm'
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputChars: number
  readonly env: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
}

export interface SignalDeskCommandResult {
  readonly name: SignalDeskCommandName
  readonly command: 'npm'
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export type SignalDeskCommandRunner = (
  request: SignalDeskCommandRequest,
) => Promise<SignalDeskCommandResult>

export interface VerifySignalDeskWorkspaceOptions {
  readonly workspace: string
  /** Prefer the in-memory value returned by `seedSignalDeskWorkspace`. */
  readonly baseline?: SignalDeskBaseline
  readonly commandRunner?: SignalDeskCommandRunner
  /** `if-missing` is the default; `true` always runs npm install. */
  readonly installDependencies?: boolean | 'if-missing'
  /** Defaults true: restore lock-pinned binaries after the agent has edited the workspace. */
  readonly reinstallLockedDependencies?: boolean
  readonly commandTimeoutMs?: number
  readonly maxOutputChars?: number
  /** Deterministic injection for offline unit tests; production allocates a loopback port. */
  readonly hostProbePort?: number
  readonly signal?: AbortSignal
  readonly onCommandStart?: (request: SignalDeskCommandRequest) => void
  readonly onCommandEnd?: (result: SignalDeskCommandResult) => void
}

export interface SignalDeskVerificationReport {
  readonly schemaVersion: 1
  readonly workspace: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly baselineDigest?: string
  readonly passed: boolean
  readonly checks: readonly SignalDeskVerificationCheck[]
  readonly changes: SignalDeskFileChanges
  readonly commands: readonly SignalDeskCommandResult[]
}

interface HostE2eProbe {
  readonly commandArgs: readonly string[]
  cleanup(): Promise<void>
}

export async function verifySignalDeskWorkspace(
  options: VerifySignalDeskWorkspaceOptions,
): Promise<SignalDeskVerificationReport> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const workspace = resolve(options.workspace)
  const checks: SignalDeskVerificationCheck[] = []
  const commands: SignalDeskCommandResult[] = []
  const check = (
    id: string,
    name: string,
    passed: boolean,
    detail?: string,
    required = true,
  ): void => {
    checks.push(Object.freeze({
      id,
      name,
      passed,
      required,
      ...(detail === undefined ? {} : { detail }),
    }))
  }

  const workspaceInfo = await lstat(workspace).catch(() => undefined)
  check(
    'workspace-directory',
    'workspace is a plain directory',
    workspaceInfo?.isDirectory() === true && !workspaceInfo.isSymbolicLink(),
    workspace,
  )

  let markerBaseline: SignalDeskBaseline | undefined
  let markerError: string | undefined
  try {
    markerBaseline = (await readSignalDeskWorkspaceMarker(workspace)).baseline
  } catch (error) {
    markerError = errorMessage(error)
  }
  check(
    'workspace-owned',
    'workspace carries a valid Signal Desk ownership marker',
    markerBaseline !== undefined,
    markerError,
  )

  const baseline = options.baseline ?? markerBaseline
  check(
    'baseline-available',
    'fixture baseline is available for change attribution',
    baseline !== undefined,
    baseline?.digest,
  )
  if (baseline !== undefined && markerBaseline !== undefined) {
    check(
      'baseline-authentic',
      'host baseline matches the seeded ownership marker',
      baseline.digest === markerBaseline.digest,
      `host=${baseline.digest}; marker=${markerBaseline.digest}`,
    )
  }
  const workspaceAuthenticated = baseline !== undefined
    && markerBaseline !== undefined
    && baseline.digest === markerBaseline.digest

  const changes = baseline === undefined
    ? emptyChanges()
    : await compareWorkspaceToBaseline(workspace, baseline).catch(error => {
      check('workspace-scan', 'workspace can be scanned safely', false, errorMessage(error))
      return emptyChanges()
    })
  if (!checks.some(item => item.id === 'workspace-scan')) {
    check('workspace-scan', 'workspace can be scanned safely', true)
  }

  const packageValue = await readJsonObject(join(workspace, 'package.json'))
  const scripts = objectProperty(packageValue, 'scripts')
  const normalizedScripts = Object.fromEntries(Object.entries(scripts ?? {}).map(
    ([name, value]) => [name, typeof value === 'string' ? normalizeCommand(value) : value],
  ))
  const scriptProblems = [
    ...(normalizedScripts.test === 'npm run test:unit' ? [] : ['test']),
    ...(normalizedScripts['test:unit'] === 'vitest run' ? [] : ['test:unit']),
    ...(normalizedScripts.build === 'tsc -b && vite build' ? [] : ['build']),
    ...(normalizedScripts['test:e2e'] === 'playwright test' ? [] : ['test:e2e']),
    ...(
      normalizedScripts.e2e === 'playwright test'
      || normalizedScripts.e2e === 'npm run test:e2e'
        ? []
        : ['e2e']
    ),
  ]
  check(
    'package-scripts',
    'release scripts retain the real Vitest, TypeScript/Vite, and Playwright gates',
    scriptProblems.length === 0,
    scriptProblems.length === 0 ? undefined : `unsafe-or-missing=${scriptProblems.join(',')}`,
  )
  const dependencies = objectProperty(packageValue, 'dependencies')
  const devDependencies = objectProperty(packageValue, 'devDependencies')
  const dependencyProblems = Object.entries({
    react: '19.2.8',
    'react-dom': '19.2.8',
    zustand: '5.0.15',
  }).filter(([name, version]) => dependencies?.[name] !== version).map(([name]) => name)
  const devDependencyProblems = Object.entries({
    '@playwright/test': '1.62.1',
    typescript: '6.0.2',
    vite: '8.2.2',
    vitest: '4.1.11',
  }).filter(([name, version]) => devDependencies?.[name] !== version).map(([name]) => name)
  check(
    'package-toolchain',
    'the pinned runtime and test toolchain cannot be replaced with no-op packages',
    dependencyProblems.length === 0 && devDependencyProblems.length === 0,
    [...dependencyProblems, ...devDependencyProblems].length === 0
      ? undefined
      : `changed-or-missing=${[...dependencyProblems, ...devDependencyProblems].join(',')}`,
  )

  const coreFiles = [
    'src/App.tsx',
    'src/domain/history.ts',
    'src/store/persistence.ts',
    'src/store/use-signal-desk.ts',
  ]
  const deletedCoreFiles = changes.deleted.filter(path => coreFiles.includes(path))
  check(
    'core-files-preserved',
    'the exercise is solved without deleting its core implementation',
    deletedCoreFiles.length === 0,
    deletedCoreFiles.length === 0 ? undefined : `deleted=${deletedCoreFiles.join(',')}`,
  )

  const baselinePaths = new Set(baseline?.files.map(file => file.path) ?? [])
  const protectedProblems = [
    ...PROTECTED_BASELINE_FILES.filter(path =>
      !baselinePaths.has(path) || changes.modified.includes(path) || changes.deleted.includes(path)),
    ...changes.added.filter(path => /^vitest\.config\.[cm]?[jt]s$/.test(path)),
  ]
  check(
    'seeded-regressions-intact',
    'seeded specs, lockfile, and build/test configs remain byte-for-byte intact',
    protectedProblems.length === 0,
    protectedProblems.length === 0 ? undefined : `changed-or-missing=${protectedProblems.join(',')}`,
  )

  const fixCandidates = [
    'src/domain/history.ts',
    'src/store/persistence.ts',
    'src/store/use-signal-desk.ts',
  ]
  const changedFixes = changes.modified.filter(path => fixCandidates.includes(path))
  check(
    'source-fix',
    'history, persistence, and store integration were all corrected',
    fixCandidates.every(path => changedFixes.includes(path)),
    `changed=${changedFixes.join(',') || 'none'}`,
  )

  const persistenceText = await readBoundedText(join(workspace, 'src', 'store', 'persistence.ts'))
  const persistenceProblems = [
    ...(persistenceText?.includes('signal-desk:events:v2') === true ? [] : ['versioned v2 key']),
    ...(persistenceText !== undefined && /\btry\s*\{/.test(persistenceText)
      && /\bcatch\b/.test(persistenceText)
      ? []
      : ['storage failures are not guarded']),
  ]
  check(
    'persistence-contract',
    'persistence uses the v2 durable-event key and guards storage failures',
    persistenceProblems.length === 0,
    persistenceProblems.length === 0 ? undefined : persistenceProblems.join('; '),
  )

  const appText = await readBoundedText(join(workspace, 'src', 'App.tsx'))
  const appChanged = changes.modified.includes('src/App.tsx')
  const wholeStoreSubscription = appText === undefined
    || /useSignalDesk\s*\(\s*\)/.test(appText)
  const mirroredFilteredState = appText !== undefined
    && (/setFiltered\w*\s*\(/.test(appText) || /useEffect\s*\([\s\S]{0,800}filter\s*\(/i.test(appText))
  const indexKey = appText !== undefined
    && /key\s*=\s*\{\s*(?:index|i)\s*\}/.test(appText)
  const stableSignalKey = appText !== undefined
    && /key\s*=\s*\{\s*signal\.id\s*\}/.test(appText)
  const repeatedSignalScans = (appText?.match(/\b(?:allSignals|signals)\s*\.\s*filter\s*\(/g)
    ?? []).length > 1
  const reactProblems = [
    ...(appChanged ? [] : ['App.tsx unchanged']),
    ...(wholeStoreSubscription ? ['whole-store subscription remains'] : []),
    ...(mirroredFilteredState ? ['filtered data remains mirrored through an effect'] : []),
    ...(indexKey ? ['list index key remains'] : []),
    ...(stableSignalKey ? [] : ['signal identity is not keyed by signal.id']),
    ...(repeatedSignalScans ? ['signals are repeatedly scanned with filter during render'] : []),
  ]
  check(
    'react-refactor',
    'React view removes the seeded subscription and derived-state anti-patterns',
    reactProblems.length === 0,
    reactProblems.length === 0 ? undefined : reactProblems.join('; '),
  )

  const verificationDocument = await readBoundedText(join(workspace, 'docs', 'verification.md'))
  const normalizedDocument = verificationDocument?.toLowerCase() ?? ''
  const documentationProblems = [
    ...(normalizedDocument.includes('root cause') ? [] : ['root cause']),
    ...(normalizedDocument.includes('systematic-debugging') ? [] : ['systematic-debugging']),
    ...(normalizedDocument.includes('vercel-react-best-practices')
      ? []
      : ['vercel-react-best-practices']),
    ...(normalizedDocument.includes('playwright') ? [] : ['playwright']),
    ...(normalizedDocument.includes('npm test') ? [] : ['npm test']),
    ...(normalizedDocument.includes('npm run build') ? [] : ['npm run build']),
    ...(normalizedDocument.includes('npm run e2e') ? [] : ['npm run e2e']),
    ...(hasObservedZeroExitCode(verificationDocument ?? '')
      ? []
      : ['observed exit code']),
  ]
  check(
    'verification-document',
    'verification.md records root causes, skill use, and observed release-gate evidence',
    documentationProblems.length === 0,
    documentationProblems.length === 0
      ? undefined
      : `missing=${documentationProblems.join(',')}`,
  )

  const playwrightConfig = await firstExistingFile(workspace, [
    'playwright.config.ts',
    'playwright.config.mts',
    'playwright.config.js',
    'playwright.config.mjs',
  ])
  const e2eFiles = await findE2eSpecs(workspace)
  check(
    'playwright-artifacts',
    'Playwright configuration and at least one E2E spec were added',
    playwrightConfig !== undefined && e2eFiles.length > 0,
    `config=${playwrightConfig ?? 'none'}; specs=${e2eFiles.join(',') || 'none'}`,
  )

  const playwrightConfigText = playwrightConfig === undefined
    ? undefined
    : await readBoundedText(join(workspace, playwrightConfig))
  const playwrightConfigSource = stripJavaScriptComments(playwrightConfigText ?? '')
  const configProblems = [
    ...(/\bbaseURL\s*:/.test(playwrightConfigSource) ? [] : ['baseURL']),
    ...(/\bwebServer\s*:/.test(playwrightConfigSource) ? [] : ['webServer']),
    ...(/\bcommand\s*:/.test(playwrightConfigSource) ? [] : ['webServer.command']),
    ...(/\burl\s*:/.test(playwrightConfigSource) ? [] : ['webServer.url']),
  ]
  check(
    'playwright-config',
    'Playwright config owns a baseURL-backed development web server',
    playwrightConfig !== undefined && configProblems.length === 0,
    configProblems.length === 0 ? undefined : `missing=${configProblems.join(',')}`,
  )

  const e2eUnits = (await Promise.all(e2eFiles.map(async path => ({
    path,
    text: await readBoundedText(join(workspace, ...path.split('/'))),
  })))).filter((unit): unit is { readonly path: string; readonly text: string } =>
    unit.text !== undefined)
  const e2eText = e2eUnits.map(unit => unit.text).join('\n')
  const e2eSource = stripJavaScriptComments(e2eText)
  const e2eBehavior = extractReachablePlaywrightBehavior(e2eUnits)
  const e2eBehaviorSource = stripJavaScriptComments(e2eBehavior.source)
  const coverage = {
    testBody: e2eBehavior.testCount > 0,
    navigation: /\bpage\.goto\s*\(/.test(e2eBehaviorSource),
    semanticLocators: /\bpage\.(?:getByRole|getByLabel|getByPlaceholder)\s*\(/.test(e2eBehaviorSource),
    titleInput: /What happened/i.test(e2eBehaviorSource)
      && /\.fill\s*\(/.test(e2eBehaviorSource),
    criticalSeverity: /critical/i.test(e2eBehaviorSource)
      && /\.selectOption\s*\(/.test(e2eBehaviorSource),
    createClick: /Add to desk/i.test(e2eBehaviorSource) && /\.click\s*\(/.test(e2eBehaviorSource),
    filter: /Filter signals/i.test(e2eBehaviorSource) && /\.fill\s*\(/.test(e2eBehaviorSource),
    status: /Status for|investigating/i.test(e2eBehaviorSource)
      && /\.selectOption\s*\(/.test(e2eBehaviorSource),
    reload: /\bpage\.reload\s*\(/.test(e2eBehaviorSource),
    visibleAssertion: /\bexpect\s*\([\s\S]{0,240}\)\s*\.\s*(?:toBeVisible|toHaveText|toContainText)\s*\(/.test(e2eBehaviorSource),
    statusAssertion: /\bexpect\s*\([\s\S]{0,240}\)\s*\.\s*toHaveValue\s*\(\s*['"]investigating['"]/.test(e2eBehaviorSource),
  }
  const missingCoverage = Object.entries(coverage)
    .filter(([, present]) => !present)
    .map(([name]) => name)
  check(
    'e2e-scenario',
    'E2E spec exercises create, filter, status, and persistence after reload',
    missingCoverage.length === 0,
    missingCoverage.length === 0 ? undefined : `missing=${missingCoverage.join(',')}`,
  )
  const forbiddenE2ePatterns = [
    ...(/\bwaitForTimeout\s*\(/.test(e2eSource) ? ['waitForTimeout'] : []),
    ...(/\btest\s*\.\s*(?:skip|fixme|fail|only)\s*\(|\btest\.describe\.(?:skip|only|serial)\s*\(/.test(e2eSource)
      ? ['test.skip']
      : []),
    ...(/\b(?:page\.)?locator\s*\(/.test(e2eSource) ? ['CSS/XPath locator API'] : []),
    ...(/\b(?:page\.)?\$\$?\s*\(/.test(e2eSource) ? ['CSS selector API'] : []),
    ...(/\bif\s*\(\s*(?:false|0)\s*\)/.test(e2eSource) ? ['unreachable test branch'] : []),
  ]
  check(
    'e2e-quality',
    'E2E spec avoids sleeps, disabled/serial tests, and CSS/XPath locators',
    e2eFiles.length > 0 && forbiddenE2ePatterns.length === 0,
    forbiddenE2ePatterns.length === 0
      ? (e2eFiles.length > 0 ? undefined : 'no E2E spec')
      : `forbidden=${forbiddenE2ePatterns.join(',')}`,
  )

  const timeoutMs = boundedInteger(
    options.commandTimeoutMs,
    DEFAULT_COMMAND_TIMEOUT_MS,
    1_000,
    300_000,
    'commandTimeoutMs',
  )
  const maxOutputChars = boundedInteger(
    options.maxOutputChars,
    DEFAULT_OUTPUT_CHARS,
    4_096,
    1_000_000,
    'maxOutputChars',
  )
  const runner = options.commandRunner ?? runSignalDeskCommand
  const commandEnv: NodeJS.ProcessEnv = Object.freeze({
    ...process.env,
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  })
  const installMode = options.installDependencies ?? 'if-missing'
  const hasNodeModules = (await stat(join(workspace, 'node_modules')).catch(() => undefined))
    ?.isDirectory() === true
  const hasPackageLock = (await stat(join(workspace, 'package-lock.json')).catch(() => undefined))
    ?.isFile() === true
  const installArgs = hasPackageLock
    ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['install', '--ignore-scripts', '--no-audit', '--no-fund']
  const shouldInstall = (hasPackageLock && options.reinstallLockedDependencies !== false)
    || installMode === true
    || (installMode === 'if-missing' && !hasNodeModules)
  let hostProbe: HostE2eProbe | undefined
  let hostProbeError: string | undefined
  if (workspaceAuthenticated) {
    try {
      const port = options.hostProbePort === undefined
        ? await allocateLoopbackPort()
        : boundedInteger(options.hostProbePort, options.hostProbePort, 1_024, 65_535, 'hostProbePort')
      hostProbe = await createHostE2eProbe(workspace, port)
    } catch (error) {
      hostProbeError = errorMessage(error)
    }
  } else {
    hostProbeError = 'workspace ownership/baseline authentication failed'
  }
  check(
    'host-e2e-probe-ready',
    'host-owned behavioral E2E probe was staged safely',
    hostProbe !== undefined,
    hostProbeError,
  )

  const plans: readonly { readonly name: SignalDeskCommandName; readonly args: readonly string[] }[] =
    workspaceAuthenticated
      ? [
          ...(shouldInstall
            ? [{ name: 'install' as const, args: installArgs }]
            : []),
          {
            name: 'regression',
            args: [
              'exec', '--', 'vitest', 'run',
              'src/domain/history.spec.ts',
              'src/store/persistence.spec.ts',
            ],
          },
          { name: 'unit', args: ['test'] },
          { name: 'build', args: ['run', 'build'] },
          { name: 'e2e', args: ['run', 'e2e'] },
          ...(hostProbe === undefined
            ? []
            : [{ name: 'host-e2e' as const, args: hostProbe.commandArgs }]),
        ]
      : []

  try {
    for (const plan of plans) {
      const request: SignalDeskCommandRequest = Object.freeze({
        name: plan.name,
        command: 'npm',
        args: Object.freeze([...plan.args]),
        cwd: workspace,
        timeoutMs,
        maxOutputChars,
        env: commandEnv,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      options.onCommandStart?.(request)
      let result: SignalDeskCommandResult
      try {
        result = await runner(request)
      } catch (error) {
        result = failedSignalDeskCommandResult(request, error)
      }
      commands.push(result)
      options.onCommandEnd?.(result)
      check(
        `command-${plan.name}`,
        `${formatNpmArguments(plan.args)} exits successfully`,
        result.exitCode === 0 && !result.timedOut && !result.aborted,
        commandDetail(result),
      )
    }
  } finally {
    if (hostProbe !== undefined) {
      try {
        await hostProbe.cleanup()
        check('host-e2e-probe-cleanup', 'host-owned E2E probe files were removed', true)
      } catch (error) {
        check(
          'host-e2e-probe-cleanup',
          'host-owned E2E probe files were removed',
          false,
          errorMessage(error),
        )
      }
    }
  }

  const finished = Date.now()
  const frozenChecks = Object.freeze(checks.map(item => Object.freeze({ ...item })))
  return Object.freeze({
    schemaVersion: 1,
    workspace,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    ...(baseline === undefined ? {} : { baselineDigest: baseline.digest }),
    passed: frozenChecks.every(item => !item.required || item.passed),
    checks: frozenChecks,
    changes: Object.freeze({
      modified: Object.freeze([...changes.modified]),
      added: Object.freeze([...changes.added]),
      deleted: Object.freeze([...changes.deleted]),
    }),
    commands: Object.freeze(commands.map(item => Object.freeze({ ...item }))),
  })
}

export async function runSignalDeskCommand(
  request: SignalDeskCommandRequest,
): Promise<SignalDeskCommandResult> {
  const started = Date.now()
  const executable = await resolveNpmExecutable()
  const command = executable.kind === 'node' ? process.execPath : executable.path
  const args = executable.kind === 'node'
    ? [executable.path, ...request.args]
    : [...request.args]

  return new Promise(resolvePromise => {
    const stdout = new BoundedCapture(request.maxOutputChars)
    const stderr = new BoundedCapture(request.maxOutputChars)
    let timedOut = false
    let aborted = false
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const child = spawn(command, args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => stdout.append(chunk as string))
    child.stderr.on('data', chunk => stderr.append(chunk as string))

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      request.signal?.removeEventListener('abort', abortListener)
      resolvePromise(Object.freeze({
        name: request.name,
        command: request.command,
        args: Object.freeze([...request.args]),
        exitCode,
        signal,
        timedOut,
        aborted,
        durationMs: Math.max(0, Date.now() - started),
        stdout: stdout.value(),
        stderr: stderr.value(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      }))
    }
    const abortListener = (): void => {
      aborted = true
      terminateProcessTree(child.pid)
    }
    child.once('error', error => {
      stderr.append(errorMessage(error))
      finish(null, null)
    })
    child.once('close', (code, signal) => finish(code, signal))
    timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child.pid)
    }, request.timeoutMs)
    timer.unref()
    if (request.signal?.aborted) abortListener()
    else request.signal?.addEventListener('abort', abortListener, { once: true })
  })
}

export function formatSignalDeskVerificationSummary(
  report: SignalDeskVerificationReport,
): string {
  const passedChecks = report.checks.filter(check => check.passed).length
  const failed = report.checks.filter(check => check.required && !check.passed)
  const lines = [
    `Signal Desk verification: ${report.passed ? 'PASS' : 'FAIL'}`,
    `Checks: ${passedChecks}/${report.checks.length}`,
    `Changes: ${report.changes.modified.length} modified, ${report.changes.added.length} added, ${report.changes.deleted.length} deleted`,
    `Commands: ${report.commands.map(command => `${command.name}=${command.exitCode ?? 'spawn-error'}`).join(', ') || 'none'}`,
  ]
  if (failed.length > 0) {
    lines.push('Failures:')
    for (const item of failed) {
      lines.push(`- ${item.id}: ${item.detail ?? item.name}`)
    }
  }
  return lines.join('\n')
}

async function createHostE2eProbe(
  workspace: string,
  port: number,
): Promise<HostE2eProbe> {
  const token = randomUUID().replaceAll('-', '')
  const specName = `.signal-desk-host-${token}.probe.ts`
  const configName = `.signal-desk-host-${token}.config.ts`
  const specPath = join(workspace, specName)
  const configPath = join(workspace, configName)
  const title = `Host probe critical ${token.slice(0, 8)}`
  const origin = `http://127.0.0.1:${port}`
  const spec = [
    "import { expect, test } from '@playwright/test'",
    '',
    "test('host-owned Signal Desk behavior', async ({ page }) => {",
    "  await page.goto('/')",
    "  await page.evaluate(() => localStorage.setItem('signal-desk:events:v2', '{corrupt'))",
    '  await page.reload()',
    "  await expect(page.getByRole('heading', { name: 'Signal Desk' })).toBeVisible()",
    "  await expect.poll(() => page.evaluate(() => localStorage.getItem('signal-desk:events:v2'))).toBeNull()",
    '  await page.evaluate(() => localStorage.clear())',
    '  await page.reload()',
    `  const title = ${JSON.stringify(title)}`,
    "  await page.getByLabel('What happened?').fill(title)",
    "  await page.getByLabel('Severity', { exact: true }).selectOption('critical')",
    "  await page.getByRole('button', { name: 'Add to desk' }).click()",
    '  await expect(page.getByRole(\'heading\', { name: title })).toBeVisible()',
    '  const status = page.getByLabel(`Status for ${title}`)',
    "  await status.selectOption('investigating')",
    "  await expect(status).toHaveValue('investigating')",
    "  await page.getByPlaceholder('Filter signals').fill(title)",
    '  await expect(page.getByRole(\'heading\', { name: title })).toBeVisible()',
    '  await page.reload()',
    '  await expect(page.getByRole(\'heading\', { name: title })).toBeVisible()',
    "  await expect(page.getByLabel(`Status for ${title}`)).toHaveValue('investigating')",
    '})',
    '',
  ].join('\n')
  const config = [
    "import { defineConfig } from '@playwright/test'",
    '',
    'export default defineConfig({',
    "  testDir: '.',",
    `  testMatch: ${JSON.stringify(specName)},`,
    '  fullyParallel: false,',
    '  workers: 1,',
    "  reporter: 'line',",
    `  use: { baseURL: ${JSON.stringify(origin)}, trace: 'off', screenshot: 'off', video: 'off' },`,
    '  webServer: {',
    `    command: ${JSON.stringify(`npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`)},`,
    `    url: ${JSON.stringify(origin)},`,
    '    reuseExistingServer: false,',
    '    timeout: 120_000,',
    '  },',
    '})',
    '',
  ].join('\n')

  try {
    await writeFile(specPath, spec, { encoding: 'utf8', flag: 'wx' })
    await writeFile(configPath, config, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await Promise.all([
      rm(specPath, { force: true }),
      rm(configPath, { force: true }),
    ])
    throw error
  }

  return Object.freeze({
    commandArgs: Object.freeze([
      'exec', '--', 'playwright', 'test', specName, '--config', configName,
    ]),
    cleanup: async () => {
      await Promise.all([
        rm(specPath, { force: true }),
        rm(configPath, { force: true }),
      ])
    },
  })
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a loopback port for the host E2E probe'))
        return
      }
      server.close(error => {
        if (error !== undefined) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}

async function compareWorkspaceToBaseline(
  workspace: string,
  baseline: SignalDeskBaseline,
): Promise<SignalDeskFileChanges> {
  const baselineByPath = new Map(baseline.files.map(file => [file.path, file]))
  const currentPaths = await scanRelevantFiles(workspace)
  const currentSet = new Set(currentPaths)
  const modified: string[] = []
  const deleted: string[] = []
  const added: string[] = []

  for (const baselineFile of baseline.files) {
    if (!currentSet.has(baselineFile.path)) {
      deleted.push(baselineFile.path)
      continue
    }
    const currentHash = await hashFile(join(workspace, ...baselineFile.path.split('/')))
    if (currentHash !== baselineFile.sha256) modified.push(baselineFile.path)
  }
  for (const path of currentPaths) {
    if (!baselineByPath.has(path)) added.push(path)
  }
  modified.sort(ordinal)
  added.sort(ordinal)
  deleted.sort(ordinal)
  return Object.freeze({
    modified: Object.freeze(modified),
    added: Object.freeze(added),
    deleted: Object.freeze(deleted),
  })
}

async function scanRelevantFiles(workspace: string): Promise<readonly string[]> {
  const output: string[] = []
  await walk(workspace, workspace, output)
  output.sort(ordinal)
  return output
}

async function walk(root: string, current: string, output: string[]): Promise<void> {
  const handle = await opendir(current)
  for await (const entry of handle) {
    if (current === root && GENERATED_DIRECTORIES.has(entry.name)) continue
    if (entry.name === SIGNAL_DESK_WORKSPACE_MARKER) continue
    const absolute = join(current, entry.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`workspace contains a link: ${absolute}`)
    if (info.isDirectory()) {
      if (GENERATED_DIRECTORIES.has(entry.name)) continue
      await walk(root, absolute, output)
      continue
    }
    if (!info.isFile()) throw new Error(`workspace contains an unsupported entry: ${absolute}`)
    output.push(relative(root, absolute).split(sep).join('/'))
    if (output.length > MAX_SCANNED_FILES) {
      throw new RangeError(`workspace scan exceeds ${MAX_SCANNED_FILES} files`)
    }
  }
}

async function findE2eSpecs(workspace: string): Promise<readonly string[]> {
  const directory = join(workspace, 'e2e')
  const info = await stat(directory).catch(() => undefined)
  if (!info?.isDirectory()) return []
  const files = await scanRelevantFiles(directory)
  return files
    .filter(path => /(?:\.spec|\.test)\.[cm]?[jt]sx?$/.test(path))
    .map(path => `e2e/${path}`)
    .sort(ordinal)
}

async function firstExistingFile(
  workspace: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const info = await stat(join(workspace, candidate)).catch(() => undefined)
    if (info?.isFile()) return candidate
  }
  return undefined
}

async function readBoundedText(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile() || info.size > MAX_STATIC_TEXT_BYTES) return undefined
  return readFile(path, 'utf8').catch(() => undefined)
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readBoundedText(path)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function objectProperty(
  value: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> | undefined {
  const property = value?.[name]
  return typeof property === 'object' && property !== null && !Array.isArray(property)
    ? property as Record<string, unknown>
    : undefined
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function emptyChanges(): SignalDeskFileChanges {
  return Object.freeze({
    modified: Object.freeze([]),
    added: Object.freeze([]),
    deleted: Object.freeze([]),
  })
}

async function resolveNpmExecutable(): Promise<
  { readonly kind: 'node'; readonly path: string }
  | { readonly kind: 'direct'; readonly path: string }
> {
  const npmExecPath = process.env.npm_execpath
  const candidates = [
    ...(npmExecPath === undefined ? [] : [npmExecPath]),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isFile()) return Object.freeze({ kind: 'node', path: candidate })
  }
  return Object.freeze({ kind: 'direct', path: process.platform === 'win32' ? 'npm.cmd' : 'npm' })
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.unref()
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The process already exited between timeout/abort and termination.
    }
  }
}

class BoundedCapture {
  readonly #limit: number
  readonly #headLimit: number
  readonly #tailLimit: number
  #head = ''
  #tail = ''
  #totalChars = 0

  constructor(limit: number) {
    this.#limit = limit
    this.#headLimit = Math.floor(limit / 2)
    this.#tailLimit = limit - this.#headLimit
  }

  get truncated(): boolean {
    return this.#totalChars > this.#limit
  }

  append(chunk: string): void {
    this.#totalChars += chunk.length
    if (this.#head.length < this.#headLimit) {
      const needed = this.#headLimit - this.#head.length
      this.#head += chunk.slice(0, needed)
      chunk = chunk.slice(needed)
    }
    if (chunk.length > 0) {
      this.#tail = (this.#tail + chunk).slice(-this.#tailLimit)
    }
  }

  value(): string {
    if (!this.truncated) return this.#head + this.#tail
    const omitted = Math.max(0, this.#totalChars - this.#head.length - this.#tail.length)
    return `${this.#head}\n... <${omitted} output chars omitted> ...\n${this.#tail}`
  }
}

export function failedSignalDeskCommandResult(
  request: SignalDeskCommandRequest,
  error: unknown,
): SignalDeskCommandResult {
  return Object.freeze({
    name: request.name,
    command: request.command,
    args: Object.freeze([...request.args]),
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: request.signal?.aborted === true,
    durationMs: 0,
    stdout: '',
    stderr: errorMessage(error),
    stdoutTruncated: false,
    stderrTruncated: false,
  })
}

function commandDetail(result: SignalDeskCommandResult): string {
  const tail = (result.stderr.trim() || result.stdout.trim()).slice(-1_000)
  return [
    `exit=${result.exitCode ?? 'spawn-error'}`,
    `durationMs=${result.durationMs}`,
    ...(result.timedOut ? ['timedOut=true'] : []),
    ...(result.aborted ? ['aborted=true'] : []),
    ...(tail.length === 0 ? [] : [`output=${tail}`]),
  ].join('; ')
}

function formatNpmArguments(args: readonly string[]): string {
  return ['npm', ...args].join(' ')
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function stripJavaScriptComments(value: string): string {
  type Mode = 'code' | 'single' | 'double' | 'template' | 'line' | 'block'
  let mode: Mode = 'code'
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index] ?? ''
    const next = value[index + 1] ?? ''
    if (mode === 'line') {
      if (current === '\n') {
        mode = 'code'
        output += '\n'
      }
      continue
    }
    if (mode === 'block') {
      if (current === '*' && next === '/') {
        mode = 'code'
        output += ' '
        index += 1
      } else if (current === '\n') {
        output += '\n'
      }
      continue
    }
    if (mode === 'code') {
      if (current === '/' && next === '/') {
        mode = 'line'
        index += 1
        continue
      }
      if (current === '/' && next === '*') {
        mode = 'block'
        index += 1
        continue
      }
      if (current === "'") mode = 'single'
      else if (current === '"') mode = 'double'
      else if (current === '`') mode = 'template'
      output += current
      continue
    }
    output += current
    if (current === '\\') {
      output += next
      index += 1
      continue
    }
    if ((mode === 'single' && current === "'")
      || (mode === 'double' && current === '"')
      || (mode === 'template' && current === '`')) mode = 'code'
  }
  return output
}

function extractReachablePlaywrightBehavior(
  units: readonly { readonly path: string; readonly text: string }[],
): { readonly testCount: number; readonly source: string } {
  const sources = units.map(unit => stripJavaScriptComments(unit.text))
  const bodies = sources.flatMap(extractInlineTestBodies)
  const beforeEachBodies = sources.flatMap(source => extractInlineCallbackBodies(
    source,
    /\btest\s*\.\s*beforeEach\s*\(/g,
  ))
  return Object.freeze({
    testCount: bodies.length,
    source: [...beforeEachBodies, ...bodies].join('\n'),
  })
}

function extractInlineTestBodies(source: string): readonly string[] {
  return extractInlineCallbackBodies(source, /\btest\s*\(/g)
}

function extractInlineCallbackBodies(source: string, pattern: RegExp): readonly string[] {
  const output: string[] = []
  while (pattern.exec(source) !== null) {
    const arrow = findOutsideStrings(source, '=>', pattern.lastIndex)
    if (arrow < 0) break
    let bodyStart = arrow + 2
    while (/\s/.test(source[bodyStart] ?? '')) bodyStart += 1
    if (source[bodyStart] !== '{') {
      pattern.lastIndex = bodyStart
      continue
    }
    const bodyEnd = findBalancedBrace(source, bodyStart)
    if (bodyEnd < 0) break
    output.push(source.slice(bodyStart + 1, bodyEnd))
    pattern.lastIndex = bodyEnd + 1
  }
  return output
}

function hasObservedZeroExitCode(value: string): boolean {
  if (/exit\s*(?:code)?\s*[:=]?\s*0/i.test(value)) return true

  const lines = value.split(/\r?\n/)
  for (let index = 0; index < lines.length - 2; index += 1) {
    const header = markdownTableCells(lines[index] ?? '')
    const delimiter = markdownTableCells(lines[index + 1] ?? '')
    if (header.length === 0 || delimiter.length !== header.length
      || !delimiter.every(cell => /^:?-{3,}:?$/.test(cell))) continue

    const exitCodeColumn = header.findIndex(cell =>
      /\bexit\s*code\b/i.test(stripMarkdownDecoration(cell)))
    if (exitCodeColumn < 0) continue

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const row = markdownTableCells(lines[rowIndex] ?? '')
      if (row.length !== header.length) break
      if (stripMarkdownDecoration(row[exitCodeColumn] ?? '') === '0') return true
    }
  }
  return false
}

function markdownTableCells(line: string): readonly string[] {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return []
  const withoutEdges = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  return withoutEdges.split('|').map(cell => cell.trim())
}

function stripMarkdownDecoration(value: string): string {
  return value.replace(/[*_`]/g, '').trim()
}

function findOutsideStrings(source: string, needle: string, start: number): number {
  let quote: "'" | '"' | '`' | undefined
  for (let index = start; index <= source.length - needle.length; index += 1) {
    const current = source[index]
    if (quote !== undefined) {
      if (current === '\\') index += 1
      else if (current === quote) quote = undefined
      continue
    }
    if (current === "'" || current === '"' || current === '`') {
      quote = current
      continue
    }
    if (source.startsWith(needle, index)) return index
  }
  return -1
}

function findBalancedBrace(source: string, start: number): number {
  let depth = 0
  let quote: "'" | '"' | '`' | undefined
  for (let index = start; index < source.length; index += 1) {
    const current = source[index]
    if (quote !== undefined) {
      if (current === '\\') index += 1
      else if (current === quote) quote = undefined
      continue
    }
    if (current === "'" || current === '"' || current === '`') {
      quote = current
      continue
    }
    if (current === '{') depth += 1
    else if (current === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
