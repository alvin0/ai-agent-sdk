import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialStore, type CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import {
  codexPlugin, getCodexTokens, refreshCodexTokens, type CodexAuthFile,
} from '@alvin0/ai-agent-sdk-provider-codex'
import {
  copilotPlugin, createCopilotTokenCache, getCopilotToken,
  type CopilotAuthFile, type CopilotTokenCache,
} from '../../packages/provider-copilot/src/index.ts'
import { sqliteCredentialStore } from '../../samples/credential-database/sqlite-store.ts'

const logger = { child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }
const operation: CredentialOperationOptions = { signal: new AbortController().signal, logger }
function tokens(exp: number) {
  return { access_token: 'e30.' + btoa(JSON.stringify({ exp })) + '.signature',
    id_token: 'e30.' + btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })) + '.signature',
    refresh_token: 'refresh-token', account_id: 'account' }
}
const future = () => Math.floor(Date.now() / 1000) + 3600

describe('database-owned provider credentials', () => {
  it.each(['', '   '])('rejects an empty tenant scope before database work: %j', tenant => {
    const db = new DatabaseSync(':memory:')
    try { expect(() => sqliteCredentialStore(db, tenant, 'codex')).toThrow() }
    finally { db.close() }
  })

  it('preserves the stored Codex account when refresh omits an identity token', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = sqliteCredentialStore<CodexAuthFile>(db, 'tenant', 'codex')
      await store.commit({ value: { tokens: { ...tokens(1), id_token: 'opaque-id' } },
        expectedRevision: null }, operation)
      const result = await getCodexTokens(store, { fetch: async () =>
        Response.json({ access_token: tokens(future()).access_token, refresh_token: 'rotated' }) })
      expect(result.account_id).toBe('account')
    } finally { db.close() }
  })

  it.each(['', 42, null])('refuses a malformed refresh token without corrupting storage: %j', async refreshToken => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = sqliteCredentialStore<CodexAuthFile>(db, 'tenant', 'codex')
      const initial = await store.commit({ value: { tokens: tokens(1) }, expectedRevision: null }, operation)
      await expect(getCodexTokens(store, { fetch: async () =>
        Response.json({ refresh_token: refreshToken }) })).rejects.toThrow()
      expect((await store.read(operation))?.revision).toBe(initial.revision)
    } finally { db.close() }
  })

  it('cancels waiting for a host token cache even when the hook ignores its signal', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = sqliteCredentialStore<CopilotAuthFile>(db, 'tenant', 'copilot')
      await store.commit({ value: { version: 1, github: { token: 'ghu_example' } },
        expectedRevision: null }, operation)
      const controller = new AbortController()
      const pending = getCopilotToken(store, { signal: controller.signal, tokenCache: {
        acquire: async () => { controller.abort(new Error('caller cancelled')); return { token: 'late', expiresAtMs: Date.now() + 10000 } },
        invalidate() {},
      } })
      await expect(pending).rejects.toThrow('caller cancelled')
    } finally { db.close() }
  })

  it.each(['codex', 'copilot'] as const)('%s cancels a pending database read without starting token I/O', async provider => {
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    let finish!: (value: undefined) => void
    const read = new Promise<undefined>(resolve => { finish = resolve })
    const definition = {
      id: 'slow-database', label: 'Database',
      read: () => { entered(); return read },
      commit: async () => { throw new Error('unexpected commit') },
    }
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const pending = provider === 'codex'
      ? getCodexTokens(defineCredentialStore<CodexAuthFile>(definition), { signal: controller.signal, fetch })
      : getCopilotToken(defineCredentialStore<CopilotAuthFile>(definition), { signal: controller.signal, fetch })
    const assertion = expect(pending).rejects.toThrow('cancel read')
    await reading
    controller.abort(new Error('cancel read'))
    try { await assertion }
    finally { finish(undefined) }
    expect(fetch).not.toHaveBeenCalled()
  })
  it('persists tenant-isolated credentials across connections and rejects stale commits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sdk-credential-db-'))
    const path = join(directory, 'credentials.sqlite')
    let db = new DatabaseSync(path)
    try {
      const a = sqliteCredentialStore<CodexAuthFile>(db, 'tenant-a', 'codex')
      const b = sqliteCredentialStore<CodexAuthFile>(db, 'tenant-b', 'codex')
      const value = { tokens: tokens(future()) }
      const first = await a.commit({ value, expectedRevision: null }, operation)
      expect(await b.read(operation)).toBeUndefined()
      await a.commit({ value, expectedRevision: first.revision }, operation)
      await expect(a.commit({ value, expectedRevision: first.revision }, operation))
        .rejects.toMatchObject({ code: 'CODEX_CREDENTIAL_REVISION_CONFLICT' })
      db.close()
      db = new DatabaseSync(path)
      const reloaded = sqliteCredentialStore<CodexAuthFile>(db, 'tenant-a', 'codex')
      const fetch = vi.fn<typeof globalThis.fetch>()
      expect(await getCodexTokens(reloaded, { fetch })).toEqual(value.tokens)
      expect(fetch).not.toHaveBeenCalled()
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('Codex reads, refreshes and commits rotated tokens, and supports explicit refresh', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = sqliteCredentialStore<CodexAuthFile>(db, 'tenant', 'codex')
      const old = tokens(1)
      await store.commit({ value: { tokens: old }, expectedRevision: null }, operation)
      const next = { ...tokens(future()), refresh_token: 'rotated-token' }
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(next))
      expect(await getCodexTokens(store, { refreshIfNeeded: false, fetch })).toEqual(old)
      expect(fetch).not.toHaveBeenCalled()
      expect(await getCodexTokens(store, { fetch })).toMatchObject(next)
      expect((await store.read(operation))?.value.tokens).toMatchObject(next)
      expect(await getCodexTokens(store, { fetch })).toMatchObject(next)
      expect(fetch).toHaveBeenCalledTimes(1)
      await refreshCodexTokens(store, { fetch })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body)).refresh_token).toBe('rotated-token')
    } finally { db.close() }
  })

  it('Codex runtime refresh writes to the same database store before inference', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = sqliteCredentialStore<CodexAuthFile>(db, 'tenant', 'codex')
      await store.commit({ value: { tokens: tokens(1) }, expectedRevision: null }, operation)
      const next = tokens(future())
      const refresh = vi.fn<typeof globalThis.fetch>(async () => Response.json(next))
      const inference = vi.fn<typeof globalThis.fetch>(async () => {
        expect((await store.read(operation))?.value.tokens?.access_token).toBe(next.access_token)
        return Response.json({ error: { message: 'controlled rejection' } }, { status: 400 })
      })
      const runtime = await createAgentRuntime({ providers: [codexPlugin({
        authStore: store, models: [], oauth: { fetch: refresh }, fetch: inference,
      })] })
      try {
        await runtime.agent({ id: 'agent', instructions: 'Reply.', compaction: false,
          model: { provider: 'codex', id: 'custom' },
        }).generate('Hello').catch(() => undefined)
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(inference).toHaveBeenCalledTimes(1)
        expect(new Headers(inference.mock.calls[0]![1]?.headers).get('authorization'))
          .toBe('Bearer ' + next.access_token)
      } finally { await runtime.close() }
    } finally { db.close() }
  })

  it('does not report a refreshed Codex token as successful if persistence fails', async () => {
    const store = defineCredentialStore<CodexAuthFile>({
      id: 'unavailable-database', label: 'Database',
      read: async () => ({ value: { tokens: tokens(1) }, revision: 'original' }),
      commit: async () => { throw new Error('Database unavailable') },
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(tokens(future())))
    await expect(getCodexTokens(store, { fetch })).rejects.toThrow('Database unavailable')
    expect(fetch).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    await expect(getCodexTokens(store, { signal: controller.signal, fetch })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('Copilot shares exchange cache between token acquisition and runtime without rewriting GitHub credentials', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = sqliteCredentialStore<CopilotAuthFile>(db, 'tenant', 'copilot')
      const original = await store.commit({ value: { version: 1, github: { token: 'ghu_example' } },
        expectedRevision: null }, operation)
      const exchange = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ token: 'copilot-api-token', expires_at: future() }))
      const tokenCache = createCopilotTokenCache({ fetch: exchange })
      expect((await getCopilotToken(store, { tokenCache })).token).toBe('copilot-api-token')
      await getCopilotToken(store, { tokenCache })
      expect(exchange).toHaveBeenCalledTimes(1)
      const inference = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error: { message: 'controlled rejection' } }, { status: 400 }))
      const runtime = await createAgentRuntime({ providers: [copilotPlugin({
        authStore: store, tokenCache, models: [], fetch: inference,
      })] })
      try {
        await runtime.agent({ id: 'agent', instructions: 'Reply.', compaction: false,
          model: { provider: 'copilot', id: 'gpt-5' },
        }).generate('Hello').catch(() => undefined)
        expect(inference).toHaveBeenCalledTimes(1)
        expect(new Headers(inference.mock.calls[0]![1]?.headers).get('authorization'))
          .toBe('Bearer copilot-api-token')
        expect(exchange).toHaveBeenCalledTimes(1)
        await getCopilotToken(store, { tokenCache, forceRefresh: true })
        expect(exchange).toHaveBeenCalledTimes(2)
        expect((await store.read(operation))?.revision).toBe(original.revision)
        await store.commit({ value: { version: 1, github: { token: 'ghu_replaced' } },
          expectedRevision: original.revision }, operation)
        await getCopilotToken(store, { tokenCache })
        expect(exchange).toHaveBeenCalledTimes(3)
      } finally { await runtime.close() }
    } finally { db.close() }
  })

  it('supports host-owned Copilot acquire/invalidate hooks and cancellation', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const store = sqliteCredentialStore<CopilotAuthFile>(db, 'tenant', 'copilot')
      await store.commit({ value: { version: 1, github: { token: 'ghu_example' } },
        expectedRevision: null }, operation)
      const acquire = vi.fn<CopilotTokenCache['acquire']>(async () =>
        ({ token: 'host-managed', expiresAtMs: Date.now() + 3600000 }))
      const invalidate = vi.fn()
      expect((await getCopilotToken(store, { tokenCache: { acquire, invalidate }, forceRefresh: true })).token)
        .toBe('host-managed')
      expect(invalidate).toHaveBeenCalledOnce()
      expect(acquire.mock.calls[0]?.[0].file.github.token).toBe('ghu_example')
      const controller = new AbortController()
      controller.abort()
      await expect(getCopilotToken(store, { signal: controller.signal, tokenCache: { acquire, invalidate } }))
        .rejects.toThrow()
      expect(acquire).toHaveBeenCalledOnce()
    } finally { db.close() }
  })
})
