import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentSdkError } from '@ai-agent-sdk/core'
import {
  apiKeyFromEnv,
  envCredential,
} from '@ai-agent-sdk/auth-node/env'
import {
  CODEX_AUTH_PATH_ENV,
  DEFAULT_CODEX_AUTH_PATH,
  codexAdapter,
  codexNodeAdapter,
  codexNodePlugin,
  codexPlugin,
  fileCodexAuthStore,
  resolveCodexAuthPath,
} from '@ai-agent-sdk/auth-node/codex'

const cleanup: string[] = []
const changedEnvironment = new Map<string, string | undefined>()

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
    expect(() => envCredential('   ')).toThrow(/must not be empty/)
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

  it('provides explicit Node wrappers while retaining legacy Codex identities', () => {
    expect(codexAdapter).toBe(codexNodeAdapter)
    expect(codexPlugin).toBe(codexNodePlugin)
    expect(() => codexNodeAdapter({ models: [] })).not.toThrow()
    expect(codexNodePlugin({ models: [] })).toMatchObject({ id: 'codex', displayName: 'Codex' })
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
