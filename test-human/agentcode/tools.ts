/** Workspace-confined coding tools for the agentcode acceptance test. */

import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { defineTool } from '@ai-agent-sdk/agent'
import { ToolRegistry } from '@ai-agent-sdk/agent'
import {
  ensureAgentCodeWorkspace,
  resolveExistingAgentCodePath,
  resolveWritableAgentCodePath,
} from './workspace.ts'
import {
  createWindowsCommandProcessCleanup,
  forceTerminateWindowsProcessTree,
  type AgentCodeCommandProcessCleanup,
  type AgentCodeCommandProcessCleanupInvocation,
  type AgentCodeProcessCleanupResult,
} from './process-cleanup.ts'

const MAX_READ_CHARS = 20_000
const MAX_GREP_CHARS = 12_000
const MAX_COMMAND_OUTPUT_CHARS = 20_000
const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024
const POST_EXIT_CLEANUP_TIMEOUT_MS = 5_000
const CLEANUP_CANCEL_TIMEOUT_MS = 1_000
const DEFAULT_MAX_ENTRIES = 500
const DEFAULT_MAX_DIRECTORIES = 2_000
const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules',
])
const SEARCH_EXCLUDES = [
  '!node_modules/**', '!.git/**', '!dist/**', '!build/**', '!coverage/**',
  '!.next/**', '!.turbo/**', '!package-lock.json', '!pnpm-lock.yaml',
  '!yarn.lock', '!bun.lock', '!bun.lockb', '!*.min.*',
]

export interface AgentCodeToolRegistryOptions {
  /** Injectable so process discovery remains deterministic in unit tests. */
  readonly commandProcessCleanup?: AgentCodeCommandProcessCleanup | false
  /** Maximum UTF-8 bytes accepted by write/replace operations. Defaults to 1 MiB. */
  readonly maxWriteBytes?: number
  /** Return true only for paths this agent identity owns. Omission permits every workspace path. */
  readonly canWrite?: (relativePath: string, operation: 'write' | 'replace') => boolean
  /** Resolve an approved npm-shaped request to a shell-free executable invocation. */
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
  /** Exact child environment; omission inherits the host environment. */
  readonly env?: Readonly<Record<string, string>>
}

