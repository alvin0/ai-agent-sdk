import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import type { DiffLine, SearchMatch } from '../wire'
import { json, card, optionalString, requireString } from './values'
import { inRoot, walk } from './paths'
import { diffLines } from './text'

export const MAX_READ_LINES = 400

export const MAX_MATCHES = 60

export function readFileTool(root: string) {
  return defineTool({
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
      const record = value as {
        firstLine: number; lines: string[]; truncated?: boolean; totalLines?: number
      } | undefined
      if (record === undefined) return [{ type: 'text', text: '(no output)' }]
      const body = record.lines.map((line, index) => `${record.firstLine + index}\t${line}`).join('\n')
      // The model reads only this text. Without the footer a 3,000-line log
      // read as "a 400-line file", and a worker reported counts from the first
      // page as the whole answer (observed live).
      if (record.truncated !== true) return [{ type: 'text', text: body }]
      const last = record.firstLine + record.lines.length - 1
      const footer = `[Showing lines ${String(record.firstLine)}-${String(last)} `
        + `of ${String(record.totalLines ?? '?')}. `
        + `The file continues: read again with offset ${String(last + 1)}, `
        + 'or use search_files or run_command to scan it all.]'
      return [{ type: 'text', text: `${body}\n\n${footer}` }]
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
  })
}

export function listDirectoryTool(root: string) {
  return defineTool({
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
  })
}

export function searchFilesTool(root: string) {
  return defineTool({
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
      let limited = false
      for await (const file of walk(absolute, 4)) {
        if (matches.length >= MAX_MATCHES) { limited = true; break }
        let text: string
        try {
          text = await readFile(file, 'utf8')
        } catch {
          continue
        }
        const lines = text.split('\n')
        for (const [index, line] of lines.entries()) {
          if (!line.toLowerCase().includes(needle)) continue
          if (matches.length >= MAX_MATCHES) { limited = true; break }
          matches.push({ path: relative(root, file), line: index + 1, text: line.slice(0, 240) })
        }
      }
      // A capped list reads as "all the matches" unless it says otherwise, and a
      // model counting occurrences would report the cap as the count.
      return json({ query, matches, ...limited ? {
        limited: true,
        note: `Stopped at ${String(MAX_MATCHES)} matches; additional matches may exist. `
          + 'Narrow the query or path, or count with run_command.',
      } : {} })
    },
    meta: value => {
      const record = value as { query: string; matches: SearchMatch[] } | undefined
      return record === undefined ? undefined : card({ kind: 'search', query: record.query, matches: record.matches })
    },
  })
}

export function proposeEditTool(root: string) {
  return defineTool({
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
  })
}
