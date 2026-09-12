import { describe, expect, it, vi } from 'vitest'
import { COMPOSITION_LIMITS, MODEL_BINDING_ERROR_CODES } from '../../../packages/core/src/composition/common/config.ts'
import { preflightProviderIdentities } from '../../../packages/core/src/composition/provider/preflight.ts'
import { providerTopology, resolveAgentModel } from '../../../packages/core/src/composition/provider/model-selection.ts'

function provider(id: string, defaultModel?: { provider: string; id: string }, routes = [id]) {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id, displayName: id, family: 'openai', routes,
    ...(defaultModel === undefined ? {} : { defaultModel }), setup: vi.fn(),
  }
}

describe('per-agent model selection from captured provider configuration', () => {
  it('lets each agent override the same provider default independently', () => {
    const source = provider('account-a', { provider: 'account-a', id: 'general' })
    const plan = preflightProviderIdentities([source])
    expect(resolveAgentModel(plan)).toEqual({ provider: 'account-a', id: 'general' })
    const coding = { provider: 'account-a', id: 'coding' }
    const bound = resolveAgentModel(plan, coding)
    expect(bound).toEqual(coding)
    expect(resolveAgentModel(plan, { provider: 'account-a', id: 'research' }).id).toBe('research')
    coding.id = 'mutated'
    expect(bound.id).toBe('coding')
    expect(Object.isFrozen(bound)).toBe(true)
    expect(source.setup).not.toHaveBeenCalled()
  })

  it('uses route-only selection for that exact account, overriding runtime selection', () => {
    const plan = preflightProviderIdentities([
      provider('a', { provider: 'a', id: 'model-a' }),
      provider('b', { provider: 'b', id: 'model-b' }),
    ], 'a')
    expect(resolveAgentModel(plan)).toEqual({ provider: 'a', id: 'model-a' })
    expect(resolveAgentModel(plan, { provider: 'b' })).toEqual({ provider: 'b', id: 'model-b' })
    expect(resolveAgentModel(plan, { provider: 'b', id: 'independent' })).toEqual({ provider: 'b', id: 'independent' })
  })

  it('uses the unique configured default without selecting the first registered provider', () => {
    const without = provider('first')
    const withDefault = provider('second', { provider: 'second', id: 'default' })
    for (const sources of [[without, withDefault], [withDefault, without]]) {
      expect(resolveAgentModel(preflightProviderIdentities(sources))).toEqual({ provider: 'second', id: 'default' })
    }
  })

  it('rejects ambiguous defaults independently of registration order', () => {
    const a = provider('a', { provider: 'a', id: 'one' })
    const b = provider('b', { provider: 'b', id: 'two' })
    for (const sources of [[a, b], [b, a]]) {
      expect(() => resolveAgentModel(preflightProviderIdentities(sources)))
        .toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.AMBIGUOUS_DEFAULT }))
    }
  })

  it('names the competing routes and both ways out in the ambiguity message', () => {
    // The code is what a host routes on, but a person reads the message, and
    // "defaults are ambiguous" on its own says neither which routes collided nor
    // that `defaultProvider` exists to settle it.
    const plan = preflightProviderIdentities([
      provider('a', { provider: 'a', id: 'one' }),
      provider('b', { provider: 'b', id: 'two' }),
    ])
    const message = (() => {
      try { resolveAgentModel(plan); return '' } catch (error) { return (error as Error).message }
    })()
    expect(message).toContain('"a"')
    expect(message).toContain('"b"')
    expect(message).toContain('defaultProvider')
    expect(message).toContain('{ provider, id }')
  })

  it('names the configured routes when a target is unroutable or has no default', () => {
    const plan = preflightProviderIdentities([provider('configured')])
    const unroutable = (() => {
      try { resolveAgentModel(plan, { provider: 'absent' }); return '' } catch (error) { return (error as Error).message }
    })()
    expect(unroutable).toContain('"absent"')
    expect(unroutable).toContain('"configured"')
    const missing = (() => {
      try { resolveAgentModel(plan, { provider: 'configured' }); return '' } catch (error) { return (error as Error).message }
    })()
    expect(missing).toContain('"configured"')
    expect(missing).toContain('defaultModel')
  })

  it('allows providers without defaults but requires a full agent target', () => {
    const plan = preflightProviderIdentities([provider('a'), provider('b')])
    expect(resolveAgentModel(plan, { provider: 'b', id: 'model/with/slashes' }))
      .toEqual({ provider: 'b', id: 'model/with/slashes' })
    expect(() => resolveAgentModel(plan)).toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.MISSING_DEFAULT }))
    expect(() => resolveAgentModel(plan, { provider: 'a' }))
      .toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.MISSING_DEFAULT }))
  })

  it('does not use another alias or account when the requested route lacks a default', () => {
    const plan = preflightProviderIdentities([
      provider('aliases', { provider: 'a', id: 'a-default' }, ['a', 'b']),
    ])
    expect(() => resolveAgentModel(plan, { provider: 'b' }))
      .toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.MISSING_DEFAULT }))
    expect(() => resolveAgentModel(plan, { provider: 'openai' }))
      .toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.UNKNOWN_ROUTE }))
    expect(providerTopology(plan)[1]!.defaultModel).toBeUndefined()
  })

  it.each([
    null, '', 'a/model', 42, [], {}, { provider: 'a', id: '' }, { provider: 'a', id: undefined },
    { provider: 'a', id: null }, { provider: 'a', id: 12 }, { provider: '' },
    { provider: 'a', id: '  ' }, { provider: 'a', id: 'valid', unexpected: true },
    { provider: 'a', id: 'x'.repeat(COMPOSITION_LIMITS.modelIdBytes + 1) },
    { provider: 'a', id: 'é'.repeat(COMPOSITION_LIMITS.modelIdBytes / 2 + 1) },
  ])('never substitutes a default for malformed explicit input %#', input => {
    const plan = preflightProviderIdentities([provider('a', { provider: 'a', id: 'default' })])
    expect(() => resolveAgentModel(plan, input)).toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.INVALID }))
  })

  it('rejects inherited or accessor target fields without evaluating accessors', () => {
    const plan = preflightProviderIdentities([provider('a', { provider: 'a', id: 'default' })])
    expect(() => resolveAgentModel(plan, Object.create({ provider: 'a', id: 'inherited' }))).toThrow()
    const get = vi.fn(() => 'hidden')
    const input = { provider: 'a' }
    Object.defineProperty(input, 'id', { get })
    expect(() => resolveAgentModel(plan, input)).toThrow()
    expect(get).not.toHaveBeenCalled()
  })

  it('accepts exact UTF-8 bounds and publishes detached immutable topology', () => {
    const id = 'é'.repeat(COMPOSITION_LIMITS.modelIdBytes / 2)
    const configured = { provider: 'a', id }
    const source = provider('a', configured)
    const plan = preflightProviderIdentities([source])
    const topology = providerTopology(plan)
    configured.id = 'changed'
    source.routes.push('late')
    source.displayName = 'changed'
    expect(resolveAgentModel(plan).id).toBe(id)
    expect(topology).toHaveLength(1)
    expect(topology[0]).toMatchObject({ id: 'a', route: 'a', name: 'a', defaultModel: { id } })
    expect(Object.isFrozen(topology)).toBe(true)
    expect(Object.isFrozen(topology[0])).toBe(true)
    expect(Object.isFrozen(topology[0]!.defaultModel)).toBe(true)
    expect(Object.isFrozen(configured)).toBe(false)
  })
})