export function createAgentCodeToolRegistry(
  workspaceRoot: string,
  options: AgentCodeToolRegistryOptions = {},
): ToolRegistry {
  const root = resolve(workspaceRoot)
  const tools = new ToolRegistry()
  const maxWriteBytes = boundedInteger(
    options.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES, 1, 64 * 1024 * 1024, 'maxWriteBytes',
  )
  const commandProcessCleanup = options.commandProcessCleanup === false
    ? undefined
    : options.commandProcessCleanup
      ?? (process.platform === 'win32' ? createWindowsCommandProcessCleanup() : undefined)

  tools.register(defineTool({
    name: 'list_files',
    description: 'Recursively list files under a directory in the agentcode workspace. node_modules, .git, dist, and coverage are skipped. File and canonical-directory budgets bound traversal.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory; defaults to .', default: '.' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 2000, default: DEFAULT_MAX_ENTRIES },
        maxDirectories: { type: 'integer', minimum: 1, maximum: 10000, default: DEFAULT_MAX_DIRECTORIES },
      },
      additionalProperties: false,
    },
    parse(raw) {
      const value = record(raw)
      return {
        path: optionalString(value.path, '.') ,
        maxEntries: boundedInteger(value.maxEntries, DEFAULT_MAX_ENTRIES, 1, 2000, 'maxEntries'),
        maxDirectories: boundedInteger(
          value.maxDirectories, DEFAULT_MAX_DIRECTORIES, 1, 10_000, 'maxDirectories',
        ),
      }
    },
    async execute({ path, maxEntries, maxDirectories }, context) {
      const directory = await resolveExistingAgentCodePath(root, path)
      const entries: string[] = []
      const traversal = await walk(
        directory, root, entries, maxEntries, maxDirectories, context.signal,
      )
      return {
        path: portableRelative(root, directory) || '.', entries,
        truncated: traversal.truncated,
        visitedDirectories: traversal.visitedDirectories,
        ...(traversal.truncatedReason === undefined
          ? {} : { truncatedReason: traversal.truncatedReason }),
      }
    },
    timeoutMs: 35_000,
    isConcurrencySafe: () => true,
  }))

  tools.register(defineTool({
    name: 'read_file',
    description: 'Stream a UTF-8 file range in the agentcode workspace. Use line ranges and the returned nextStartLine/nextStartColumn cursor to keep long coding turns token-efficient.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1, default: 1 },
        startColumn: { type: 'integer', minimum: 1, default: 1 },
        endLine: { type: 'integer', minimum: 1, description: 'Inclusive; defaults to at most 1000 lines after startLine.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    parse(raw) {
      const value = record(raw)
      const path = requiredString(value.path, 'path')
      const startLine = boundedInteger(value.startLine, 1, 1, 1_000_000, 'startLine')
      const startColumn = boundedInteger(value.startColumn, 1, 1, 100_000_000, 'startColumn')
      const endLine = boundedInteger(value.endLine, startLine + 999, startLine, startLine + 999, 'endLine')
      return { path, startLine, startColumn, endLine }
    },
    async execute({ path, startLine, startColumn, endLine }, context) {
      const target = await resolveExistingAgentCodePath(root, path)
      const selection = await streamLineRange(
        target, startLine, startColumn, endLine, MAX_READ_CHARS, context.signal,
      )
      return {
        path: portableRelative(root, target), startLine, startColumn,
        endLine: selection.endLine, totalLines: selection.totalLines,
        text: selection.text, truncated: selection.truncated,
        ...(selection.nextStartLine === undefined ? {} : {
          nextStartLine: selection.nextStartLine,
          nextStartColumn: selection.nextStartColumn,
        }),
      }
    },
    timeoutMs: 35_000,
    isConcurrencySafe: () => true,
  }))

  tools.register(defineTool({
    name: 'write_file',
    description: 'Create or overwrite one UTF-8 file in the agentcode workspace. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }, content: { type: 'string' },
        overwrite: { type: 'boolean', default: true },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    parse(raw) {
      const value = record(raw)
      return {
        path: requiredString(value.path, 'path'),
        content: stringValue(value.content, 'content'),
        overwrite: optionalBoolean(value.overwrite, true, 'overwrite'),
      }
    },
    async execute({ path, content, overwrite }) {
      const target = await resolveWritableAgentCodePath(root, path)
      const relativePath = portableRelative(root, target)
      assertWriteAllowed(options, relativePath, 'write')
      const bytes = Buffer.byteLength(content)
      if (bytes > maxWriteBytes) throw new Error(`write_file content exceeds the ${maxWriteBytes}-byte limit`)
      await writeFile(target, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' })
      return { path: relativePath, bytes, overwritten: overwrite }
    },
  }))

  tools.register(defineTool({
    name: 'replace_in_file',
    description: 'Make a deterministic sed-like exact-text replacement in one workspace file. By default oldText must occur exactly once; use replaceAll only intentionally.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' },
        replaceAll: { type: 'boolean', default: false },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    parse(raw) {
      const value = record(raw)
      const oldText = requiredString(value.oldText, 'oldText')
      return {
        path: requiredString(value.path, 'path'), oldText,
        newText: stringValue(value.newText, 'newText'),
        replaceAll: optionalBoolean(value.replaceAll, false, 'replaceAll'),
      }
    },
    async execute({ path, oldText, newText, replaceAll }) {
      const target = await resolveExistingAgentCodePath(root, path)
      const relativePath = portableRelative(root, target)
      assertWriteAllowed(options, relativePath, 'replace')
      const text = await readFile(target, 'utf8')
      const occurrences = countOccurrences(text, oldText)
      if (occurrences === 0) throw new Error(`oldText was not found in ${path}`)
      if (!replaceAll && occurrences !== 1) {
        throw new Error(`oldText occurs ${occurrences} times in ${path}; provide more context or set replaceAll=true`)
      }
      const updated = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText)
      if (Buffer.byteLength(updated) > maxWriteBytes) {
        throw new Error(`replace_in_file result exceeds the ${maxWriteBytes}-byte limit`)
      }
      await writeFile(target, updated, 'utf8')
      return { path: relativePath, replacements: replaceAll ? occurrences : 1 }
    },
  }))

  tools.register(defineTool({
    name: 'grep_files',
    description: 'Search workspace text with ripgrep regex syntax. Results include file, line, and column and are capped to avoid flooding context.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' }, path: { type: 'string', default: '.' },
        glob: { type: 'string', description: 'Optional rg glob such as **/*.tsx.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    parse(raw) {
      const value = record(raw)
      const glob = value.glob === undefined ? undefined : requiredString(value.glob, 'glob')
      return {
        pattern: requiredString(value.pattern, 'pattern'), path: optionalString(value.path, '.'),
        ...(glob === undefined ? {} : { glob }),
        maxResults: boundedInteger(value.maxResults, 50, 1, 200, 'maxResults'),
      }
    },
    async execute({ pattern, path, glob, maxResults }, context) {
      const cwd = await ensureAgentCodeWorkspace(root)
      const target = await resolveExistingAgentCodePath(cwd, path)
      const args = [
        '--line-number', '--column', '--no-heading', '--color', 'never', '--hidden',
        '--max-filesize', '1M',
      ]
      for (const excluded of SEARCH_EXCLUDES) args.push('--glob', excluded)
      if (glob !== undefined) args.push('--glob', glob)
      args.push('--', pattern, relative(cwd, target) || '.')
      const result = await runProcess('rg', args, cwd, 30_000, context.signal, MAX_GREP_CHARS)
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`ripgrep failed (${result.exitCode}): ${result.stderr || result.stdout}`)
      }
      const all = result.stdout.split(/\r?\n/).filter(Boolean).map(portableGrepMatch)
      const matches = takeBoundedLines(all, maxResults, MAX_GREP_CHARS)
      return {
        pattern,
        matches,
        truncated: result.outputTruncated || matches.length < all.length,
        omittedMatches: Math.max(0, all.length - matches.length),
      }
    },
    timeoutMs: 35_000,
    isConcurrencySafe: () => true,
  }))

  tools.register(defineTool({
    name: 'run_command',
    description: 'Run npm with an argv array and no shell, inside a workspace-relative directory. Use for scaffolding, dependency installation, tests, and builds. Shell syntax and arbitrary executables are not accepted. npm package scripts are trusted executable code and are not a filesystem sandbox.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['npm'] },
        args: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        cwd: { type: 'string', default: '.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 120000 },
      },
      required: ['command', 'args'],
      additionalProperties: false,
    },
    parse(raw) {
      const value = record(raw)
      if (value.command !== 'npm') throw new Error('command must be npm')
      if (!Array.isArray(value.args) || value.args.length > 50
        || value.args.some(argument => typeof argument !== 'string')) {
        throw new Error('args must be an array of at most 50 strings')
      }
      return {
        command: 'npm' as const, args: value.args as string[], cwd: optionalString(value.cwd, '.'),
        timeoutMs: boundedInteger(value.timeoutMs, 120_000, 1_000, 120_000, 'timeoutMs'),
      }
    },
    async execute({ command, args, cwd, timeoutMs }, context) {
      const directory = await resolveExistingAgentCodePath(root, cwd)
      const invocation: AgentCodeResolvedCommand = options.resolveCommand === undefined
        ? await npmInvocation(args)
        : validateResolvedCommand(await options.resolveCommand({
            command, args: Object.freeze([...args]), cwd: directory,
            workspaceRoot: root, timeoutMs,
          }))
      const result = await runProcess(
        invocation.executable, invocation.args, directory, timeoutMs, context.signal,
        MAX_COMMAND_OUTPUT_CHARS,
        commandProcessCleanup === undefined ? undefined : {
          cleanup: commandProcessCleanup,
          workspaceRoot: directory,
          trackDetachedDescendants: shouldTrackDetachedNpmDescendants(args),
        },
        invocation.env,
      )
      return { command, args, cwd: portableRelative(root, directory) || '.', ...result }
    },
    // Includes the pre-spawn baseline snapshot and bounded post-exit cleanup.
    timeoutMs: 160_000,
  }))

  return tools
}

