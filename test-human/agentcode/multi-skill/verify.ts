/** Host-owned acceptance checks for the Signal Desk multi-skill task. */

import { lstat, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readSignalDeskWorkspaceMarker, type SignalDeskBaseline } from './seed.ts'
import {
  DEFAULT_COMMAND_TIMEOUT_MS, DEFAULT_OUTPUT_CHARS, emptyChanges,
  type SignalDeskCommandName, type SignalDeskCommandRequest, type SignalDeskCommandResult,
  type SignalDeskVerificationCheck, type SignalDeskVerificationReport,
  type VerifySignalDeskWorkspaceOptions,
} from './verify/contracts.ts'
import { compareWorkspaceToBaseline } from './verify/filesystem.ts'
import { boundedInteger, commandDetail, failedSignalDeskCommandResult, runSignalDeskCommand } from './verify/command.ts'
import { allocateLoopbackPort, createHostE2eProbe } from './verify/probe.ts'
import { runStaticVerificationChecks } from './verify/static-checks.ts'
import { formatSignalDeskVerificationSummary } from './verify/summary.ts'

export type {
  SignalDeskCommandName, SignalDeskCommandRequest, SignalDeskCommandResult, SignalDeskCommandRunner, SignalDeskFileChanges,
  SignalDeskVerificationCheck, SignalDeskVerificationReport, VerifySignalDeskWorkspaceOptions,
} from './verify/contracts.ts'
export { failedSignalDeskCommandResult, formatSignalDeskVerificationSummary, runSignalDeskCommand }

