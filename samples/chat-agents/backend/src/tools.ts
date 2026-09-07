/**
 * Demo tool set for the sample. Every tool is read-only or preview-only: the
 * agent can inspect the workspace and propose an edit, but nothing here writes
 * to disk. Each tool returns a `meta.card` — the UI card model the frontend
 * renders instead of raw JSON (see `wire.ts`).
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { defineTool, ToolRegistry } from '@ai-agent-sdk/core/agent'
import type { JsonObject, JsonValue } from '@ai-agent-sdk/core'
import type { DiffLine, SearchMatch, TodoItem, ToolCard } from './wire'

const MAX_READ_LINES = 400
const MAX_MATCHES = 60
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage'])

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

  tools.register(defineTool({
    name: 'write_todos',
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
    description: 'Fetch an https page and return its readable text.',
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
    execute: async ({ url }) => {
      const response = await fetch(url, { redirect: 'follow' })
      const html = (await response.text()).slice(0, 200_000)
      const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? url
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8_000)
      return { url, title, status: response.status, text }
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