function assertWriteAllowed(
  options: AgentCodeToolRegistryOptions,
  relativePath: string,
  operation: 'write' | 'replace',
): void {
  if (options.canWrite !== undefined && !options.canWrite(relativePath, operation)) {
    throw new Error(`${operation} is not permitted for agent-owned path: ${relativePath}`)
  }
}

function portableRelative(root: string, target: string): string {
  return relative(root, target).replaceAll('\\', '/')
}

function portableGrepMatch(line: string): string {
  const match = /^(.*?):(\d+):(\d+):([\s\S]*)$/.exec(line)
  if (match === null) return line
  return `${match[1]?.replaceAll('\\', '/')}:${match[2]}:${match[3]}:${match[4]}`
}

function validateResolvedCommand(value: AgentCodeResolvedCommand): AgentCodeResolvedCommand {
  if (typeof value?.executable !== 'string' || value.executable.length === 0) {
    throw new Error('resolved command executable must be a non-empty string')
  }
  if (!Array.isArray(value.args) || value.args.length > 100
    || value.args.some(argument => typeof argument !== 'string')) {
    throw new Error('resolved command args must contain at most 100 strings')
  }
  const env = value.env === undefined ? undefined : validateCommandEnvironment(value.env)
  return Object.freeze({
    executable: value.executable,
    args: Object.freeze([...value.args]),
    ...(env === undefined ? {} : { env }),
  })
}

