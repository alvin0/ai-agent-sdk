/**
 * Demo tool set for the sample.
 *
 * Two halves, and the split matters. The inspection tools (read, list, search,
 * diff preview, todos, fetch) run unattended. The mutating tools (write, edit,
 * delete, move, mkdir, shell) change the machine, so each one is named in
 * {@link MUTATING_TOOLS} and {@link describeMutation} turns a pending call into
 * something a human can say yes or no to — see `approvals.ts` for the gate
 * itself. A tool never asks for permission on its own: by the time `execute`
 * runs, the call is already allowed.
 *
 * Each tool returns a `meta.card` — the UI card model the frontend renders
 * instead of raw JSON (see `wire.ts`).
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { defineTool, ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import type { JsonObject, JsonValue } from '@alvin0/ai-agent-sdk-core'
import { commandHazards } from './hazards'
import type { Hazard } from './hazards'
import type { DiffLine, SearchMatch, TodoItem, ToolCard } from './wire'
import { webLinks } from './web-links'

const MAX_READ_LINES = 400
const MAX_MATCHES = 60
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage'])
/** Cap on captured command output, so one chatty build cannot flood the UI. */
const MAX_COMMAND_OUTPUT = 20_000
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/** Read only a bounded prefix; cancel the network body instead of buffering it all. */
async function webPrefix(response: Response, signal: AbortSignal): Promise<{ html: string; truncated: boolean }> {
  const reader = response.body?.getReader()
  if (reader === undefined) return { html: '', truncated: false }
  const decoder = new TextDecoder()
  let remaining = 200_000
  let html = ''
  try {
    while (remaining > 0) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) return { html: html + decoder.decode(), truncated: false }
      const kept = value.subarray(0, remaining)
      html += decoder.decode(kept, { stream: true })
      remaining -= kept.byteLength
    }
    return { html: html + decoder.decode(), truncated: true }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Cast a structurally-JSON result to the SDK's `JsonValue`. */
function json<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

function card(value: ToolCard): JsonObject {
  return { card: value } as unknown as JsonObject
}

/** Resolve a caller-supplied path inside `root`, refusing every escape. */
function inRoot(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const rel = relative(root, absolute)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`path escapes the workspace root: ${path}`)
  }
  return absolute
}

function optionalString(raw: unknown, key: string): string | undefined {
  const value = (raw as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requireString(raw: unknown, key: string): string {
  const value = (raw as Record<string, unknown> | null)?.[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`"${key}" must be a non-empty string`)
  return value
}

async function* walk(dir: string, depth: number): AsyncGenerator<string> {
  if (depth < 0) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full, depth - 1)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function optionalBoolean(raw: unknown, key: string): boolean {
  return (raw as Record<string, unknown> | null)?.[key] === true
}

/** Read a file, treating "missing" as empty so a create and an edit diff alike. */
async function currentText(absolute: string): Promise<string> {
  try {
    return await readFile(absolute, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Apply one exact-string replacement.
 * @param text - Current file content.
 * @param oldText - The literal to replace.
 * @param newText - Its replacement.
 * @param replaceAll - Replace every occurrence instead of insisting on one.
 * @returns The new content and how many occurrences changed.
 * @throws When the literal is absent, or ambiguous without `replaceAll`.
 */
function replaceOnce(
  text: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): { content: string; count: number } {
  const occurrences = text.split(oldText).length - 1
  if (occurrences === 0) throw new Error('"oldText" does not appear in the file')
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `"oldText" appears ${String(occurrences)} times; include more surrounding lines or set replaceAll`,
    )
  }
  return {
    content: replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText),
    count: replaceAll ? occurrences : 1,
  }
}

/** Receives output from a command while it is still running. */
export type CommandOutputListener = (callId: string, chunk: string) => void

/**
 * Subscribers to live command output.
 *
 * A module-level bus rather than a constructor argument, because tool
 * registries are cached per workspace root and shared by every conversation
 * using that folder, so a per-run callback cannot be baked into one. Output is
 * tagged with the call id instead, and a run picks out the calls it owns.
 *
 * `ToolRunContext` offers no channel for this: a tool result is delivered once,
 * when the tool returns. Everything a long command prints before that would
 * otherwise be invisible until it exits.
 */
const outputListeners = new Set<CommandOutputListener>()

/**
 * Watch output from commands as they run.
 * @param listener - Called with each flushed chunk and the call that produced it.
 * @returns A disposer.
 */
export function onCommandOutput(listener: CommandOutputListener): () => void {
  outputListeners.add(listener)
  return () => void outputListeners.delete(listener)
}

function publishOutput(callId: string, chunk: string): void {
  for (const listener of [...outputListeners]) {
    try {
      listener(callId, chunk)
    } catch {
      // A broken observer must not fail the command it is watching.
    }
  }
}

interface CommandOutcome {
  readonly command: string
  readonly cwd: string
  readonly output: string
  readonly exitCode: number
  readonly timedOut: boolean
}

/**
 * Run one shell command inside the workspace.
 *
 * stdout and stderr are interleaved into a single stream, because that is what
 * the terminal card shows and what the model needs to read a failure.
 * @param command - The command line, run through the platform shell.
 * @param cwd - Absolute working directory, already confined to the root.
 * @param timeoutMs - Kill the process after this long.
 * @param report - Receives output as it arrives, coalesced; omitted stays silent.
 * @returns The captured output and exit status; a non-zero exit is data, not an error.
 */
async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  report?: (chunk: string) => void,
): Promise<CommandOutcome> {
  return await new Promise<CommandOutcome>((settle, fail) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let output = ''
    let timedOut = false
    // Coalesced on a short timer: a build prints in bursts of many tiny writes,
    // and one wire event each would spend more on framing than on output.
    let unsent = ''
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      flushTimer = undefined
      if (unsent === '') return
      const chunk = unsent
      unsent = ''
      report?.(chunk)
    }
    const collect = (chunk: Buffer | string): void => {
      if (output.length >= MAX_COMMAND_OUTPUT) return
      const text = String(chunk)
      output = (output + text).slice(0, MAX_COMMAND_OUTPUT)
      if (report === undefined) return
      unsent += text
      flushTimer ??= setTimeout(flush, 200)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      fail(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // Whatever the last burst printed still belongs on screen, and the timer
      // that would have sent it is now moot.
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flush()
      settle({
        command,
        cwd,
        output: timedOut ? `${output}\n[timed out after ${String(timeoutMs)}ms]` : output,
        // A killed process reports a null code; surface it as a failure.
        exitCode: code ?? 1,
        timedOut,
      })
    })
  })
}

