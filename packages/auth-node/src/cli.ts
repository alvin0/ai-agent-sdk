import { openBrowser } from './common/browser.ts'
/**
 * `npm run provider:codex:login-device` / `npm run provider:codex:login-browser`
 *
 * Signs in to Codex with the OAuth device-code flow (default) or, with
 * `--browser`, straight through the browser with a loopback callback on
 * `localhost:1455` (no device authorization needed), and stores the tokens in this
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
 *   --browser        sign in through the browser instead of with a device code
 *   --port <n>       loopback port for --browser (default 1455)
 *   --force          sign in again even if valid credentials already exist
 *   --status         report the current credential state and exit
 *   --account <name> sign in a named extra account (`.providers/.codex/accounts/<name>.json`),
 *                    e.g. a backup for `failoverProviderPlugin`
 *   --path <file>    write somewhere other than the default
 *   --issuer <url>   use a non-production auth issuer
 */

import {
  codexAccountAuthPath,
  fileCodexAuthStore,
  readJwtClaims,
  resolveCodexAuthPath,
  runBrowserLogin,
  runDeviceCodeLogin,
  shouldRefresh,
  type CodexLoginResult,
  type CodexDeviceCode,
  type CodexAuthFile,
} from './codex.ts'

const BLUE = '\u001B[94m'
const GRAY = '\u001B[90m'
const BOLD = '\u001B[1m'
const RESET = '\u001B[0m'

interface Flags {
  browser: boolean
  port: number | undefined
  force: boolean
  status: boolean
  path: string | undefined
  issuer: string | undefined
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { browser: false, port: undefined, force: false, status: false, path: undefined,
    issuer: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case '--browser': flags.browser = true; break
      case '--force': flags.force = true; break
      case '--status': flags.status = true; break
      default:
        if (arg !== undefined && VALUE_FLAGS.has(arg)) setValueFlag(flags, arg, argv[++index])
        else if (arg !== undefined && arg.startsWith('-')) throw new Error(`unknown flag "${arg}"`)
    }
  }
  return flags
}

const VALUE_FLAGS = new Set(['--port', '--path', '--account', '--issuer'])

function setValueFlag(flags: Flags, arg: string, value: string | undefined): void {
  // A missing value must not silently fall back to a default, nor swallow the next flag as its value.
  if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${arg} requires a value`)
  switch (arg) {
    case '--port': flags.port = parsePort(value); break
    case '--path': flags.path = value; break
    case '--account': flags.path = codexAccountAuthPath(value); break
    default: flags.issuer = value
  }
}

function parsePort(value: string | undefined): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid --port "${value ?? ''}"`)
  return port
}

function renderBrowserPrompt(url: string): void {
  process.stdout.write(
    `\n${BOLD}Sign in to Codex${RESET} ${GRAY}(browser)${RESET}\n`
    + `\n  Opening your browser. If it does not open, visit:\n     ${BLUE}${url}${RESET}\n`
    + `\n${GRAY}  waiting for the browser to return to localhost… (Ctrl-C to cancel)${RESET}\n`,
  )
}

function renderPrompt(code: CodexDeviceCode): void {
  process.stdout.write(
    `\n${BOLD}Sign in to Codex${RESET} ${GRAY}(device authorization)${RESET}\n`
    + `\n  1. Open this URL and sign in:\n     ${BLUE}${code.verificationUrl}${RESET}\n`
    + `\n  2. Enter this one-time code ${GRAY}(expires in 15 minutes)${RESET}:\n`
    + `     ${BOLD}${BLUE}${code.userCode}${RESET}\n`
    + `\n${GRAY}Only continue if YOU started this login. If someone sent you this code, stop.${RESET}\n\n`,
  )
}


function renderStatus(existing: CodexAuthFile, tokens: NonNullable<CodexAuthFile['tokens']>, location: string) {
    const claims = readJwtClaims(tokens.id_token)
    const stale = shouldRefresh(existing)
    process.stdout.write(
      `codex: signed in ${GRAY}(${location})${RESET}\n`
      + `  account : ${claims?.accountId ?? tokens.account_id ?? '<none>'}\n`
      + `  email   : ${claims?.email ?? '<undisclosed>'}\n`
      + `  plan    : ${claims?.planType ?? '<undisclosed>'}\n`
      + `  token   : ${stale ? 'needs refresh' : 'valid'}\n`,
    )
}

function reportStatus(existing: CodexAuthFile | undefined, location: string): number {
    if (existing?.tokens === undefined || existing.tokens === null) {
      process.stdout.write(`codex: not signed in ${GRAY}(${location})${RESET}\n`)
      return 1
    }
    renderStatus(existing, existing.tokens, location)
    return 0
}

async function signIn(flags: Flags, store: ReturnType<typeof fileCodexAuthStore>): Promise<number> {
  // Ctrl-C during a 15-minute poll should exit promptly rather than wait.
  const cancel = new AbortController()
  const onSigint = (): void => {
    cancel.abort()
    process.stdout.write('\ncodex: login cancelled\n')
  }
  process.once('SIGINT', onSigint)

  try {
    const options = { signal: cancel.signal, ...flags.issuer === undefined ? {} : { issuer: flags.issuer } }
    const result = flags.browser
      ? await runBrowserLogin(store, { ...options, ...flags.port === undefined ? {} : { port: flags.port } }, {
        onPrompt: ({ url }) => {
          renderBrowserPrompt(url)
          void openBrowser(url)
        },
      })
      : await deviceLogin(store, options)
    renderSignedIn(result)
    return 0
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

function renderSignedIn(result: CodexLoginResult): void {
  process.stdout.write(
    `\n${BOLD}codex: signed in${RESET}\n`
    + `  account : ${result.accountId ?? '<none>'}\n`
    + `  email   : ${result.email ?? '<undisclosed>'}\n`
    + `  plan    : ${result.planType ?? '<undisclosed>'}\n`
    + `  stored  : ${result.location} ${GRAY}(git-ignored)${RESET}\n`,
  )
}

async function deviceLogin(store: ReturnType<typeof fileCodexAuthStore>,
  options: { signal: AbortSignal; issuer?: string }): Promise<CodexLoginResult> {
  let lastReport = 0
  return await runDeviceCodeLogin(store, options, {
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
  })
}

function reportExistingSignIn(flags: Flags, existing: CodexAuthFile | undefined, location: string): boolean {
  if (!flags.force && existing?.tokens !== undefined && existing.tokens !== null
    && !shouldRefresh(existing)) {
    const claims = readJwtClaims(existing.tokens.id_token)
    process.stdout.write(
      `codex: already signed in as ${claims?.email ?? claims?.accountId ?? 'this account'}\n`
      + `${GRAY}  ${location}\n  pass --force to sign in again${RESET}\n`,
    )
    return true
  }

  return false
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const location = resolveCodexAuthPath(flags.path)
  const store = fileCodexAuthStore(location)
  const existing = await store.read()

  if (flags.status) return reportStatus(existing, location)

  if (reportExistingSignIn(flags, existing, location)) return 0

  return signIn(flags, store)
}

try {
  process.exitCode = await main()
} catch (error: unknown) {
  process.stdout.write(`\ncodex: login failed — ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
