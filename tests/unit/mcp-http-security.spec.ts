import { describe, expect, it, vi } from 'vitest'
import {
  createGuardedMcpFetch,
  snapshotHttpSecurityOptions,
  type McpHttpSecurityOptions,
} from '../../packages/mcp/src/client/http-security.ts'

function policy(overrides: Partial<McpHttpSecurityOptions> = {}): McpHttpSecurityOptions {
  return Object.freeze({
    requireHttps: true,
    allowPrivateNetwork: false,
    allowRedirects: false,
    maxTransportBytes: 1_024,
    timeoutMs: 1_000,
    teardownTimeoutMs: 100,
    ...overrides,
  })
}

describe('MCP HTTP redirect boundary', () => {
  it.each(['deadline', 'caller'] as const)('cancels a response arriving after %s interruption', async interruption => {
    vi.useFakeTimers()
    try {
      let respond!: (response: Response) => void
      const fetched = new Promise<Response>(resolve => { respond = resolve })
      const cancelled = vi.fn()
      const fetchMock = vi.fn(() => fetched)
      const caller = new AbortController()
      const guarded = createGuardedMcpFetch(fetchMock, policy({ timeoutMs: 10 }))
      const request = guarded('https://mcp.example.test/late', { signal: caller.signal })
      const rejected = expect(request).rejects.toBeDefined()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledOnce()
      if (interruption === 'caller') caller.abort()
      else await vi.advanceTimersByTimeAsync(11)
      await rejected
      respond(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })))
      await vi.advanceTimersByTimeAsync(0)
      expect(cancelled).toHaveBeenCalledOnce()
    } finally { await vi.runAllTimersAsync(); vi.useRealTimers() }
  })

  it('uses server-safe defaults and awaits endpoint validation before fetch', async () => {
    const defaults = snapshotHttpSecurityOptions({ serverName: 'safe', url: 'https://mcp.example.test' })
    expect(defaults).toMatchObject({ requireHttps: true, allowPrivateNetwork: false, allowRedirects: false })

    const order: string[] = []
    const guarded = createGuardedMcpFetch(async () => {
      order.push('fetch')
      return new Response('{}')
    }, policy({
      validateEndpoint: async () => {
        await Promise.resolve()
        order.push('validate')
      },
    }))
    await guarded('https://mcp.example.test/api')
    expect(order).toEqual(['validate', 'fetch'])
  })

  it('cancels the body when final response URL validation rejects', async () => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }))
    Object.defineProperty(response, 'url', { value: 'http://127.0.0.1/internal' })
    const guarded = createGuardedMcpFetch(async () => response, policy())
    await expect(guarded('https://mcp.example.test/api')).rejects.toThrow(/private or local/)
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('bounds endpoint validation with the request deadline and caller cancellation', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    let receivedSignal: AbortSignal | undefined
    const guarded = createGuardedMcpFetch(fetchMock, policy({
      timeoutMs: 10,
      validateEndpoint: (_url, signal) => {
        receivedSignal = signal
        return new Promise(() => undefined)
      },
    }))
    await expect(guarded('https://mcp.example.test/api')).rejects.toMatchObject({ name: 'McpOperationTimeoutError' })
    expect(receivedSignal?.aborted).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()

    const caller = new AbortController()
    const cancelled = guarded('https://mcp.example.test/api', { signal: caller.signal })
    caller.abort(new Error('cancel validation'))
    await expect(cancelled).rejects.toThrow('cancel validation')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not fetch after validator rejection or a pre-aborted request', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    const rejected = createGuardedMcpFetch(fetchMock, policy({
      validateEndpoint: async () => { throw new Error('endpoint rejected') },
    }))
    await expect(rejected('https://mcp.example.test/api')).rejects.toThrow('endpoint rejected')
    expect(fetchMock).not.toHaveBeenCalled()

    const validate = vi.fn()
    const preAborted = createGuardedMcpFetch(fetchMock, policy({ validateEndpoint: validate }))
    const caller = new AbortController()
    caller.abort(new Error('already cancelled'))
    await expect(preAborted('https://mcp.example.test/api', { signal: caller.signal }))
      .rejects.toThrow('already cancelled')
    expect(validate).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not dispatch a queued validator after caller cancellation', async () => {
    const validate = vi.fn()
    const fetchMock = vi.fn(async () => new Response('{}'))
    const caller = new AbortController()
    const guarded = createGuardedMcpFetch(fetchMock, policy({ validateEndpoint: validate }))
    const request = guarded('https://mcp.example.test/api', { signal: caller.signal })
    caller.abort()
    await expect(request).rejects.toBeDefined()
    expect(validate).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the same absolute deadline for redirect validation', async () => {
    const calls: string[] = []
    const guarded = createGuardedMcpFetch(async input => {
      calls.push(String(input))
      return new Response(null, { status: 307, headers: { location: '/next' } })
    }, policy({
      timeoutMs: 10, allowRedirects: true,
      validateEndpoint: url => url.pathname === '/next' ? new Promise(() => undefined) : undefined,
    }))
    await expect(guarded('https://mcp.example.test/start')).rejects.toMatchObject({ name: 'McpOperationTimeoutError' })
    expect(calls).toEqual(['https://mcp.example.test/start'])
  })

  it('keeps the absolute deadline active until the response body settles', async () => {
    const cancelled = vi.fn()
    const guarded = createGuardedMcpFetch(async () => new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: cancelled,
    })), policy({ timeoutMs: 10 }))
    const response = await guarded('https://mcp.example.test/stream')
    await expect(response.text()).rejects.toMatchObject({ name: 'McpOperationTimeoutError' })
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
  })

  it('keeps caller cancellation active until the response body settles', async () => {
    const caller = new AbortController()
    const cancelled = vi.fn()
    const guarded = createGuardedMcpFetch(async () => new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: cancelled,
    })), policy({ timeoutMs: 1_000 }))
    const response = await guarded('https://mcp.example.test/stream', { signal: caller.signal })
    const reason = new Error('cancel response body')
    caller.abort(reason)
    await expect(response.text()).rejects.toBe(reason)
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
  })

  it('reports oversized bodies without waiting for uncooperative cancellation', async () => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn(() => new Promise<void>(() => undefined))
      const guarded = createGuardedMcpFetch(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(2)) }, cancel,
      })), policy({ maxTransportBytes: 1, timeoutMs: 10, teardownTimeoutMs: 1_000 }))
      const response = await guarded('https://mcp.example.test/oversized')
      let failure: unknown
      const reading = response.text().catch(error => { failure = error })
      await vi.advanceTimersByTimeAsync(11)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain('1-byte limit')
      expect(cancel).toHaveBeenCalledOnce()
      await reading
    } finally { await vi.runAllTimersAsync(); vi.useRealTimers() }
  })

  it('disposes the response deadline after a successful body read', async () => {
    let signal: AbortSignal | undefined
    const guarded = createGuardedMcpFetch(async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Response('complete')
    }, policy({ timeoutMs: 10 }))
    const response = await guarded('https://mcp.example.test/complete')
    await expect(response.text()).resolves.toBe('complete')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(signal?.aborted).toBe(false)
  })

  it('uses portable manual mode and rejects a redirect before an unallowed target is contacted', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push(String(input))
      expect(init?.redirect).toBe('manual')
      return new Response(null, {
        status: 307,
        headers: { location: 'https://forbidden.example.test/mcp' },
      })
    })
    const guarded = createGuardedMcpFetch(fetchMock, policy({
      allowRedirects: true,
      allowedOrigins: ['https://allowed.example.test'],
    }))

    await expect(guarded('https://allowed.example.test/mcp', {
      headers: { authorization: 'Bearer PRIVATE_TOKEN' },
    })).rejects.toThrow(/not allowed/)
    expect(calls).toEqual(['https://allowed.example.test/mcp'])
  })

  it('removes every caller capability header before an allowed cross-origin hop', async () => {
    const requests: { readonly url: string; readonly headers: Headers }[] = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      if (requests.length === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://second.example.test/mcp' },
        })
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    })
    const guarded = createGuardedMcpFetch(fetchMock, policy({
      allowRedirects: true,
      allowedOrigins: ['https://first.example.test', 'https://second.example.test'],
    }))

    await guarded('https://first.example.test/mcp', {
      method: 'POST', body: '{}', headers: {
        authorization: 'Bearer PRIVATE_TOKEN',
        'mcp-session-id': 'PRIVATE_SESSION',
        'x-capability-key': 'PRIVATE_CAPABILITY',
        'content-type': 'application/json',
      },
    })
    expect(requests.map(item => item.url)).toEqual([
      'https://first.example.test/mcp', 'https://second.example.test/mcp',
    ])
    expect([...requests[0]!.headers.keys()]).toContain('x-capability-key')
    expect([...requests[1]!.headers.keys()]).toEqual([])
  })

  it('rejects observable redirects in no-follow mode and applies 303 method semantics', async () => {
    const noFollow = createGuardedMcpFetch(async () => new Response(null, {
      status: 302, headers: { location: '/next' },
    }), policy())
    await expect(noFollow('https://mcp.example.test/start')).rejects.toThrow(/rejected a redirect/)

    const methods: (string | undefined)[] = []
    const headers: Headers[] = []
    const follow = createGuardedMcpFetch(async (_input, init) => {
      methods.push(init?.method)
      headers.push(new Headers(init?.headers))
      return methods.length === 1
        ? new Response(null, { status: 303, headers: { location: '/result' } })
        : new Response('{}')
    }, policy({ allowRedirects: true }))
    await follow('https://mcp.example.test/start', {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    })
    expect(methods).toEqual(['POST', 'GET'])
    expect(headers[1]?.has('content-type')).toBe(false)
  })
})
