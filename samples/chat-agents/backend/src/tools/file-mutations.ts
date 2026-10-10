import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import type { DiffLine } from '../wire'
import { json, card, requireString, optionalBoolean } from './values'
import { inRoot } from './paths'
import { currentText, replaceOnce, diffLines } from './text'

export function writeFileTool(root: string) {
  return defineTool({
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
  })
}

export function editFileTool(root: string) {
  return defineTool({
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
  })
}

export function deletePathTool(root: string) {
  return defineTool({
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
  })
}

export function createDirectoryTool(root: string) {
  return defineTool({
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
  })
}

export function movePathTool(root: string) {
  return defineTool({
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
  })
}