/**
 * Build the sample's tool registry.
 * @param root - Workspace root; every path argument is confined to it.
 * @returns A registry ready to hand to `runAgent`.
 */
export function createSampleTools(root: string): ToolRegistry {
  const tools = new ToolRegistry()

  tools.register(defineTool({
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. Returns numbered lines.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        offset: { type: 'number', description: '1-based first line to read.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    parse: raw => ({
      path: requireString(raw, 'path'),
      offset: Number((raw as { offset?: unknown }).offset ?? 1),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ path, offset }) => {
      const absolute = inRoot(root, path)
      const text = await readFile(absolute, 'utf8')
      const all = text.split('\n')
      const first = Number.isFinite(offset) && offset >= 1 ? Math.floor(offset) : 1
      const lines = all.slice(first - 1, first - 1 + MAX_READ_LINES)
      return {
        path: relative(root, absolute),
        firstLine: first,
        truncated: all.length > first - 1 + lines.length,
        totalLines: all.length,
        lines,
      }
    },
    render: value => {
      const record = value as { firstLine: number; lines: string[] } | undefined
      if (record === undefined) return [{ type: 'text', text: '(no output)' }]
      const body = record.lines.map((line, index) => `${record.firstLine + index}\t${line}`).join('\n')
      return [{ type: 'text', text: body }]
    },
    meta: value => {
      const record = value as { path: string; firstLine: number; lines: string[]; truncated: boolean } | undefined
      if (record === undefined) return undefined
      return card({
        kind: 'read',
        path: record.path,
        firstLine: record.firstLine,
        lines: record.lines,
        truncated: record.truncated,
      })
    },
  }))

  tools.register(defineTool({
    name: 'list_directory',
    description: 'List the files under a workspace directory, recursively up to a small depth.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory.' },
        depth: { type: 'number', description: 'Recursion depth, default 1.' },
      },
      additionalProperties: false,
    },
    // The workspace root is the obvious default; an agent that omits the path
    // means "here" rather than making an invalid call.
    parse: raw => ({
      path: optionalString(raw, 'path') ?? '.',
      depth: Number((raw as { depth?: unknown }).depth ?? 1),
    }),
    isConcurrencySafe: () => true,
    execute: async ({ path, depth }) => {
      const absolute = inRoot(root, path)
      const info = await stat(absolute)
      if (!info.isDirectory()) throw new Error(`not a directory: ${path}`)
      const found: string[] = []
      for await (const file of walk(absolute, Number.isFinite(depth) ? Math.min(Math.max(depth, 0), 4) : 1)) {
        found.push(relative(root, file))
        if (found.length >= 200) break
      }
      return json({ path: relative(root, absolute), files: found })
    },
    meta: (value, args) => {
      const record = value as { files: string[] } | undefined
      if (record === undefined) return undefined
      return card({
        kind: 'search',
        query: `ls ${args.path}`,
        matches: record.files.map((file): SearchMatch => ({ path: file, line: 0, text: '' })),
      })
    },
  }))

  tools.register(defineTool({
    name: 'search_files',
    description: 'Case-insensitive plain-substring search across workspace text files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to look for.' },
        path: { type: 'string', description: 'Workspace-relative directory to search, default the root.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    parse: raw => ({
      query: requireString(raw, 'query'),
      path: typeof (raw as { path?: unknown }).path === 'string' ? (raw as { path: string }).path : '.',
    }),
    isConcurrencySafe: () => true,
    execute: async ({ query, path }) => {
      const absolute = inRoot(root, path)
      const needle = query.toLowerCase()
      const matches: SearchMatch[] = []
      for await (const file of walk(absolute, 4)) {
        if (matches.length >= MAX_MATCHES) break
        let text: string
        try {
          text = await readFile(file, 'utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        for (const [index, line] of lines.entries()) {
          if (!line.toLowerCase().includes(needle)) continue
          matches.push({ path: relative(root, file), line: index + 1, text: line.slice(0, 240) })
          if (matches.length >= MAX_MATCHES) break
        }
      }
      return json({ query, matches })
    },
    meta: value => {
      const record = value as { query: string; matches: SearchMatch[] } | undefined
      return record === undefined ? undefined : card({ kind: 'search', query: record.query, matches: record.matches })
    },
  }))

  tools.register(defineTool({
    name: 'propose_edit',
    description: 'Propose a replacement for a file and return a unified diff. Nothing is written to disk.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'The complete proposed file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    parse: raw => ({ path: requireString(raw, 'path'), content: requireString(raw, 'content') }),
    execute: async ({ path, content }) => {
      const absolute = inRoot(root, path)
      let current = ''
      try {
        current = await readFile(absolute, 'utf8')
      } catch {
        current = ''
      }
      return json({ path: relative(root, absolute), lines: diffLines(current, content) })
    },
    meta: value => {
      const record = value as { path: string; lines: DiffLine[] } | undefined
      return record === undefined ? undefined : card({ kind: 'diff', path: record.path, lines: record.lines })
    },
  }))

  // ---- mutating tools ----------------------------------------------------
  // Every tool below is gated by `approvals.ts`. None of them checks
  // permission itself: reaching `execute` already means the user said yes.

  tools.register(defineTool({
    name: 'write_file',
    description: 'Create a file or replace its entire content. Parent directories are created.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'The complete file content to write.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    // An empty file is a legitimate thing to write, so the content is read
    // directly rather than through `requireString`.
    parse: (raw) => {
      const content = (raw as { content?: unknown }).content
      if (typeof content !== 'string') throw new Error('"content" must be a string')
      return { path: requireString(raw, 'path'), content }
    },
    execute: async ({ path, content }) => {
      const absolute = inRoot(root, path)
      const before = await currentText(absolute)
      const existed = before !== '' || await stat(absolute).then(() => true, () => false)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, content, 'utf8')
      return json({
        path: relative(root, absolute),
        created: !existed,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: diffLines(before, content),
      })
    },
    render: (value) => {
      const record = value as { path: string; created: boolean; bytes: number } | undefined
      if (record === undefined) return [{ type: 'text', text: '(no output)' }]
      return [{
        type: 'text',
        text: `${record.created ? 'created' : 'updated'} ${record.path} (${String(record.bytes)} bytes)`,
      }]
    },
    meta: (value) => {
      const record = value as { path: string; lines: DiffLine[] } | undefined
      return record === undefined ? undefined : card({ kind: 'diff', path: record.path, lines: record.lines })
    },
  }))

  tools.register(defineTool({
    name: 'edit_file',
    description: 'Replace an exact string in an existing file. Fails when the string is absent or ambiguous.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        oldText: { type: 'string', description: 'The exact text to replace, including indentation.' },
        newText: { type: 'string', description: 'Its replacement; empty deletes the text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    parse: (raw) => {
      const newText = (raw as { newText?: unknown }).newText
      if (typeof newText !== 'string') throw new Error('"newText" must be a string')
      return {
        path: requireString(raw, 'path'),
        oldText: requireString(raw, 'oldText'),
        newText,
        replaceAll: optionalBoolean(raw, 'replaceAll'),
      }
    },
    execute: async ({ path, oldText, newText, replaceAll }) => {
      const absolute = inRoot(root, path)
      const before = await readFile(absolute, 'utf8')
      const { content, count } = replaceOnce(before, oldText, newText, replaceAll)
      await writeFile(absolute, content, 'utf8')
      return json({ path: relative(root, absolute), replaced: count, lines: diffLines(before, content) })
    },
    render: (value) => {
      const record = value as { path: string; replaced: number } | undefined
      if (record === undefined) return [{ type: 'text', text: '(no output)' }]
      return [{ type: 'text', text: `edited ${record.path} (${String(record.replaced)} replacement(s))` }]
    },
    meta: (value) => {
      const record = value as { path: string; lines: DiffLine[] } | undefined
      return record === undefined ? undefined : card({ kind: 'diff', path: record.path, lines: record.lines })
    },
  }))

  tools.register(defineTool({
    name: 'delete_path',
    description: 'Delete a file, or a directory when recursive is set.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file or directory.' },
        recursive: { type: 'boolean', description: 'Required to delete a non-empty directory.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    parse: raw => ({ path: requireString(raw, 'path'), recursive: optionalBoolean(raw, 'recursive') }),
    execute: async ({ path, recursive }) => {
      const absolute = inRoot(root, path)
      // `inRoot` allows the root itself; deleting the workspace is never what
      // a tool call meant.
      if (absolute === resolve(root)) throw new Error('refusing to delete the workspace root')
      const info = await stat(absolute)
      if (info.isDirectory() && !recursive) throw new Error(`${path} is a directory; set recursive to delete it`)
      await rm(absolute, { recursive, force: false })
      return json({ path: relative(root, absolute), directory: info.isDirectory() })
    },
    render: (value) => {
      const record = value as { path: string } | undefined
      return [{ type: 'text', text: record === undefined ? '(no output)' : `deleted ${record.path}` }]
    },
    meta: (value) => {
      const record = value as { path: string; directory: boolean } | undefined
      return record === undefined
        ? undefined
        : card({
            kind: 'fs',
            action: 'deleted',
            path: record.path,
            ...record.directory ? { detail: 'directory' } : {},
          })
    },
  }))

  tools.register(defineTool({
    name: 'create_directory',
    description: 'Create a directory, including any missing parents.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative directory.' } },
      required: ['path'],
      additionalProperties: false,
    },
    parse: raw => ({ path: requireString(raw, 'path') }),
    execute: async ({ path }) => {
      const absolute = inRoot(root, path)
      await mkdir(absolute, { recursive: true })
      return json({ path: relative(root, absolute) })
    },
    render: (value) => {
      const record = value as { path: string } | undefined
      return [{ type: 'text', text: record === undefined ? '(no output)' : `created ${record.path}/` }]
    },
    meta: (value) => {
      const record = value as { path: string } | undefined
      return record === undefined
        ? undefined
        : card({ kind: 'fs', action: 'created', path: record.path, detail: 'directory' })
    },
  }))

  tools.register(defineTool({
    name: 'move_path',
    description: 'Move or rename a file or directory inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Workspace-relative source.' },
        to: { type: 'string', description: 'Workspace-relative destination.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    parse: raw => ({ from: requireString(raw, 'from'), to: requireString(raw, 'to') }),
    execute: async ({ from, to }) => {
      const source = inRoot(root, from)
      const target = inRoot(root, to)
      await mkdir(dirname(target), { recursive: true })
      await rename(source, target)
      return json({ from: relative(root, source), to: relative(root, target) })
    },
    render: (value) => {
      const record = value as { from: string; to: string } | undefined
      return [{ type: 'text', text: record === undefined ? '(no output)' : `moved ${record.from} → ${record.to}` }]
    },
    meta: (value) => {
      const record = value as { from: string; to: string } | undefined
      return record === undefined
        ? undefined
        : card({ kind: 'fs', action: 'moved', path: record.from, detail: `→ ${record.to}` })
    },
  }))

  tools.register(defineTool({
    name: 'run_command',
    description: 'Run a shell command with the workspace as its working directory. '
      + 'Returns the interleaved output and the exit code; a non-zero exit is reported, not thrown.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Workspace-relative working directory, default the root.' },
        timeoutMs: { type: 'number', description: 'Kill the command after this long, default 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    parse: raw => ({
      command: requireString(raw, 'command'),
      cwd: optionalString(raw, 'cwd') ?? '.',
      timeoutMs: Number((raw as { timeoutMs?: unknown }).timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
    }),
    execute: async ({ command, cwd, timeoutMs }, context) => {
      const absolute = inRoot(root, cwd)
      const budget = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, 600_000)
        : DEFAULT_COMMAND_TIMEOUT_MS
      // Tagged with the call id so a run can match the output to the row it is
      // already showing for this call.
      const outcome = await runShell(command, absolute, budget, (chunk) => {
        publishOutput(context.callId, chunk)
      })
      return json({ ...outcome, cwd: relative(root, absolute) || '.' })
    },
    render: (value) => {
      const record = value as CommandOutcome | undefined
      if (record === undefined) return [{ type: 'text', text: '(no output)' }]
      const status = record.exitCode === 0 ? 'exit 0' : `exit ${String(record.exitCode)}`
      return [{ type: 'text', text: `$ ${record.command}\n${record.output}\n[${status}]` }]
    },
    meta: (value) => {
      const record = value as CommandOutcome | undefined
      return record === undefined
        ? undefined
        : card({
            kind: 'terminal',
            command: record.command,
            output: record.output,
            exitCode: record.exitCode,
          })
    },
  }))

  tools.register(defineTool({
    name: 'write_todos',
    budgetExempt: true,
    completionExempt: true,
    description: 'Publish the current task list so the user can follow along.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'active', 'done'] },
            },
            required: ['text', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    parse: (raw) => {
      const items = (raw as { items?: unknown }).items
      if (!Array.isArray(items)) throw new Error('"items" must be an array')
      return {
        items: items.map((entry): TodoItem => {
          const record = entry as { text?: unknown; status?: unknown }
          if (typeof record.text !== 'string') throw new Error('every item needs a "text" string')
          const status = record.status
          return {
            text: record.text,
            status: status === 'active' || status === 'done' ? status : 'pending',
          }
        }),
      }
    },
    execute: ({ items }) => json({ items, count: items.length }),
    meta: value => {
      const record = value as { items: TodoItem[] } | undefined
      return record === undefined ? undefined : card({ kind: 'todo', items: record.items })
    },
  }))

  tools.register(defineTool({
    name: 'fetch_url',
    description: 'Fetch an https page and return its readable text and up to 40 source links. Follow relevant returned links instead of guessing endpoint paths. fetchedAt is the retrieval time, not the publication date or market-price timestamp; those must be verified from the source.',
    timeoutMs: 30_000,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute https URL.' } },
      required: ['url'],
      additionalProperties: false,
    },
    parse: (raw) => {
      const url = new URL(requireString(raw, 'url'))
      if (url.protocol !== 'https:') throw new Error('only https URLs are allowed')
      return { url: url.toString() }
    },
    isConcurrencySafe: () => true,
    execute: async ({ url }, context) => {
      const response = await fetch(url, { redirect: 'follow', signal: context.signal })
      const fetchedAt = new Date().toISOString()
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`Source unavailable: HTTP ${response.status} for ${url}. Do not treat the error page as research evidence.`)
      }
      const { html, truncated } = await webPrefix(response, context.signal)
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? url
      const readable = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const text = readable.slice(0, 8_000)
      return { url: response.url || url, title, status: response.status, text,
        links: webLinks(html, response.url || url),
        fetchedAt, truncated: truncated || readable.length > text.length }
    },
    meta: value => {
      const record = value as { url: string; title: string; text: string } | undefined
      return record === undefined
        ? undefined
        : card({ kind: 'web', url: record.url, title: record.title, snippet: record.text.slice(0, 400) })
    },
  }))

  return tools
}

