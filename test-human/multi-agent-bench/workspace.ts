import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { defineTool, type ToolDefinition } from '../../packages/core/dist/index.js'
import * as coreTools from '../../packages/core/dist/tools.js'
import type { JsonWriteGuardOptions } from '../../packages/core/dist/tools.js'
import { artifactChecks, checkCount, fixtureRoot, type Task } from './tasks.ts'

import { auditChecks } from './volume-grade.ts'
import { sandboxChecks, sandboxScript } from './sandbox.ts'
export { sandboxChecks } from './sandbox.ts'

if (typeof coreTools.validateJsonFileContent !== 'function') {
  throw new Error('Benchmark requires core validateJsonFileContent; rebuild @alvin0/ai-agent-sdk-core before running')
}

function validatePage(offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16384) {
    throw new Error('Expected byte offset >=0 and limit between 1 and 16384')
  }
}
function pageEnd(bytes: Buffer, offset: number, limit: number): number {
  if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error('Offset splits a UTF-8 character')
  let end = Math.min(bytes.length, offset + limit)
  while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--
  if (end === offset && offset < bytes.length) throw new Error('Limit splits a UTF-8 character')
  return end
}

export class Workspace {
  readonly root: string
  readonly task: Task
  private readonly options: JsonWriteGuardOptions
  private constructor(root: string, task: Task, options: JsonWriteGuardOptions) {
    this.root = root; this.task = task; this.options = options
  }
  static async create(task: Task, parent = tmpdir(), options: JsonWriteGuardOptions = {}) {
    const root = await mkdtemp(join(parent, 'ma-bench-'))
    if (task.files) {
      for (const [name, content] of Object.entries(task.files)) {
        const path = join(root, name)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
      }
    } else await cp(join(fixtureRoot, task.id), root, { recursive: true })
    return new Workspace(root, task, options)
  }
  async path(name: string) {
    if (!name || isAbsolute(name) || name.includes('\0')) throw new Error('Expected relative workspace path')
    const target = resolve(this.root, name)
    const rel = relative(this.root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path outside workspace')
    let current = this.root
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part)
      const stat = await lstat(current).catch(() => undefined)
      if (stat?.isSymbolicLink()) throw new Error('Symlinks are forbidden')
    }
    return target
  }
  async files(directory = '.'): Promise<string[]> {
    const entries = await readdir(await this.path(directory), { withFileTypes: true })
    const groups = await Promise.all(entries.map(async entry => {
      const name = join(directory, entry.name)
      return entry.isDirectory() ? this.files(name) : [name]
    }))
    return groups.flat().sort()
  }
  async readAll(name: string) { return readFile(await this.path(name), 'utf8') }
  async page(name: string, offset = 0, limit = 16384) {
    validatePage(offset, limit)
    const bytes = Buffer.from(await this.readAll(name))
    const end = pageEnd(bytes, offset, limit)
    return { content: bytes.subarray(offset, end).toString('utf8'),
      nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length }
  }
  async read(name: string, offset = 0, limit = 16384) { return (await this.page(name, offset, limit)).content }
  async write(name: string, content: string) {
    if (Buffer.byteLength(content) > 65536) throw new Error('Write exceeds 64 KiB')
    const files = await this.files()
    if (files.length >= 128 && !files.includes(name)) throw new Error('Workspace file limit exceeded')
    const path = await this.path(name)
    if (this.task.frozen?.includes(relative(this.root, path))) {
      throw new Error('Frozen shared interface or healthy module')
    }
    coreTools.validateJsonFileContent(relative(this.root, path), content, this.options)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    return { written: name }
  }
  private editTail: Promise<unknown> = Promise.resolve()
  async edit(name: string, edits: { old: string; new: string }[]) {
    // Serialize edit batches so concurrent workers cannot lose another batch's changes.
    const apply = async () => {
      if (!Array.isArray(edits) || edits.length === 0) throw new Error('Expected at least one edit')
      let content = await this.readAll(name)
      for (const edit of edits) {
        if (typeof edit.old !== 'string' || !edit.old || typeof edit.new !== 'string') {
          throw new Error('Each edit requires a nonempty old string and a new string')
        }
        const index = content.indexOf(edit.old)
        if (index < 0 || content.indexOf(edit.old, index + 1) >= 0) {
          throw new Error('Each old string must match exactly once; no edits were written')
        }
        content = content.slice(0, index) + edit.new + content.slice(index + edit.old.length)
      }
      return this.write(name, content)
    }
    const pending = this.editTail.then(apply)
    this.editTail = pending.catch(() => undefined)
    return pending
  }
  async grade(signal?: AbortSignal) {
    const count = checkCount(this.task)
    let checks: boolean[], error: string | undefined
    try { checks = this.task.checks.length ? await this.test(signal) : await artifactChecks(this.task, this.root) }
    catch (caught) {
      checks = Array.from({ length: count - (this.task.frozen?.length ?? 0) }, () => false)
      error = String(caught)
    }
    for (const name of this.task.frozen ?? []) {
      checks.push(await this.readAll(name).then(text => text === this.task.files?.[name], () => false))
    }
    if (checks.length !== count) throw new Error(`Grader denominator mismatch: ${checks.length}/${count}`)
    return { ...await this.auditQuality(), score: checks.filter(Boolean).length / count,
      pass: count > 0 && checks.every(Boolean), checks, ...(error ? { error } : {}) }
  }
  private async auditQuality(): Promise<{ precision?: number; recall?: number }> {
    if (!this.task.auditFindings) return {}
    const answer = await this.readAll('findings.json').then(text => {
      try { return JSON.parse(text) as unknown } catch { return {} }
    }, () => ({}))
    const { precision, recall } = auditChecks(this.task, answer)
    return { precision, recall }
  }
  async test(signal?: AbortSignal, module?: string) {
    const names = (await this.files()).filter(name => name.endsWith('.cjs'))
    const sources = await Promise.all(names.map(async name => [name, await this.readAll(name)] as const))
    const checks = module ? this.task.moduleChecks?.[module] : this.task.checks
    if (!checks) throw new Error('Unknown test module')
    return sandboxChecks(Object.fromEntries(sources), checks, signal)
  }
  async run(script: string, output: string, signal?: AbortSignal) {
    if (!this.task.checks.length || this.task.kind === 'volume') {
      throw new Error('No script execution for reading-volume or artifact tasks')
    }
    const pages: Record<string, unknown[]> = {}
    for (const name of await this.files()) {
      const chunks: unknown[] = []
      let offset: number | null = 0
      while (offset !== null) {
        const page = await this.page(name, offset)
        chunks.push({ offset, ...page }); offset = page.nextOffset
      }
      pages[name] = chunks
    }
    const value = await sandboxScript(await this.readAll(script), pages, signal)
    return this.write(output, JSON.stringify(value))
  }
  async close() { await rm(await realpath(this.root), { recursive: true, force: true }) }
}

