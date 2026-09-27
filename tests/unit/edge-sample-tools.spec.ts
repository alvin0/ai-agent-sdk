import { describe, expect, it, vi } from 'vitest'
import { createEdgeTools } from '../../samples/edge-runtime-chat-agents/web/src/server/tools.ts'

function read(fetcher: typeof fetch, url: string, signal = new AbortController().signal) {
  const tool = createEdgeTools(fetcher).find(tool => tool.name === 'fetch_url')!
  return tool.execute(tool.parse!({ url }) as never, { signal } as never)
}

describe('Edge sample bounded public HTTPS fetch', () => {
  it.each(['https://localhost./', 'https://[::1]/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://[::ffff:127.0.0.1]/', 'https://100.64.0.1/', 'http://example.com/', 'https://user:pass@example.com/'])('refuses %s before dispatch', async url => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('unreachable'))
    await expect(read(fetcher, url)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('validates redirect destinations before following them', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => init?.redirect === 'follow'
      ? new Response('private endpoint data')
      : new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }))
    await expect(read(fetcher, 'https://example.com/')).rejects.toThrow(/private|loopback/i)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('follows a bounded relative public redirect and cancels its old body', async () => {
    let cancelled = false, calls = 0
    const fetcher = vi.fn<typeof fetch>(async () => ++calls === 1
      ? new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 302, headers: { location: '/page' } })
      : new Response('public page'))
    await expect(read(fetcher, 'https://example.com/start')).resolves.toMatchObject({ finalUrl: 'https://example.com/page', excerpt: 'public page' })
    expect(cancelled).toBe(true)
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://example.com/page')
  })

  it('accepts a public IPv6 literal', async () => {
    await expect(read(async () => new Response('public'), 'https://[2001:4860:4860::8888]/')).resolves.toMatchObject({ excerpt: 'public' })
  })

  it('does not decode bytes beyond the body cap from an oversized chunk', async () => {
    const payload = 'start ' + ' '.repeat(400000) + 'OUTSIDE_BYTE_CAP'
    await expect(read(async () => new Response(payload), 'https://example.com/')).resolves.toMatchObject({ excerpt: 'start' })
  })

  it('cancels a pending body read when the caller aborts', async () => {
    let cancelled = false, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const abort = new AbortController()
    const pending = read(async () => new Response(new ReadableStream({ pull() { entered() }, cancel() { cancelled = true } })), 'https://example.com/', abort.signal)
    const assertion = expect(pending).rejects.toThrow()
    await started; abort.abort(new Error('fixture cancelled'))
    await assertion
    expect(cancelled).toBe(true)
  }, 2000)
})