/**
 * The tools that change the machine, and therefore need the user's permission.
 *
 * `propose_edit` is deliberately absent: it only computes a diff.
 */
export const MUTATING_TOOLS: readonly string[] = [
  'write_file', 'edit_file', 'delete_path', 'create_directory', 'move_path', 'run_command',
]

/** One breadth a session or workspace grant can be given at. */
export interface RuleChoice {
  /** The stored grant key, e.g. `run_command:prefix:git diff`. */
  readonly key: string
  /** What that key covers, in words. */
  readonly label: string
}

/** A pending mutating call, in the words a permission prompt needs. */
export interface MutationDescription {
  /** Short action title, e.g. "Run command". */
  readonly title: string
  /** One line saying what will happen. */
  readonly summary: string
  /**
   * The breadths offered on the prompt, NARROWEST FIRST — `git diff *` before
   * `git *`, this directory before every file. The first is the default, so a
   * distracted "allow for this project" grants the smallest useful family.
   *
   * Empty means no grant is offered at all and the call can only be permitted
   * once: a command line whose shape cannot be reasoned about, or an
   * executable that must never be signed away wholesale.
   */
  readonly rules: readonly RuleChoice[]
  /**
   * Every key that covers this call — a superset of {@link rules}, because a
   * key can be honoured without ever being suggested: a broader prefix stored
   * earlier, a legacy key, or a grant added through the permissions API for an
   * executable this module refuses to put on a chip.
   */
  readonly matchKeys: readonly string[]
  /**
   * What the call would destroy, when it is recognisably destructive — most
   * severe first, empty when nothing was recognised (which is not a claim that
   * the call is safe). A call with any hazard offers no `rules`: it is answered
   * once, deliberately, or not at all.
   */
  readonly hazards: readonly Hazard[]
  /** Preview of the change, when one can be computed without making it. */
  readonly card?: ToolCard
}

