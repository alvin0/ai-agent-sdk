import { spawnSync } from 'node:child_process'
import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { envCredential } from '@ai-agent-sdk/auth-node/env'
import { createAgentRuntime } from '@ai-agent-sdk/core'
import {
  codexNodeAdapter,
  codexNodeProviderPlugin,
  fileCodexAuthStore,
  fileCodexCredentialStore,
} from '@ai-agent-sdk/auth-node/codex'

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
const cli = resolve('node_modules/@ai-agent-sdk/auth-node/bin/ai-agent-sdk-codex-login.mjs')
const status = spawnSync(process.execPath, [cli, '--status', '--path', resolve('missing.json')], {
  encoding: 'utf8', env: process.env,
})
if (status.status !== 1 || !status.stdout.includes('not signed in')) {
  throw new Error(`built login CLI failed: ${status.stdout}\n${status.stderr}`)
}
console.log('auth-node-packed:pass')
