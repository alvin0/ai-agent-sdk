import { connect, createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  CODEX_CLIENT_ID,
  completeBrowserLogin,
  createBrowserAuthorization,
  memoryCodexAuthStore,
} from '@alvin0/ai-agent-sdk-provider-codex'
import { runBrowserLogin } from '@alvin0/ai-agent-sdk-auth-node/codex'

const ISSUER = 'https://auth.example.test'

function jwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `e30.${encoded}.signature`
}

const ID_TOKEN = jwt({
  email: 'user@example.test',
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' },
})

/** A token endpoint that records each exchange. */
function tokenEndpoint() {
  const exchanges: URLSearchParams[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(String(input)).toBe(`${ISSUER}/oauth/token`)
    exchanges.push(new URLSearchParams(String(init?.body)))
    return Response.json({ id_token: ID_TOKEN, access_token: jwt({}), refresh_token: 'refresh-1' })
  }
  return { exchanges, fetch: fetch as typeof globalThis.fetch }
}

async function sha256Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('Codex browser login (authorization code + PKCE)', () => {
  it('builds an S256 authorization URL for the registered loopback redirect', async () => {
    const authorization = await createBrowserAuthorization({ issuer: ISSUER, workspaceId: 'ws-1' })
    const url = new URL(authorization.url)
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oauth/authorize`)
    expect(authorization.redirectUri).toBe('http://localhost:1455/auth/callback')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: CODEX_CLIENT_ID, redirect_uri: authorization.redirectUri,
      scope: 'openid profile email offline_access', code_challenge_method: 'S256', state: authorization.state,
      allowed_workspace_id: 'ws-1',
    })
    expect(url.searchParams.get('code_challenge')).toBe(await sha256Url(authorization.codeVerifier))
    expect(authorization.codeVerifier).toMatch(/^[\w-]{86}$/)
    const other = await createBrowserAuthorization({ issuer: ISSUER })
    expect(other.state).not.toBe(authorization.state)
    expect(other.codeVerifier).not.toBe(authorization.codeVerifier)
  })

  it('exchanges the callback code with its verifier and redirect URI, and stores the tokens', async () => {
    const authorization = await createBrowserAuthorization({ issuer: ISSUER })
    const { exchanges, fetch } = tokenEndpoint()
    const store = memoryCodexAuthStore()
    const result = await completeBrowserLogin(store,
      authorization, `${authorization.redirectUri}?code=code-1&state=${authorization.state}`, { issuer: ISSUER, fetch })
    expect(Object.fromEntries(exchanges[0]!)).toEqual({
      grant_type: 'authorization_code', code: 'code-1', redirect_uri: authorization.redirectUri,
      client_id: CODEX_CLIENT_ID, code_verifier: authorization.codeVerifier,
    })
    expect(result).toMatchObject({ email: 'user@example.test', accountId: 'acct-1', planType: 'plus' })
    expect((await store.read())?.tokens).toMatchObject({ refresh_token: 'refresh-1', account_id: 'acct-1' })
  })

  it('rejects a callback from another login, or one reporting an error, without exchanging anything', async () => {
    const authorization = await createBrowserAuthorization({ issuer: ISSUER })
    const { exchanges, fetch } = tokenEndpoint()
    const store = memoryCodexAuthStore()
    await expect(completeBrowserLogin(store, authorization, '?code=code-1&state=forged', { issuer: ISSUER, fetch }))
      .rejects.toMatchObject({ code: 'CODEX_AUTH_STATE_MISMATCH' })
    await expect(completeBrowserLogin(store, authorization,
      new URLSearchParams({ error: 'access_denied', state: authorization.state }), { issuer: ISSUER, fetch }))
      .rejects.toMatchObject({ code: 'CODEX_AUTH_FAILED' })
    expect(exchanges).toHaveLength(0)
    expect(await store.read()).toBeUndefined()
  })
})

describe('Node browser login listener', () => {
  it('turns away a foreign callback, then completes on the one for this login', async () => {
    const { exchanges, fetch } = tokenEndpoint()
    const store = memoryCodexAuthStore()
    let url: URL | undefined
    const login = runBrowserLogin(store, { issuer: ISSUER, fetch, port: 0 }, {
      onPrompt: (prompt) => { url = new URL(prompt.url) },
    })
    await expect.poll(() => url).toBeDefined()
    const redirect = new URL(url!.searchParams.get('redirect_uri')!)
    expect(redirect.hostname).toBe('localhost')
    const callback = `http://127.0.0.1:${redirect.port}${redirect.pathname}`
    const foreign = await globalThis.fetch(`${callback}?code=stolen&state=forged`)
    expect(foreign.status).toBe(400)
    expect(await foreign.text()).not.toContain('forged')
    const own = await globalThis.fetch(`${callback}?code=code-1&state=${url!.searchParams.get('state')}`)
    expect(own.status).toBe(200)
    await expect(login).resolves.toMatchObject({ email: 'user@example.test', accountId: 'acct-1' })
    expect(exchanges.map(body => body.get('code'))).toEqual(['code-1'])
    expect(exchanges[0]!.get('redirect_uri')).toBe(redirect.href)
    // The listener is closed once the login settles.
    await expect(globalThis.fetch(`${callback}?code=late`)).rejects.toThrow()
  })

  it('stops on GET /cancel, on its timeout, and on the caller signal', async () => {
    let url: URL | undefined
    const store = memoryCodexAuthStore()
    // Settled before the test awaits it: take the outcome as a value so it is never an unhandled rejection.
    const cancelled = runBrowserLogin(store, { issuer: ISSUER, port: 0 },
      { onPrompt: (prompt) => { url = new URL(prompt.url) } }).catch((error: unknown) => error)
    await expect.poll(() => url).toBeDefined()
    const redirect = new URL(url!.searchParams.get('redirect_uri')!)
    await globalThis.fetch(`http://127.0.0.1:${redirect.port}/cancel`)
    expect(await cancelled).toMatchObject({ code: 'ABORTED' })

    await expect(runBrowserLogin(store, { issuer: ISSUER, port: 0, timeoutMs: 30 }))
      .rejects.toMatchObject({ code: 'CODEX_AUTH_TIMEOUT' })

    const controller = new AbortController()
    const aborted = runBrowserLogin(store, { issuer: ISSUER, port: 0, signal: controller.signal },
      { onPrompt: () => { controller.abort() } })
    await expect(aborted).rejects.toMatchObject({ code: 'ABORTED' })
    expect(await store.read()).toBeUndefined()
  })

  /** Send one raw HTTP request (what a browser would refuse to send) and return the status line. */
  async function raw(port: number, head: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => { socket.write(`${head}\r\nConnection: close\r\n\r\n`) })
      let text = ''
      socket.on('data', (chunk) => { text += String(chunk) })
      socket.on('end', () => { resolve(text.split('\r\n')[0] ?? '') })
      socket.on('error', reject)
    })
  }

  it('answers malformed or misdirected requests without crashing or ending the login', async () => {
    let url: URL | undefined
    const store = memoryCodexAuthStore()
    const { fetch } = tokenEndpoint()
    const login = runBrowserLogin(store, { issuer: ISSUER, fetch, port: 0 }, {
      onPrompt: (prompt) => { url = new URL(prompt.url) },
    }).catch((error: unknown) => error)
    await expect.poll(() => url).toBeDefined()
    const redirect = new URL(url!.searchParams.get('redirect_uri')!)
    const port = Number(redirect.port)
    expect(await raw(port, `GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}`)).toMatch(/^HTTP\/1\.1 400/)
    // A DNS-rebound page reaches the same socket under its own host name.
    expect(await raw(port, `GET /cancel HTTP/1.1\r\nHost: attacker.example:${port}`)).toMatch(/^HTTP\/1\.1 421/)
    // A web page cannot cancel the login: browsers mark even no-cors requests.
    expect(await raw(port, `GET /cancel HTTP/1.1\r\nHost: localhost:${port}\r\nSec-Fetch-Site: cross-site`))
      .toMatch(/^HTTP\/1\.1 403/)
    expect(await raw(port, `GET /cancel HTTP/1.1\r\nHost: localhost:${port}\r\nOrigin: https://attacker.example`))
      .toMatch(/^HTTP\/1\.1 403/)
    const own = await globalThis.fetch(`http://127.0.0.1:${port}/auth/callback?code=code-1&state=${url!.searchParams.get('state')}`)
    expect(own.status).toBe(200)
    expect(await login).toMatchObject({ email: 'user@example.test' })
  })

  it('lets an abort during the exchange fail it, so nothing is stored for a failed login', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const { fetch: answer } = tokenEndpoint()
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      await held
      return await answer(input, init)
    }) as typeof globalThis.fetch
    const controller = new AbortController()
    const store = memoryCodexAuthStore()
    let url: URL | undefined
    const login = runBrowserLogin(store, { issuer: ISSUER, fetch, port: 0, signal: controller.signal }, {
      onPrompt: (prompt) => { url = new URL(prompt.url) },
    }).catch((error: unknown) => error)
    await expect.poll(() => url).toBeDefined()
    const port = new URL(url!.searchParams.get('redirect_uri')!).port
    const callback = globalThis.fetch(`http://127.0.0.1:${port}/auth/callback?code=code-1&state=${url!.searchParams.get('state')}`)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await globalThis.fetch(`http://127.0.0.1:${port}/cancel`)).status).toBe(409)
    // The abort reaches the exchange itself, so it fails and nothing is stored: the outcome matches the store.
    controller.abort()
    expect((await callback).status).toBe(400)
    release()
    expect(await login).toMatchObject({ name: expect.stringMatching(/Error/) })
    expect(await store.read()).toBeUndefined()
  })

  it('reports success when a cancel arrives after the exchange already succeeded', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const { fetch: answer } = tokenEndpoint()
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      await held
      return await answer(input, init)
    }) as typeof globalThis.fetch
    const store = memoryCodexAuthStore()
    let url: URL | undefined
    const login = runBrowserLogin(store, { issuer: ISSUER, fetch, port: 0 }, {
      onPrompt: (prompt) => { url = new URL(prompt.url) },
    }).catch((error: unknown) => error)
    await expect.poll(() => url).toBeDefined()
    const port = new URL(url!.searchParams.get('redirect_uri')!).port
    const callback = globalThis.fetch(`http://127.0.0.1:${port}/auth/callback?code=code-1&state=${url!.searchParams.get('state')}`)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await globalThis.fetch(`http://127.0.0.1:${port}/cancel`)).status).toBe(409)
    release()
    expect((await callback).status).toBe(200)
    expect(await login).toMatchObject({ email: 'user@example.test' })
    expect((await store.read())?.tokens?.refresh_token).toBe('refresh-1')
  })

  it('gives up after a bounded grace period when the store never settles, and frees the port', async () => {
    let url: URL | undefined
    let writes = 0
    // A store whose write never completes.
    const store = { location: 'hanging', read: async () => undefined,
      write: () => { writes++; return new Promise<void>(() => {}) } }
    const { fetch } = tokenEndpoint()
    const started = Date.now()
    const login = runBrowserLogin(store, { issuer: ISSUER, fetch, port: 0, timeoutMs: 150 }, {
      onPrompt: (prompt) => { url = new URL(prompt.url) },
    }).catch((error: unknown) => error)
    await expect.poll(() => url).toBeDefined()
    const port = Number(new URL(url!.searchParams.get('redirect_uri')!).port)
    // The callback starts completing, then hangs in the store; its response never arrives.
    void globalThis.fetch(`http://127.0.0.1:${port}/auth/callback?code=code-1&state=${url!.searchParams.get('state')}`)
      .catch(() => undefined)
    await expect.poll(() => writes).toBe(1)
    expect(await login).toMatchObject({ code: 'CODEX_AUTH_TIMEOUT' })
    // Timeout plus a grace of at most the timeout.
    expect(Date.now() - started).toBeLessThan(1_500)
    await expect(globalThis.fetch(`http://127.0.0.1:${port}/cancel`)).rejects.toThrow()
  })

  it('rejects an unusable timeout or port up front', async () => {
    await expect(runBrowserLogin(memoryCodexAuthStore(), { timeoutMs: Number.NaN })).rejects.toThrow(/timeoutMs/)
    await expect(runBrowserLogin(memoryCodexAuthStore(), { timeoutMs: 2 ** 40 })).rejects.toThrow(/timeoutMs/)
    await expect(runBrowserLogin(memoryCodexAuthStore(), { port: 70_000 })).rejects.toThrow(/port/)
  })

  it('reports a port held by another sign-in instead of failing obscurely', async () => {
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
    const port = (holder.address() as { port: number }).port
    try {
      await expect(runBrowserLogin(memoryCodexAuthStore(), { issuer: ISSUER, port }))
        .rejects.toMatchObject({ code: 'CODEX_AUTH_UNAVAILABLE' })
    } finally {
      holder.close()
    }
  })
})