function validateCommandEnvironment(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (name.length === 0 || name.includes('=') || typeof entry !== 'string') {
      throw new Error('resolved command env must contain valid string entries')
    }
    env[name] = entry
  }
  return Object.freeze(env)
}

async function npmInvocation(args: readonly string[]): Promise<{
  readonly executable: string
  readonly args: readonly string[]
}> {
  if (process.platform !== 'win32') return { executable: 'npm', args }
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0)
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return { executable: process.execPath, args: [candidate, ...args] }
    } catch {
      // Try the next standard npm CLI location without invoking a command shell.
    }
  }
  throw new Error('could not locate npm-cli.js for shell-free npm execution on Windows')
}

function shouldTrackDetachedNpmDescendants(args: readonly string[]): boolean {
  const normalized = args.map(argument => argument.toLocaleLowerCase('en-US'))
  const first = normalized[0]
  if (first === 'start') return true
  if (first === 'run' || first === 'run-script') {
    const script = normalized[1] ?? ''
    return /(^|[:_-])(dev|serve|start|preview|e2e|playwright|cypress)([:_-]|$)/.test(script)
  }
  if (first === 'exec' || first === 'x') {
    return normalized.some(argument => /(^|[/@])(playwright|cypress|vite)([/@]|$)/.test(argument))
  }
  return false
}

type TraversalTruncatedReason = 'max-entries' | 'max-directories'

interface TraversalResult {
  readonly truncated: boolean
  readonly visitedDirectories: number
  readonly truncatedReason?: TraversalTruncatedReason
}

interface PendingDirectory {
  readonly physicalPath: string
  readonly displayPath: string
}

async function walk(
  directory: string,
  root: string,
  output: string[],
  entryLimit: number,
  directoryLimit: number,
  signal: AbortSignal,
): Promise<TraversalResult> {
  const pending: PendingDirectory[] = [{
    physicalPath: directory,
    displayPath: portableRelative(root, directory),
  }]
  const visited = new Set<string>()
  while (pending.length > 0) {
    throwIfAborted(signal)
    const current = pending.pop()
    if (current === undefined) break
    const canonical = await resolveExistingAgentCodePath(root, relative(root, current.physicalPath) || '.')
    throwIfAborted(signal)
    const key = canonicalPathKey(canonical)
    if (visited.has(key)) continue
    if (visited.size >= directoryLimit) {
      return { truncated: true, visitedDirectories: visited.size, truncatedReason: 'max-directories' }
    }
    visited.add(key)
    const entries = await readdir(canonical, { withFileTypes: true })
    throwIfAborted(signal)
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const childDirectories: PendingDirectory[] = []
    for (const entry of entries) {
      throwIfAborted(signal)
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
      const displayPath = current.displayPath.length === 0
        ? entry.name
        : `${current.displayPath}/${entry.name}`
      const target = resolve(canonical, entry.name)
      if (entry.isDirectory()) {
        childDirectories.push({ physicalPath: target, displayPath })
      } else if (entry.isFile()) {
        if (output.length >= entryLimit) {
          return { truncated: true, visitedDirectories: visited.size, truncatedReason: 'max-entries' }
        }
        output.push(displayPath)
      } else if (entry.isSymbolicLink()) {
        const linked = await safeLinkedEntry(root, target)
        if (linked?.kind === 'directory' && !IGNORED_DIRECTORIES.has(entry.name)) {
          childDirectories.push({ physicalPath: linked.canonical, displayPath })
        } else if (linked?.kind === 'file') {
          if (output.length >= entryLimit) {
            return { truncated: true, visitedDirectories: visited.size, truncatedReason: 'max-entries' }
          }
          output.push(displayPath)
        }
      }
    }
    // Stack in reverse so traversal remains lexically ordered like the recursive implementation.
    for (let index = childDirectories.length - 1; index >= 0; index--) {
      const child = childDirectories[index]
      if (child !== undefined) pending.push(child)
    }
  }
  return { truncated: false, visitedDirectories: visited.size }
}

