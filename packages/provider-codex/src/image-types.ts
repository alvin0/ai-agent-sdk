import type { ImageBlock } from '@alvin0/ai-agent-sdk-core'
import type { CodexAuthStore, CodexCredentialStore } from './auth.ts'
import type { CodexOAuthOptions } from './oauth-types.ts'

/** Experimental standalone Images transport; separate from Responses native tools. */
export interface CodexImageOptions {
  readonly authStore: CodexAuthStore | CodexCredentialStore
  /** Required image model. Never inferred from the agent's text model or silently replaced. */
  readonly model: string
  /** Codex API base; defaults to CODEX_BASE_URL. Only send credentials to a trusted HTTPS host. */
  readonly baseUrl?: string
  readonly originator?: string
  readonly oauth?: CodexOAuthOptions
  readonly fetch?: typeof globalThis.fetch
  /** Includes credential resolution and response reading. Defaults to 180 seconds. */
  readonly timeoutMs?: number
  /** Maximum encoded JSON bytes. Standalone defaults to 32 MiB; host tool defaults to 2,000,000 bytes. */
  readonly maxBytes?: number
  readonly quality?: 'auto' | 'low' | 'medium' | 'high'
  readonly size?: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'
  readonly background?: 'auto' | 'opaque' | 'transparent'
}

export interface GenerateCodexImageOptions extends CodexImageOptions {
  readonly prompt: string
  readonly signal?: AbortSignal
}

export interface CodexImageResult {
  readonly images: readonly ImageBlock[]
}
