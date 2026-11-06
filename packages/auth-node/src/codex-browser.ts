/** Browser (authorization-code + PKCE) Codex login with a loopback callback listener. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentSdkError, MAX_TIMER_MS } from '@alvin0/ai-agent-sdk-core'
import {
  CODEX_BROWSER_CALLBACK_PATH,
  CODEX_BROWSER_CALLBACK_PORT,
  completeBrowserLogin,
  createBrowserAuthorization,
  type CodexAuthStore,
  type CodexBrowserAuthorization,
  type CodexCredentialStore,
  type CodexLoginResult,
  type CodexOAuthOptions,
} from '@alvin0/ai-agent-sdk-provider-codex'

/** Settings for {@link runBrowserLogin}. */
export interface CodexBrowserLoginOptions extends CodexOAuthOptions {
  /**
   * Loopback port to listen on. Defaults to 1455, the port the Codex OAuth
   * client registers; another port only works with an issuer that accepts it.
   */
  readonly port?: number
  /** Restrict sign-in to one ChatGPT workspace (account) id. */
  readonly workspaceId?: string
  /** Give up when no sign-in completes within this long. Defaults to 15 minutes. */
  readonly timeoutMs?: number
}

/** Progress reported while a browser login runs. */
export interface CodexBrowserLoginProgress {
  /** The callback listener is up: show this URL and open it in the browser. */
  onPrompt?: (prompt: { readonly url: string }) => void
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000
/**
 * How long a callback already being completed may keep the login open after the
 * timeout or a cancellation (at most the login timeout itself): the token request
 * has its own bound, but a custom store that never settles must not hold the port forever.
 */
const COMPLETION_GRACE_MS = 60_000

/**
 * Sign in through the browser, without device authorization: listen on
 * `http://localhost:1455/auth/callback`, report the authorization URL, and wait
 * for the browser to return there. Needs a browser on this machine (or a
 * forwarded port); on a remote shell use {@link runDeviceCodeLogin} instead.
 * Only a callback carrying this login's `state` is accepted; a `GET /cancel`
 * from a local tool stops the wait, as it does for the Codex CLI, so a newer login
 * can take the port (a web page in the browser cannot cancel it).
 * @param store - where to write the credentials.
 * @param options - issuer, client id, port, timeout, cancellation.
 * @param progress - prompt notification for a CLI to render.
 * @returns a summary of who signed in and where it was stored.
 */
export function runBrowserLogin(
  store: CodexCredentialStore,
  options?: CodexBrowserLoginOptions,
  progress?: CodexBrowserLoginProgress,
): Promise<CodexLoginResult>
export function runBrowserLogin(
  store: CodexAuthStore,
  options?: CodexBrowserLoginOptions,
  progress?: CodexBrowserLoginProgress,
): Promise<CodexLoginResult>
export async function runBrowserLogin(
  store: CodexCredentialStore | CodexAuthStore,
  options: CodexBrowserLoginOptions = {},
  progress: CodexBrowserLoginProgress = {},
): Promise<CodexLoginResult> {
  options.signal?.throwIfAborted()
  const timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMER_MS, 'timeoutMs')
  const login = new LoopbackLogin(store, options)
  const port = await login.listen(boundedInteger(options.port ?? CODEX_BROWSER_CALLBACK_PORT, 0, 65_535, 'port'))
  try {
    const authorization = await createBrowserAuthorization({
      ...options, redirectUri: `http://localhost:${port}${CODEX_BROWSER_CALLBACK_PATH}`,
    })
    login.authorization = authorization
    try { progress.onPrompt?.({ url: authorization.url }) } catch { /* progress observers do not own authentication */ }
    return await login.result(timeoutMs, options.signal)
  } finally {
    login.close()
  }
}

/** One login's listener: accepts the first callback carrying its `state`, then completes the login. */
class LoopbackLogin {
  authorization: CodexBrowserAuthorization | undefined
  private readonly server: Server
  private completing = false
  private port = 0
  private settle: { resolve: (value: CodexLoginResult) => void; reject: (error: unknown) => void } | undefined
  private early: { error: unknown } | { value: CodexLoginResult } | undefined

  constructor(
    private readonly store: CodexCredentialStore | CodexAuthStore,
    private readonly options: CodexBrowserLoginOptions,
  ) {
    this.server = createServer((request, response) => {
      // A request that breaks the handler gets an error response; it never becomes an unhandled rejection.
      this.handle(request, response).catch(() => {
        if (response.headersSent) response.destroy()
        else reply(response, 400, 'Bad request.')
      })
    })
  }

