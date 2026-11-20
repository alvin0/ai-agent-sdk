import { AgentSdkError } from '@alvin0/ai-agent-sdk-core/provider'
import {
  antigravityNodeAdapter, antigravityAccountAuthPath, fileAntigravityCredentialStore,
  resolveAntigravityAuthPath, runAntigravityBrowserLogin, type AntigravityAuthFile,
  type AntigravityCredentialStore,
} from './antigravity.ts'
import { antigravityFileRevision } from './antigravity-store.ts'
import { openBrowser } from './common/browser.ts'

interface Flags {
  status: boolean; models: boolean; force: boolean; noOpen: boolean; help: boolean
  path?: string; account?: string; projectId?: string
}

const SWITCHES: Record<string, 'status' | 'models' | 'force' | 'noOpen' | 'help'> = {
  '--status': 'status', '--models': 'models', '--force': 'force', '--no-open': 'noOpen', '--help': 'help', '-h': 'help',
}
const VALUES: Record<string, 'path' | 'account' | 'projectId'> = {
  '--path': 'path', '--account': 'account', '--project': 'projectId',
}
const HELP = 'Usage: ai-agent-sdk-antigravity-login [--browser] [--status | --models] [--force] [--no-open]\n'
  + '       [--account NAME | --path FILE] [--project PROJECT_ID]\n'
  + 'Google OAuth sign-in uses localhost:51121/oauth-callback. Forward port 51121 when using SSH.\n'
  + 'Set AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID and, if required, AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET.\n'
const logger = { child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }

function flagsOf(argv: readonly string[]): Flags {
  const flags: Flags = { status: false, models: false, force: false, noOpen: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    const toggle = SWITCHES[flag]
    if (toggle !== undefined) { flags[toggle] = true; continue }
    if (flag === '--browser') continue
    const key = VALUES[flag]
    if (key === undefined) throw new Error(`Unknown flag ${flag}`)
    flags[key] = flagValue(argv[++index], flag)
  }
  validateFlags(flags)
  return flags
}

function flagValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('-')) throw new Error(`${flag} needs a value`)
  return value
}

function validateFlags(flags: Flags): void {
  if (flags.path !== undefined && flags.account !== undefined) throw new Error('Choose either --path or --account')
  if (flags.status && flags.models) throw new Error('Choose either --status or --models')
}

function showStatus(value: AntigravityAuthFile | undefined, path: string): void {
  if (value === undefined) { process.stdout.write(`Not signed in. Credentials: ${path}\n`); return }
  process.stdout.write(`Signed in to Antigravity. Project: ${value.projectId}\nCredentials: ${path}\n`)
  if (value.account?.email !== undefined) process.stdout.write(`Account: ${value.account.email}\n`)
  const expiry = value.tokens.expires_at > Date.now() ? 'valid' : 'expired (refreshes when used)'
  process.stdout.write(`Access token ${expiry}.\n`)
}

async function action(flags: Flags, store: AntigravityCredentialStore, path: string, signal: AbortSignal) {
  if (flags.models) {
    const models = await antigravityNodeAdapter({ authStore: store }).listModels('antigravity', signal)
    for (const model of models) process.stdout.write(`${model.id}\t${model.name}\n`)
    return
  }
  if (!flags.force || flags.status) {
    const current = await store.read({ signal, logger })
    if (flags.status || current !== undefined) {
      showStatus(current?.value, path)
      if (current === undefined) process.exitCode = 1
      return
    }
  }
  const revision = flags.force ? await antigravityFileRevision(path, signal) : null
  await login(flags, store, { path, signal, revision })
}

async function login(flags: Flags, store: AntigravityCredentialStore,
  { path, signal, revision }: { path: string; signal: AbortSignal; revision: string | null }) {
  await runAntigravityBrowserLogin(store, {
    expectedRevision: revision,
    signal, ...(flags.projectId === undefined ? {} : { projectId: flags.projectId }),
  }, { onPrompt({ url }) {
    process.stdout.write(`Open this URL to sign in with Google:\n${url}\n`)
    if (!flags.noOpen) void openBrowser(url)
  } })
  process.stdout.write(`Signed in to Antigravity. Credentials saved to ${path}\n`)
}

async function main(): Promise<void> {
  const flags = flagsOf(process.argv.slice(2))
  if (flags.help) { process.stdout.write(HELP); return }
  const accountPath = flags.account === undefined ? undefined : antigravityAccountAuthPath(flags.account)
  const path = resolveAntigravityAuthPath(flags.path ?? accountPath)
  const store = fileAntigravityCredentialStore(path)
  const controller = new AbortController()
  const cancel = (): void => { controller.abort(new AgentSdkError('Antigravity sign-in cancelled', 'ABORTED')) }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try { await action(flags, store, path, controller.signal) }
  finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Antigravity sign-in failed'}\n`)
  process.exitCode = 1
})
