import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { runBrowserLogin } from '../../packages/auth-node/src/codex-browser.ts'
import { memoryCodexAuthStore } from '@alvin0/ai-agent-sdk-provider-codex'

const { createServer } = vi.hoisted(() => ({ createServer: vi.fn() }))
vi.mock('node:http', async importOriginal => ({
  ...await importOriginal<typeof import('node:http')>(), createServer,
}))

describe('Codex synthetic callback listener cleanup', () => {
  it('aborts a pending exchange when timeout and completion grace close the login', async () => {
    let handler!: (request: unknown, response: unknown) => void
    const server = Object.assign(new EventEmitter(), {
      listen(_port: number, _host: string, ready: () => void) { queueMicrotask(ready) },
      address() { return { port: 1455 } },
      close: vi.fn(), closeAllConnections: vi.fn(),
    })
    createServer.mockImplementation(listener => { handler = listener; return server })
    let exchangeSignal: AbortSignal | undefined
    const awaitExchangeAbort = (_resolve: (response: Response) => void, reject: (reason: unknown) => void) => {
      exchangeSignal?.addEventListener('abort', () => reject(exchangeSignal?.reason), { once: true })
    }
    const fetch = vi.fn(async (_input: unknown, options?: RequestInit) => {
      exchangeSignal = options?.signal ?? undefined
      return await new Promise<Response>(awaitExchangeAbort)
    })
    const store = memoryCodexAuthStore()
    const outcome = await runBrowserLogin(store, {
      issuer: 'https://auth.example.test', fetch, timeoutMs: 20, port: 0,
    }, {
      onPrompt({ url }) {
        const authorization = new URL(url)
        handler({ method: 'GET', headers: { host: 'localhost:1455' },
          url: `/auth/callback?code=synthetic-code&state=${authorization.searchParams.get('state')}`,
        }, { headersSent: false, writeHead() {}, end() {} })
      },
    }).catch((error: unknown) => error)
    expect(outcome).toMatchObject({ code: 'CODEX_AUTH_TIMEOUT' })
    expect(exchangeSignal?.aborted).toBe(true)
    expect(server.close).toHaveBeenCalledOnce()
    expect(server.closeAllConnections).toHaveBeenCalledOnce()
    expect(await store.read()).toBeUndefined()
  })
})