/**
 * Longest prefix a command grant may name.
 *
 * Past this a "family" is really one command line with its arguments, which
 * would be remembered forever and match nothing again.
 */
const MAX_PREFIX_TOKENS = 8

/**
 * Shell syntax that makes a command line more than a plain argument list.
 *
 * A prefix grant is only sound when the prefix decides what runs. `git diff`
 * does; `git diff && rm -rf .` and `git $CMD` do not — the chip would read
 * "every `git diff …` command" while the line runs something else. Rather than
 * parse a shell, anything that can redirect, chain, expand, or substitute makes
 * the line opaque: permitted once, never remembered.
 *
 * Quotes are deliberately NOT here. They only group words, and grouping cannot
 * change which program runs once everything above is excluded — so
 * `git commit -m "two words"` still scopes to `git commit`, which is the
 * commonest command in the sample there is. A quote in the program word itself
 * is still refused, below: `"git"` and `git` must not share a key.
 */
const SHELL_METACHARACTERS = /[$`(){}<>&|;*?~!#\n\r\\]/

/**
 * Executables never offered as a grant.
 *
 * Not a security boundary — the workspace root and the sandbox are that. It
 * keeps the prompt from offering one chip that signs away deletion, privilege
 * escalation, or "run this arbitrary text" for a whole project. An explicit
 * grant added through the permissions API is still honoured.
 */
const UNGRANTABLE_EXECUTABLES: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'mv', 'dd', 'mkfs', 'chmod', 'chown', 'sudo', 'doas', 'su',
  'shutdown', 'reboot', 'kill', 'killall', 'eval', 'exec', 'source',
  'sh', 'bash', 'zsh', 'fish', 'env', 'xargs',
  'node', 'python', 'python3', 'ruby', 'perl', 'osascript',
  'curl', 'wget', 'ssh', 'scp', 'nc',
])

/**
 * The words of a command line, when it is a plain argument list.
 * @param command - The command line as the model wrote it.
 * @returns Its words, or an empty array when nothing about it can be trusted
 *   to a prefix rule.
 */
export function plainTokens(command: string): readonly string[] {
  const trimmed = command.trim()
  if (trimmed === '' || SHELL_METACHARACTERS.test(trimmed)) return []
  const tokens = trimmed.split(/\s+/)
  const program = tokens[0]
  if (program === undefined) return []
  // `FOO=1 cmd` runs `cmd` with an environment the prefix does not describe,
  // and a quoted or escaped program word is a second spelling of a name that
  // already has a key.
  if (program.includes('=') || /["']/.test(program)) return []
  return tokens
}

/**
 * Whether a command word names a file rather than a program on `PATH`.
 *
 * The distinction decides what a grant may say. `git` is whatever `PATH`
 * resolves, and a rule about it is a rule about git. `./git` is a file in the
 * workspace — a file the agent can WRITE — so a grant that stripped the path
 * would let a newly created `./git` ride the user's trust in git. A path stays
 * in the key verbatim instead, where it names one file and nothing else.
 */
function isPath(word: string): boolean {
  return word.includes('/') || word.includes('\\')
}

/** The last segment of a command word, for reading a path against the ban list. */
function basename(word: string): string {
  return word.split(/[/\\]/).pop() ?? word
}

/**
 * Longest word a chip may name.
 *
 * A rule's label has to be readable in a row of chips at a glance. A model can
 * write a 400-character path as its first word, and a chip that wide is a
 * decision the user cannot actually read — so that width is simply not offered,
 * and the call is permitted once.
 */
const MAX_LABEL_WORD = 48

/** Longest directory a chip may name, for the same reason. */
const MAX_LABEL_DIRECTORY = 80

/** Whether an executable may be offered as a grant at all. */
function grantable(word: string): boolean {
  if (word.length > MAX_LABEL_WORD) return false
  return !UNGRANTABLE_EXECUTABLES.has(basename(word).toLowerCase())
}

/**
 * Every grant key that covers one command line.
 *
 * A stored `run_command:prefix:<words>` covers a call when its words are a
 * prefix of the call's words, so this enumerates the call's own prefixes and
 * lets the store be checked by equality. `run_command:<executable>` is listed
 * too: it is the key this sample granted before prefixes existed, and rows
 * written then still mean "every `git` command".
 * @param command - The command line about to run.
 * @returns The keys, narrowest first; empty for an opaque command line.
 */
export function commandRuleKeys(command: string): readonly string[] {
  const tokens = plainTokens(command)
  const executable = tokens[0]
  if (executable === undefined) return []
  const keys: string[] = []
  const depth = Math.min(tokens.length, MAX_PREFIX_TOKENS)
  for (let count = depth; count >= 1; count -= 1) {
    keys.push(`run_command:prefix:${tokens.slice(0, count).join(' ')}`)
  }
  // The key this sample wrote before prefixes existed, and only for a program
  // on `PATH`: a bare-name grant must never be what permits `./git`.
  if (!isPath(executable)) keys.push(`run_command:${executable}`)
  return keys
}

/**
 * The breadths a command prompt offers: the subcommand, then the executable.
 *
 * `git diff --stat` offers `git diff *` and `git *` — the first because
 * approving one diff should not have to approve `git push`, the second because
 * a user who trusts a tool should be able to say so once.
 * @param command - The command line about to run.
 * @returns The choices, narrowest first; empty when none may be offered.
 */
export function commandRules(command: string): readonly RuleChoice[] {
  const tokens = plainTokens(command)
  const executable = tokens[0]
  if (executable === undefined) return []
  if (!grantable(executable)) return []
  const rules: RuleChoice[] = []
  const sub = tokens[1]
  // A flag is not a subcommand: `ls -la` would offer "every `ls -la …`", which
  // is one command line wearing a family's clothes.
  if (sub !== undefined && !sub.startsWith('-') && sub.length <= MAX_LABEL_WORD) {
    rules.push({
      key: `run_command:prefix:${executable} ${sub}`,
      label: `every \`${executable} ${sub} …\` command`,
    })
  }
  rules.push({ key: `run_command:prefix:${executable}`, label: `every \`${executable}\` command` })
  return rules
}

