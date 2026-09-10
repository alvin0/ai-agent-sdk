import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NextConfig } from 'next'

// The sample reuses the repository's root .env (provider credentials) instead
// of asking for a second copy of the same key. This runs in the Node process
// that builds the app, never inside the Edge runtime that serves it.
const rootEnv = resolve(process.cwd(), '../../../.env')
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const config: NextConfig = {
  // Nothing here is Node-specific, so no package needs transpiling and no
  // `serverExternalPackages` escape hatch applies: the Edge bundle has to
  // contain every module it calls.
  experimental: {},
}

export default config
