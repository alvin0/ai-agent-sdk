/**
 * Environment markers for confined children.
 *
 * Tools, test suites, and nested agents cannot otherwise tell they are running
 * under confinement, so they retry writes that will never succeed. These two
 * variables make the boundary observable from inside it.
 */

/** Set to the selected backend id whenever confinement is active. */
export const SANDBOX_ENV_VAR = 'AI_AGENT_SDK_SANDBOX'

/** Set to the active file-effect mode whenever confinement is active. */
export const SANDBOX_MODE_ENV_VAR = 'AI_AGENT_SDK_SANDBOX_MODE'

/** The environment additions one confined execution should carry. */
export function sandboxEnv(backend: string, mode: string): Readonly<Record<string, string>> {
  return Object.freeze({ [SANDBOX_ENV_VAR]: backend, [SANDBOX_MODE_ENV_VAR]: mode })
}

/** Whether the current process is itself running inside a sandbox. */
export function insideSandbox(env: Readonly<Record<string, string | undefined>>): boolean {
  return typeof env[SANDBOX_ENV_VAR] === 'string' && env[SANDBOX_ENV_VAR] !== ''
}