/**
 * One tool argument as a canonical workspace-relative path.
 *
 * The same resolution the tools themselves use, so a rule is derived from the
 * path that will actually be written — not from the string the model typed.
 * `a/../b.txt` is `b.txt`, `./src/x` is `src/x`, and a file whose NAME
 * contains a separator character for another platform stays one name rather
 * than turning into a directory a grant could be widened through.
 * @param root - Workspace root.
 * @param path - The path argument, as the tool received it.
 * @returns The relative path with `/` separators, or undefined when it names
 *   nothing inside the workspace.
 */
function workspacePath(root: string, path: string): string | undefined {
  if (path === '') return undefined
  try {
    const rest = relative(root, inRoot(root, path))
    return rest === '' ? '.' : rest.split(sep).join('/')
  } catch {
    // Escapes the root. The call will fail on its own terms; until it does,
    // the prompt must not imply a directory scope it cannot enforce.
    return undefined
  }
}

/**
 * The directories a path sits under, nearest first.
 *
 * `.` is the workspace root and closes the chain, so a root-level file yields
 * exactly one directory.
 * @param root - Workspace root.
 * @param path - The path argument, as the tool received it.
 * @returns The chain, or undefined when the path is not inside the workspace
 *   and so cannot be scoped.
 */
function directoryChain(root: string, path: string): readonly string[] | undefined {
  const normal = workspacePath(root, path)
  if (normal === undefined) return undefined
  const parts = normal.split('/').filter(part => part !== '' && part !== '.')
  parts.pop()
  const chain: string[] = []
  let prefix = ''
  for (const part of parts) {
    prefix = prefix === '' ? part : `${prefix}/${part}`
    chain.push(prefix)
  }
  // Built root-outwards; the prompt wants the nearest directory first, and the
  // workspace root last, where it means "anywhere in the project".
  chain.reverse()
  chain.push('.')
  return chain
}

