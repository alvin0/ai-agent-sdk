import { beforeEach, describe, expect, it } from 'vitest'
import { edgeChatWorker, resetEdgeChatForTests } from './app.ts'
import { edgeFixtureRequests } from './scripted-fixture.ts'

describe('human Edge Chat worker', () => {
  beforeEach(() => resetEdgeChatForTests())

  it('serves the website and identifies the Web Standards runtime', async () => {
    const page = await edgeChatWorker.fetch(new Request('https://edge.test/'))
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    await expect(page.text()).resolves.toContain('Edge / Web Standards')
    const health = await edgeChatWorker.fetch(new Request('https://edge.test/health'))
    await expect(health.json()).resolves.toMatchObject({ ok: true, runtime: 'web-standards' })
  })

  it('streams a multi-turn tool loop with authoritative usage', async () => {
    const response = await edgeChatWorker.fetch(chatRequest('math-session', '19 * 23'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('event: delta')
    expect(body).toContain('event: tool-call')
    expect(body).toContain('event: tool-result')
    expect(body).toContain('437')
    expect(body).toContain('totalTokens')
    const envelopes = parseSse(body)
    expect(envelopes.map(event => field(event.data, 'sequence'))).toEqual(
      envelopes.map((_event, index) => index + 1),
    )
    expect(envelopes.every(event => field(event.data, 'schemaVersion') === 1)).toBe(true)
    expect(envelopes.filter(event => ['complete', 'failed', 'aborted'].includes(event.type))).toHaveLength(1)

    const followUp = await edgeChatWorker.fetch(chatRequest('math-session', 'Cảm ơn bạn'))
    expect(await followUp.text()).toContain('lượt hội thoại thứ 2')
  })

  it('deep-searches, reads sources, fails the first audit, and reports only after the final audit passes', async () => {
    const response = await edgeChatWorker.fetch(chatRequest(
      'research-session',
      'Phân tích cách xây chat streaming và giữ conversation state trên Edge runtime',
      'deep-search',
    ))
    const events = await sseEvents(response)
    const calls = events.filter(event => event.type === 'tool-call')
    const results = events.filter(event => event.type === 'tool-result')
    expect(field(events.find(event => event.type === 'start')?.data, 'mode')).toBe('deep-search')
    const progress = events.filter(event => event.type === 'delta' && field(event.data, 'phase') === 'commentary')
    expect(String(field(progress[0]?.data, 'text'))).toContain('Kế hoạch:')
    expect(progress).toHaveLength(6)
    expect(calls.map(event => field(event.data, 'name'))).toEqual([
      'web_search', 'read_web_page', 'audit_research',
      'web_search', 'read_web_page', 'audit_research',
    ])
    expect(calls.every(event => /^edge-tool-/u.test(String(field(event.data, 'callId'))))).toBe(true)
    expect(calls.every(event => !/search-standards|read-streams|audit-final/u.test(String(field(event.data, 'callId'))))).toBe(true)
    const auditCalls = calls.filter(event => field(event.data, 'name') === 'audit_research')
    expect(auditCalls.map(event => field(field(event.data, 'input'), 'sourceCount'))).toEqual([1, 2])
    expect(results).toHaveLength(6)
    expect(results.every(event => field(event.data, 'isError') === false)).toBe(true)
    const audits = results.filter(event => field(event.data, 'name') === 'audit_research')
    expect(field(field(audits[0]?.data, 'meta'), 'sufficient')).toBe(false)
    expect(field(field(audits[0]?.data, 'meta'), 'missingTopics')).toEqual(['stateful-conversation'])
    expect(field(field(audits[1]?.data, 'meta'), 'sufficient')).toBe(true)
    const finalAuditIndex = events.indexOf(audits[1]!)
    const completeIndex = events.findIndex(event => event.type === 'complete')
    expect(completeIndex).toBeGreaterThan(finalAuditIndex)
    expect(JSON.stringify(events.at(completeIndex)?.data)).toContain('Báo cáo deep search')
    expect(JSON.stringify(events.at(completeIndex)?.data)).toContain('developer.mozilla.org')
    expect(JSON.stringify(events.at(completeIndex)?.data)).toContain('durable-objects')
  })

  it('can activate the deep-search instruction from an auto-detected request', async () => {
    const events = await sseEvents(await edgeChatWorker.fetch(chatRequest(
      'auto-research-session',
      'Nghiên cứu sâu về chat streaming và conversation state trên Edge',
      'auto',
    )))
    expect(field(events.find(event => event.type === 'start')?.data, 'mode')).toBe('deep-search')
    expect(events.some(event => event.type === 'tool-call' && field(event.data, 'name') === 'audit_research')).toBe(true)
  })

  it('projects provider-native Web Search distinctly with the exact typed config', async () => {
    const events = await sseEvents(await edgeChatWorker.fetch(chatRequest('native-search', '[native-search]')))
    const native = events.find(event => event.type === 'native-tool')
    expect(native?.data).toMatchObject({
      callId: 'edge-native-web-1', name: 'web-search', family: 'provider-native', status: 'completed',
    })
    expect(edgeFixtureRequests.at(-1)?.tools).toContainEqual({
      type: 'native', name: 'web-search', searchContextSize: 'high', maxUses: 3,
    })
  })

  it('rejects malformed input and isolates concurrent conversations', async () => {
    const invalid = await edgeChatWorker.fetch(new Request('https://edge.test/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    }))
    expect(invalid.status).toBe(400)
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      edgeChatWorker.fetch(chatRequest(`parallel-${index}`, `hello ${index}`))
    )))
    expect(results.every(result => result.status === 200)).toBe(true)
    const bodies = await Promise.all(results.map(result => result.text()))
    expect(bodies.every(body => body.includes('event: complete'))).toBe(true)
  })

  it('keeps one principal-bound history across modes and rejects an unauthenticated public host', async () => {
    await (await edgeChatWorker.fetch(chatRequest('one-history', 'hello'))).text()
    await (await edgeChatWorker.fetch(chatRequest(
      'one-history', 'Phân tích chat streaming trên Edge', 'deep-search',
    ))).text()
    const health = await edgeChatWorker.fetch(new Request('https://edge.test/health'))
    await expect(health.json()).resolves.toMatchObject({ activeSessions: 1 })
    const unauthorized = await edgeChatWorker.fetch(new Request('https://public.example/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'public', message: 'hello' }),
    }))
    expect(unauthorized.status).toBe(401)
  })

  it('projects failures safely and settles response cancellation before the next turn', async () => {
    const failed = await sseEvents(await edgeChatWorker.fetch(chatRequest('safe-failure', '[fail]')))
    expect(failed.at(-1)?.type).toBe('failed')
    expect(JSON.stringify(failed)).not.toContain('PRIVATE/PROVIDER_BODY_SENTINEL')

    const missing = await sseEvents(await edgeChatWorker.fetch(chatRequest('missing-usage', '[missing-usage]')))
    expect(missing.at(-1)?.type).toBe('failed')
    expect(field(missing.at(-1)?.data, 'code')).toBe('USAGE_REQUIRED')

    const degraded = await sseEvents(await edgeChatWorker.fetch(chatRequest('degraded-observation', 'hello')))
    expect(degraded.at(-1)?.type).toBe('failed')
    expect(field(degraded.at(-1)?.data, 'code')).toBe('OBSERVATION_DEGRADED')
    expect(JSON.stringify(degraded)).not.toContain('PRIVATE/EDGE_EXPORTER_FAILURE')

    const slow = await edgeChatWorker.fetch(chatRequest('cancel-session', '[slow] cancellation'))
    const reader = slow.body?.getReader()
    expect(reader).toBeDefined()
    await reader!.read()
    await reader!.cancel('human cancelled')
    await new Promise(resolve => setTimeout(resolve, 20))
    const next = await edgeChatWorker.fetch(chatRequest('cancel-session', 'after cancel'))
    expect(next.status).toBe(200)
    expect(await next.text()).toContain('event: complete')
  })
})

function chatRequest(conversationId: string, message: string, mode?: 'auto' | 'deep-search'): Request {
  return new Request('https://edge.test/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId, message, ...(mode === undefined ? {} : { mode }) }),
  })
}

async function sseEvents(response: Response): Promise<Array<{ type: string; data: unknown }>> {
  return parseSse(await response.text())
}

function parseSse(payload: string): Array<{ type: string; data: unknown }> {
  return payload.split(/\r?\n\r?\n/u).filter(Boolean).map(frame => ({
    type: /^event:\s*(.+)$/mu.exec(frame)?.[1] ?? 'message',
    data: JSON.parse(/^data:\s*(.+)$/mu.exec(frame)?.[1] ?? '{}') as unknown,
  }))
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, name) : undefined
}
