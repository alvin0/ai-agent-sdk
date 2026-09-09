import { describe, expect, it } from 'vitest'
import {
  httpErrorCode,
  parseErrorBody,
  requestIdFrom,
  retryAfterMs,
} from '@alvin0/ai-agent-sdk-provider-http'

describe('httpErrorCode', () => {
  it('maps credential and request failures away from the retryable bucket', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
    expect(httpErrorCode(413)).toBe('INVALID_REQUEST')
    // A missing model is the caller's mistake; classifying it as SERVER would
    // make retry policy hammer a request that can never succeed.
    expect(httpErrorCode(404)).toBe('INVALID_REQUEST')
  })

  it('classifies an exhausted quota before the rate-limit status', () => {
    // Both arrive as 429 but only one clears on its own.
    expect(httpErrorCode(429, 'insufficient_quota You exceeded your current quota'))
      .toBe('QUOTA')
    expect(httpErrorCode(429, 'rate_limit_error too many requests')).toBe('RATE_LIMIT')
  })

  it('separates a context overflow from a malformed request', () => {
    expect(httpErrorCode(400, 'context_length_exceeded maximum context length is 200000'))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(httpErrorCode(400, 'invalid_request_error tools[0].name is required'))
      .toBe('INVALID_REQUEST')
  })

  it('treats every 5xx as retryable, including 529 overloaded', () => {
    expect(httpErrorCode(500)).toBe('SERVER')
    expect(httpErrorCode(529, 'overloaded_error')).toBe('SERVER')
  })

  it('falls back to a status-derived code it cannot classify', () => {
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })
})

describe('retryAfterMs', () => {
  it('reads the delta-seconds form', () => {
    expect(retryAfterMs('30')).toBe(30_000)
  })

  it('reads the HTTP-date form', () => {
    const future = new Date(Date.now() + 60_000).toUTCString()
    const parsed = retryAfterMs(future)
    expect(parsed).toBeGreaterThan(0)
    expect(parsed).toBeLessThanOrEqual(60_000)
  })

  it('rejects an absent, zero, or past value rather than returning a negative delay', () => {
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs('0')).toBeUndefined()
    expect(retryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBeUndefined()
    expect(retryAfterMs('not-a-date')).toBeUndefined()
  })
})

describe('parseErrorBody', () => {
  it('reads the wrapped {error:{...}} shape', () => {
    const parsed = parseErrorBody(JSON.stringify({
      error: { type: 'invalid_request_error', code: 'bad', message: 'nope' },
    }))
    expect(parsed.message).toBe('nope')
    expect(parsed.detail).toBe('bad invalid_request_error nope')
  })

  it('reads a bare {type,message} shape', () => {
    const parsed = parseErrorBody(JSON.stringify({ type: 'overloaded_error', message: 'busy' }))
    expect(parsed.message).toBe('busy')
  })

  it('reads the {detail} shape the Codex backend uses', () => {
    // Verified against the live endpoint: an unsupported model comes back as a
    // bare `detail` string with no `error` wrapper and no `message`.
    const parsed = parseErrorBody(JSON.stringify({
      detail: "The 'gpt-9' model is not supported when using Codex with a ChatGPT account.",
    }))
    expect(parsed.message).toMatch(/not supported/)
    expect(parsed.detail).toMatch(/not supported/)
  })

  it('survives a non-JSON body from an intermediary', () => {
    const parsed = parseErrorBody('<html><body>502 Bad Gateway</body></html>')
    expect(parsed.message).toBeUndefined()
    expect(parsed.detail).toContain('502')
  })
})

describe('requestIdFrom', () => {
  it('prefers the canonical header and falls back in order', () => {
    expect(requestIdFrom(new Headers({ 'request-id': 'a', 'x-request-id': 'b' }))).toBe('a')
    expect(requestIdFrom(new Headers({ 'cf-ray': 'ray-1' }))).toBe('ray-1')
    expect(requestIdFrom(new Headers())).toBeUndefined()
  })
})
