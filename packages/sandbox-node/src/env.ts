/**
 * Environment markers, and the environment a confined execution should get.
 *
 * A file boundary says nothing about environment variables, and the process
 * that spawns a confined command usually holds the credentials the agent runs
 * on — `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, an API key. Inheriting the
 * parent environment wholesale hands every one of them to the command, so the
 * confinement stops at the filesystem while the secrets walk through.
 *
 * The default is therefore an allow-list: enough for a program to run, and
 * nothing that identifies the caller.
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

/**
 * Variables a confined command receives by default: locale, paths, and the
 * handful of names a shell or toolchain needs to start at all. Nothing here
 * identifies the caller or authorizes anything on their behalf.
 */
export const BASELINE_ENV_NAMES: readonly string[] = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'PWD', 'SHELL',
  'TMPDIR', 'TEMP', 'TMP',
  // Windows needs these to resolve an executable at all.
  'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE',
])

/**
 * Names that carry a credential regardless of which tool defined them. Applied
 * even to explicitly allowed variables, because an allow-list is written once
 * and the environment keeps changing.
 */
const SECRET_NAME_PATTERN =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|API_KEY|ACCESS_KEY|SESSION|COOKIE|AUTH)(_|$)/i

/** Whether a variable name looks like it carries a credential. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name)
}

/** How the environment for a confined execution is assembled. */
export interface ConfinedEnvOptions {
  /** Source environment; defaults to the current process's. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Extra names to pass through, beyond {@link BASELINE_ENV_NAMES}. */
  readonly allow?: readonly string[]
  /**
   * Pass the whole source environment instead of the allow-list. The
   * credential-shaped names are still removed — an operator asking for the
   * caller's environment is asking for its configuration, not its secrets.
   */
  readonly inherit?: boolean
}

/**
 * Build the environment a confined execution receives.
 * @param additions - the confinement markers from `confine()`.
 */
export function confinedEnv(
  additions: Readonly<Record<string, string>> = {},
  options: ConfinedEnvOptions = {},
): Readonly<Record<string, string>> {
  const source = options.env ?? process.env
  const allowed = new Set([...BASELINE_ENV_NAMES, ...(options.allow ?? [])])
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isSecretEnvName(name)) continue
    if (options.inherit !== true && !allowed.has(name)) continue
    result[name] = value
  }
  return Object.freeze({ ...result, ...additions })
}
