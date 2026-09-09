/** Safe, read-only host tools used by the human CLI. */

import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineTool } from '@ai-agent-sdk/core/agent'
import { ToolRegistry } from '@ai-agent-sdk/core/agent'

export function createHumanToolRegistry(workspaceRoot: string): ToolRegistry {
  const root = resolve(workspaceRoot)
  const tools = new ToolRegistry()

  tools.register(defineTool({
    name: 'calculate',
    description: 'Perform one basic arithmetic operation. Use this instead of mental arithmetic.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['operation', 'a', 'b'],
      additionalProperties: false,
    },
    parse(raw) {
      const value = raw as { operation?: unknown; a?: unknown; b?: unknown }
      if (!['add', 'subtract', 'multiply', 'divide'].includes(String(value.operation))) {
        throw new Error('operation must be add, subtract, multiply, or divide')
      }
      if (typeof value.a !== 'number' || typeof value.b !== 'number') {
        throw new Error('a and b must be numbers')
      }
      return { operation: value.operation as 'add' | 'subtract' | 'multiply' | 'divide', a: value.a, b: value.b }
    },
    execute({ operation, a, b }) {
      if (operation === 'divide' && b === 0) throw new Error('division by zero')
      const result = operation === 'add' ? a + b
        : operation === 'subtract' ? a - b
          : operation === 'multiply' ? a * b : a / b
      return { operation, a, b, result }
    },
    isConcurrencySafe: () => true,
  }))

  tools.register(defineTool({
    name: 'list_directory',
    description: 'List entries in one directory inside the current workspace. This tool is read-only.',
    parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
    },
    parse(raw) {
      const path = (raw as { path?: unknown }).path
      if (typeof path !== 'string' || path.length === 0) throw new Error('path must be a non-empty string')
      return { path }
    },
    async execute({ path }) {
      const target = resolveWorkspacePath(root, path)
      const entries = await readdir(target, { withFileTypes: true })
      return {
        path: relative(root, target) || '.',
        entries: entries.slice(0, 200).map(entry => ({
          name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        })),
        truncated: entries.length > 200,
      }
    },
    isConcurrencySafe: () => true,
  }))

  tools.register(defineTool({
    name: 'read_text_file',
    description: 'Read up to 50,000 characters from a UTF-8 text file inside the current workspace. This tool is read-only.',
    parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
    },
    parse(raw) {
      const path = (raw as { path?: unknown }).path
      if (typeof path !== 'string' || path.length === 0) throw new Error('path must be a non-empty string')
      return { path }
    },
    async execute({ path }) {
      const target = resolveWorkspacePath(root, path)
      const text = await readFile(target, 'utf8')
      return {
        path: relative(root, target),
        text: text.slice(0, 50_000),
        truncated: text.length > 50_000,
      }
    },
    isConcurrencySafe: () => true,
  }))

  return tools
}

export function resolveWorkspacePath(root: string, requested: string): string {
  const target = resolve(root, requested)
  const fromRoot = relative(root, target)
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    throw new Error(`path escapes workspace: ${requested}`)
  }
  return target
}
