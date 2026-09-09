import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NextConfig } from 'next'

// The sample reuses the repository's root .env (provider credentials) instead
// of asking for a second copy of the same key.
const rootEnv = resolve(process.cwd(), '../../../.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)
// Sample-local state: SQLite database and the default agent workspace sandbox.
process.env.CHAT_AGENTS_DB ??= resolve(process.cwd(), '../.data/chat-agents.db')
process.env.CHAT_AGENTS_WORKSPACE ??= resolve(process.cwd(), '../.workspace')
// Next bundles the backend package, so point the migration runner at the
// generated SQL explicitly rather than at the bundle's own location.
process.env.CHAT_AGENTS_MIGRATIONS ??= resolve(process.cwd(), '../backend/drizzle')
// Codex tokens live in the repository's project-local store, not in the Codex
// CLI's own file: sharing one rotating refresh token would log the CLI out.
process.env.AI_AGENT_SDK_CODEX_AUTH ??= resolve(process.cwd(), '../../../.providers/.codex/auth.json')


const config: NextConfig = {
  // Isolated live checks can run beside the developer server.
  ...(process.env.CHAT_AGENTS_DIST_DIR === undefined ? {} : { distDir: process.env.CHAT_AGENTS_DIST_DIR }),
  // The backend ships TypeScript sources and is consumed as a dependency, so
  // Next compiles it in the same pass as the app.
  transpilePackages: ['@chat-agents/backend'],
  experimental: {
    // The markdown renderer and the Shiki highlighter are the two heavy client
    // imports; keeping their barrels un-flattened keeps dev rebuilds honest.
    optimizePackageImports: ['shiki', '@shikijs/langs'],
  },
}

export default config
