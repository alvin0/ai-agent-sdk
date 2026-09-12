/**
 * The persisted half of the two-tier Copilot credential contract.
 *
 * Two tiers, two lifetimes: the long-lived `GitHub_User_Token` lives here and on
 * disk, and the short-lived `Copilot_Api_Token` obtained from it lives only in
 * process memory (see `../exchange.ts`). This file describes the first tier and
 * nothing else.
 *
 * These types are declared here rather than derived from the Codex contract on
 * purpose: `CopilotAuthFile` DOES NOT import `CodexAuthFile` and IS NOT an alias
 * of it. The two credential models differ structurally — Codex rotates a
 * single-use refresh token, Copilot does not rotate anything — so an alias would
 * make a false claim that the type checker would then help spread.
 *
 * @module ai-agent-sdk/providers/copilot/store-types
 */

import type { CredentialStore } from '@alvin0/ai-agent-sdk-core/provider'

/**
 * The long-lived GitHub user token, prefixed `ghu_`.
 *
 * It DOES NOT rotate when it is exchanged for a `Copilot_Api_Token`. That is the
 * structural difference from Codex's single-use refresh token, and it is why the
 * credential file is written exactly once at login and only read from then on.
 */
export interface CopilotGitHubToken {
  /** The token value. Never put this in an error message or a trace. */
  readonly token: string
  /** Token type as declared by the endpoint, when present. Diagnostics only. */
  readonly tokenType?: string
  /** Granted scope, when the endpoint discloses it. Diagnostics only. */
  readonly scope?: string
}

/** Session identity, limited to what the endpoint actually discloses. */
export interface CopilotAccountIdentity {
  readonly login?: string
  readonly id?: number
  readonly name?: string
}

/**
 * The persisted credential document.
 *
 * Four things are deliberately absent, each one a decision:
 *
 * - **No `Copilot_Api_Token`.** The short-lived token lives ~25 minutes;
 *   persisting it adds a write path and a second secret on disk while saving
 *   nothing, because the next process run almost always has to exchange again.
 * - **No refresh-token field.** There is no refresh token in this model.
 *   `Copilot_Token_Exchange` does not consume the credential, so there is
 *   nothing to rotate.
 * - **No `last_refresh`.** Codex needs it as a fallback when `exp` is
 *   unreadable. Copilot reads `expires_at` straight from the exchange response,
 *   and that response lives in memory rather than in this file, so a
 *   file-age fallback would have nothing to say.
 * - **No API-key-equivalent config.** This surface rejects personal access
 *   tokens, so a "use an API key instead of OAuth" configuration has no
 *   situation to represent.
 */
export interface CopilotAuthFile {
  /**
   * Structure version. Reading a file with an unknown version is an error, not
   * an implicit migration.
   */
  readonly version: 1
  readonly github: CopilotGitHubToken
  readonly account?: CopilotAccountIdentity
  /** The OAuth client id that minted this token; used to diagnose a 403. */
  readonly clientId?: string
  /** Login time, ISO-8601. */
  readonly obtainedAt?: string
}

/**
 * @deprecated Read/write variant, kept only for symmetry with Codex. Normal
 * runtime composition uses {@link CopilotCredentialStore}.
 */
export interface CopilotAuthStore {
  readonly location: string
  read(): Promise<CopilotAuthFile | undefined>
  write(file: CopilotAuthFile): Promise<void>
}

/** Compare-and-swap variant used by normal runtime composition. */
export type CopilotCredentialStore = CredentialStore<CopilotAuthFile>
