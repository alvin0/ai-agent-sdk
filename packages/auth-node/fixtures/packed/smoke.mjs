import { spawnSync } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node/env'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import {
  codexNodeAdapter,
  codexNodeProviderPlugin,
  fileCodexAuthStore,
  fileCodexCredentialStore,
} from '@alvin0/ai-agent-sdk-auth-node/codex'
import {
  copilotNodeProviderPlugin,
  fileCopilotAuthStore,
  fileCopilotCredentialStore,
} from '@alvin0/ai-agent-sdk-auth-node/copilot'

process.env.PACKED_AUTH_KEY = 'packed-secret'
if (envCredential('PACKED_AUTH_KEY')() !== 'packed-secret') throw new Error('env credential failed')
const store = fileCodexAuthStore(undefined, { cwd: process.cwd(), env: {} })
const value = {
  auth_mode: 'chatgpt',
  tokens: { id_token: 'id', access_token: 'access', refresh_token: 'refresh', account_id: null },
}
await store.write(value)
if (JSON.stringify(await store.read()) !== JSON.stringify(value)) throw new Error('auth store round-trip failed')
const info = await lstat(store.location)
if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) throw new Error('auth mode is not 0600')
if ((await readdir(resolve(process.cwd(), '.providers/.codex'))).some(name => name.includes('.tmp'))) {
  throw new Error('temporary credential file leaked')
}
const revisioned = fileCodexCredentialStore(resolve('revisioned.json'))
const logger = Object.freeze({
  child: () => logger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
})
const operation = { signal: new AbortController().signal, logger }
const created = await revisioned.commit({ value, expectedRevision: null }, operation)
const snapshot = await revisioned.read(operation)
if (snapshot?.revision !== created.revision) throw new Error('revisioned credential read failed')
await revisioned.commit({
  value: { ...value, auth_mode: 'updated' }, expectedRevision: snapshot.revision,
}, operation)
let staleRejected = false
try { await revisioned.commit({ value, expectedRevision: snapshot.revision }, operation) }
catch (error) { staleRejected = error?.code === 'CODEX_CREDENTIAL_REVISION_CONFLICT' }
if (!staleRejected) throw new Error('stale credential revision was accepted')
codexNodeAdapter({ models: [] })
const runtime = await createAgentRuntime({ providers: [codexNodeProviderPlugin({ models: [] })] })
await runtime.close()
const cli = resolve('node_modules/@alvin0/ai-agent-sdk-auth-node/bin/ai-agent-sdk-codex-login.mjs')
const status = spawnSync(process.execPath, [cli, '--status', '--path', resolve('missing.json')], {
  encoding: 'utf8', env: process.env,
})
if (status.status !== 1 || !status.stdout.includes('not signed in')) {
  throw new Error(`built login CLI failed: ${status.stdout}\n${status.stderr}`)
}

// ---------------------------------------------------------------------------
// Copilot half — the same three questions asked of the second credential family.
//
// It runs against the INSTALLED tarball rather than against `src/`, because the
// three things that can only break here are packaging facts: the `./copilot`
// export condition, the `copilot-cli` dist entry the bin script loads, and the
// `bin` mapping itself. A unit test importing TypeScript sources passes happily
// while any of the three is missing.
// ---------------------------------------------------------------------------

const copilotValue = { version: 1, github: { token: 'ghu_packed_example', scope: 'read:user' } }
const copilotStore = fileCopilotAuthStore(undefined, { cwd: process.cwd(), env: {} })
await copilotStore.write(copilotValue)
if (JSON.stringify(await copilotStore.read()) !== JSON.stringify(copilotValue)) {
  throw new Error('copilot auth store round-trip failed')
}
if (!copilotStore.location.endsWith(join('.providers', '.copilot', 'auth.json'))) {
  throw new Error(`copilot default path moved: ${copilotStore.location}`)
}
if (copilotStore.location === store.location) throw new Error('copilot shares the codex credential file')
const copilotInfo = await lstat(copilotStore.location)
if (process.platform !== 'win32' && (copilotInfo.mode & 0o777) !== 0o600) {
  throw new Error('copilot auth mode is not 0600')
}

const copilotRevisioned = fileCopilotCredentialStore(resolve('copilot-revisioned.json'))
const copilotCreated = await copilotRevisioned.commit(
  { value: copilotValue, expectedRevision: null }, operation,
)
const copilotSnapshot = await copilotRevisioned.read(operation)
if (copilotSnapshot?.revision !== copilotCreated.revision) {
  throw new Error('revisioned copilot credential read failed')
}
let copilotStaleRejected = false
try { await copilotRevisioned.commit({ value: copilotValue, expectedRevision: null }, operation) }
catch (error) { copilotStaleRejected = error?.code === 'COPILOT_CREDENTIAL_REVISION_CONFLICT' }
if (!copilotStaleRejected) throw new Error('stale copilot credential revision was accepted')

copilotNodeProviderPlugin({ models: [] })
const copilotRuntime = await createAgentRuntime({ providers: [copilotNodeProviderPlugin({ models: [] })] })
await copilotRuntime.close()

const copilotCli = resolve('node_modules/@alvin0/ai-agent-sdk-auth-node/bin/ai-agent-sdk-copilot-login.mjs')
const copilotStatus = spawnSync(
  process.execPath, [copilotCli, '--status', '--path', resolve('copilot-missing.json')],
  { encoding: 'utf8', env: process.env },
)
if (copilotStatus.status !== 1 || !copilotStatus.stdout.includes('not signed in')) {
  throw new Error(`built copilot login CLI failed: ${copilotStatus.stdout}\n${copilotStatus.stderr}`)
}
// Requirement 13.7 on the packaged surface: no command prints a token value, so a
// stored token must not appear even when the CLI reads a populated file.
const copilotSignedIn = spawnSync(
  process.execPath,
  // A closed loopback port keeps the trial exchange off the public internet: the
  // credential block this assertion reads is printed before the exchange runs, so
  // the refused connection costs nothing and the fixture stays hermetic.
  [copilotCli, '--status', '--path', copilotStore.location, '--github-api', 'https://127.0.0.1:1'],
  { encoding: 'utf8', env: process.env },
)
const copilotOutput = `${copilotSignedIn.stdout}${copilotSignedIn.stderr}`
if (!copilotOutput.includes('signed in')) {
  throw new Error(`copilot --status did not see the stored credential: ${copilotOutput}`)
}
if (copilotOutput.includes(copilotValue.github.token)) {
  throw new Error('copilot --status printed the token value')
}

console.log('auth-node-packed:pass')