/**
 * Directory keys covering every path one call touches.
 *
 * A move touches two paths, and a grant must cover both or it does not cover
 * the call, so the chains are intersected rather than concatenated.
 * @param toolName - The tool the key belongs to.
 * @param paths - The workspace-relative paths the call writes.
 * @returns The keys, narrowest first; empty when any path cannot be scoped.
 */
function pathRuleKeys(
  root: string,
  toolName: string,
  paths: readonly string[],
): readonly string[] {
  const chains = paths.map(path => directoryChain(root, path))
  if (chains.length === 0 || chains.some(chain => chain === undefined)) return []
  const [first, ...rest] = chains as readonly (readonly string[])[]
  const shared = (first ?? []).filter(dir => rest.every(chain => chain.includes(dir)))
  return shared.map(dir => `${toolName}:dir:${dir}`)
}

/**
 * The breadths a filesystem prompt offers: this directory, then the tool.
 * @param toolName - The tool about to run.
 * @param toolLabel - What a tool-wide grant covers, in words.
 * @param paths - The workspace-relative paths the call writes.
 * @returns The choices, narrowest first.
 */
function pathRules(
  root: string,
  toolName: string,
  toolLabel: string,
  paths: readonly string[],
): readonly RuleChoice[] {
  const keys = pathRuleKeys(root, toolName, paths)
  const nearest = keys[0]
  const directory = nearest?.slice(`${toolName}:dir:`.length)
  // A directory too long to read is a chip the user cannot weigh; the
  // tool-wide width still stands, and so does answering once.
  const scoped: readonly RuleChoice[] = nearest === undefined || directory === undefined
    || directory === '.' || directory.length > MAX_LABEL_DIRECTORY
    ? []
    : [{ key: nearest, label: `${toolLabel} under \`${directory}/\`` }]
  return [...scoped, { key: toolName, label: toolLabel }]
}

