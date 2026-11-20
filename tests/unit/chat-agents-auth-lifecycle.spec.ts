import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const issuer = vi.hoisted(() => ({ start: vi.fn(), store: { read: vi.fn(), commit: vi.fn() } }))
vi.mock('@alvin0/ai-agent-sdk-auth-node/codex', () => ({
  fileCodexAuthStore: () => ({ location: 'fixture' }),
  fileCodexCredentialStore: () => issuer.store,
  resolveCodexAuthPath: () => 'fixture',
  requireTokens: () => ({}),
  readJwtClaims: () => undefined,
  runDeviceCodeLogin: issuer.start,
}))
import { cancelCodexLogin, codexLoginState, startCodexLogin } from '../../samples/chat-agents/backend/src/auth.ts'

interface Login {
  prompt(): void
  finish(): void
}
const slot = Symbol.for('@chat-agents/backend.codex-login')
const holder = globalThis as unknown as Record<symbol, unknown>
const logins: Login[] = []

beforeEach(() => {
  vi.useFakeTimers()
  delete holder[slot]
  logins.length = 0
  issuer.start.mockReset().mockImplementation((_store, _options, hooks) => new Promise(resolve => {
    logins.push({
      prompt: () => hooks.onPrompt({ verificationUrl: 'https://example.test/activate', userCode: 'fixture' }),
      finish: () => resolve({ location: 'fixture' }),
    })
  }))
})
afterEach(() => { delete holder[slot]; vi.clearAllTimers(); vi.useRealTimers() })

describe('sample Codex login lifecycle with a local issuer stub', () => {
  it('uses the revisioned store and keeps issuer details out of the public failure state', async () => {
    issuer.start.mockRejectedValueOnce(new Error('private issuer body'))
    const result = await startCodexLogin()
    expect(issuer.start.mock.calls[0]?.[0]).toBe(issuer.store)
    expect(result.status).toBe('error')
    expect(JSON.stringify(result)).not.toContain('private issuer body')
    await expect(codexLoginState()).resolves.toEqual(result)
  })

  it('shares starting login work and releases prompt timers', async () => {
    let timersAfterPrompt = 0
    for (let iteration = 0; iteration < 100; iteration++) {
      delete holder[slot]
      const first = startCodexLogin()
      const second = startCodexLogin()
      await Promise.resolve()
      for (const login of logins.splice(0)) { login.prompt(); login.finish() }
      await Promise.all([first, second])
      timersAfterPrompt += vi.getTimerCount()
      vi.clearAllTimers()
    }
    console.log(JSON.stringify({ scenario: 'sample-auth-concurrent-start', attempts: 100,
      issuerStarts: issuer.start.mock.calls.length, timersAfterPrompt }))
    expect(issuer.start).toHaveBeenCalledTimes(100)
    expect(timersAfterPrompt).toBe(0)
  })

  it('cancels the initial issuer wait and settles the caller promptly', async () => {
    let cancellations = 0
    for (let iteration = 0; iteration < 100; iteration++) {
      delete holder[slot]
      const pending = startCodexLogin()
      await Promise.resolve()
      if (cancelCodexLogin()) cancellations++
      for (const login of logins.splice(0)) { login.prompt(); login.finish() }
      await pending
      vi.clearAllTimers()
    }
    console.log(JSON.stringify({ scenario: 'sample-auth-cancel-starting', attempts: 100, cancellations }))
    expect(cancellations).toBe(100)
  })

  it('ignores canceled attempt callbacks after a new attempt starts', async () => {
    const first = startCodexLogin()
    await Promise.resolve()
    const old = logins[0]!
    expect(cancelCodexLogin()).toBe(true)
    const second = startCodexLogin()
    await Promise.resolve()
    const current = logins[1]!
    old.prompt()
    old.finish()
    current.prompt()
    await expect(first).resolves.toEqual({ status: 'idle' })
    await expect(second).resolves.toMatchObject({ status: 'pending' })
    await expect(codexLoginState()).resolves.toMatchObject({ status: 'pending' })
    current.finish()
  })
})
