/**
 * `npm run provider:codex:login-device`
 *
 * Signs in to Codex with the OAuth device-code flow and stores the tokens in this
 * PROJECT, at `.providers/.codex/auth.json`, rather than touching the Codex CLI's
 * own `~/.codex/auth.json`.
 *
 * The isolation is deliberate. OAuth refresh tokens are single-use and rotate on
 * every refresh, so two programs sharing one credential file will eventually race:
 * the second one to refresh replays a spent token, gets `refresh_token_reused`, and
 * the user is silently logged out of their real Codex CLI. A separate store cannot
 * cause that.
 *
 * Flags:
 *   --force          sign in again even if valid credentials already exist
 *   --status         report the current credential state and exit
 *   --path <file>    write somewhere other than the default
 *   --issuer <url>   use a non-production auth issuer
 */

import {
  fileCodexAuthStore,
  readJwtClaims,
  resolveCodexAuthPath,
  runDeviceCodeLogin,
  shouldRefresh,
  type CodexDeviceCode,
} from './codex.ts'

const BLUE = '\u001B[94m'
const GRAY = '\u001B[90m'
const BOLD = '\u001B[1m'
const RESET = '\u001B[0m'

interface Flags {
  force: boolean
  status: boolean
  path: string | undefined
  issuer: string | undefined
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { force: false, status: false, path: undefined, issuer: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case '--force': flags.force = true; break
      case '--status': flags.status = true; break
      case '--path': flags.path = argv[++index]; break
      case '--issuer': flags.issuer = argv[++index]; break
      default:
        if (arg !== undefined && arg.startsWith('-')) {
          throw new Error(`unknown flag "${arg}"`)
        }
    }
  }
  return flags
}

function renderPrompt(code: CodexDeviceCode): void {
  process.stdout.write(
    `\n${BOLD}Sign in to Codex${RESET} ${GRAY}(device authorization)${RESET}\n`
    + `\n  1. Open this URL and sign in:\n     ${BLUE}${code.verificationUrl}${RESET}\n`
    + `\n  2. Enter this one-time code ${GRAY}(expires in 15 minutes)${RESET}:\n     ${BOLD}${BLUE}${code.userCode}${RESET}\n`
    + `\n${GRAY}Only continue if YOU started this login. If someone sent you this code, stop.${RESET}\n\n`,
  )
}

/** Best-effort browser launch; failure is fine because the URL is printed anyway. */
async function openBrowser(url: string): Promise<void> {
  try {
    const { spawn } = await import('node:child_process')
    const command = process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] }
    spawn(command.file, command.args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // The printed URL is the real interface; auto-open is a convenience.
  }
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const location = resolveCodexAuthPath(flags.path)
  const store = fileCodexAuthStore(location)
  const existing = await store.read()

  if (flags.status) {
    if (existing?.tokens === undefined || existing.tokens === null) {
      process.stdout.write(`codex: not signed in ${GRAY}(${location})${RESET}\n`)
      return 1
    }
    const claims = readJwtClaims(existing.tokens.id_token)
    const stale = shouldRefresh(existing)
    process.stdout.write(
      `codex: signed in ${GRAY}(${location})${RESET}\n`
      + `  account : ${claims?.accountId ?? existing.tokens.account_id ?? '<none>'}\n`
      + `  email   : ${claims?.email ?? '<undisclosed>'}\n`
      + `  plan    : ${claims?.planType ?? '<undisclosed>'}\n`
      + `  token   : ${stale ? 'needs refresh' : 'valid'}\n`,
    )
    return 0
  }

  if (!flags.force && existing?.tokens !== undefined && existing.tokens !== null
    && !shouldRefresh(existing)) {
    const claims = readJwtClaims(existing.tokens.id_token)
    process.stdout.write(
      `codex: already signed in as ${claims?.email ?? claims?.accountId ?? 'this account'}\n`
      + `${GRAY}  ${location}\n  pass --force to sign in again${RESET}\n`,
    )
    return 0
  }

  // Ctrl-C during a 15-minute poll should exit promptly rather than wait.
  const cancel = new AbortController()
  const onSigint = (): void => {
    cancel.abort()
    process.stdout.write('\ncodex: login cancelled\n')
  }
  process.once('SIGINT', onSigint)

  let lastReport = 0
  try {
    const result = await runDeviceCodeLogin(
      store,
      { signal: cancel.signal, ...flags.issuer === undefined ? {} : { issuer: flags.issuer } },
      {
        onPrompt: (code) => {
          renderPrompt(code)
          void openBrowser(code.verificationUrl)
        },
        onPoll: (elapsedMs) => {
          // Throttle to one line per 15s so a long wait does not spam the log.
          if (elapsedMs - lastReport < 15_000 && elapsedMs !== 0) return
          lastReport = elapsedMs
          process.stdout.write(`${GRAY}  waiting for approval… ${Math.round(elapsedMs / 1000)}s${RESET}\n`)
        },
      },
    )
    process.stdout.write(
      `\n${BOLD}codex: signed in${RESET}\n`
      + `  account : ${result.accountId ?? '<none>'}\n`
      + `  email   : ${result.email ?? '<undisclosed>'}\n`
      + `  plan    : ${result.planType ?? '<undisclosed>'}\n`
      + `  stored  : ${result.location} ${GRAY}(git-ignored)${RESET}\n`,
    )
    return 0
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

try {
  process.exitCode = await main()
} catch (error: unknown) {
  process.stdout.write(`\ncodex: login failed — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
