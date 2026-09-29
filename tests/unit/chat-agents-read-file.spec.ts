import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const { createSampleTools } = await import('../../samples/chat-agents/backend/src/tools.ts')
const root = mkdtempSync(join(tmpdir(), 'chat-agents-read-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function read(path: string, offset?: number) {
  const tool = createSampleTools(root).get('read_file')!
  const args = tool.parse!({ path, ...offset === undefined ? {} : { offset } })
  const value = await tool.execute(args as never, {} as never)
  return tool.render!(value as never, args as never).map(block => block.type === 'text' ? block.text : '').join('')
}

describe('chat-agents read_file tells the model when a file continues', () => {
  it('ends a partial page with the range, the total and the next offset', async () => {
    writeFileSync(join(root, 'big.log'), Array.from({ length: 1000 }, (_, i) => `line ${String(i + 1)}`).join('\n'))
    const first = await read('big.log')
    expect(first).toContain('[Showing lines 1-400 of 1000.')
    expect(first).toContain('offset 401')
    const last = await read('big.log', 801)
    expect(last).not.toContain('[Showing lines')
    expect(last.trim().endsWith('1000\tline 1000')).toBe(true)
  })

  it('adds nothing to a file that fits', async () => {
    writeFileSync(join(root, 'small.txt'), 'a\nb\n')
    expect(await read('small.txt')).toBe('1\ta\n2\tb\n3\t')
  })
})

describe('chat-agents search_files and run_command say when they stopped early', () => {
  it('marks a capped search as limited', async () => {
    writeFileSync(join(root, 'many.log'), Array.from({ length: 200 }, (_, i) => `ERROR ${String(i)}`).join('\n'))
    const tool = createSampleTools(root).get('search_files')!
    const args = tool.parse!({ query: 'ERROR', path: '.' })
    const value = await tool.execute(args as never, { signal: new AbortController().signal } as never) as { matches: unknown[]; limited?: boolean }
    expect(value.matches).toHaveLength(60)
    expect(value.limited).toBe(true)
    const few = await tool.execute(tool.parse!({ query: 'ERROR 199', path: '.' }) as never, { signal: new AbortController().signal } as never) as { limited?: boolean }
    expect(few.limited).toBeUndefined()
  })

  it('marks cut command output', async () => {
    const tool = createSampleTools(root).get('run_command')!
    const args = tool.parse!({ command: `node -e "process.stdout.write('x'.repeat(30000))"` })
    const value = await tool.execute(args as never, { signal: new AbortController().signal } as never) as { output: string }
    expect(value.output).toContain('[output truncated at 20000 characters')
  }, 30_000)
})
