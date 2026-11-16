import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  memoryCodexAuthStore,
  parseCodexUsageBody,
  parseCodexUsageHeaders,
} from '@alvin0/ai-agent-sdk-provider-codex'
import { formatSpan, renderUsage, reportUsage } from '../../packages/auth-node/src/cli-usage.ts'
import { LIVE_BODY, NOW_SECONDS, authFile, jwt, plain, usageFetch } from './fixtures/codex-usage.ts'

/** Headers as recorded from a live Codex response. */
const LIVE_HEADERS = {
  'x-codex-primary-used-percent': '5',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': '1791949103',
  'x-codex-primary-reset-after-seconds': '561019',
  'x-codex-primary-over-secondary-limit-percent': '0',
  'x-codex-secondary-used-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'x-codex-secondary-reset-at': '',
  'x-codex-secondary-reset-after-seconds': '0',
  'x-codex-plan-type': 'prolite',
  'x-codex-credits-has-credits': 'False',
  'x-codex-credits-unlimited': 'False',
  'x-codex-credits-balance': '0',
  'x-codex-active-limit': 'premium',
  'x-codex-turn-state': 'opaque-turn-state',
}

describe('parseCodexUsageHeaders', () => {
  it('reads live response headers and omits the unused secondary slot', () => {
    const usage = parseCodexUsageHeaders(new Headers(LIVE_HEADERS))
    expect(usage).toMatchObject({
      source: 'response-headers',
      planType: 'prolite',
      activeLimit: 'premium',
      rateLimit: {
        primary: { usedPercent: 5, remainingPercent: 95, windowSeconds: 604_800, resetAfterSeconds: 561_019,
          resetsAt: new Date(1_791_949_103_000).toISOString() },
      },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      models: {},
      additionalRateLimits: [],
    })
    expect(usage?.rateLimit).not.toHaveProperty('secondary')
    expect(JSON.stringify(usage)).not.toContain('opaque-turn-state')
  })

  it('accepts a plain record in any header case, such as a response log record', () => {
    const mixed = Object.fromEntries(Object.entries(LIVE_HEADERS).map(([key, value]) => [key.toUpperCase(), value]))
    expect(parseCodexUsageHeaders(mixed)?.rateLimit?.primary?.usedPercent).toBe(5)
  })

  it('keeps a secondary window that is in use', () => {
    const usage = parseCodexUsageHeaders({
      ...LIVE_HEADERS,
      'x-codex-secondary-used-percent': '40',
      'x-codex-secondary-window-minutes': '300',
      'x-codex-secondary-reset-at': '1791000000',
    })
    expect(usage?.rateLimit?.secondary).toMatchObject({ usedPercent: 40, remainingPercent: 60, windowSeconds: 18_000 })
  })

  it('returns undefined for a response without usage headers', () => {
    expect(parseCodexUsageHeaders(new Headers({ 'content-type': 'text/event-stream' }))).toBeUndefined()
    expect(parseCodexUsageHeaders({ 'x-codex-primary-used-percent': 'n/a' })).toBeUndefined()
  })
})

describe('codex --usage rendering', () => {
  it.each([[18_000, '5h'], [604_800, '7d'], [410_575, '4d 18h'], [90, '1m'], [30, '1m'], [0, '0m'], [3_660, '1h 1m']])(
    'formats %i seconds as %s', (seconds, text) => { expect(formatSpan(seconds)).toBe(text) },
  )

  it('prints remaining share, reset and model availability', () => {
    const usage = parseCodexUsageBody(LIVE_BODY)
    const output = plain(renderUsage(usage, '<memory>'))
    expect(output).toContain('codex: usage (plan plus) (<memory>)')
    expect(output).toContain('5h window   : 100% left (0% used, resets in 5h)')
    expect(output).toContain('7d window   : 89% left (11% used, resets in 4d 18h)')
    expect(output).toContain('credits     : none')
    expect(output).toContain('model       : gpt-6-astra available')
    expect(output).not.toContain('limit reached')
  })

  it('flags a reached limit and an unavailable model', () => {
    const usage = parseCodexUsageBody({
      rate_limit: { limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18_000,
        reset_after_seconds: 600 } },
      rate_limit_reached_type: 'primary',
      model_usage: { 'gpt-6-astra': { available: false, available_at: 1_800_000_000 } },
    })
    const output = plain(renderUsage(usage, '<memory>'))
    expect(output).toContain('5h window   : 0% left (100% used, resets in 10m)')
    expect(output).toContain('limit reached: primary')
    expect(output).toContain(`gpt-6-astra unavailable until ${new Date(1_800_000_000_000).toISOString()}`)
  })
})

describe('codex --usage command', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('refreshes due tokens against the --issuer the account signed in with', async () => {
    const refresh = vi.fn(async (_input: string | URL | Request) => Response.json({
      id_token: jwt({}), access_token: jwt({ exp: NOW_SECONDS + 3_600 }), refresh_token: 'private-new-refresh',
    }))
    vi.stubGlobal('fetch', refresh)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const fetch = usageFetch(() => Response.json(LIVE_BODY))

    const code = await reportUsage(memoryCodexAuthStore(authFile(-60)), '<memory>',
      { issuer: 'https://auth.custom.example', fetch })

    expect(code).toBe(0)
    expect(String(refresh.mock.calls[0]![0])).toBe('https://auth.custom.example/oauth/token')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(plain(String(write.mock.calls[0]![0]))).toContain('7d window   : 89% left')
  })
})
