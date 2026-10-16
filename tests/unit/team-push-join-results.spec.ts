import { describe, expect, it, vi } from 'vitest'
import { closeManagedWorker } from '../../packages/core/src/agent/team/managed-close.ts'
import { TeamResults } from '../../packages/core/src/agent/team/team-results.ts'
import { GatedTeam, create, tool } from './team-push-join.fixture.ts'

describe('bounded retained worker results', () => {
  it('marks structured pages truncated only when they omit part of the retained value', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter, { autoLeadCoordination: false })
    await team.spawn({ name: 'w', task: 'Research' })
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    const structured = { detail: 'x'.repeat(500) }
    team.team.recordOutcome('w', { kind: 'completed', text: 'done', structured })
    const full = await tool(team, 'get_agent_result', { target: 'w', field: 'structured' })
    expect(full.result.structuredTruncated).toBe(false)
    expect(full.result.structuredPreview).toBe(JSON.stringify(structured))
    expect(full.page.nextOffset).toBeNull()
    const first = await tool(team, 'get_agent_result', { target: 'w', field: 'structured', maxBytes: 256 })
    expect(first.result.structuredTruncated).toBe(true)
    const tail = await tool(team, 'get_agent_result', { target: 'w', field: 'structured', offset: 256 })
    expect(tail.result.structuredTruncated).toBe(true)
    expect(tail.page.nextOffset).toBeNull()
  })

  it('preserves closing text when a worker completes during cancellation', async () => {
    const runtime = { request: { name: 'w', writes: [] }, status: 'running', dependencies: [],
      controller: new AbortController(), session: { isRunning: false }, settled: Promise.resolve(),
      markSettled: vi.fn(), evidence: {}, result: undefined as { text: string } | undefined }
    const recordOutcome = vi.fn()
    const previous = await closeManagedWorker(runtime as never, new Error('close'), {
      closeTimeoutMs: 100, workerRuntimes: new Map([['w', runtime]]),
      team: { cancel: async () => { runtime.result = { text: 'Completed report at the close boundary' } },
        releaseSlot: vi.fn(), recordOutcome, detach: vi.fn() },
      scheduling: { workerHasWork: () => false, releaseDependents: async () => {} },
    } as never)
    expect(previous).toBe('running')
    expect(recordOutcome).toHaveBeenCalledWith('w', { kind: 'failed', status: 'cancelled',
      message: 'Worker cancelled', text: 'Completed report at the close boundary' })
  })

  it('delivers typical 6 KiB reports without a second result read', async () => {
    const adapter = new GatedTeam()
    adapter.workerText = 'finding ' + 'x'.repeat(6_000)
    const team = create(adapter)
    const running = team.run('Research')
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    adapter.gates.get('w')!.resolve()
    await running
    const notice = team.lead.history.messages().find(message => message.source.kind === 'app'
      && message.source.producer === 'managed-team-settlement')
    expect(JSON.stringify(notice)).toContain(adapter.workerText)
    expect(JSON.stringify(notice)).not.toContain('… (truncated; read full result) …')
  })

  it('bounds aggregate compact fields including escaped text and structured errors', () => {
    const members = Array.from({ length: 7 }, (_, index) => ({ name: `w${index}`, kind: 'local',
      status: 'idle', outcome: { kind: 'failed', text: '\u0000"\\😀'.repeat(8_000),
        message: 'error'.repeat(10_000), structured: { data: 'x'.repeat(20_000) } } }))
    const results = new TeamResults().take('lead', members as never)
    expect(results).toHaveLength(7)
    expect(new TextEncoder().encode(JSON.stringify(results)).byteLength).toBeLessThan(48 * 1024)
  })

  it('pages text, structured data, and errors without splitting Unicode or consuming delivery', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter, { autoLeadCoordination: false })
    await team.spawn({ name: 'w', task: 'Research' })
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    const text = '😀漢字'.repeat(4_000)
    const structured = { detail: text }
    team.team.recordOutcome('w', { kind: 'failed', text, message: text, structured })
    for (const field of ['text', 'structured', 'error']) {
      let offset = 0
      let collected = ''
      for (;;) {
        const page = await tool(team, 'get_agent_result', { target: 'w', field, offset, maxBytes: 1024 })
        const chunk = pageField(field, page.result)
        expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(1024)
        collected += chunk
        if (page.page.nextOffset === null) break
        expect(page.page.nextOffset).toBeGreaterThan(offset)
        offset = page.page.nextOffset
      }
      expect(collected).toBe(field === 'structured' ? JSON.stringify(structured) : text)
    }
    expect((await tool(team, 'wait_agents', { targets: ['w'] })).results).toHaveLength(1)
    expect((await tool(team, 'wait_agents', { targets: ['w'] })).results).toHaveLength(0)
  })

  it.each([{ offset: -1 }, { offset: 1.5 }, { offset: 999999 }, { maxBytes: 65536 },
    { maxBytes: 0 }, { field: 'history' }, { unknown: true }])('rejects invalid result paging %j', async args => {
    const adapter = new GatedTeam()
    const team = create(adapter)
    await team.spawn({ name: 'w', task: 'Research' })
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    await expect(tool(team, 'get_agent_result', { target: 'w', ...args })).rejects.toThrow()
  })
})

function pageField(field: string, result: { structuredPreview?: string; message?: string; text: string }): string {
  if (field === 'structured') return result.structuredPreview!
  if (field === 'error') return result.message!
  return result.text
}
