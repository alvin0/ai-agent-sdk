import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'

export interface GitHubOAuthRuntimeOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUrl: string
  readonly callbackTimeoutMs: number
  readonly openBrowser: boolean
  readonly onStatus?: (message: string) => void
}

/** In-memory OAuth provider: secrets and tokens never touch a plaintext file. */
export class GitHubOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string
  readonly clientMetadata: OAuthClientMetadata

  private readonly clientId: string
  private readonly clientSecret: string
  private readonly onAuthorization: (url: URL) => Promise<void>
  private storedTokens: StoredOAuthTokens | undefined
  private verifier: string | undefined
  private discovery: OAuthDiscoveryState | undefined
  private currentState: string | undefined

  constructor(options: {
    readonly clientId: string
    readonly clientSecret: string
    readonly redirectUrl: string
    readonly onAuthorization: (url: URL) => Promise<void>
  }) {
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.redirectUrl = options.redirectUrl
    this.onAuthorization = options.onAuthorization
    this.clientMetadata = {
      client_name: 'ai-agent-sdk GitHub MCP human test',
      redirect_uris: [options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'native',
    }
  }

  get expectedState(): string | undefined { return this.currentState }

  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation {
    return {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...(ctx === undefined ? {} : { issuer: ctx.issuer }),
    }
  }

  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    if (ctx !== undefined && this.storedTokens?.issuer !== undefined && this.storedTokens.issuer !== ctx.issuer) {
      return undefined
    }
    return this.storedTokens
  }

  saveTokens(tokens: StoredOAuthTokens): void { this.storedTokens = tokens }

  state(): string {
    this.currentState = randomUUID()
    return this.currentState
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onAuthorization(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void { this.verifier = codeVerifier }

  codeVerifier(): string {
    if (this.verifier === undefined) throw new Error('OAuth PKCE verifier is unavailable')
    return this.verifier
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void { this.discovery = discovery }

  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'tokens') this.storedTokens = undefined
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined
  }
}

/** Owns the loopback callback only; protocol discovery and token exchange stay in the MCP SDK. */
export class GitHubOAuthRuntime {
  readonly provider: GitHubOAuthProvider

  private readonly redirectUrl: URL
  private readonly callbackTimeoutMs: number
  private readonly onStatus: (message: string) => void
  private readonly callback: Promise<URLSearchParams>
  private resolveCallback!: (params: URLSearchParams) => void
  private rejectCallback!: (error: Error) => void
  private server: Server | undefined
  private timeout: ReturnType<typeof setTimeout> | undefined
  private settled = false

  constructor(options: GitHubOAuthRuntimeOptions) {
    this.redirectUrl = new URL(options.redirectUrl)
    this.callbackTimeoutMs = options.callbackTimeoutMs
    this.onStatus = options.onStatus ?? (() => undefined)
    this.callback = new Promise<URLSearchParams>((resolve, reject) => {
      this.resolveCallback = resolve
      this.rejectCallback = reject
    })
    this.provider = new GitHubOAuthProvider({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUrl: options.redirectUrl,
      onAuthorization: async url => {
        this.onStatus(`Open this authorization URL if the browser does not launch:\n${url.href}`)
        if (options.openBrowser && !await launchBrowser(url)) {
          this.onStatus('Could not launch a browser automatically; open the URL above manually.')
        }
      },
    })
  }

  async start(): Promise<void> {
    if (this.server !== undefined) return
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', this.redirectUrl.origin)
      if (request.method !== 'GET' || requestUrl.pathname !== this.redirectUrl.pathname) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      if (this.settled) {
        response.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('OAuth callback was already received.')
        return
      }
      this.settled = true
      if (requestUrl.searchParams.has('error')) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Authorization was not completed. Return to the terminal.')
        this.rejectCallback(new Error('OAuth authorization was denied or failed'))
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><title>GitHub MCP authorized</title><p>Authorization received. You can close this tab.</p>')
        this.resolveCallback(requestUrl.searchParams)
      }
      void this.stopServer()
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { reject(error) }
      server.once('error', failed)
      server.listen(Number(this.redirectUrl.port), callbackHost(this.redirectUrl.hostname), () => {
        server.off('error', failed)
        resolve()
      })
    })
    this.timeout = setTimeout(() => {
      if (this.settled) return
      this.settled = true
      this.rejectCallback(new Error(`OAuth callback timed out after ${this.callbackTimeoutMs}ms`))
      void this.stopServer()
    }, this.callbackTimeoutMs)
  }

  waitForCallback(): Promise<URLSearchParams> { return this.callback }

  async close(): Promise<void> {
    if (this.timeout !== undefined) clearTimeout(this.timeout)
    this.timeout = undefined
    await this.stopServer()
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (server === undefined || !server.listening) return
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
}

function callbackHost(hostname: string): string {
  return hostname === '[::1]' ? '::1' : hostname
}

async function launchBrowser(url: URL): Promise<boolean> {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href]
  return await new Promise<boolean>(resolve => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => { resolve(false) })
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}
