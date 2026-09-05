import { readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { defineTool, ToolRegistry } from '@ai-agent-sdk/core/agent'
import { ensureAgentCodeWorkspace, resolveExistingAgentCodePath, resolveWritableAgentCodePath } from '../workspace.ts'
import { createWindowsCommandProcessCleanup } from '../process-cleanup.ts'
import { DEFAULT_MAX_DIRECTORIES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_WRITE_BYTES, MAX_COMMAND_OUTPUT_CHARS, MAX_GREP_CHARS, MAX_READ_CHARS, SEARCH_EXCLUDES, type AgentCodeResolvedCommand, type AgentCodeToolRegistryOptions } from './types.ts'
import { boundedInteger, countOccurrences, npmInvocation, optionalBoolean, optionalString, record, requiredString, shouldTrackDetachedNpmDescendants, stringValue, validateResolvedCommand } from './validation.ts'
import { portableGrepMatch, portableRelative, streamLineRange, takeBoundedLines, walk } from './filesystem.ts'
import { runProcess } from './process.ts'
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
