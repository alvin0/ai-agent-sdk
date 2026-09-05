import type { SignalDeskBaseline } from '../seed.ts'

export const GENERATED_DIRECTORIES = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])
export const MAX_SCANNED_FILES = 4_096
export const MAX_STATIC_TEXT_BYTES = 2 * 1024 * 1024
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const DEFAULT_OUTPUT_CHARS = 64_000
export const PROTECTED_BASELINE_FILES = Object.freeze([
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
  readonly baseline?: SignalDeskBaseline
  readonly commandRunner?: SignalDeskCommandRunner
  readonly installDependencies?: boolean | 'if-missing'
  readonly reinstallLockedDependencies?: boolean
  readonly commandTimeoutMs?: number
  readonly maxOutputChars?: number
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

export interface HostE2eProbe {
  readonly commandArgs: readonly string[]
  cleanup(): Promise<void>
}

export function emptyChanges(): SignalDeskFileChanges {
  return Object.freeze({
    modified: Object.freeze([]),
    added: Object.freeze([]),
    deleted: Object.freeze([]),
  })
}