/**
 * What a filesystem call would reach that the user has to be told about.
 *
 * These tools resolve every path through the workspace root and refuse to
 * leave, so an outside path is a call that will FAIL rather than one that will
 * do damage. It is still worth saying: the model asked to touch something
 * outside the project, and the user is the one who should know that.
 * @param root - Workspace root.
 * @param toolName - The tool about to run.
 * @param paths - The path arguments, as the tool received them.
 * @param recursive - Whether a delete takes everything underneath.
 * @returns The hazards, empty when there is nothing to say.
 */
function pathHazards(
  root: string,
  toolName: string,
  paths: readonly string[],
  recursive = false,
): readonly Hazard[] {
  const hazards: Hazard[] = []
  for (const path of paths) {
    if (path === '') continue
    if (workspacePath(root, path) !== undefined) continue
    hazards.push({
      severity: 'critical',
      title: 'Points outside the workspace',
      detail: `\`${path}\` resolves outside \`${root}\`. This tool refuses to leave the workspace, so the call will fail — but it asked to reach the rest of the machine, which is worth knowing before permitting anything else it does.`,
    })
  }
  if (toolName === 'delete_path' && recursive && paths.some(path => workspacePath(root, path) === '.')) {
    hazards.push({
      severity: 'critical',
      title: 'Deletes the whole workspace',
      detail: `A recursive delete of the workspace root removes every file in \`${root}\`, including anything not tracked by git. It is not undoable.`,
    })
  }
  return hazards
}