async function safeLinkedEntry(
  root: string,
  target: string,
): Promise<{ readonly kind: 'directory' | 'file'; readonly canonical: string } | undefined> {
  try {
    const canonical = await resolveExistingAgentCodePath(root, relative(root, target))
    const info = await stat(canonical)
    if (info.isDirectory()) return { kind: 'directory', canonical }
    if (info.isFile()) return { kind: 'file', canonical }
    return undefined
  } catch (error: unknown) {
    if (isPathEscape(error) || isMissingPath(error)) return undefined
    throw error
  }
}

function canonicalPathKey(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

function isPathEscape(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('path escapes agentcode workspace:')
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

interface StreamedLineRange {
  readonly text: string
  readonly endLine: number
  readonly totalLines: number
  readonly truncated: boolean
  readonly nextStartLine?: number
  readonly nextStartColumn?: number
}

async function streamLineRange(
  path: string,
  startLine: number,
  startColumn: number,
  requestedEndLine: number,
  maxChars: number,
  signal: AbortSignal,
): Promise<StreamedLineRange> {
  throwIfAborted(signal)
  const collector = new LineRangeCollector(startLine, startColumn, requestedEndLine, maxChars)
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  let pendingCarriageReturn = false
  for await (const rawChunk of stream) {
    throwIfAborted(signal)
    const chunk = typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8')
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset)
      const endsLine = newline >= 0
      const end = endsLine ? newline : chunk.length
      let segment = chunk.slice(offset, end)
      if (pendingCarriageReturn) {
        if (!(endsLine && segment.length === 0)) collector.append('\r')
        pendingCarriageReturn = false
      }
      if (endsLine && segment.endsWith('\r')) segment = segment.slice(0, -1)
      else if (!endsLine && segment.endsWith('\r')) {
        segment = segment.slice(0, -1)
        pendingCarriageReturn = true
      }
      collector.append(segment)
      if (endsLine) collector.finishLine()
      offset = endsLine ? newline + 1 : chunk.length
    }
  }
  if (pendingCarriageReturn) collector.append('\r')
  collector.finishLine()
  return collector.result()
}

class LineRangeCollector {
  private readonly output: string[] = []
  private readonly requestedStartLine: number
  private readonly requestedStartColumn: number
  private readonly requestedEndLine: number
  private readonly maxChars: number
  private outputChars = 0
  private line = 1
  private column = 1
  private outputLine: number | undefined
  private lastOutputLine: number | undefined
  private nextLine: number | undefined
  private nextColumn: number | undefined

  constructor(startLine: number, startColumn: number, endLine: number, maxChars: number) {
    this.requestedStartLine = startLine
    this.requestedStartColumn = startColumn
    this.requestedEndLine = endLine
    this.maxChars = maxChars
  }

  append(text: string): void {
    const segmentColumn = this.column
    this.column += text.length
    if (text.length === 0 || this.nextLine !== undefined || !this.selectsCurrentLine()) return
    const selectedColumn = this.line === this.requestedStartLine ? this.requestedStartColumn : 1
    const offset = Math.max(0, selectedColumn - segmentColumn)
    if (offset >= text.length) return
    const content = text.slice(offset)
    const contentColumn = segmentColumn + offset
    if (!this.startOutputLine(contentColumn)) return
    const available = this.maxChars - this.outputChars
    const written = content.slice(0, available)
    this.output.push(written)
    this.outputChars += written.length
    if (written.length < content.length) this.setContinuation(this.line, contentColumn + written.length)
  }

  finishLine(): void {
    if (this.nextLine === undefined && this.selectsCurrentLine()) {
      const selectedColumn = this.line === this.requestedStartLine ? this.requestedStartColumn : 1
      if (selectedColumn <= this.column) this.startOutputLine(selectedColumn)
    }
    this.line++
    this.column = 1
    this.outputLine = undefined
  }

  result(): StreamedLineRange {
    const totalLines = this.line - 1
    let nextStartLine = this.nextLine
    let nextStartColumn = this.nextColumn
    if (nextStartLine === undefined && this.requestedEndLine < totalLines) {
      nextStartLine = this.requestedEndLine + 1
      nextStartColumn = 1
    }
    return {
      text: this.output.join(''),
      endLine: this.lastOutputLine ?? Math.min(this.requestedEndLine, totalLines),
      totalLines,
      truncated: nextStartLine !== undefined,
      ...(nextStartLine === undefined ? {} : { nextStartLine, nextStartColumn: nextStartColumn ?? 1 }),
    }
  }

