import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  antigravityFileRevision, completeAntigravityLogin, createAntigravityAuthorization,
  antigravityAccountAuthPath, fileAntigravityCredentialStore, resolveAntigravityAuthPath,
  runAntigravityBrowserLogin, memoryAntigravityCredentialStore, type AntigravityAuthFile,
} from '@alvin0/ai-agent-sdk-auth-node/antigravity'

const directories: string[] = []
const logger = { child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }
const operation = () => ({ signal: new AbortController().signal, logger })
const file = (): AntigravityAuthFile => ({ version: 1, projectId: 'project', clientId: 'client', obtainedAt: new Date().toISOString(),
  tokens: { access_token: 'test-access', refresh_token: 'test-refresh', expires_at: Date.now() + 3_600_000 } })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'antigravity-auth-')); directories.push(path); return path }

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Antigravity Node credentials', () => {
  it('resolves project-local paths and rejects account traversal', () => {
    expect(resolveAntigravityAuthPath(undefined, { cwd: '/project', env: {} })).toBe('/project/.providers/.antigravity/auth.json')
    expect(resolveAntigravityAuthPath(undefined, { cwd: '/project', env: { AI_AGENT_SDK_ANTIGRAVITY_AUTH: 'custom.json' } })).toBe('/project/custom.json')
    expect(antigravityAccountAuthPath('backup')).toBe('.providers/.antigravity/accounts/backup.json')
    expect(() => antigravityAccountAuthPath('../escape')).toThrow()
    expect(() => resolveAntigravityAuthPath('bad\0path')).toThrow()
  })

  it('stores private credentials atomically and rejects stale cross-store commits', async () => {
    const directory = await temporary()
    const path = join(directory, 'private', 'auth.json')
    const one = fileAntigravityCredentialStore(path)
    const two = fileAntigravityCredentialStore(path)
    const initial = await one.commit({ value: file(), expectedRevision: null }, operation())
    expect((await two.read(operation()))?.revision).toBe(initial.revision)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, 'private'))).mode & 0o777).toBe(0o700)
    }
    const results = await Promise.allSettled([one, two].map(store => store.commit({ expectedRevision: initial.revision,
      value: { ...file(), projectId: crypto.randomUUID() } }, operation())))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')!
    expect(rejected.reason).toMatchObject({ code: 'ANTIGRAVITY_CREDENTIAL_REVISION_CONFLICT' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('version', 1)
  })

  it('refuses symlinks and malformed files without leaking their contents', async () => {
    const directory = await temporary()
    const target = join(directory, 'target.json')
    await writeFile(target, 'invalid-secret-content')
    const link = join(directory, 'link.json')
    await symlink(target, link)
    await expect(fileAntigravityCredentialStore(link).read(operation())).rejects.toThrow()
    await expect(fileAntigravityCredentialStore(target).read(operation())).rejects.toMatchObject({
      message: 'Antigravity credential file is invalid; sign in again', code: 'ANTIGRAVITY_AUTH_INVALID',
    })
    expect(await readFile(target, 'utf8')).toBe('invalid-secret-content')
  })

  it.each([false, true])('recovers a malformed file by its original bytes and preserves a competing login: %s', async race => {
    const path = join(await temporary(), 'auth.json')
    await writeFile(path, Buffer.from([123, 255]))
    const store = fileAntigravityCredentialStore(path)
    const expectedRevision = await antigravityFileRevision(path, operation().signal)
    const authorization = await createAntigravityAuthorization({ clientId: 'client', redirectUri: 'http://localhost:51121/' })
    const login = completeAntigravityLogin(store, authorization, new URLSearchParams({ state: authorization.state, code: 'code' }), {
      expectedRevision, fetch: async url => {
        if (String(url).includes('/token')) return json({ access_token: 'fresh', refresh_token: 'grant', expires_in: 3600 })
        if (String(url).includes('loadCodeAssist')) return json({ cloudaicompanionProject: 'fresh-project' })
        if (race) await store.commit({ value: file(), expectedRevision }, operation())
        return new Response(null, { status: 503 })
      },
    })
    if (race) await expect(login).rejects.toMatchObject({ code: 'ANTIGRAVITY_CREDENTIAL_REVISION_CONFLICT' })
    else await expect(login).resolves.toEqual({ projectId: 'fresh-project' })
    expect((await store.read(operation()))?.value.projectId).toBe(race ? 'project' : 'fresh-project')
  })

  it('executes the installed CLI help and local status without contacting a provider', async () => {
    const directory = await temporary()
    const cli = fileURLToPath(new URL('../../packages/auth-node/bin/ai-agent-sdk-antigravity-login.mjs', import.meta.url))
    const run = promisify(execFile)
    const help = await run(process.execPath, [cli, '--help'], { cwd: directory })
    expect(help.stdout).toContain('localhost:51121')
    await expect(run(process.execPath, [cli, '--status'], { cwd: directory })).rejects.toMatchObject({
      code: 1, stdout: expect.stringContaining('Not signed in'),
    })
    await expect(run(process.execPath, [cli, '--path'], { cwd: directory })).rejects.toMatchObject({ code: 1 })
  })
})

