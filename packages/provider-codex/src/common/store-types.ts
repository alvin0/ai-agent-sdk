import type { CredentialStore } from '@alvin0/ai-agent-sdk-core/provider'

/** OAuth tokens as stored by Codex authentication. */
export interface CodexTokens {
  id_token: string
  access_token: string
  refresh_token: string
  account_id?: string | null
}

/** Persisted Codex authentication document. */
export interface CodexAuthFile {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: CodexTokens | null
  last_refresh?: string | null
}

/** @deprecated Marker-free storage contract retained for compatibility. */
export interface CodexAuthStore {
  readonly location: string
  read(): Promise<CodexAuthFile | undefined>
  write(file: CodexAuthFile): Promise<void>
}

/** Revision-aware credential storage used by normal runtime composition. */
export type CodexCredentialStore = CredentialStore<CodexAuthFile>
