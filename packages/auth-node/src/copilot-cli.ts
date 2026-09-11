/**
 * `npm run provider:copilot:login-device`
 *
 * Signs in to GitHub Copilot with the OAuth device-code flow and stores the
 * long-lived `GitHub_User_Token` in this PROJECT, at
 * `.providers/.copilot/auth.json`, rather than touching the credential file of any
 * editor client or vendor CLI (Requirements 6.6, 6.7).
 *
 * The isolation has a different reason than the Codex CLI's. Codex MUST have its
 * own file because its refresh token rotates and is single-use, so two programs
 * sharing one file eventually sign the user out of their real CLI. Copilot has no
 * rotation hazard at all — the user token this file holds never changes — and is
 * still separate for the two remaining reasons: the SDK has no business writing
 * into another program's file, and a file the SDK owns is the precondition for
 * `--status` telling the truth about the SDK's OWN state.
 *
 * The short-lived `Copilot_Api_Token` is deliberately NOT persisted anywhere, so
 * `--status` cannot read one from disk. It performs ONE trial exchange instead,
 * which is the only honest way to answer "will a request work right now" — the
 * presence of a user token says nothing about whether the account still has a
 * Copilot subscription, and the exchange is the surface that knows.
 *
 * No command here ever prints a token value, in either tier (Requirement 13.7).
 *
 * Flags:
 *   --force              sign in again even when a credential already exists
 *   --status             report credential state plus one trial token exchange
 *   --models             list the catalog with the endpoint chosen for each model
 *   --path <file>        read/write somewhere other than the default
 *   --issuer <url>       use a non-production OAuth issuer
 *   --github-api <url>   use a non-production GitHub API base for the exchange
 *
 * @module ai-agent-sdk/auth-node/copilot-cli
 */

import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import {
  COPILOT_BASE_URL,
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_DEVICE_LOGIN_WARNING,
  createCopilotEndpointRouter,
  discoverCopilotModels,
  exchangeCopilotToken,
  fileCopilotCredentialStore,
  requireGitHubToken,
  resolveCopilotAuthPath,
  resolveCopilotCatalogLimits,
  runCopilotDeviceLogin,
  type CopilotAuthFile,
  type CopilotDeviceCode,
  type CopilotGitHubToken,
} from './copilot.ts'

const BLUE = '\u001B[94m'
const GRAY = '\u001B[90m'
const BOLD = '\u001B[1m'
const RESET = '\u001B[0m'

/** Sink for the credential-store operation options; a CLI has no log pipeline. */
const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

interface Flags {
  force: boolean
  status: boolean
  models: boolean
  path: string | undefined
  issuer: string | undefined
  githubApi: string | undefined
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    force: false,
    status: false,
    models: false,
    path: undefined,
    issuer: undefined,
    githubApi: undefined,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case '--force': flags.force = true; break
      case '--status': flags.status = true; break
      case '--models': flags.models = true; break
      case '--path': flags.path = argv[++index]; break
      case '--issuer': flags.issuer = argv[++index]; break
      case '--github-api': flags.githubApi = argv[++index]; break
      default:
        if (arg !== undefined && arg.startsWith('-')) {
          throw new Error(`unknown flag "${arg}"`)
        }
    }
  }
  return flags
}