export async function verifySignalDeskWorkspace(options: VerifySignalDeskWorkspaceOptions): Promise<SignalDeskVerificationReport> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const workspace = resolve(options.workspace)
  const checks: SignalDeskVerificationCheck[] = []
  const commands: SignalDeskCommandResult[] = []
  const check = (id: string, name: string, passed: boolean, detail?: string, required = true): void => {
    checks.push(Object.freeze({ id, name, passed, required, ...(detail === undefined ? {} : { detail }) }))
  }
  const workspaceInfo = await lstat(workspace).catch(() => undefined)
  check('workspace-directory', 'workspace is a plain directory', workspaceInfo?.isDirectory() === true && !workspaceInfo.isSymbolicLink(), workspace)
  let markerBaseline: SignalDeskBaseline | undefined
  let markerError: string | undefined
  try { markerBaseline = (await readSignalDeskWorkspaceMarker(workspace)).baseline } catch (error) { markerError = errorMessage(error) }
  check('workspace-owned', 'workspace carries a valid Signal Desk ownership marker', markerBaseline !== undefined, markerError)
  const baseline = options.baseline ?? markerBaseline
  check('baseline-available', 'fixture baseline is available for change attribution', baseline !== undefined, baseline?.digest)
  if (baseline !== undefined && markerBaseline !== undefined) {
    check('baseline-authentic', 'host baseline matches the seeded ownership marker', baseline.digest === markerBaseline.digest, `host=${baseline.digest}; marker=${markerBaseline.digest}`)
  }
  const workspaceAuthenticated = baseline !== undefined && markerBaseline !== undefined && baseline.digest === markerBaseline.digest
  const changes = baseline === undefined ? emptyChanges() : await compareWorkspaceToBaseline(workspace, baseline).catch(error => {
    check('workspace-scan', 'workspace can be scanned safely', false, errorMessage(error)); return emptyChanges()
  })
  if (!checks.some(item => item.id === 'workspace-scan')) check('workspace-scan', 'workspace can be scanned safely', true)
  await runStaticVerificationChecks(workspace, baseline, changes, check)

  const timeoutMs = boundedInteger(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 1_000, 300_000, 'commandTimeoutMs')
  const maxOutputChars = boundedInteger(options.maxOutputChars, DEFAULT_OUTPUT_CHARS, 4_096, 1_000_000, 'maxOutputChars')
  const runner = options.commandRunner ?? runSignalDeskCommand
  const commandEnv: NodeJS.ProcessEnv = Object.freeze({ ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' })
  const installMode = options.installDependencies ?? 'if-missing'
  const hasNodeModules = (await stat(join(workspace, 'node_modules')).catch(() => undefined))?.isDirectory() === true
  const hasPackageLock = (await stat(join(workspace, 'package-lock.json')).catch(() => undefined))?.isFile() === true
  const installArgs = hasPackageLock ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['install', '--ignore-scripts', '--no-audit', '--no-fund']
  const shouldInstall = (hasPackageLock && options.reinstallLockedDependencies !== false) || installMode === true || (installMode === 'if-missing' && !hasNodeModules)
  let hostProbe: Awaited<ReturnType<typeof createHostE2eProbe>> | undefined
  let hostProbeError: string | undefined
  if (workspaceAuthenticated) {
    try {
      const port = options.hostProbePort === undefined ? await allocateLoopbackPort() : boundedInteger(options.hostProbePort, options.hostProbePort, 1_024, 65_535, 'hostProbePort')
      hostProbe = await createHostE2eProbe(workspace, port)
    } catch (error) { hostProbeError = errorMessage(error) }
  } else hostProbeError = 'workspace ownership/baseline authentication failed'
  check('host-e2e-probe-ready', 'host-owned behavioral E2E probe was staged safely', hostProbe !== undefined, hostProbeError)
  const plans: readonly { readonly name: SignalDeskCommandName; readonly args: readonly string[] }[] = workspaceAuthenticated ? [
    ...(shouldInstall ? [{ name: 'install' as const, args: installArgs }] : []),
    { name: 'regression', args: ['exec', '--', 'vitest', 'run', 'src/domain/history.spec.ts', 'src/store/persistence.spec.ts'] },
    { name: 'unit', args: ['test'] }, { name: 'build', args: ['run', 'build'] }, { name: 'e2e', args: ['run', 'e2e'] },
    ...(hostProbe === undefined ? [] : [{ name: 'host-e2e' as const, args: hostProbe.commandArgs }]),
  ] : []
  try {
    for (const plan of plans) {
      const request: SignalDeskCommandRequest = Object.freeze({ name: plan.name, command: 'npm', args: Object.freeze([...plan.args]), cwd: workspace, timeoutMs, maxOutputChars, env: commandEnv, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      options.onCommandStart?.(request)
      let result: SignalDeskCommandResult
      try { result = await runner(request) } catch (error) { result = failedSignalDeskCommandResult(request, error) }
      commands.push(result); options.onCommandEnd?.(result)
      check(`command-${plan.name}`, `${formatNpmArguments(plan.args)} exits successfully`, result.exitCode === 0 && !result.timedOut && !result.aborted, commandDetail(result))
    }
  } finally {
    if (hostProbe !== undefined) {
      try { await hostProbe.cleanup(); check('host-e2e-probe-cleanup', 'host-owned E2E probe files were removed', true) }
      catch (error) { check('host-e2e-probe-cleanup', 'host-owned E2E probe files were removed', false, errorMessage(error)) }
    }
  }
  const finished = Date.now()
  const frozenChecks = Object.freeze(checks.map(item => Object.freeze({ ...item })))
  return Object.freeze({
    schemaVersion: 1, workspace, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: Math.max(0, finished - started),
    ...(baseline === undefined ? {} : { baselineDigest: baseline.digest }), passed: frozenChecks.every(item => !item.required || item.passed), checks: frozenChecks,
    changes: Object.freeze({ modified: Object.freeze([...changes.modified]), added: Object.freeze([...changes.added]), deleted: Object.freeze([...changes.deleted]) }),
    commands: Object.freeze(commands.map(item => Object.freeze({ ...item }))),
  })
}

function formatNpmArguments(args: readonly string[]): string { return ['npm', ...args].join(' ') }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