  private selectsCurrentLine(): boolean {
    return this.line >= this.requestedStartLine && this.line <= this.requestedEndLine
  }

  private startOutputLine(column: number): boolean {
    if (this.outputLine === this.line) return true
    const prefix = `${this.lastOutputLine === undefined ? '' : '\n'}${this.line}: `
    if (this.outputChars + prefix.length > this.maxChars) {
      this.setContinuation(this.line, column)
      return false
    }
    this.output.push(prefix)
    this.outputChars += prefix.length
    this.outputLine = this.line
    this.lastOutputLine = this.line
    return true
  }

  private setContinuation(line: number, column: number): void {
    if (this.nextLine !== undefined) return
    this.nextLine = line
    this.nextColumn = column
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

interface ProcessResult {
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

interface SuccessfulExitProcessCleanup {
  readonly cleanup: AgentCodeCommandProcessCleanup
  readonly workspaceRoot: string
  readonly trackDetachedDescendants: boolean
}

async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  maxOutputChars: number,
  successfulExitCleanup?: SuccessfulExitProcessCleanup,
  environment?: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  if (signal.aborted) throw abortReason(signal)
  const startedAtMs = Date.now()
  let cleanupInvocation: AgentCodeCommandProcessCleanupInvocation | undefined
  let cleanupSetupWarning: string | undefined
  const beginInvocation = successfulExitCleanup?.cleanup.beginInvocation
  if (beginInvocation !== undefined && successfulExitCleanup !== undefined) {
    try {
      cleanupInvocation = await beginInvocation.call(successfulExitCleanup.cleanup, {
        workspaceRoot: successfulExitCleanup.workspaceRoot,
        startedAtMs,
        trackDetachedDescendants: successfulExitCleanup.trackDetachedDescendants,
        signal,
      })
    } catch (error: unknown) {
      cleanupSetupWarning = `cleanup setup failed: ${processCleanupErrorMessage(error)}`
    }
  }
  if (signal.aborted) {
    await cancelCleanupInvocation(cleanupInvocation)
    throw abortReason(signal)
  }

  let child: ChildProcess
  try {
    child = spawn(executable, args, {
      cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(environment === undefined ? {} : { env: environment }),
    })
  } catch (error: unknown) {
    await cancelCleanupInvocation(cleanupInvocation)
    throw error
  }
  if (cleanupInvocation !== undefined) {
    if (child.pid === undefined) {
      cleanupSetupWarning = 'cleanup setup failed: spawned process has no PID'
      void cancelCleanupInvocation(cleanupInvocation)
      cleanupInvocation = undefined
    } else {
      try {
        cleanupInvocation.attachRoot(child.pid)
      } catch (error: unknown) {
        cleanupSetupWarning = `cleanup setup failed: ${processCleanupErrorMessage(error)}`
        void cancelCleanupInvocation(cleanupInvocation)
        cleanupInvocation = undefined
      }
    }
  }

  return new Promise((fulfill, reject) => {
    const output = new BoundedProcessOutput(maxOutputChars)
    let timedOut = false
    let termination: Promise<string | undefined> | undefined
    let settled = false
    child.stdout?.on('data', (chunk: Buffer) => { output.append('stdout', chunk.toString('utf8')) })
    child.stderr?.on('data', (chunk: Buffer) => { output.append('stderr', chunk.toString('utf8')) })
    const stop = (): Promise<string | undefined> => {
      if (child.exitCode !== null) return Promise.resolve(undefined)
      termination ??= terminateProcessTree(child)
      return termination
    }
    const abort = (): void => { void stop() }
    signal.addEventListener('abort', abort, { once: true })
    // Abort may have raced with spawn and listener registration.
    if (signal.aborted) void stop()
    const timer = setTimeout(() => {
      if (child.exitCode !== null) return
      timedOut = true
      void stop()
    }, timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    child.once('error', error => {
      if (settled) return
      settled = true
      cleanup()
      void cancelCleanupInvocation(cleanupInvocation)
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      // The command is already closed. Its timeout and abort listener must not
      // remain armed while potentially slow post-exit discovery is running.
      const abortedAtClose = signal.aborted
      cleanup()
      void (async () => {
        let processCleanup: AgentCodeProcessCleanupResult | undefined
        let terminationWarning: string | undefined
        if (termination !== undefined) {
          try {
            terminationWarning = await termination
          } catch (error: unknown) {
            terminationWarning = `forced process termination failed: ${processCleanupErrorMessage(error)}`
          }
          if (cleanupInvocation !== undefined
            && successfulExitCleanup !== undefined
            && child.pid !== undefined) {
            processCleanup = await runPostExitCleanup({
              cleanup: successfulExitCleanup.cleanup,
              invocation: cleanupInvocation,
              rootPid: child.pid,
              workspaceRoot: successfulExitCleanup.workspaceRoot,
              startedAtMs,
              ...(cleanupSetupWarning === undefined ? {} : { setupWarning: cleanupSetupWarning }),
            })
          } else {
            await cancelCleanupInvocation(cleanupInvocation)
          }
        }
        if (termination === undefined && child.pid !== undefined && successfulExitCleanup !== undefined) {
          processCleanup = await runPostExitCleanup({
            cleanup: successfulExitCleanup.cleanup,
            rootPid: child.pid,
            workspaceRoot: successfulExitCleanup.workspaceRoot,
            startedAtMs,
            ...(cleanupInvocation === undefined ? {} : { invocation: cleanupInvocation }),
            ...(cleanupSetupWarning === undefined ? {} : { setupWarning: cleanupSetupWarning }),
          })
        }
        if (settled) return
        settled = true
        if (abortedAtClose) { reject(abortReason(signal)); return }
        fulfill({
          exitCode: code, timedOut, ...output.result(),
          ...(processCleanup === undefined ? {} : { processCleanup }),
          ...(terminationWarning === undefined ? {} : { terminationWarning }),
        })
      })().catch(error => {
        if (settled) return
        settled = true
        reject(error)
      })
    })
  })
}

interface PostExitCleanupInput {
  readonly cleanup: AgentCodeCommandProcessCleanup
  readonly invocation?: AgentCodeCommandProcessCleanupInvocation
  readonly rootPid: number
  readonly workspaceRoot: string
  readonly startedAtMs: number
  readonly setupWarning?: string
}

async function runPostExitCleanup(input: PostExitCleanupInput): Promise<AgentCodeProcessCleanupResult> {
  try {
    const result = await withDeadline(
      input.invocation === undefined
        ? cleanupSignal => input.cleanup.beginInvocation === undefined
          ? input.cleanup.cleanupAfterExit({
            rootPid: input.rootPid,
            workspaceRoot: input.workspaceRoot,
            startedAtMs: input.startedAtMs,
          }, cleanupSignal)
          : Promise.resolve(emptyProcessCleanup('cleanup tracking unavailable'))
        : cleanupSignal => input.invocation?.cleanupAfterExit(cleanupSignal)
          ?? Promise.resolve(emptyProcessCleanup('cleanup tracking unavailable')),
      POST_EXIT_CLEANUP_TIMEOUT_MS,
      'post-exit process cleanup',
    )
    return input.setupWarning === undefined ? result : appendProcessCleanupWarning(result, input.setupWarning)
  } catch (error: unknown) {
    return emptyProcessCleanup(processCleanupErrorMessage(error))
  }
}

async function cancelCleanupInvocation(
  invocation: AgentCodeCommandProcessCleanupInvocation | undefined,
): Promise<void> {
  if (invocation === undefined) return
  try {
    await withDeadline(
      cleanupSignal => invocation.cancel(cleanupSignal),
      CLEANUP_CANCEL_TIMEOUT_MS,
      'process cleanup cancellation',
    )
  } catch {
    // Cancellation is best-effort and must not replace the command outcome.
  }
}

function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise((fulfill, reject) => {
    const controller = new AbortController()
    let settled = false
    const finish = (error: unknown, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) fulfill(value as T)
      else reject(error)
    }
    const timer = setTimeout(() => {
      const error = new Error(`${label} exceeded ${timeoutMs}ms`)
      controller.abort(error)
      finish(error)
    }, timeoutMs)
    Promise.resolve().then(() => operation(controller.signal)).then(
      value => { finish(undefined, value) },
      error => { finish(error) },
    )
  })
}

function emptyProcessCleanup(warning: string): AgentCodeProcessCleanupResult {
  return {
    attempted: true,
    matchedProcesses: 0,
    terminatedProcessTrees: 0,
    warning: warning.slice(0, 2_000),
  }
}

function appendProcessCleanupWarning(
  result: AgentCodeProcessCleanupResult,
  warning: string,
): AgentCodeProcessCleanupResult {
  return {
    ...result,
    warning: [result.warning, warning].filter((item): item is string => item !== undefined)
      .join('; ').slice(0, 2_000),
  }
}

type ProcessOutputStream = 'stdout' | 'stderr'

interface OutputSegment {
  readonly stream: ProcessOutputStream
  text: string
}

/** One shared process-output budget retaining the beginning and most recent tail. */
class BoundedProcessOutput {
  private readonly headLimit: number
  private readonly tailLimit: number
  private readonly head: OutputSegment[] = []
  private readonly tail: OutputSegment[] = []
  private headChars = 0
  private tailChars = 0
  private stdoutChars = 0
  private stderrChars = 0

