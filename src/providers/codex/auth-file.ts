/**
 * The Codex credential file: its shape, where it lives, and how to read the
 * claims buried inside its JWTs.
 *
 * This SDK deliberately keeps its OWN credential store, project-local by default
 * at `.providers/.codex/auth.json`, instead of reading `~/.codex/auth.json`.
 * Sharing the global file would mean two programs writing the same refresh token:
 * OAuth refresh tokens are single-use, so whichever process refreshes second gets
 * `refresh_token_reused` and the user is silently logged out of their real Codex
 * CLI. An isolated store cannot do that.
 *
 * The on-disk format is kept byte-compatible with the Codex CLI's file anyway, so
 * a user who wants to point this SDK at an existing login can, explicitly.
 *
 * @module ai-agent-sdk/providers/codex/auth-file
 */

import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@ai-agent-sdk/core'

/** Default project-relative location of this SDK's own Codex credentials. */
export const DEFAULT_CODEX_AUTH_PATH = '.providers/.codex/auth.json'

/** Environment variable that overrides the credential file location. */
export const CODEX_AUTH_PATH_ENV = 'AI_AGENT_SDK_CODEX_AUTH'

/** OAuth tokens as stored on disk. */
export interface CodexTokens {
  /** Raw JWT. Carries the account and plan claims. */
  id_token: string
  /** Raw JWT used as the bearer token. Its `exp` drives refresh. */
  access_token: string
  /** Single-use; rotated on every refresh. */
  refresh_token: string
  /** Workspace/account id, or null when it must be read from `id_token`. */
  account_id?: string | null
}

/** The credential file, matching the Codex CLI's own format. */
export interface CodexAuthFile {
  auth_mode?: string
  /** Present for API-key logins; unused by the ChatGPT-token path. */
  OPENAI_API_KEY?: string | null
  tokens?: CodexTokens | null
  /** RFC3339. Fallback staleness signal when `access_token.exp` is unreadable. */
  last_refresh?: string | null
}

/**
 * Read and write the credential file.
 *
 * An interface rather than direct `node:fs` calls so the adapter stays free of a
 * filesystem dependency: tests substitute an in-memory store, and a deployment
 * that keeps credentials in a secret manager substitutes its own.
 */
export interface CodexAuthStore {
  /** Human-readable location, used only in diagnostics. */
  readonly location: string
  /** The file's contents, or `undefined` when it does not exist. */
  read(): Promise<CodexAuthFile | undefined>
  /** Replace the file's contents. */
  write(file: CodexAuthFile): Promise<void>
}

/**
 * Resolve where the credential file should live.
 * @param explicitPath - a caller-supplied path, which always wins.
 * @returns the resolved path.
 */
export function resolveCodexAuthPath(explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.length > 0) return explicitPath
  const fromEnv = globalThis.process?.env?.[CODEX_AUTH_PATH_ENV]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return DEFAULT_CODEX_AUTH_PATH
}

/**
 * A {@link CodexAuthStore} backed by the local filesystem.
 *
 * `node:fs` is imported dynamically so that merely importing this module does not
 * require a filesystem, keeping the rest of the package usable on runtimes that
 * have none.
 * @param path - file location; defaults to {@link resolveCodexAuthPath}.
 * @returns a store reading and writing that path.
 */
export function fileCodexAuthStore(path?: string): CodexAuthStore {
  const location = resolveCodexAuthPath(path)
  return {
    location,
    async read(): Promise<CodexAuthFile | undefined> {
      const { readFile } = await import('node:fs/promises')
      let raw: string
      try {
        raw = await readFile(location, 'utf8')
      } catch (error: unknown) {
        if ((error as { code?: string } | null)?.code === 'ENOENT') return undefined
        throw error
      }
      try {
        return JSON.parse(raw) as CodexAuthFile
      } catch (error: unknown) {
        throw new AgentSdkError(
          `Codex credential file at ${location} is not valid JSON; delete it and log in again`,
          'INVALID_CREDENTIAL',
          { cause: error },
        )
      }
    },
    async write(file: CodexAuthFile): Promise<void> {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(location), { recursive: true })
      // 0600: the file holds a long-lived refresh token. The mode is a no-op on
      // Windows, where directory ACLs are the actual protection.
      await writeFile(location, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    },
  }
}

/** An in-memory {@link CodexAuthStore}, for tests. */
export function memoryCodexAuthStore(initial?: CodexAuthFile): CodexAuthStore {
  let current = initial
  return {
    location: '<memory>',
    read: () => Promise.resolve(current),
    write: (file) => {
      current = file
      return Promise.resolve()
    },
  }
}

