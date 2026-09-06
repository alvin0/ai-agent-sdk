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