  constructor(maxChars: number) {
    this.headLimit = Math.ceil(maxChars * 0.6)
    this.tailLimit = maxChars - this.headLimit
  }

  append(stream: ProcessOutputStream, text: string): void {
    if (text.length === 0) return
    if (stream === 'stdout') this.stdoutChars += text.length
    else this.stderrChars += text.length
    const headRemaining = this.headLimit - this.headChars
    if (headRemaining > 0) {
      const prefix = text.slice(0, headRemaining)
      this.head.push({ stream, text: prefix })
      this.headChars += prefix.length
      text = text.slice(prefix.length)
    }
    if (text.length === 0 || this.tailLimit === 0) return
    this.tail.push({ stream, text })
    this.tailChars += text.length
    this.trimTail()
  }

  result(): Omit<ProcessResult, 'exitCode' | 'timedOut'> {
    const retained = [...this.head, ...this.tail]
    const stdout = retained.filter(segment => segment.stream === 'stdout')
      .map(segment => segment.text).join('')
    const stderr = retained.filter(segment => segment.stream === 'stderr')
      .map(segment => segment.text).join('')
    const stdoutOmittedChars = Math.max(0, this.stdoutChars - stdout.length)
    const stderrOmittedChars = Math.max(0, this.stderrChars - stderr.length)
    const omittedOutputChars = stdoutOmittedChars + stderrOmittedChars
    return {
      stdout, stderr,
      outputTruncated: omittedOutputChars > 0,
      omittedOutputChars, stdoutOmittedChars, stderrOmittedChars,
    }
  }