/** The custom claim namespace OpenAI puts its ChatGPT account fields under. */
const AUTH_CLAIM_NAMESPACE = 'https://api.openai.com/auth'

/** Claims this SDK reads out of a Codex JWT. */
export interface CodexJwtClaims {
  exp?: number
  email?: string
  accountId?: string
  planType?: string
  isFedramp: boolean
}

/** Decode a base64url segment without requiring Node's Buffer. */
function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (segment.length % 4)) % 4)
  const binary = atob(padded)
  // The payload is UTF-8; `atob` yields latin1, so re-decode to preserve
  // non-ASCII values such as an email with accented characters.
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Read the claims this SDK cares about out of a JWT.
 *
 * The signature is NOT verified, and does not need to be: this token is being
 * read to decide which account id to send and whether to refresh, not to grant
 * anything. The issuer verifies it.
 * @param jwt - a compact-serialization JWT.
 * @returns the claims, or `undefined` when the token is unreadable.
 */
export function readJwtClaims(jwt: string): CodexJwtClaims | undefined {
  const parts = jwt.split('.')
  const payload = parts.length === 3 ? parts[1] : undefined
  if (payload === undefined || payload.length === 0) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(decodeBase64Url(payload)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const auth = parsed[AUTH_CLAIM_NAMESPACE]
  const authClaims = typeof auth === 'object' && auth !== null
    ? auth as Record<string, unknown>
    : {}
  const exp = parsed.exp
  const email = parsed.email
  const accountId = authClaims.chatgpt_account_id
  const planType = authClaims.chatgpt_plan_type
  return {
    ...typeof exp === 'number' ? { exp } : {},
    ...typeof email === 'string' ? { email } : {},
    ...typeof accountId === 'string' ? { accountId } : {},
    ...typeof planType === 'string' ? { planType } : {},
    isFedramp: authClaims.chatgpt_account_is_fedramp === true,
  }
}

/**
 * Resolve the account id to send as `ChatGPT-Account-ID`.
 *
 * Prefers the stored value and falls back to the `id_token` claim, because the
 * stored field is legitimately null for personal accounts.
 * @param tokens - the stored tokens.
 * @returns the account id, or `undefined` when neither source has one.
 */
export function resolveAccountId(tokens: CodexTokens): string | undefined {
  const stored = tokens.account_id
  if (typeof stored === 'string' && stored.length > 0) return stored
  return readJwtClaims(tokens.id_token)?.accountId
}

/** Whether this account must be routed through the FedRAMP edge. */
export function isFedrampAccount(tokens: CodexTokens): boolean {
  return readJwtClaims(tokens.id_token)?.isFedramp === true
}

/** Refresh this long before the access token actually expires. */
export const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1_000

/** Fallback staleness bound, used only when `exp` cannot be read. */
export const LAST_REFRESH_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000

/**
 * Whether the access token should be refreshed before the next request.
 *
 * Primary signal is the token's own `exp`, with a five-minute margin so a request
 * cannot expire in flight. The `last_refresh` age is only a fallback for a token
 * whose `exp` is unreadable — matching how the Codex CLI decides.
 * @param file - the credential file.
 * @param now - current time in epoch milliseconds; injectable for tests.
 * @returns true when a refresh is due.
 */
export function shouldRefresh(file: CodexAuthFile, now = Date.now()): boolean {
  const tokens = file.tokens
  if (tokens === undefined || tokens === null) return false
  const exp = readJwtClaims(tokens.access_token)?.exp
  if (exp !== undefined) return exp * 1_000 <= now + ACCESS_TOKEN_REFRESH_WINDOW_MS
  const lastRefresh = file.last_refresh
  if (lastRefresh === undefined || lastRefresh === null) return false
  const at = Date.parse(lastRefresh)
  return Number.isFinite(at) && at < now - LAST_REFRESH_MAX_AGE_MS
}

/**
 * Require usable ChatGPT tokens, with a message that says how to get them.
 * @param file - the credential file, or `undefined` when absent.
 * @param location - the path checked, named in the diagnostic.
 * @returns the tokens.
 */
export function requireTokens(
  file: CodexAuthFile | undefined,
  location: string,
): CodexTokens {
  const tokens = file?.tokens
  if (tokens === undefined || tokens === null
    || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new AgentSdkError(
      `no Codex credentials at ${location}; run \`npm run provider:codex:login-device\` to sign in`,
      MISSING_CREDENTIAL_CODE,
    )
  }
  return tokens
}