const parameters = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false })
const string = { type: 'string' }

export function workspaceTools(workspace: Workspace): ToolDefinition<any>[] {
  return [
    defineTool<{ path: string; offset?: number; limit?: number }>({ name: 'read_file',
      description: 'Read up to 16 KiB of a UTF-8 file. Byte offset defaults to 0; page using nextOffset until null.',
      parameters: parameters({ path: string, offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 16384 } }, ['path']),
      execute: args => workspace.page(args.path, args.offset, args.limit) }),
    defineTool<{ path: string; content: string }>({ name: 'write_file',
      description: 'Write a UTF-8 workspace file (64 KiB max). Parent directories are created.',
      parameters: parameters({ path: string, content: string }, ['path', 'content']),
      execute: args => workspace.write(args.path, args.content) }),
    defineTool<{ path: string; edits: { old: string; new: string }[] }>({ name: 'edit_file',
      description: 'Apply exact old-to-new string replacements to a UTF-8 file, in order. '
        + 'Batch multiple edits per call. Each nonempty old string must match exactly once; '
        + 'otherwise the entire batch fails without writing. Existing write limits apply.',
      parameters: parameters({ path: string, edits: { type: 'array', minItems: 1,
        items: parameters({ old: { type: 'string', minLength: 1 }, new: string }, ['old', 'new']) } },
      ['path', 'edits']), execute: args => workspace.edit(args.path, args.edits) }),
    defineTool({ name: 'list_files', description: 'List workspace files recursively.',
      parameters: parameters({}, []), execute: () => workspace.files() }),
    defineTool<{ query: string }>({ name: 'search_files', 
      description: 'Literal substring search; at most 40 matching lines and 16 KiB. Not an aggregation tool.',
      parameters: parameters({ query: string }, ['query']), execute: async args => {
        const matches = await Promise.all((await workspace.files()).map(async path =>
          ({ path, lines: (await workspace.readAll(path)).split('\n')
            .filter(line => line.includes(args.query)).slice(0, 40) })))
        let remaining = 16384, lines = 40
        return matches.filter(match => match.lines.length).flatMap(match => {
          const selected: string[] = []
          for (const line of match.lines) {
            const bytes = Buffer.byteLength(line) + Buffer.byteLength(match.path) + 64
            if (lines <= 0 || bytes > remaining) break
            selected.push(line); remaining -= bytes; lines--
          }
          return selected.length ? [{ path: match.path, lines: selected }] : []
        })
      } }),
    defineTool<{ command: string }>({ name: 'shell',
      description: workspace.task.kind === 'volume' ? 'Isolated runner: test [package] only.'
        : 'Isolated runner: test [module], or run <script.cjs> <output.json>. '
        + 'Scripts export run() returning JSON, using read_file(path,offset) pages and list_files().',
      parameters: parameters({ command: string }, ['command']), execute: async (args, context) => {
        const match = /^test(?: ([a-z][\w-]*))?$/.exec(args.command)
        if (match) return { checks: await workspace.test(context.signal, match[1]) }
        if (workspace.task.kind === 'volume') throw new Error('Only test [package] is allowed')
        const run = /^run ([\w./-]+\.cjs) ([\w./-]+\.json)$/.exec(args.command)
        if (!run) throw new Error('Only test or run <script.cjs> <output.json> is allowed')
        return workspace.run(run[1]!, run[2]!, context.signal)
      } }),
  ].filter(tool => tool.name !== 'shell' || workspace.task.checks.length > 0)
}
