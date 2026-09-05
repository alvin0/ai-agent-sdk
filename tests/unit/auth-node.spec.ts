import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentSdkError, createAgentRuntime } from '@ai-agent-sdk/core'
import {
  apiKeyFromEnv,
  envCredential,
} from '@ai-agent-sdk/auth-node/env'
import {
  CODEX_AUTH_PATH_ENV,
  DEFAULT_CODEX_AUTH_PATH,
  codexAdapter,
  codexNodeAdapter,
  codexNodeProviderPlugin,
  codexNodePlugin,
  codexPlugin,
  fileCodexAuthStore,
  fileCodexCredentialStore,
  resolveCodexAuthPath,
} from '@ai-agent-sdk/auth-node/codex'

const cleanup: string[] = []
const changedEnvironment = new Map<string, string | undefined>()
const NULL_LOGGER = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
  for (const [name, value] of changedEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  changedEnvironment.clear()
})

describe('Node credentials', () => {
  it('resolves explicit, environment, and project-local Codex paths against an explicit cwd', () => {
    const cwd = resolve('/tmp', 'auth-node-path-fixture')
    expect(resolveCodexAuthPath(undefined, { cwd, env: {} })).toBe(resolve(cwd, DEFAULT_CODEX_AUTH_PATH))
    expect(resolveCodexAuthPath(undefined, {
      cwd, env: { [CODEX_AUTH_PATH_ENV]: 'private/codex.json' },
    })).toBe(resolve(cwd, 'private/codex.json'))
    expect(resolveCodexAuthPath('chosen/auth.json', {
      cwd, env: { [CODEX_AUTH_PATH_ENV]: 'ignored.json' },
    })).toBe(resolve(cwd, 'chosen/auth.json'))
  })

  it('reads environment credentials lazily and keeps the compatibility alias identical', () => {
    rememberEnvironment('AUTH_NODE_TEST_KEY')
    const credential = envCredential('AUTH_NODE_TEST_KEY')
    expect(apiKeyFromEnv).toBe(envCredential)
    expect(() => credential()).toThrow(AgentSdkError)
    process.env.AUTH_NODE_TEST_KEY = 'secret-value'
    expect(credential()).toBe('secret-value')
    expect(credential.kind).toBe('credential-source')
    expect(credential.apiVersion).toBe(1)
    expect(credential.id).toBe('env:AUTH_NODE_TEST_KEY')
    expect(Object.isFrozen(credential)).toBe(true)
    expect(() => envCredential('   ')).toThrow(/must not be empty/)
  })

  it('uses the required credential operation signal on the marked env view', async () => {
    rememberEnvironment('AUTH_NODE_SIGNAL_KEY')
    process.env.AUTH_NODE_SIGNAL_KEY = 'must-not-resolve-after-abort'
    const credential = envCredential('AUTH_NODE_SIGNAL_KEY')
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    expect(() => credential.resolve({
      signal: controller.signal,
      logger: NULL_LOGGER,
    })).toThrow('cancelled')
  })

  it('writes atomically with private modes and reads the committed value', async () => {
    const cwd = await temporaryRoot()
    const store = fileCodexAuthStore(undefined, { cwd, env: {} })
    const value = {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: 'id', access_token: 'access', refresh_token: 'refresh', account_id: null,
      },
      last_refresh: '2026-09-01T00:00:00.000Z',
    }
    await store.write(value)

    await expect(store.read()).resolves.toEqual(value)
    const fileInfo = await lstat(store.location)
    const directory = join(cwd, '.providers', '.codex')
    const directoryInfo = await lstat(directory)
    expect((await readdir(directory)).filter(name => name.includes('.tmp'))).toEqual([])
    if (process.platform !== 'win32') {
      expect(fileInfo.mode & 0o777).toBe(0o600)
      expect(directoryInfo.mode & 0o777).toBe(0o700)
    }

    await store.write({ ...value, auth_mode: 'updated' })
    await expect(store.read()).resolves.toMatchObject({ auth_mode: 'updated' })
  })

  it('provides revisioned create-only and compare-and-swap file commits', async () => {
    const cwd = await temporaryRoot()
    const store = fileCodexCredentialStore(undefined, { cwd, env: {} })
    const operation = {
      signal: new AbortController().signal,
      logger: NULL_LOGGER,
    }
    const firstValue = { auth_mode: 'first' }
    const created = await store.commit({ value: firstValue, expectedRevision: null }, operation)
    const first = await store.read(operation)
    expect(first).toEqual({ value: firstValue, revision: created.revision })

    await expect(store.commit({
      value: { auth_mode: 'stale-write' }, expectedRevision: 'stale-revision',
    }, operation)).rejects.toMatchObject({ code: 'CODEX_CREDENTIAL_REVISION_CONFLICT' })
    await expect(store.read(operation)).resolves.toEqual(first)

    const replaced = await store.commit({
      value: { auth_mode: 'second' }, expectedRevision: first!.revision,
    }, operation)
    await expect(store.read(operation)).resolves.toEqual({
      value: { auth_mode: 'second' }, revision: replaced.revision,
    })
  })

  it('honors a pre-aborted operation signal before revisioned file I/O', async () => {
    const cwd = await temporaryRoot()
    const store = fileCodexCredentialStore(undefined, { cwd, env: {} })
    const controller = new AbortController()
    const reason = new Error('credential operation cancelled')
    controller.abort(reason)
    const operation = { signal: controller.signal, logger: NULL_LOGGER }

    await expect(store.read(operation)).rejects.toBe(reason)
    await expect(store.commit({
      value: { auth_mode: 'must-not-create' }, expectedRevision: null,
    }, operation)).rejects.toBe(reason)
    await expect(readdir(cwd)).resolves.toEqual([])
  })

  it('serializes concurrent CAS writers and preserves the winning revision', async () => {
    const cwd = await temporaryRoot()
    const store = fileCodexCredentialStore(undefined, { cwd, env: {} })
    const operation = {
      signal: new AbortController().signal,
      logger: NULL_LOGGER,
    }
    await store.commit({ value: { auth_mode: 'initial' }, expectedRevision: null }, operation)
    const initial = await store.read(operation)
    const results = await Promise.allSettled([
      store.commit({ value: { auth_mode: 'left' }, expectedRevision: initial!.revision }, operation),
      store.commit({ value: { auth_mode: 'right' }, expectedRevision: initial!.revision }, operation),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { code: 'CODEX_CREDENTIAL_REVISION_CONFLICT' },
    })
    expect(['left', 'right']).toContain((await store.read(operation))?.value.auth_mode)
  })

  it('never converts a file read failure into a create or overwrite', async () => {
    const cwd = await temporaryRoot()
    const location = join(cwd, 'credential-target')
    await mkdir(location)
    const store = fileCodexCredentialStore(location)
    const operation = {
      signal: new AbortController().signal,
      logger: NULL_LOGGER,
    }
    await expect(store.read(operation)).rejects.toThrow(/regular file/i)
    await expect(store.commit({
      value: { auth_mode: 'must-not-overwrite' }, expectedRevision: null,
    }, operation)).rejects.toThrow(/regular file/i)
    expect((await lstat(location)).isDirectory()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('never follows a credential-file symlink', async () => {
    const cwd = await temporaryRoot()
    const directory = join(cwd, '.providers', '.codex')
    const target = join(cwd, 'outside.json')
    const location = join(directory, 'auth.json')
    await mkdir(directory, { recursive: true })
    await writeFile(target, '{"outside":true}\n', { mode: 0o600 })
    await symlink(target, location)
    const store = fileCodexAuthStore(undefined, { cwd, env: {} })

    await expect(store.read()).rejects.toThrow(/symbolic|loop/i)
    await expect(store.write({ auth_mode: 'unsafe' })).rejects.toThrow(/symbolic/i)
    await expect(readFile(target, 'utf8')).resolves.toBe('{"outside":true}\n')
  })

  it('bounds malformed credential files without exposing their location in the error', async () => {
    const cwd = await temporaryRoot()
    const location = join(cwd, 'secret-name.json')
    await writeFile(location, '{broken', { mode: 0o600 })
    const store = fileCodexAuthStore(location)
    const error = await store.read().then(() => undefined, value => value as Error)
    expect(error).toBeInstanceOf(AgentSdkError)
    expect(error?.message).not.toContain('secret-name.json')

    await chmod(location, 0o600)
    await writeFile(location, 'x'.repeat(1024 * 1024 + 1))
    await expect(store.read()).rejects.toThrow(/1 MiB/)
  })

  it('provides explicit Node wrappers while retaining legacy Codex identities', async () => {
    expect(codexAdapter).toBe(codexNodeAdapter)
    expect(codexPlugin).toBe(codexNodePlugin)
    expect(() => codexNodeAdapter({ models: [] })).not.toThrow()
    expect(codexNodePlugin({ models: [] })).toMatchObject({ id: 'codex', displayName: 'Codex' })
    const preferred = codexNodeProviderPlugin({ models: [] })
    expect(preferred).toMatchObject({
      kind: 'model-provider-plugin', apiVersion: 1, id: 'codex', family: 'codex', routes: ['codex'],
    })
    const runtime = await createAgentRuntime({ providers: [preferred] })
    await runtime.close()
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-agent-sdk-auth-node-'))
  cleanup.push(root)
  return root
}

function rememberEnvironment(name: string): void {
  changedEnvironment.set(name, process.env[name])
  delete process.env[name]
}
