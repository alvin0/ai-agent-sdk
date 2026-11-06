import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import { CODEX_ORIGINATOR } from './adapter-types.ts'
import { issuerOf, clientIdOf } from './oauth-http.ts'
import type { CodexOAuthOptions } from './oauth-types.ts'

/**
 * Port of the loopback callback the Codex OAuth client accepts. The client only
 * allows registered redirect URIs, so a browser login listens here.
 */
export const CODEX_BROWSER_CALLBACK_PORT = 1455

/** Path of the loopback callback. */
export const CODEX_BROWSER_CALLBACK_PATH = '/auth/callback'

/** Scopes a Codex sign-in asks for; `offline_access` yields the refresh token. */
const SCOPE = 'openid profile email offline_access'

/** Settings for starting a browser (authorization-code + PKCE) login. */
export interface CodexBrowserAuthorizationOptions extends CodexOAuthOptions {
  /**
   * Where the browser returns after sign-in. Defaults to
   * `http://localhost:1455/auth/callback`; the OAuth client rejects unregistered URIs.
   */
  readonly redirectUri?: string
  /** Restrict sign-in to one ChatGPT workspace (account) id. */
  readonly workspaceId?: string
}

/**
 * A pending browser login: open `url`, then hand the callback back to
 * {@link completeBrowserLogin} together with this object. `state` and
 * `codeVerifier` are secrets for this one login; keep them server-side.
 */
export interface CodexBrowserAuthorization {
  /** Authorization URL to open in the user's browser. */
  readonly url: string
  /** Redirect URI the authorization was issued for; the token exchange repeats it. */
  readonly redirectUri: string
  /** Anti-forgery value the callback must echo. */
  readonly state: string
  /** PKCE verifier whose S256 challenge is in `url`. */
  readonly codeVerifier: string
}

/** The callback query the browser delivers, or its parsed parameters. */
export type CodexBrowserCallback = string | URL | URLSearchParams

/**
 * Start a browser login: a PKCE verifier, an anti-forgery `state`, and the
 * authorization URL. Unlike device-code login it needs no device authorization
 * enabled on the account, but the browser must be able to reach the redirect
 * URI (normally a loopback listener on the same machine).
 */
export async function createBrowserAuthorization(
  options: CodexBrowserAuthorizationOptions = {},
): Promise<CodexBrowserAuthorization> {
  const issuer = issuerOf(options)
  const redirectUri = options.redirectUri
    ?? `http://localhost:${CODEX_BROWSER_CALLBACK_PORT}${CODEX_BROWSER_CALLBACK_PATH}`
  const codeVerifier = randomToken(64)
  const state = randomToken(32)
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientIdOf(options),
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: await s256(codeVerifier),
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: CODEX_ORIGINATOR,
  })
  if (options.workspaceId !== undefined) query.set('allowed_workspace_id', options.workspaceId)
  return Object.freeze({ url: `${issuer}/oauth/authorize?${query.toString()}`, redirectUri, state, codeVerifier })
}

/**
 * Check a callback against its authorization and return the authorization code.
 * Throws `CODEX_AUTH_STATE_MISMATCH` for a callback this login did not issue,
 * and `CODEX_AUTH_FAILED` when the issuer reports an error or sends no code.
 */
export function authorizationCodeFrom(
  authorization: CodexBrowserAuthorization, callback: CodexBrowserCallback,
): string {
  const params = callbackParams(callback)
  if (!constantTimeEqual(params.get('state') ?? '', authorization.state)) {
    throw new AgentSdkError('browser login callback does not match this login (state mismatch)',
      'CODEX_AUTH_STATE_MISMATCH')
  }
  const error = params.get('error')
  if (error !== null) {
    const description = params.get('error_description')
    throw new AgentSdkError(`browser login was not completed: ${error}`, 'CODEX_AUTH_FAILED',
      description === null ? undefined : { cause: new Error(description) })
  }
  const code = params.get('code')
  if (code === null || code.length === 0) {
    throw new AgentSdkError('browser login callback carried no authorization code', 'CODEX_AUTH_FAILED')
  }
  return code
}

function callbackParams(callback: CodexBrowserCallback): URLSearchParams {
  if (callback instanceof URLSearchParams) return callback
  if (callback instanceof URL) return callback.searchParams
  const text = callback.trim()
  // A full URL (as pasted from the address bar) or just its query string.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) return new URL(text).searchParams
  return new URLSearchParams(text.startsWith('?') ? text.slice(1) : text)
}

function randomToken(bytes: number): string {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return base64Url(value)
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}
