import { describe, expect, it, vi } from 'vitest'
import {
  CodexUsageError,
  codexUsageUrl,
  getCodexUsage,
  memoryCodexAuthStore,
  memoryCodexCredentialStore,
  parseCodexUsageBody,
} from '@alvin0/ai-agent-sdk-provider-codex'
import { getCodexNodeUsage } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { LIVE_BODY, authFile, hangingFetch, jwt, NOW_SECONDS, usageFetch } from './fixtures/codex-usage.ts'

describe('getCodexUsage', () => {
  it('reads the usage endpoint and normalizes the live response shape', async () => {
    const fetch = usageFetch(() => Response.json(LIVE_BODY))
    const usage = await getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch })

    expect(usage.source).toBe('usage-endpoint')
    expect(usage.planType).toBe('plus')
    expect(usage.rateLimit).toEqual({
      allowed: true,
      limitReached: false,
      primary: { usedPercent: 0, remainingPercent: 100, windowSeconds: 18_000, resetAfterSeconds: 18_000,
        resetsAt: new Date(1_794_661_029_000).toISOString() },
      secondary: { usedPercent: 11, remainingPercent: 89, windowSeconds: 604_800, resetAfterSeconds: 410_575,
        resetsAt: new Date(1_795_053_604_000).toISOString() },
    })
    expect(usage.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0', overageLimitReached: false })
    expect(usage.models).toEqual({ 'gpt-6-astra': { available: true } })
    expect(usage.additionalRateLimits).toEqual([])
    expect(usage.spendControlReached).toBe(false)
    expect(usage).not.toHaveProperty('codeReviewRateLimit')
    expect(usage).not.toHaveProperty('limitReachedType')
    expect(Number.isNaN(Date.parse(usage.observedAt))).toBe(false)
    expect(Object.isFrozen(usage)).toBe(true)
  })

  it('never returns the personal identifiers the endpoint sends', async () => {
    const fetch = usageFetch(() => Response.json(LIVE_BODY))
    const usage = await getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch })
    const serialized = JSON.stringify(usage)
    for (const secret of ['user-private-123', 'acct-private-1', 'someone@example.com']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('sends Codex credentials to the derived ChatGPT usage URL without following redirects', async () => {
    const fetch = usageFetch(() => Response.json(LIVE_BODY))
    await getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch })

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(init?.redirect).toBe('manual')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toMatch(/^Bearer e30\./)
    expect(headers.originator).toBe('codex_cli_rs')
    expect(headers['chatgpt-account-id']).toBe('acct-private-1')
    expect(headers).not.toHaveProperty('session-id')
  })

  it('refreshes expired tokens before reading usage, as a model request would', async () => {
    const store = memoryCodexCredentialStore(authFile(-60))
    const refreshed = jwt({ exp: NOW_SECONDS + 3_600 })
    const refreshFetch = vi.fn(async () => Response.json({
      id_token: jwt({}), access_token: refreshed, refresh_token: 'private-new-refresh',
    }))
    const fetch = usageFetch(() => Response.json(LIVE_BODY))
    await getCodexUsage({ authStore: store, fetch, oauth: { fetch: refreshFetch } })

    expect(refreshFetch).toHaveBeenCalledTimes(1)
    const headers = fetch.mock.calls[0]![1]?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${refreshed}`)
  })

  it.each([
    [401, 'CODEX_USAGE_UNAUTHORIZED'],
    [403, 'CODEX_USAGE_UNAUTHORIZED'],
    [429, 'CODEX_USAGE_HTTP'],
    [500, 'CODEX_USAGE_HTTP'],
  ])('maps HTTP %i to %s and keeps the status', async (status, code) => {
    const fetch = usageFetch(() => new Response('{"detail":"no"}', { status }))
    const failure = await getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CodexUsageError)
    expect(failure).toMatchObject({ code, status })
  })

  it.each([
    ['a non-JSON body', () => new Response('<html>busy</html>', { status: 200 })],
    ['a JSON array', () => Response.json([1, 2])],
  ])('reports %s as malformed', async (_name, response) => {
    const failure = await getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch: usageFetch(response) })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CodexUsageError)
    expect(failure).toMatchObject({ code: 'CODEX_USAGE_MALFORMED' })
  })

  it('rejects a redirect instead of sending credentials onward', async () => {
    const fetch = usageFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }))
    await expect(getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch }))
      .rejects.toMatchObject({ name: 'CodexUsageError', code: 'CODEX_USAGE_REDIRECT', status: 302 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('bounds the response size', async () => {
    const fetch = usageFetch(() => Response.json({ plan_type: 'x'.repeat(5_000) }))
    await expect(getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch, maxBytes: 1_024 }))
      .rejects.toMatchObject({ code: 'CODEX_USAGE_TOO_LARGE', message: expect.stringMatching(/1024-byte limit/) })
  })

  it('reports its own deadline as a timeout', async () => {
    await expect(getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch: hangingFetch, timeoutMs: 20 }))
      .rejects.toMatchObject({ name: 'CodexUsageError', code: 'CODEX_USAGE_TIMEOUT' })
  })

  it('reports a failed connection as a network error', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed') })
    await expect(getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch }))
      .rejects.toMatchObject({ code: 'CODEX_USAGE_NETWORK' })
  })

  it('reports a body cut off mid-stream as a network error, not a malformed response', async () => {
    const fetch = usageFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"plan_type":'))
        controller.error(new TypeError('terminated'))
      },
    })))
    await expect(getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch }))
      .rejects.toMatchObject({ code: 'CODEX_USAGE_NETWORK' })
  })

  it('releases the body of a response that arrives after cancellation', async () => {
    const controller = new AbortController()
    let deliver!: (response: Response) => void
    let cancelled = false
    const late = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))
    const fetch = vi.fn(() => new Promise<Response>(resolve => { deliver = resolve }))
    const pending = getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch, signal: controller.signal })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    controller.abort(new Error('caller stopped'))
    await expect(pending).rejects.toThrow('caller stopped')
    deliver(late)
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  it('honours caller cancellation', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(hangingFetch)
    const pending = getCodexUsage({ authStore: memoryCodexAuthStore(authFile()), fetch, signal: controller.signal })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    controller.abort(new Error('caller stopped'))
    await expect(pending).rejects.toThrow('caller stopped')
  })

  it('keeps the credential error when no credentials are stored, before any request', async () => {
    const fetch = usageFetch(() => Response.json({}))
    const failure = await getCodexUsage({ authStore: memoryCodexAuthStore(), fetch }).catch((error: unknown) => error)
    expect(failure).not.toBeInstanceOf(CodexUsageError)
    expect(failure).toMatchObject({ message: expect.stringMatching(/no Codex credentials/) })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects unusable limits before any request', async () => {
    const fetch = usageFetch(() => Response.json(LIVE_BODY))
    const authStore = memoryCodexAuthStore(authFile())
    await expect(getCodexUsage({ authStore, fetch, timeoutMs: 0 })).rejects.toThrow(RangeError)
    await expect(getCodexUsage({ authStore, fetch, maxBytes: 1.5 })).rejects.toThrow(RangeError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('works through the Node wrapper with an injected store and fetch', async () => {
    const fetch = usageFetch(() => Response.json(LIVE_BODY))
    const usage = await getCodexNodeUsage({ authStore: memoryCodexCredentialStore(authFile()), fetch })
    expect(usage.rateLimit?.secondary?.remainingPercent).toBe(89)
  })
})

describe('codexUsageUrl', () => {
  it.each([
    [undefined, 'https://chatgpt.com/backend-api/wham/usage'],
    ['https://chatgpt.com/backend-api/codex/', 'https://chatgpt.com/backend-api/wham/usage'],
    ['https://chatgpt.com/backend-api/codex?x=1#y', 'https://chatgpt.com/backend-api/wham/usage'],
    ['https://proxy.example/v1', 'https://proxy.example/v1/api/codex/usage'],
    ['https://proxy.example', 'https://proxy.example/api/codex/usage'],
    ['https://chatgpt.com', 'https://chatgpt.com/backend-api/wham/usage'],
    ['https://chat.openai.com/', 'https://chat.openai.com/backend-api/wham/usage'],
    ['https://proxy.example/backend-api-v2', 'https://proxy.example/backend-api-v2/api/codex/usage'],
  ])('maps %s to %s', (base, expected) => {
    expect(codexUsageUrl(base)).toBe(expected)
  })

  it('refuses plain http and embedded credentials', () => {
    expect(() => codexUsageUrl('http://chatgpt.com/backend-api/codex')).toThrow(/https/)
    expect(() => codexUsageUrl('https://user:pass@chatgpt.com/backend-api/codex')).toThrow(/credentials/)
  })
})

describe('parseCodexUsageBody', () => {
  it('drops fields of the wrong type instead of trusting them', () => {
    const usage = parseCodexUsageBody({
      plan_type: 42,
      rate_limit: {
        allowed: 'yes',
        primary_window: { used_percent: '5', limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 30, reset_at: 'not a date', limit_window_seconds: Number.NaN },
      },
      credits: { has_credits: 1, balance: 7 },
      model_usage: { '': { available: true }, 'm1': 'nope', 'm2': { available: false, available_at: 1_800_000_000 } },
      additional_rate_limits: [{ limit_name: '' }, { metered_limit_name: 'codex_other', rate_limit: null }],
    })
    expect(usage).not.toHaveProperty('planType')
    expect(usage.rateLimit).toEqual({ secondary: { usedPercent: 30, remainingPercent: 70 } })
    expect(usage.credits).toEqual({})
    expect(usage.models).toEqual({ m2: { available: false, availableAt: new Date(1_800_000_000_000).toISOString() } })
    expect(usage.additionalRateLimits).toEqual([{ name: 'codex_other', meteredName: 'codex_other' }])
  })

  it('floors the remaining share at zero when usage exceeds the window', () => {
    const usage = parseCodexUsageBody({
      rate_limit: { limit_reached: true, primary_window: { used_percent: 130 } },
      rate_limit_reached_type: 'primary',
    })
    expect(usage.rateLimit?.primary).toEqual({ usedPercent: 130, remainingPercent: 0 })
    expect(usage.limitReachedType).toBe('primary')
  })

  it('rounds away float noise and clamps the remaining share to 0–100', () => {
    const usage = parseCodexUsageBody({ rate_limit: {
      primary_window: { used_percent: 66.6 }, secondary_window: { used_percent: -5 },
    } })
    expect(usage.rateLimit?.primary?.remainingPercent).toBe(33.4)
    expect(usage.rateLimit?.secondary).toEqual({ usedPercent: -5, remainingPercent: 100 })
  })

  it('reads additional and code-review limits', () => {
    const window = { used_percent: 40, limit_window_seconds: 18_000 }
    const usage = parseCodexUsageBody({
      code_review_rate_limit: { allowed: true, primary_window: window },
      additional_rate_limits: [{ limit_name: 'GPT-6 Pro', metered_limit_name: 'gpt6_pro',
        rate_limit: { allowed: false, limit_reached: true, primary_window: window } }],
    })
    expect(usage.codeReviewRateLimit?.primary?.remainingPercent).toBe(60)
    expect(usage.additionalRateLimits).toEqual([{
      name: 'GPT-6 Pro', meteredName: 'gpt6_pro',
      rateLimit: { allowed: false, limitReached: true,
        primary: { usedPercent: 40, remainingPercent: 60, windowSeconds: 18_000 } },
    }])
  })

  it('rejects a body that is not an object', () => {
    expect(() => parseCodexUsageBody(null)).toThrow(TypeError)
    expect(() => parseCodexUsageBody([LIVE_BODY])).toThrow(TypeError)
  })
})
