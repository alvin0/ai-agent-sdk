import type { CredentialStore } from '@alvin0/ai-agent-sdk-core/provider'

export interface AntigravityAuthFile {
  readonly version: 1
  readonly tokens: {
    readonly access_token: string
    readonly refresh_token: string
    readonly expires_at: number
  }
  readonly projectId: string
  readonly account?: { readonly email?: string }
  readonly clientId: string
  readonly obtainedAt: string
}

export type AntigravityCredentialStore = CredentialStore<AntigravityAuthFile>

export interface AntigravityOAuthOptions {
  /** Host-supplied OAuth client. Required for login; refresh reuses the credential record's clientId. */
  readonly clientId?: string
  /** Host-supplied secret, when required by the configured OAuth client. Never persisted in the auth file. */
  readonly clientSecret?: string
  readonly authorizationUrl?: string
  readonly tokenUrl?: string
  readonly userInfoUrl?: string
  readonly baseUrl?: string
  readonly userAgent?: string
  readonly projectId?: string
  readonly fetch?: typeof globalThis.fetch
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
  readonly maxResponseBytes?: number
  /** Explicit opt-in for local fixture endpoints. */
  readonly allowInsecureHttp?: boolean
}

export interface AntigravityAuthorization {
  readonly url: string
  readonly state: string
  readonly verifier: string
  readonly redirectUri: string
  readonly clientId: string
  readonly createdAt: number
}

export interface AntigravityLoginResult {
  readonly account?: { readonly email?: string }
  readonly projectId: string
}
