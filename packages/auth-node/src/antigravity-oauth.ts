import type { AntigravityOAuthOptions } from '@alvin0/ai-agent-sdk-provider-antigravity'

export const ANTIGRAVITY_CLIENT_ID_ENV = 'AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID'
export const ANTIGRAVITY_CLIENT_SECRET_ENV = 'AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET'

function environmentSecret(options: AntigravityOAuthOptions, env: Readonly<Record<string, string | undefined>>) {
  const environmentId = env[ANTIGRAVITY_CLIENT_ID_ENV]?.trim()
  if (options.clientId !== undefined && environmentId !== undefined && options.clientId !== environmentId) {
    return undefined
  }
  return env[ANTIGRAVITY_CLIENT_SECRET_ENV]?.trim()
}

/** Node-only defaults. Explicit options take precedence; Universal code never consults the environment. */
export function withAntigravityOAuthEnvironment<T extends AntigravityOAuthOptions>(
  options: T, env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  const clientId = options.clientId ?? env[ANTIGRAVITY_CLIENT_ID_ENV]?.trim()
  const clientSecret = options.clientSecret ?? environmentSecret(options, env)
  return { ...options,
    ...(clientId === undefined || clientId === '' ? {} : { clientId }),
    ...(clientSecret === undefined || clientSecret === '' ? {} : { clientSecret }),
  }
}
