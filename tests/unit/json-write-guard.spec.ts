import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import {
  dispatchToolCall, ToolRegistry, validateJsonFileContent, type JsonWriteGuardOptions,
} from '@alvin0/ai-agent-sdk-core/agent'
import { createSampleTools } from '../../samples/chat-agents/backend/src/tools.ts'
import { createAgentCodeToolRegistry } from '../../test-human/agentcode/tools/registry.ts'
import { Workspace, workspaceTools } from '../../test-human/multi-agent-bench/workspace.ts'
import { tasks } from '../../test-human/multi-agent-bench/tasks.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(host: string, options: JsonWriteGuardOptions = {}) {
  let root: string
  let tools: ToolRegistry
  if (host === 'benchmark') {
    const workspace = await Workspace.create(tasks[0]!, tmpdir(), options)
    root = workspace.root
    tools = new ToolRegistry()
    workspaceTools(workspace).forEach(tool => tools.register(tool))
  } else {
    root = await mkdtemp(join(tmpdir(), 'json-guard-'))
    tools = host === 'chat' ? createSampleTools(root, options) : createAgentCodeToolRegistry(root, options)
  }
  roots.push(root)
  const call = (toolName: string, args: object) => dispatchToolCall({
    catalog: tools, call: { callId: ToolCallId('json-test'), toolName, rawArguments: JSON.stringify(args) },
    position: { turn: 1, step: 1 }, signal: new AbortController().signal,
  })
  return {
    root, write: (path: string, content: string) => call('write_file', { path, content }),
    edit: (path: string, oldText: string, newText: string) => host === 'benchmark'
      ? call('edit_file', { path, edits: [{ old: oldText, new: newText }] })
      : call(host === 'chat' ? 'edit_file' : 'replace_in_file', { path, oldText, newText }),
  }
}

describe.each(['chat', 'agentcode', 'benchmark'])('%s workspace JSON writes', host => {
  it.each(['{\r\n  "name": "Việt 日本 😀", "n": 1e2\r\n}\n', '\uFEFF[1, null, true]\n', '42', '"text"']) (
    'preserves valid JSON bytes exactly: %j', async content => {
      const f = await fixture(host)
      expect((await f.write('output.JsOn', content)).isError).toBe(false)
      expect(await readFile(join(f.root, 'output.JsOn'))).toEqual(Buffer.from(content))
    },
  )

  it('rejects an invalid new file without creating it or its parent directory', async () => {
    const f = await fixture(host)
    const result = await f.write('new/output.json', '[1 2]')
    expect(result).toMatchObject({ isError: true, error: { code: 'INVALID_ARGUMENTS' } })
    await expect(readFile(join(f.root, 'new/output.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(f.root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects invalid overwrite and edit without changing existing bytes, then accepts a corrected edit', async () => {
    const f = await fixture(host)
    const original = '{\n  "items": [1, 2]\n}\n'
    await f.write('output.json', original)
    expect((await f.write('output.json', '{')).isError).toBe(true)
    expect(await readFile(join(f.root, 'output.json'), 'utf8')).toBe(original)
    expect((await f.edit('output.json', '1, 2', '1 2')).isError).toBe(true)
    expect(await readFile(join(f.root, 'output.json'), 'utf8')).toBe(original)
    expect((await f.edit('output.json', '1, 2', '3, 4')).isError).toBe(false)
    expect(await readFile(join(f.root, 'output.json'), 'utf8')).toBe(original.replace('1, 2', '3, 4'))
  })

  it('can repair an already-invalid file by validating only its final content', async () => {
    const f = await fixture(host)
    await writeFile(join(f.root, 'output.json'), '[1 2]')
    expect((await f.edit('output.json', '1 2', '1, 2')).isError).toBe(false)
    expect(await readFile(join(f.root, 'output.json'), 'utf8')).toBe('[1, 2]')
  })

  it.each(['', ' \r\n\t', '\uFEFF'])('rejects empty JSON: %j', async content => {
    const f = await fixture(host)
    expect((await f.write('output.json', content)).isError).toBe(true)
  })

  it.each(['output.txt', 'output.jsonc', 'output.json5'])('leaves %s unvalidated for writes and edits', async path => {
    const f = await fixture(host)
    expect((await f.write(path, '{invalid}')).isError).toBe(false)
    expect((await f.edit(path, '{invalid}', '')).isError).toBe(false)
    expect(await readFile(join(f.root, path), 'utf8')).toBe('')
  })

  it('lets the host opt out for both writes and edits', async () => {
    const f = await fixture(host, { validateJsonWrites: false })
    expect((await f.write('output.JSON', '{invalid}')).isError).toBe(false)
    expect((await f.edit('output.JSON', '{invalid}', '')).isError).toBe(false)
    expect(await readFile(join(f.root, 'output.JSON'), 'utf8')).toBe('')
  })

  it('returns a recoverable tool error with path, parse reason, location, excerpt and correction hint', async () => {
    const f = await fixture(host)
    const content = '{\n  "items": [1 2]\n}'
    const result = await f.write('output.json', content)
    expect(result).toMatchObject({ isError: true, error: { code: 'INVALID_ARGUMENTS' } })
    if (!result.isError) throw new Error('Expected a tool error')
    expect(result.error.message).toContain('Invalid JSON in "output.json"')
    expect(result.error.message).toContain('Expected')
    expect(result.error.message).toContain('line 2, column 15')
    expect(result.error.message).toContain(`Near: ${JSON.stringify(content)}`)
    expect(result.error.message).toContain('Fix the JSON and retry; no file was written.')
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Error: Invalid JSON') })
  })
})

describe('portable JSON diagnostics', () => {
  it.each([
    ['{\n  "x": }', 2, 8], ['{\n  "x": truX}', 2, 11], ['[1,]', 1, 4],
    ['\uFEFF[1 2]', 1, 5], ['{\r\n  "x": [1 2]}', 2, 11], ['', 1, 1], ['[1,', 1, 4],
  ] as const)('locates syntax failure in %j', (content, line, column) => {
    expect(() => validateJsonFileContent('test.json', content)).toThrow(`line ${line}, column ${column}.`)
  })

  it('bounds the excerpt for large output and locates failure after a non-ASCII string', () => {
    const content = JSON.stringify({ label: '😀日本', entries: Array.from({ length: 2000 }, () => 1) })
      .replace('1,1', '1 1')
    let message = ''
    try { validateJsonFileContent('test.json', content) } catch (error) { message = (error as Error).message }
    expect(message).toContain(`column ${content.indexOf('1 1') + 3}.`)
    const excerpt = message.split('Near: ')[1]!.split('. Fix the JSON')[0]!
    expect((JSON.parse(excerpt) as string).length).toBeLessThanOrEqual(80)
    expect(message.length).toBeLessThan(500)
  })

  it('validates a benchmark edit batch after every replacement is applied', async () => {
    const workspace = await Workspace.create(tasks[0]!)
    roots.push(workspace.root)
    await workspace.write('batch.json', '{"a": 1, "b": 2}')
    await workspace.edit('batch.json', [{ old: '1,', new: '1' }, { old: '"b"', new: ', "b"' }])
    expect(await workspace.readAll('batch.json')).toBe('{"a": 1 , "b": 2}')
  })

  it('locates deeply nested unexpected tokens without recursive diagnostic parsing', () => {
    const content = '['.repeat(12_000) + 'BAD' + ']'.repeat(12_000)
    expect(() => validateJsonFileContent('deep.json', content)).toThrow('line 1, column 12001.')
  })
})
