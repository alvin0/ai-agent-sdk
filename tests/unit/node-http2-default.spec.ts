import { describe, expect, it, vi } from 'vitest'

// Mocked by real path: auth-node resolves the providers through its own workspace links.
vi.mock('../../packages/provider-codex/dist/index.js', async (original) => ({
  ...await original<Record<string, unknown>>(),
  codexPlugin: vi.fn((options: unknown) => options),
}))
vi.mock('../../packages/provider-copilot/dist/index.js', async (original) => ({
  ...await original<Record<string, unknown>>(),
  copilotPlugin: vi.fn((options: unknown) => options),
}))

const { customGlobalDispatcher, defaultNodeFetch } = await import('../../packages/auth-node/src/http2/default.ts')
const { codexNodeProviderPlugin } = await import('../../packages/auth-node/src/codex.ts')
const { copilotNodeProviderPlugin } = await import('../../packages/auth-node/src/copilot.ts')

type WithFetch = { readonly fetch?: typeof globalThis.fetch }

describe('Node plugins default to the shared HTTP/2 transport', () => {
  it('shares one transport across plugins and keeps a caller fetch', () => {
    const shared = defaultNodeFetch({})
    expect(shared).toBeTypeOf('function')
    expect(defaultNodeFetch({})).toBe(shared)
    expect((codexNodeProviderPlugin() as unknown as WithFetch).fetch).toBe(shared)
    expect((copilotNodeProviderPlugin() as unknown as WithFetch).fetch).toBe(shared)
    const own = vi.fn(globalThis.fetch)
    expect((codexNodeProviderPlugin({ fetch: own }) as unknown as WithFetch).fetch).toBe(own)
    expect((copilotNodeProviderPlugin({ fetch: own }) as unknown as WithFetch).fetch).toBe(own)
  })

  it('keeps the platform fetch when the environment configures a proxy', () => {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'ALL_PROXY']) {
      expect(defaultNodeFetch({ [name]: 'http://proxy.internal:3128' })).toBeUndefined()
    }
    expect(defaultNodeFetch({ HTTPS_PROXY: '  ' })).toBeTypeOf('function')
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.internal:3128')
    try {
      expect((codexNodeProviderPlugin() as unknown as WithFetch).fetch).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('an application-installed global dispatcher', () => {
  const V2 = Symbol.for('undici.globalDispatcher.2')
  const V1 = Symbol.for('undici.globalDispatcher.1')
  const kOptions = Symbol('options')
  class Agent { [kOptions]: Record<string, unknown>; constructor(options: Record<string, unknown> = {}) { this[kOptions] = options } }
  class ProxyAgent {}
  class MockAgent {}
  class Dispatcher1Wrapper {}

  it('treats only the platform default Agent as not custom', async () => {
    // The platform installs its own default on first use.
    await fetch('data:,')
    expect(customGlobalDispatcher()).toBe(false)
    expect(customGlobalDispatcher({})).toBe(false)
    // Limits are not routing: the platform's own default carries `maxOrigins: Infinity`.
    expect(customGlobalDispatcher({ [V2]: new Agent({ maxOrigins: Infinity, connections: 4 }), [V1]: new Dispatcher1Wrapper() })).toBe(false)
    expect(customGlobalDispatcher({ [V1]: new Agent() })).toBe(false)
    expect(customGlobalDispatcher({ [V2]: new ProxyAgent() })).toBe(true)
    expect(customGlobalDispatcher({ [V1]: new MockAgent() })).toBe(true)
    expect(customGlobalDispatcher({ [V2]: new Agent({ connect: { ca: 'pem' } }) })).toBe(true)
    // An undici v7 dispatcher set over an undici v8 default still counts.
    expect(customGlobalDispatcher({ [V2]: new Agent(), [V1]: new ProxyAgent() })).toBe(true)
  })

  it('routes requests through the platform fetch while one is installed', async () => {
    const shared = defaultNodeFetch({})!
    const platform = vi.fn(async () => new Response('via platform'))
    vi.stubGlobal('fetch', platform)
    const previous = (globalThis as Record<symbol, unknown>)[V2]
    ;(globalThis as Record<symbol, unknown>)[V2] = new ProxyAgent()
    try {
      const response = await shared('https://example.invalid/v1/models')
      expect(await response.text()).toBe('via platform')
      expect(platform).toHaveBeenCalledWith('https://example.invalid/v1/models', undefined)
    } finally {
      ;(globalThis as Record<symbol, unknown>)[V2] = previous
      vi.unstubAllGlobals()
    }
  })
})
