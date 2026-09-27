import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'chat-session-admission-'))
process.env.CHAT_AGENTS_DB = join(scratch, 'app.db')
process.env.CHAT_AGENTS_WORKSPACE = join(scratch, 'workspace')
process.env.CHAT_AGENTS_SPILL = join(scratch, 'spill')
process.env.CHAT_AGENTS_MIGRATIONS = resolve('samples/chat-agents/backend/drizzle')
const { session, forgetSession } = await import('../../samples/chat-agents/backend/src/session.ts')
const ids = new Set<string>()
afterEach(() => { for (const id of ids) forgetSession(id); ids.clear() })

describe('chat-agents live session admission', () => {
  it('shares one history, approval broker and sequence counter across concurrent cold touches', async () => {
    const id = 'cold-admission'; ids.add(id)
    const results = await Promise.all(Array.from({ length: 8 }, () => session(id)))
    expect(new Set(results.map(result => result.history)).size).toBe(1)
    expect(new Set(results.map(result => result.broker)).size).toBe(1)
    expect(new Set(results).size).toBe(1)
    expect(await session(id)).toBe(results[0])
  })

  it('does not publish a hydration forgotten while it was pending', async () => {
    const id = 'forgotten-hydration'; ids.add(id)
    const pending = session(id)
    forgetSession(id)
    await expect(pending).rejects.toThrow(/closed/i)
    const fresh = await session(id)
    expect(await session(id)).toBe(fresh)
  })
})
