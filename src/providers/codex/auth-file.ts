/** Node filesystem store plus Universal Codex auth contracts. */

import { AgentSdkError } from '@ai-agent-sdk/core'
import type { CodexAuthFile, CodexAuthStore } from '@ai-agent-sdk/provider-codex'

export const DEFAULT_CODEX_AUTH_PATH = '.providers/.codex/auth.json'
export const CODEX_AUTH_PATH_ENV = 'AI_AGENT_SDK_CODEX_AUTH'

export function resolveCodexAuthPath(explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.length > 0) return explicitPath
  const fromEnv = globalThis.process?.env?.[CODEX_AUTH_PATH_ENV]
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_CODEX_AUTH_PATH
}

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
      await writeFile(location, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600,
      })
    },
  }
}

export {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  LAST_REFRESH_MAX_AGE_MS,
  isFedrampAccount,
  memoryCodexAuthStore,
  readJwtClaims,
  requireTokens,
  resolveAccountId,
  shouldRefresh,
  type CodexAuthFile,
  type CodexAuthStore,
  type CodexJwtClaims,
  type CodexTokens,
} from '@ai-agent-sdk/provider-codex'
