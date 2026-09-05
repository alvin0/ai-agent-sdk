import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { resolveExistingAgentCodePath } from '../workspace.ts'
import { IGNORED_DIRECTORIES, type PendingDirectory, type StreamedLineRange, type TraversalResult } from './types.ts'
import { abortReason } from './process.ts'
export function portableRelative(root: string, target: string): string {
  return relative(root, target).replaceAll('\\', '/')
}

export function portableGrepMatch(line: string): string {
  const match = /^(.*?):(\d+):(\d+):([\s\S]*)$/.exec(line)
  if (match === null) return line
  return `${match[1]?.replaceAll('\\', '/')}:${match[2]}:${match[3]}:${match[4]}`
}

export async function walk(
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

export async function streamLineRange(
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

export function takeBoundedLines(lines: readonly string[], maxResults: number, maxChars: number): string[] {
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
