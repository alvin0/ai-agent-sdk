import { describe, expect, it, vi } from 'vitest'
import { COMPOSITION_LIMITS } from '../../../packages/core/src/composition/common/config.ts'
import { AgentRuntimeConstructionError } from '../../../packages/core/src/composition/common/errors.ts'
import { captureProviderMethods, preflightProviderIdentities } from '../../../packages/core/src/composition/provider/preflight.ts'
import { providerTopology } from '../../../packages/core/src/composition/provider/model-selection.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'

function provider(id = 'team-a', routes = [id]) {
  return { kind: 'model-provider-plugin', apiVersion: 1, id, displayName: 'Provider', family: 'openai', routes, setup: vi.fn() }
}

function failure(operation: () => unknown): AgentRuntimeConstructionError {
  try { operation() } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeConstructionError)
    return error as AgentRuntimeConstructionError
  }
  throw new Error('Expected preflight to fail')
}

describe('provider identity preflight', () => {
  it('accepts distinct accounts in one family and separates ID and route namespaces', () => {
    const left = provider('account-a', ['account-b'])
    const right = provider('account-b', ['account-a'])
    const plan = preflightProviderIdentities([left, right])
    expect(providerTopology(plan)).toMatchObject([
      { id: 'account-b', route: 'account-b', pluginId: 'account-a', family: 'openai' },
      { id: 'account-a', route: 'account-a', pluginId: 'account-b', family: 'openai' },
    ])
    expect(left.setup).not.toHaveBeenCalled()
    expect(right.setup).not.toHaveBeenCalled()
    expect(Object.isFrozen(left)).toBe(false)
  })

  it.each([
    ['provider-plugin-id', 'CAPABILITY_ID_CONFLICT', ['a'], ['b'], 'same', 'same'],
    ['provider-route', 'PROVIDER_ROUTE_CONFLICT', ['shared'], ['shared'], 'a', 'b'],
  ] as const)('rejects %s conflicts before any setup property lookup', (namespace, code, a, b, leftId, rightId) => {
    const get = vi.fn(() => { throw new Error('must not read setup') })
    const left = provider(leftId, [...a])
    const right = provider(rightId, [...b])
    Object.defineProperty(left, 'setup', { get })
    Object.defineProperty(right, 'setup', { get })
    const error = failure(() => preflightProviderIdentities([left, right]))
    expect(error).toMatchObject({
      code: 'RUNTIME_CONSTRUCTION_FAILED', failureCode: code, stage: 'preflight', reason: 'invalid',
      conflict: { namespace, key: '[redacted]', firstIndex: 0, secondIndex: 1 }, cleanup: [],
    })
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects repeated aliases inside one provider with both input indices', () => {
    expect(failure(() => preflightProviderIdentities([provider('a', ['alias', 'alias'])])))
      .toMatchObject({ failureCode: 'PROVIDER_ROUTE_CONFLICT', conflict: { firstIndex: 0, secondIndex: 0 } })
  })

  it('does not retain a conflicting endpoint or credential-like route in support evidence', () => {
    const route = 'https://account:credential@example.test/private/catalog~SENTINEL%'
    const error = failure(() => preflightProviderIdentities([
      provider('left', [route]), provider('right', [route]),
    ]))
    expect(error).toMatchObject({ failureCode: 'PROVIDER_ROUTE_CONFLICT', conflict: {
      namespace: 'provider-route', key: '[redacted]', firstIndex: 0, secondIndex: 1,
    } })
    expect(JSON.stringify(error)).not.toContain(route)
    expect(Object.isFrozen(error.conflict)).toBe(true)
  })

  it.each([
    [{ kind: undefined }, 'CAPABILITY_KIND_MISMATCH'],
    [{ kind: 'credential-source' }, 'CAPABILITY_KIND_MISMATCH'],
    [{ apiVersion: 2 }, 'CAPABILITY_API_UNSUPPORTED'],
  ])('rejects invalid markers without setup', (patch, failureCode) => {
    const source = { ...provider(), ...patch }
    expect(failure(() => preflightProviderIdentities([source]))).toMatchObject({ failureCode, cleanup: [] })
    expect(source.setup).not.toHaveBeenCalled()
  })

  it.each([
    { id: '' }, { id: '  ' }, { id: ' leading' }, { displayName: '' }, { family: '' },
    { routes: [] }, { routes: ['a', ''] }, { routes: 'a' },
    { routes: Array(COMPOSITION_LIMITS.routesPerProvider + 1).fill('route') },
    { id: 'a'.repeat(COMPOSITION_LIMITS.identityBytes + 1) },
    { id: 'é'.repeat(COMPOSITION_LIMITS.identityBytes / 2 + 1) },
    { defaultModel: { provider: 'unclaimed', id: 'model' } },
    { defaultModel: { provider: 'team-a' } }, { defaultModel: 'model' },
  ])('bounds and validates inert metadata %#', patch => {
    const source = { ...provider(), ...patch }
    expect(failure(() => preflightProviderIdentities([source]))).toMatchObject({ reason: 'invalid', cleanup: [] })
    expect(source.setup).not.toHaveBeenCalled()
  })

  it('rejects sparse or oversized input arrays before reading providers', () => {
    const get = vi.fn(() => provider())
    const sources = new Array(COMPOSITION_LIMITS.providers + 1)
    Object.defineProperty(sources, '0', { get })
    failure(() => preflightProviderIdentities(sources))
    expect(get).not.toHaveBeenCalled()
    failure(() => preflightProviderIdentities(new Array(1)))
  })

  it('rejects metadata accessors without invoking them', () => {
    const source = provider()
    const get = vi.fn(() => 'secret')
    Object.defineProperty(source, 'id', { get })
    failure(() => preflightProviderIdentities([source]))
    expect(get).not.toHaveBeenCalled()
  })

  it('reads every metadata field once and never asks for a setup descriptor in phase one', () => {
    const seen: string[] = []
    const source = new Proxy(provider(), {
      getOwnPropertyDescriptor(target, key) {
        seen.push(String(key))
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    preflightProviderIdentities([source])
    expect(seen.sort()).toEqual(['kind', 'apiVersion', 'id', 'displayName', 'family', 'routes', 'defaultModel'].sort())
  })

  it('contains reflected failures and never serializes raw input or an abort reason', () => {
    const secret = 'RAW_PROVIDER_INPUT/PRIVATE~SENTINEL%'
    const source = new Proxy(provider(), { getOwnPropertyDescriptor() { throw new Error(secret) } })
    const error = failure(() => preflightProviderIdentities([source]))
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(error.cause).toBeUndefined()
    expect(error.message).not.toContain(secret)
    const get = vi.fn()
    const input = new Proxy([], { getOwnPropertyDescriptor: get })
    const controller = new AbortController()
    controller.abort({ get message() { throw new Error(secret) } })
    const aborted = failure(() => preflightProviderIdentities(input, undefined, controller.signal))
    expect(aborted.failureCode).toBe('CAPABILITY_STARTUP_ABORTED')
    expect(JSON.stringify(aborted)).not.toContain(secret)
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects an unavailable default route before method access', () => {
    const source = { ...provider(), defaultModel: { provider: 'team-a', id: 'model' } }
    const get = vi.fn()
    Object.defineProperty(source, 'setup', { get })
    failure(() => preflightProviderIdentities([source], 'other'))
    expect(get).not.toHaveBeenCalled()
  })
})

describe('one-time executable capture after identity validation', () => {
  it('keeps metadata and methods detached while preserving the caller receiver and operational state', () => {
    const setup = vi.fn(function (this: { calls: number }) { this.calls++ })
    const get = vi.fn(() => setup)
    const source = { ...provider(), calls: 0, defaultModel: { provider: 'team-a', id: 'model-a' } }
    Object.defineProperty(source, 'setup', { configurable: true, get })
    const plan = preflightProviderIdentities([source])
    source.id = 'changed'
    source.routes[0] = 'changed'
    source.defaultModel.id = 'changed'
    const handles = captureProviderMethods(plan)
    Object.defineProperty(source, 'setup', { value: () => { throw new Error('replaced') } })
    Reflect.deleteProperty(source, 'setup')
    handles[0]!.setup({} as ModelProviderRegistrar)
    expect(source.calls).toBe(1)
    expect(get).toHaveBeenCalledTimes(1)
    expect(captureProviderMethods(plan)).toBe(handles)
    expect(handles[0]).toMatchObject({ id: 'team-a', routes: ['team-a'], defaultModel: { id: 'model-a' } })
    expect(Object.isFrozen(handles[0])).toBe(true)
    expect(Object.isFrozen(handles[0]!.defaultModel)).toBe(true)
    expect(Object.isFrozen(source)).toBe(false)
  })

  it('supports class prototype methods with own-data identities', () => {
    class Provider {
      kind = 'model-provider-plugin'; apiVersion = 1; id = 'a'; displayName = 'A'; routes = ['a']; calls = 0
      setup() { this.calls++ }
    }
    const source = new Provider()
    const [handle] = captureProviderMethods(preflightProviderIdentities([source]))
    handle!.setup({} as ModelProviderRegistrar)
    expect(source.calls).toBe(1)
  })

  it('never retries a partially failed capture or invokes any captured setup', () => {
    const first = provider('a')
    const second = provider('b')
    const get = vi.fn(() => { throw new Error('RAW_METHOD/PRIVATE~SENTINEL%') })
    Object.defineProperty(second, 'setup', { get })
    const plan = preflightProviderIdentities([first, second])
    const error = failure(() => captureProviderMethods(plan))
    expect(JSON.stringify(error)).not.toContain('RAW_METHOD/PRIVATE~SENTINEL%')
    failure(() => captureProviderMethods(plan))
    expect(get).toHaveBeenCalledTimes(1)
    expect(first.setup).not.toHaveBeenCalled()
  })

  it('stops method capture immediately when a getter aborts startup', () => {
    const controller = new AbortController()
    const first = provider('a')
    const second = provider('b')
    Object.defineProperty(first, 'setup', { get() { controller.abort(); return () => undefined } })
    const get = vi.fn()
    Object.defineProperty(second, 'setup', { get })
    const plan = preflightProviderIdentities([first, second])
    expect(failure(() => captureProviderMethods(plan, controller.signal)).failureCode).toBe('CAPABILITY_STARTUP_ABORTED')
    expect(get).not.toHaveBeenCalled()
  })
})