describe('Antigravity browser sign-in', () => {
  it('uses a real loopback listener, rejects forged callbacks and completes the correct one', async () => {
    vi.stubEnv('AI_AGENT_SDK_ANTIGRAVITY_CLIENT_ID', 'env-browser-client')
    vi.stubEnv('AI_AGENT_SDK_ANTIGRAVITY_CLIENT_SECRET', 'env-browser-secret')
    const store = memoryAntigravityCredentialStore()
    let callback!: Promise<void>
    const login = runAntigravityBrowserLogin(store, { port: 0, timeoutMs: 10_000,
      fetch: async (input, init) => {
        const url = String(input)
        if (url.includes('/token')) {
          const body = new URLSearchParams(String(init?.body))
          expect(body.get('client_id')).toBe('env-browser-client')
          expect(body.get('client_secret')).toBe('env-browser-secret')
          return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
        }
        if (url.includes('loadCodeAssist')) return json({ cloudaicompanionProject: 'project' })
        return json({ email: 'account@example.test' })
      },
    }, { onPrompt({ url }) {
      callback = (async () => {
        const auth = new URL(url)
        const redirect = new URL(auth.searchParams.get('redirect_uri')!)
        redirect.hostname = '127.0.0.1'
        redirect.search = new URLSearchParams({ state: 'forged', code: 'bad' }).toString()
        expect((await fetch(redirect)).status).toBe(400)
        const wrongHost = await new Promise<number | undefined>((done, reject) => {
          const req = httpRequest(redirect, { headers: { host: 'attacker.invalid' } }, response => { response.resume(); done(response.statusCode) })
          req.on('error', reject).end()
        })
        expect(wrongHost).toBe(421)
        redirect.search = new URLSearchParams({ state: auth.searchParams.get('state')!, code: 'good' }).toString()
        const response = await fetch(redirect)
        expect(response.status).toBe(200)
        expect(await response.text()).not.toContain('access_token')
      })()
    } })
    await expect(login).resolves.toEqual({ projectId: 'project', account: { email: 'account@example.test' } })
    await callback
    const saved = (await store.read(operation()))?.value
    expect(saved?.tokens.refresh_token).toBe('refresh')
    expect(saved?.clientId).toBe('env-browser-client')
    expect(JSON.stringify(saved)).not.toContain('env-browser-secret')
  })

  it('times out and releases the listener without creating credentials', async () => {
    const store = memoryAntigravityCredentialStore()
    let redirect: URL | undefined
    await expect(runAntigravityBrowserLogin(store, { port: 0, clientId: 'client', timeoutMs: 20 }, { onPrompt({ url }) {
      redirect = new URL(new URL(url).searchParams.get('redirect_uri')!)
    } })).rejects.toMatchObject({ code: 'ANTIGRAVITY_AUTH_TIMEOUT' })
    redirect!.hostname = '127.0.0.1'
    await expect(fetch(redirect!)).rejects.toThrow()
    expect(await store.read(operation())).toBeUndefined()
  })

  it('cancels a waiting login', async () => {
    const controller = new AbortController()
    const store = memoryAntigravityCredentialStore()
    await expect(runAntigravityBrowserLogin(store, { port: 0, clientId: 'client', signal: controller.signal }, {
      onPrompt() { controller.abort() },
    })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(await store.read(operation())).toBeUndefined()
  })
})
