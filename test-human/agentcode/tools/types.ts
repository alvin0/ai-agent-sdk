import type { ChildProcess } from 'node:child_process'
import type {
  AgentCodeCommandProcessCleanup,
  AgentCodeProcessCleanupResult,
} from '../process-cleanup.ts'

export const MAX_READ_CHARS = 20_000
export const MAX_GREP_CHARS = 12_000
export const MAX_COMMAND_OUTPUT_CHARS = 20_000
export const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024
export const POST_EXIT_CLEANUP_TIMEOUT_MS = 5_000
export const CLEANUP_CANCEL_TIMEOUT_MS = 1_000
export const DEFAULT_MAX_ENTRIES = 500
export const DEFAULT_MAX_DIRECTORIES = 2_000
export const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules',
])
export const SEARCH_EXCLUDES = [
  '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!coverage/**',
  '!.next/**', '!.turbo/**', '!package-lock.json', '!pnpm-lock.yaml',
  '!yarn.lock', '!bun.lock', '!bun.lockb', '!*.min.*',
]

export interface AgentCodeToolRegistryOptions {
  readonly commandProcessCleanup?: AgentCodeCommandProcessCleanup | false
  readonly maxWriteBytes?: number
  readonly canWrite?: (relativePath: string, operation: 'write' | 'replace') => boolean
  readonly resolveCommand?: (
    request: AgentCodeCommandRequest,
  ) => AgentCodeResolvedCommand | Promise<AgentCodeResolvedCommand>
}

export interface AgentCodeCommandRequest {
  readonly command: 'npm'
  readonly args: readonly string[]
  readonly cwd: string
  readonly workspaceRoot: string
  readonly timeoutMs: number
}

export interface AgentCodeResolvedCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export type TraversalTruncatedReason = 'max-entries' | 'max-directories'
export interface TraversalResult {
  readonly truncated: boolean
  readonly visitedDirectories: number
  readonly truncatedReason?: TraversalTruncatedReason
}
export interface PendingDirectory {
  readonly physicalPath: string
  readonly displayPath: string
}

export interface StreamedLineRange {
  readonly text: string
  readonly endLine: number
  readonly totalLines: number
  readonly truncated: boolean
  readonly nextStartLine?: number
  readonly nextStartColumn?: number
}

export interface ProcessResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly outputTruncated: boolean
  readonly omittedOutputChars: number
  readonly stdoutOmittedChars: number
  readonly stderrOmittedChars: number
  readonly processCleanup?: AgentCodeProcessCleanupResult
  readonly terminationWarning?: string
}

export interface SuccessfulExitProcessCleanup {
  readonly cleanup: AgentCodeCommandProcessCleanup
  readonly workspaceRoot: string
  readonly trackDetachedDescendants: boolean
}

export interface PostExitCleanupInput {
  readonly cleanup: AgentCodeCommandProcessCleanup
  readonly invocation?: import('../process-cleanup.ts').AgentCodeCommandProcessCleanupInvocation
  readonly rootPid: number
  readonly workspaceRoot: string
  readonly startedAtMs: number
  readonly setupWarning?: string
}

export type ProcessOutputStream = 'stdout' | 'stderr'
export interface OutputSegment {
  readonly stream: ProcessOutputStream
  text: string
}

export type ChildProcessLike = ChildProcess
