import { describe, expect, it, vi } from 'vitest'
import { createObservability } from '../../../packages/core/src/observability/bus.ts'
import {
  defineCredentialSource, defineCredentialStore,
} from '../../../packages/core/src/composition/credential/definition.ts'

describe('credential capability author helpers', () => {
  it('captures one source method with its live receiver and requires logger-bearing operation options', async () => {
    const original = vi.fn(function (this: { value: string }) { return this.value })
    const replacement = vi.fn(() => 'replacement')
    const definition = { id: 'account-token', value: 'first', resolve: original }
    const source = defineCredentialSource(definition)
    definition.value = 'second'
    definition.resolve = replacement
    const options = { signal: new AbortController().signal, logger: createObservability().logger() }
    expect(await source.resolve(options)).toBe('second')
    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    expect(source).toMatchObject({ kind: 'credential-source', apiVersion: 1, id: 'account-token' })
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.isFrozen(definition)).toBe(false)
  })

  it('captures store methods once without reading, freezing, or mutating caller state', async () => {
    const read = vi.fn(async function (this: { revision: string }) {
      return { value: { token: 'opaque' }, revision: this.revision }
    })
    const commit = vi.fn(async function (this: { revision: string }) {
      this.revision = 'r2'
      return { revision: this.revision }
    })
    const definition = { id: 'account-store', label: 'Account store', revision: 'r1', read, commit }
    const store = defineCredentialStore(definition)
    const replacementRead = vi.fn(async () => ({ value: { token: 'replacement' }, revision: 'replacement' }))
    const replacementCommit = vi.fn(async () => ({ revision: 'replacement' }))
    definition.read = replacementRead
    definition.commit = replacementCommit
    const options = { signal: new AbortController().signal, logger: createObservability().logger() }
    expect(await store.read(options)).toMatchObject({ revision: 'r1' })
    expect(await store.commit({ value: { token: 'next' }, expectedRevision: 'r1' }, options))
      .toEqual({ revision: 'r2' })
    expect(definition.revision).toBe('r2')
    expect(replacementRead).not.toHaveBeenCalled()
    expect(replacementCommit).not.toHaveBeenCalled()
    expect(Object.isFrozen(store)).toBe(true)
    expect(Object.isFrozen(definition)).toBe(false)
  })

  it('rejects invalid metadata before executable method access', () => {
    const resolve = vi.fn()
    const source = Object.defineProperty({ id: '' }, 'resolve', { get: resolve })
    expect(() => defineCredentialSource(source as never)).toThrow(expect.objectContaining({
      code: 'CREDENTIAL_SOURCE_INVALID',
    }))
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'read', 'commit'])('contains a throwing %s property without retaining private output', key => {
    const secret = 'PRIVATE_CREDENTIAL_GETTER/7C2D~SENTINEL%'
    const get = vi.fn(() => { throw new Error(secret) })
    const definition = key === 'resolve'
      ? { id: 'source', resolve: () => 'unused' }
      : { id: 'store', label: 'Store', read: async () => undefined,
          commit: async () => ({ revision: 'unused' }) }
    Object.defineProperty(definition, key, { get })
    let error: unknown
    try {
      key === 'resolve' ? defineCredentialSource(definition as never) : defineCredentialStore(definition as never)
    } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: key === 'resolve' ? 'CREDENTIAL_SOURCE_INVALID' : 'CREDENTIAL_STORE_INVALID' })
    expect(String(error)).not.toContain(secret)
    expect((error as Error).cause).toBeUndefined()
    expect(get).toHaveBeenCalledOnce()
  })
})
