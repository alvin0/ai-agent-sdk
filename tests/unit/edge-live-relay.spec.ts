import { afterEach, describe, expect, it } from 'vitest'
import { startCodexRelay, type CodexRelay } from '../../test-human/edge-chat/live/relay.ts'

const openRelays: CodexRelay[] = []

afterEach(async () => {
  await Promise.all(openRelays.splice(0).map(async relay => await relay.close()))
})

describe('test-only Codex loopback relay', () => {
  it('requires a high-entropy relay secret', async () => {
    await expect(startCodexRelay('too-short')).rejects.toThrow('too short')
  })

  it.each([
    { path: '/responses', secret: 'wrong-secret' },
    { path: '/not-allowed', secret: 'a'.repeat(32) },
  ])('rejects requests outside its exact authenticated route: $path', async ({ path, secret }) => {
    const relay = await startCodexRelay('a'.repeat(32))
    openRelays.push(relay)
    const response = await fetch(`${relay.origin}${path}`, {
      method: 'POST', headers: { 'x-ai-agent-sdk-relay-secret': secret }, body: '{}',
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
    expect(relay.snapshot()).toMatchObject({
      requests: 1, successfulResponses: 0, upstreamFailures: 0,
      downstreamInterruptions: 0, requestBytes: 0, responseBytes: 0,
    })
  })
})