  private trimTail(): void {
    let excess = this.tailChars - this.tailLimit
    while (excess > 0) {
      const first = this.tail[0]
      if (first === undefined) break
      if (first.text.length <= excess) {
        excess -= first.text.length
        this.tailChars -= first.text.length
        this.tail.shift()
      } else {
        first.text = first.text.slice(excess)
        this.tailChars -= excess
        excess = 0
      }
    }
  }
}

async function terminateProcessTree(child: ChildProcess): Promise<string | undefined> {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    return forceTerminateWindowsProcessTree(pid, () => {
      if (child.exitCode === null) child.kill('SIGKILL')
    })
  }

  const warnings: string[] = []
  try { signalProcessGroup(pid, 'SIGTERM') }
  catch (error: unknown) { warnings.push(`SIGTERM failed: ${processCleanupErrorMessage(error)}`) }
  await delay(250)
  // Always address the group again: the leader may exit while descendants remain.
  try { signalProcessGroup(pid, 'SIGKILL') }
  catch (error: unknown) { warnings.push(`SIGKILL group failed: ${processCleanupErrorMessage(error)}`) }
  try {
    if (child.exitCode === null) child.kill('SIGKILL')
  } catch (error: unknown) {
    warnings.push(`SIGKILL root fallback failed: ${processCleanupErrorMessage(error)}`)
  }
  return warnings.length === 0 ? undefined : warnings.join('; ').slice(0, 2_000)
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal) }
  catch (error: unknown) {
    if (!isMissingProcess(error)) throw error
  }
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ESRCH'
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('the process was aborted')
}

function processCleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function takeBoundedLines(lines: readonly string[], maxResults: number, maxChars: number): string[] {
  const selected: string[] = []
  let chars = 0
  for (const line of lines) {
    if (selected.length >= maxResults) break
    const remaining = maxChars - chars
    if (remaining <= 0) break
    if (line.length + 1 > remaining) {
      if (selected.length === 0) selected.push(line.slice(0, remaining))
      break
    }
    selected.push(line)
    chars += line.length + 1
  }
  return selected
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const found = text.indexOf(needle, offset)
    if (found < 0) return count
    count++
    offset = found + needle.length
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('arguments must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function optionalString(value: unknown, fallback: string): string {
  return value === undefined ? fallback : requiredString(value, 'value')
}

function optionalBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return value as number
}