function argString(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Describe what a mutating call is about to do.
 *
 * Called before the tool runs, so the preview is computed by reading — never by
 * writing. A file that cannot be read yields a description without a card
 * rather than failing the call: the user is still asked, just with less detail.
 * @param root - Workspace root.
 * @param toolName - The tool about to run.
 * @param args - Its parsed arguments.
 * @returns The description, or undefined when the tool changes nothing.
 */
export async function describeMutation(
  root: string,
  toolName: string,
  args: unknown,
): Promise<MutationDescription | undefined> {
  if (!MUTATING_TOOLS.includes(toolName)) return undefined

  if (toolName === 'run_command') {
    const command = argString(args, 'command')
    // Where it runs is part of what it does: `git clean -fd` reads very
    // differently in the root and in a scratch directory, and a rule is about
    // the command line alone, so the working directory has to be on the card.
    const requested = argString(args, 'cwd') || '.'
    const cwd = workspacePath(root, requested)
    const where = cwd === undefined || cwd === '.' ? '' : ` (in ${cwd}/)`
    // Hazards are read against the directory the shell will actually get. A
    // `cwd` that escapes the root makes the tool throw, but the reading has to
    // happen against SOME directory, and the root is the honest guess.
    const hazards = commandHazards(command, {
      root,
      cwd: cwd === undefined ? root : resolve(root, cwd),
    })
    // No card: a terminal block for a command that has not run yet shows an
    // empty output pane and a settled status dot, which reads as "already
    // done". The summary carries the command line, which is the whole story.
    return {
      title: 'Run command',
      summary: `${command}${where}`,
      // A line worth warning about is a line worth asking about every time:
      // remembering it would turn one deliberate answer into a standing one.
      rules: hazards.length === 0 ? commandRules(command) : [],
      matchKeys: commandRuleKeys(command),
      hazards,
    }
  }

  if (toolName === 'write_file' || toolName === 'edit_file') {
    const path = argString(args, 'path')
    const editing = toolName === 'edit_file'
    const toolLabel = editing ? 'editing files in place' : 'writing whole files'
    const base: MutationDescription = {
      title: editing ? 'Edit file' : 'Write file',
      summary: path,
      rules: pathRules(root, toolName, toolLabel, [path]),
      matchKeys: [...pathRuleKeys(root, toolName, [path]), toolName],
      hazards: pathHazards(root, toolName, [path]),
    }
    let after: string
    try {
      const absolute = inRoot(root, path)
      const before = await currentText(absolute)
      after = editing
        ? replaceOnce(before, argString(args, 'oldText'), argString(args, 'newText'), args !== null
          && typeof args === 'object' && (args as { replaceAll?: unknown }).replaceAll === true).content
        : argString(args, 'content')
      return { ...base, card: { kind: 'diff', path, lines: diffLines(before, after) } }
    } catch {
      // A missing file, an ambiguous `oldText`, or a path outside the root: the
      // call will fail on its own terms. Ask without a preview.
      return base
    }
  }

  // The remaining tools name a path and nothing more, so their summary IS the
  // preview; an `fs` card here would repeat it in a box. Those cards belong to
  // the settled tool row, where there is no diff to show instead.
  if (toolName === 'move_path') {
    const from = argString(args, 'from')
    const to = argString(args, 'to')
    return {
      title: 'Move',
      summary: `${from} → ${to}`,
      rules: pathRules(root, 'move_path', 'moving and renaming files', [from, to]),
      matchKeys: [...pathRuleKeys(root, 'move_path', [from, to]), 'move_path'],
      hazards: pathHazards(root, 'move_path', [from, to]),
    }
  }

  if (toolName === 'create_directory') {
    const target = argString(args, 'path')
    return {
      title: 'Create directory',
      summary: target,
      // The chain drops the last segment, which for a directory is the one
      // being created — so the scope is the parent it lands in.
      rules: pathRules(root, 'create_directory', 'creating directories', [target]),
      matchKeys: [...pathRuleKeys(root, 'create_directory', [target]), 'create_directory'],
      hazards: pathHazards(root, 'create_directory', [target]),
    }
  }

  const path = argString(args, 'path')
  const recursive = args !== null && typeof args === 'object'
    && (args as { recursive?: unknown }).recursive === true
  return {
    title: 'Delete',
    summary: recursive ? `${path} (recursive, including everything inside)` : path,
    rules: pathRules(root, 'delete_path', 'deleting files and directories', [path]),
    matchKeys: [...pathRuleKeys(root, 'delete_path', [path]), 'delete_path'],
    hazards: pathHazards(root, 'delete_path', [path], recursive),
  }
}

/** Minimal line diff (longest-common-subsequence) used by `propose_edit`. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  // table[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const width = b.length + 1
  const table = new Int32Array((a.length + 1) * width)
  const lcs = (i: number, j: number): number => table[i * width + j] ?? 0
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? lcs(i + 1, j + 1) + 1
        : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'ctx', text: a[i] as string })
      i += 1
      j += 1
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      lines.push({ kind: 'del', text: a[i] as string })
      i += 1
    } else {
      lines.push({ kind: 'add', text: b[j] as string })
      j += 1
    }
  }
  for (; i < a.length; i += 1) lines.push({ kind: 'del', text: a[i] as string })
  for (; j < b.length; j += 1) lines.push({ kind: 'add', text: b[j] as string })
  return lines
}

/**
 * Short human labels for the sample's tools.
 *
 * Used by the run's progress line, which has to name what it is waiting on in
 * words a person recognises — "Running a command" reads, `run_command` does not.
 */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  read_file: 'reading a file',
  list_directory: 'listing files',
  search_files: 'searching',
  propose_edit: 'preparing a diff',
  write_file: 'writing a file',
  edit_file: 'editing a file',
  delete_path: 'deleting',
  create_directory: 'creating a folder',
  move_path: 'moving a file',
  run_command: 'running a command',
  write_todos: 'updating the plan',
  fetch_url: 'fetching a page',
  wait_agents: 'waiting for another agent',
  send_message: 'messaging another agent',
  spawn_agent: 'starting another agent',
  close_agent: 'closing another agent',
  load_skill: 'loading a skill',
  read_tool_output: 'reading saved output',
}
