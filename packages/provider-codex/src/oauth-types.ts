import {
  type CodexAuthFile,
  type CodexAuthStore,
  type CodexCredentialStore,
} from './auth.ts'


export type AnyCodexStore = CodexAuthStore | CodexCredentialStore

export interface CodexStoreSnapshot {
  readonly file: CodexAuthFile | undefined
  readonly revision: string | null
}

/** OpenAI's auth issuer. */
export const DEFAULT_CODEX_ISSUER = 'https://auth.openai.com'

/** The public OAuth client id the Codex CLI uses; not a secret. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** The device code expires server-side after this long. */
export const DEVICE_CODE_MAX_WAIT_MS = 15 * 60 * 1_000

/** Used when the server does not state a polling interval. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5

/** Shared settings for the OAuth calls. */
export interface CodexOAuthOptions {
  /** Auth issuer base URL; defaults to {@link DEFAULT_CODEX_ISSUER}. */
  issuer?: string
  /** OAuth client id; defaults to {@link CODEX_CLIENT_ID}. */
  clientId?: string
  /** Cancellation for the whole flow. */
  signal?: AbortSignal
  /** HTTP implementation for tests and non-browser runtimes. */
  fetch?: typeof fetch
  /** Deadline for each auth HTTP request. Defaults to 30 seconds. */
  requestTimeoutMs?: number
  /** Maximum auth response bytes retained or parsed. Defaults to 1 MiB. */
  maxResponseBytes?: number
  /** Maximum auth response chunks accepted. Defaults to 10,000. */
  maxResponseChunks?: number
  /** Permit an http:// issuer for a trusted local test endpoint. Defaults to false. */
  allowInsecureIssuer?: boolean
}

/** Settings for reading credentials from any store and optionally refreshing them. */
export interface GetCodexTokensOptions extends CodexOAuthOptions {
  /** Defaults to true. Set false to read the stored tokens without refreshing. */
  readonly refreshIfNeeded?: boolean
}

/** A pending device authorization the user has to approve. */
export interface CodexDeviceCode {
  /** URL to open in a browser. */
  verificationUrl: string
  /** One-time code the user types there. */
  userCode: string
  /** Opaque server-side handle for this authorization. */
  deviceAuthId: string
  /** Seconds to wait between polls. */
  intervalSeconds: number
}

/** Progress reported while a device-code login runs. */
export interface CodexLoginProgress {
  /** The code is ready; show it to the user. */
  onPrompt?: (code: CodexDeviceCode) => void
  /** Called before each poll, so a CLI can show that it is still waiting. */
  onPoll?: (elapsedMs: number) => void
}

/** What the poll endpoint hands back once the user approves. */
export interface AuthorizationGrant {
  authorizationCode: string
  codeVerifier: string
}

/** Result of a completed device-code login. */
export interface CodexLoginResult {
  /** Where the credentials were written. */
  location: string
  /** Signed-in account email, when the token discloses one. */
  email: string | undefined
  /** Workspace/account id that requests will carry. */
  accountId: string | undefined
  /** Plan type, when disclosed. */
  planType: string | undefined
}
