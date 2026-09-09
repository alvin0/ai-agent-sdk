import { describe, expect, it } from 'vitest'
import { requestDeviceCode } from '@alvin0/ai-agent-sdk-provider-codex'

describe('Codex OAuth transport guards', () => {
  it('requires HTTPS unless a local test issuer is explicitly allowed', async () => {
    await expect(requestDeviceCode({
      issuer: 'http://auth.example.test',
      fetch: async () => Response.json({}),
    })).rejects.toThrow(/must use https/)
  })

  it('rejects oversized auth responses before parsing them', async () => {
    await expect(requestDeviceCode({
      issuer: 'https://auth.example.test',
      maxResponseBytes: 8,
      fetch: async () => new Response('0123456789', {
        headers: { 'content-length': '10', 'content-type': 'application/json' },
      }),
    })).rejects.toThrow(/8-byte limit/)
  })

  it('bounds a custom auth fetch that ignores cancellation', async () => {
    const started = Date.now()
    await expect(requestDeviceCode({
      issuer: 'https://auth.example.test',
      requestTimeoutMs: 10,
      fetch: async () => await new Promise<Response>(() => {}),
    })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(250)
  })
})