  async listen(port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(error.code === 'EADDRINUSE'
          ? new AgentSdkError(`port ${port} is in use: another Codex sign-in (this tool or the Codex CLI) may be `
            + 'waiting; finish or cancel it, or sign in with the device code instead', 'CODEX_AUTH_UNAVAILABLE',
          { cause: error })
          : error)
      }
      this.server.once('error', onError)
      // Loopback only: nothing off this machine can reach the callback.
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', onError)
        resolve()
      })
    })
    this.port = (this.server.address() as AddressInfo).port
    return this.port
  }

  result(timeoutMs: number, signal: AbortSignal | undefined): Promise<CodexLoginResult> {
    return new Promise<CodexLoginResult>((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined
      const graceMs = Math.min(COMPLETION_GRACE_MS, timeoutMs)
      // A callback already being completed settles the login itself, so the caller's outcome matches
      // what the store holds; it only gets a bounded grace period to do so.
      const stop = (error: AgentSdkError): void => {
        if (!this.completing) return finish({ error })
        grace ??= setTimeout(() => { finish({ error }) }, graceMs)
      }
      const timer = setTimeout(() => {
        const seconds = Math.round(timeoutMs / 1_000)
        stop(new AgentSdkError(`browser login timed out after ${seconds} s`, 'CODEX_AUTH_TIMEOUT'))
      }, timeoutMs)
      const onAbort = (): void => { stop(new AgentSdkError('browser login cancelled', 'ABORTED')) }
      const finish = (outcome: { error: unknown } | { value: CodexLoginResult }): void => {
        clearTimeout(timer)
        clearTimeout(grace)
        signal?.removeEventListener('abort', onAbort)
        this.settle = undefined
        if ('value' in outcome) resolve(outcome.value)
        else reject(outcome.error)
      }
      if (signal?.aborted === true) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (this.early !== undefined) {
        finish(this.early)
        return
      }
      this.settle = { resolve: value => { finish({ value }) }, reject: (error) => { finish({ error }) } }
    })
  }

  close(): void {
    this.server.close()
    this.server.closeAllConnections()
  }

  private done(outcome: { error: unknown } | { value: CodexLoginResult }): void {
    if (this.settle === undefined) {
      this.early ??= outcome
      return
    }
    if ('value' in outcome) this.settle.resolve(outcome.value)
    else this.settle.reject(outcome.error)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Only requests addressed to this listener by name: a DNS-rebound page carries its own host.
    const host = request.headers.host
    if (host !== `localhost:${this.port}` && host !== `127.0.0.1:${this.port}`) {
      return reply(response, 421, 'Misdirected request.')
    }
    if (request.method !== 'GET') return reply(response, 405, 'Method not allowed.')
    const url = new URL(request.url ?? '/', `http://${host}`)
    if (url.pathname === '/cancel') {
      // A local tool (the Codex CLI taking over the port) may cancel; a web page may not. Browsers mark
      // their requests, even no-cors ones, with Sec-Fetch-Site/Dest (and usually Origin or Referer).
      if (fromBrowser(request)) return reply(response, 403, 'Forbidden.')
      // Too late to cancel once a callback is being exchanged: the login settles on that exchange.
      if (this.completing) return reply(response, 409, 'Sign-in is already being completed.')
      reply(response, 200, 'Sign-in cancelled.')
      return this.done({ error: new AgentSdkError('browser login cancelled', 'ABORTED') })
    }
    if (url.pathname !== CODEX_BROWSER_CALLBACK_PATH) return reply(response, 404, 'Not found.')
    await this.callback(url.searchParams, response)
  }

  private async callback(params: URLSearchParams, response: ServerResponse): Promise<void> {
    const authorization = this.authorization
    if (authorization === undefined) return reply(response, 404, 'Not found.')
    if (this.completing) return reply(response, 409, 'Sign-in is already being completed.')
    // A callback for another login (or forged) is turned away; this login keeps waiting.
    if (!sameState(params.get('state'), authorization.state)) {
      return reply(response, 400, 'This sign-in link does not belong to the login that is waiting.')
    }
    this.completing = true
    try {
      const result = await completeBrowserLogin(this.store as CodexAuthStore, authorization, params, this.options)
      reply(response, 200, 'Signed in to Codex. You can close this tab and return to the terminal.')
      this.done({ value: result })
    } catch (error) {
      reply(response, 400, 'Sign-in failed. Return to the terminal for details.')
      this.done({ error })
    }
  }
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

function fromBrowser(request: IncomingMessage): boolean {
  const headers = request.headers
  // Not Sec-Fetch-Mode: Node's fetch sends that one too.
  return headers.origin !== undefined || headers['sec-fetch-site'] !== undefined
    || headers['sec-fetch-dest'] !== undefined || headers.referer !== undefined
}

function sameState(received: string | null, expected: string): boolean {
  if (received === null || received.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index++) {
    difference |= received.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

/** A fixed message only: nothing from the request or the issuer is reflected into the page. */
function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    connection: 'close',
  })
  response.end(`<!doctype html><meta charset="utf-8"><title>Codex sign-in</title><p>${message}</p>\n`)
}
