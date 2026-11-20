import { expect, it, vi } from 'vitest'
import { createCopilotTokenCache } from '../../packages/provider-copilot/src/token-cache.ts'
import type { CopilotCredentialSnapshot } from '../../packages/provider-copilot/src/auth.ts'
import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'

const logger: SdkLogger = { child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }
const snapshot = (token: string): CopilotCredentialSnapshot => ({
  file: { version: 1, github: { token }, clientId: 'fixture' }, revision: token, label: 'fixture',
})

it('preserves the newer credential cache when an older exchange finishes later', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const older = new Headers(init?.headers).get('authorization') === 'Bearer fixture-a'
    if (older) await gate
    return Response.json({ token: older ? 'api-a' : 'api-b', expires_at: 1_900_000_000 })
  })
  const cache = createCopilotTokenCache({ fetch, now: () => 0 })
  const operation = { signal: new AbortController().signal, logger }
  const first = cache.acquire(snapshot('fixture-a'), operation)
  await new Promise(resolve => setImmediate(resolve))
  try {
    const second = await cache.acquire(snapshot('fixture-b'), operation)
    release()
    await expect(first).resolves.toMatchObject({ token: 'api-a' })
    await expect(cache.acquire(snapshot('fixture-b'), operation)).resolves.toBe(second)
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally { release(); await first }
})
