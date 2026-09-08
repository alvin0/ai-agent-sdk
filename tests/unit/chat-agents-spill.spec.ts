import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'spill-'))
process.env.CHAT_AGENTS_SPILL = root

const { createFileSpillStore, spillRoot, sweepSpill } =
  await import('../../samples/chat-agents/backend/src/spill.ts')

const store = createFileSpillStore()

describe('chat-agents spill store', () => {
  it('saves the whole text and reads it back through the locator', async () => {
    const text = 'line one\nline two\nline three'
    const record = await store.save(text, { toolName: 'run_command', callId: 'c1' })

    expect(record.bytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(record.retrieval).toContain('read_tool_output')
    const slice = await store.read(record.locator, { offset: 0, limit: 1_000 })
    expect(slice?.text).toBe(text)
    expect(slice?.totalChars).toBe([...text].length)
  })

  it('pages through a long result', async () => {
    const record = await store.save('abcdefghij', { toolName: 'read_file', callId: 'c2' })
    const first = await store.read(record.locator, { offset: 0, limit: 4 })
    expect(first).toMatchObject({ text: 'abcd', offset: 0, totalChars: 10 })
    const second = await store.read(record.locator, { offset: 4, limit: 4 })
    expect(second).toMatchObject({ text: 'efgh', offset: 4 })
  })

  it('searches by line and reports the line number', async () => {
    const record = await store.save('alpha\nbeta\ngamma', { toolName: 'grep', callId: 'c3' })
    expect(await store.search(record.locator, '^g', 10)).toEqual(['3: gamma'])
  })

  it('refuses a locator that is not one of its own', async () => {
    // A locator travels through the model, so by the time it comes back it is
    // attacker-influenced text. Anything but the exact shape resolves to
    // nothing rather than to a path.
    const outside = join(root, '..', 'passwd')
    writeFileSync(outside, 'secret', 'utf8')
    for (const locator of [
      'spill:../passwd',
      `spill:${outside}`,
      '/etc/passwd',
      'spill:',
      'spill:NOTHEX00000000000000000000000000',
      'spill:0011',
    ]) {
      expect(await store.read(locator, { offset: 0, limit: 100 })).toBeUndefined()
      expect(await store.search(locator, '.', 10)).toBeUndefined()
    }
  })

  it('reports an unknown but well-formed locator as missing', async () => {
    expect(await store.read(`spill:${'a'.repeat(32)}`, { offset: 0, limit: 10 })).toBeUndefined()
  })

  it('keeps its files out of the workspace', () => {
    // The agent's own read and write tools are confined to the workspace. Spill
    // inside it would let one run read, edit, or delete another conversation's
    // output through the ordinary file tools.
    expect(spillRoot()).toBe(root)
  })

  it('sweeps files past the retention window and keeps fresh ones', async () => {
    const fresh = await store.save('fresh', { toolName: 'run_command', callId: 'c4' })
    const stale = await store.save('stale', { toolName: 'run_command', callId: 'c5' })
    const staleId = stale.locator.slice('spill:'.length)
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000)
    utimesSync(join(root, `${staleId}.txt`), old, old)

    expect(sweepSpill()).toBeGreaterThanOrEqual(1)
    expect(await store.read(stale.locator, { offset: 0, limit: 10 })).toBeUndefined()
    expect((await store.read(fresh.locator, { offset: 0, limit: 10 }))?.text).toBe('fresh')
    expect(readdirSync(root).some(name => name === `${staleId}.txt`)).toBe(false)
  })
})
