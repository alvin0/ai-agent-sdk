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

/** Pull an OAuth error code out of either body shape the endpoint uses. */
export function refreshErrorCode(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const error = parsed.error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
      const code = (error as Record<string, unknown>).code
      if (typeof code === 'string') return code
    }
    const code = parsed.code
    return typeof code === 'string' ? code : undefined
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