function renderPrompt(code: CopilotDeviceCode): void {
  process.stdout.write(
    `\n${BOLD}Sign in to GitHub Copilot${RESET} ${GRAY}(device authorization)${RESET}\n`
    + `\n  1. Open this URL and sign in:\n     ${BLUE}${code.verificationUrl}${RESET}\n`
    + `\n  2. Enter this one-time code ${GRAY}(expires in ${Math.round(code.expiresInSeconds / 60)} minutes)${RESET}:\n`
    + `     ${BOLD}${BLUE}${code.userCode}${RESET}\n`
    + `\n${GRAY}${COPILOT_DEVICE_LOGIN_WARNING}${RESET}\n\n`,
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

/** Read the credential file, or `undefined` when the store is empty. */
async function readCredential(
  store: ReturnType<typeof fileCopilotCredentialStore>,
  signal: AbortSignal,
): Promise<CopilotAuthFile | undefined> {
  const record = await store.read({ signal, logger: NULL_LOGGER })
  return record?.value
}

/** Exchange options carrying only the overrides that were actually supplied. */
function exchangeOptions(flags: Flags, signal: AbortSignal): {
  readonly signal: AbortSignal
  readonly githubApiBaseUrl?: string
} {
  return { signal, ...flags.githubApi === undefined ? {} : { githubApiBaseUrl: flags.githubApi } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Report state, then prove it with ONE trial exchange.
 *
 * The exchange is what makes the report worth reading: a stored user token that no
 * longer maps to a Copilot subscription looks exactly like a working one on disk,
 * and only the exchange can tell the two apart. Its outcome is printed as a status
 * word plus an expiry; the token value itself never reaches stdout.
 */
async function reportStatus(flags: Flags, signal: AbortSignal): Promise<number> {
  const location = resolveCopilotAuthPath(flags.path)
  const file = await readCredential(fileCopilotCredentialStore(flags.path), signal)
  const github = file?.github
  if (github === undefined || github.token.length === 0) {
    process.stdout.write(`copilot: not signed in ${GRAY}(${location})${RESET}\n`)
    return 1
  }
  process.stdout.write(
    `copilot: signed in ${GRAY}(${location})${RESET}\n`
    + `  login    : ${file?.account?.login ?? '<undisclosed>'}\n`
    + `  account  : ${file?.account?.id ?? '<undisclosed>'}\n`
    + `  scope    : ${github.scope ?? '<undisclosed>'}\n`
    + `  stored   : ${location} ${GRAY}(git-ignored)${RESET}\n`,
  )
  try {
    const api = await exchangeCopilotToken(github, exchangeOptions(flags, signal))
    const secondsLeft = Math.max(0, Math.round((api.expiresAtMs - Date.now()) / 1_000))
    process.stdout.write(
      `  exchange : ok ${GRAY}(api token valid for ~${secondsLeft}s)${RESET}\n`
      + `  declared : ${api.declaredApiEndpoint ?? '<undisclosed>'} `
      + `${GRAY}(diagnostic only; never used as a base URL)${RESET}\n`,
    )
    return 0
  } catch (error: unknown) {
    process.stdout.write(`  exchange : failed — ${messageOf(error)}\n`)
    return 1
  }
}

/**
 * List the catalog beside the endpoint each model will actually be dispatched to.
 *
 * This is the most useful diagnostic in the provider. When a model answers HTTP
 * 400 because it ran against the wrong endpoint, one command says both WHICH
 * endpoint was chosen and WHO chose it (`source`: an override, the catalog, the
 * prefix allowlist, or the conservative default) — the two facts that otherwise
 * have to be reconstructed from a failing request.
 */
async function reportModels(flags: Flags, signal: AbortSignal): Promise<number> {
  const location = resolveCopilotAuthPath(flags.path)
  const file = await readCredential(fileCopilotCredentialStore(flags.path), signal)
  const github: CopilotGitHubToken = requireGitHubToken(file, location)
  const api = await exchangeCopilotToken(github, exchangeOptions(flags, signal))
  const snapshot = await discoverCopilotModels(
    {
      provider: 'copilot',
      baseUrl: new URL(COPILOT_BASE_URL),
      headers: {
        authorization: `Bearer ${api.token}`,
        'editor-version': COPILOT_EDITOR_VERSION,
        'editor-plugin-version': COPILOT_EDITOR_PLUGIN_VERSION,
      },
      signal,
    },
    resolveCopilotCatalogLimits(),
    globalThis.fetch,
  )
  // A fresh router, so the printed decisions are the ones a fresh adapter would
  // reach for these exact catalog facts.
  const router = createCopilotEndpointRouter()
  router.learn(snapshot.generation)

  process.stdout.write(`\n${BOLD}copilot: generation models${RESET} ${GRAY}(${COPILOT_BASE_URL}/models)${RESET}\n`)
  for (const decision of router.snapshot()) {
    process.stdout.write(
      `  ${decision.model.padEnd(34)} ${decision.endpoint.padEnd(17)} `
      + `${GRAY}${decision.source} · ${decision.protocolId}${RESET}\n`,
    )
  }
  if (snapshot.embedding.length > 0) {
    process.stdout.write(`\n${BOLD}copilot: embedding models${RESET}\n`)
    for (const model of snapshot.embedding) {
      process.stdout.write(`  ${model.id}\n`)
    }
  }
  if (snapshot.omitted.length > 0) {
    // Advisory, not a failure: an entry this SDK cannot describe is dropped so it
    // never appears in a selector and then fails at dispatch.
    process.stdout.write(`\n${GRAY}omitted entries (advisory):${RESET}\n`)
    for (const omitted of snapshot.omitted) {
      process.stdout.write(`  ${GRAY}${omitted.id === '' ? '<no id>' : omitted.id} — ${omitted.reason}${RESET}\n`)
    }
  }
  process.stdout.write('\n')
  return snapshot.generation.length === 0 && snapshot.embedding.length === 0 ? 1 : 0
}

/** Run the device flow and persist the resulting user token. */
async function signIn(flags: Flags, cancel: AbortController): Promise<number> {
  const store = fileCopilotCredentialStore(flags.path)
  let lastReport = 0
  const result = await runCopilotDeviceLogin(
    store,
    {
      signal: cancel.signal,
      ...flags.issuer === undefined ? {} : { oauthIssuer: flags.issuer },
    },
    {
      onPrompt: (code) => {
        renderPrompt(code)
        void openBrowser(code.verificationUrl)
      },
      onPoll: (elapsedMs, intervalSeconds) => {
        // Throttle to one line per 15s so a long wait does not spam the log.
        if (elapsedMs - lastReport < 15_000 && elapsedMs !== 0) return
        lastReport = elapsedMs
        process.stdout.write(
          `${GRAY}  waiting for approval… ${Math.round(elapsedMs / 1000)}s `
          + `(polling every ${intervalSeconds}s)${RESET}\n`,
        )
      },
    },
  )
  process.stdout.write(
    `\n${BOLD}copilot: signed in${RESET}\n`
    + `  login    : ${result.login ?? '<undisclosed>'}\n`
    + `  account  : ${result.accountId ?? '<undisclosed>'}\n`
    + `  scope    : ${result.scope ?? '<undisclosed>'}\n`
    + `  stored   : ${result.location} ${GRAY}(git-ignored)${RESET}\n`,
  )
  return 0
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  // Ctrl-C during a 15-minute poll should exit promptly rather than wait, and the
  // same signal cancels a hanging exchange or catalog read.
  const cancel = new AbortController()
  const onSigint = (): void => {
    cancel.abort()
    process.stdout.write('\ncopilot: cancelled\n')
  }
  process.once('SIGINT', onSigint)

  try {
    if (flags.status) return await reportStatus(flags, cancel.signal)
    if (flags.models) return await reportModels(flags, cancel.signal)

    const location = resolveCopilotAuthPath(flags.path)
    const existing = await readCredential(fileCopilotCredentialStore(flags.path), cancel.signal)
    const token = existing?.github?.token
    if (!flags.force && token !== undefined && token.length > 0) {
      // No staleness check, unlike the Codex CLI: a `GitHub_User_Token` has no
      // expiry this SDK can read, so "already signed in" is the whole truth
      // available without a network call. `--status` is the command that asks.
      process.stdout.write(
        `copilot: already signed in as ${existing?.account?.login ?? 'this account'}\n`
        + `${GRAY}  ${location}\n  pass --force to sign in again, or --status to verify${RESET}\n`,
      )
      return 0
    }
    return await signIn(flags, cancel)
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

try {
  process.exitCode = await main()
} catch (error: unknown) {
  process.stdout.write(`\ncopilot: ${messageOf(error)}\n`)
  process.exitCode = 1
}
