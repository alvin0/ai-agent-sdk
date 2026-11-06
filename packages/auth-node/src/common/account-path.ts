/** Project-local credential paths for additional named accounts. */

const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Relative credential path for one named account of a provider, beside its
 * default credential file: `.providers/.<provider>/accounts/<name>.json`.
 * @throws TypeError when the name is not a safe path segment.
 */
export function accountAuthPath(provider: 'codex' | 'copilot', name: string): string {
  if (!ACCOUNT_NAME.test(name) || name.includes('..')) {
    throw new TypeError(`account name ${JSON.stringify(name)} must be 1-64 letters, digits, '.', '_' or '-'`)
  }
  return `.providers/.${provider}/accounts/${name}.json`
}
