import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import {
  type CodexTokens,
} from './auth.ts'


/** Why a refresh failed, which decides whether re-login is required. */
export type RefreshFailureKind = 'permanent' | 'transient'

/** A refresh that did not succeed. */
export class CodexRefreshError extends AgentSdkError {
  readonly kind: RefreshFailureKind

  constructor(message: string, kind: RefreshFailureKind, options?: ErrorOptions) {
    super(message, kind === 'permanent' ? 'CODEX_REAUTH_REQUIRED' : 'CODEX_REFRESH_TRANSIENT', options)
    this.kind = kind
  }
}

/** Error codes that mean the refresh token is gone for good. */
export const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
])

const STANDARD_OAUTH_ERROR_CODES = new Set([
  'access_denied', 'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
  'unsupported_grant_type', 'invalid_scope', 'unsupported_response_type', 'server_error', 'temporarily_unavailable',
])

/** Retain protocol classifications without retaining service-authored details. */
export function safeOAuthErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined
  const code = value.toLowerCase()
  return STANDARD_OAUTH_ERROR_CODES.has(code) || PERMANENT_REFRESH_CODES.has(code) ? code : undefined
}

/** Pull an OAuth error code out of either body shape the endpoint uses. */
export function refreshErrorCode(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const error = parsed.error
    if (typeof error === 'string') return safeOAuthErrorCode(error)
    if (typeof error === 'object' && error !== null) {
      const code = (error as Record<string, unknown>).code
      if (typeof code === 'string') return safeOAuthErrorCode(code)
    }
    const code = parsed.code
    return safeOAuthErrorCode(code)
  } catch {
    return undefined
  }
}

export function requireRefreshTokens(tokens: CodexTokens, location: string): CodexTokens {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0
    || typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length === 0) {
    throw new CodexRefreshError(`refreshed credentials at ${location} are incomplete`, 'permanent')
  }
  return tokens
}
