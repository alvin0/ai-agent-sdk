import { describe, expect, it } from 'vitest'
import { createEmbeddingRetryLedger } from '../../../packages/core/src/composition/embedding/retry.ts'
import { resolveRetryPolicy } from '../../../packages/core/src/contract/retry-policy.ts'
import { EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import { normalizeModelFailure } from '../../../packages/core/src/errors/failure.ts'
import { ModelError } from '../../../packages/core/src/errors/model-error.ts'
import { ProviderRequestId } from '../../../packages/core/src/primitives/brand.ts'

describe('embedding terminal provider facts', () => {
  it.each([
    { code: 'AUTH', status: 401, retries: 0 },
    { code: 'RATE_LIMIT', status: 429, retries: 2 },
    { code: 'SERVER', status: 503, retries: 2 },
  ])('preserves $code facts after the exact allowed attempts', async ({ code, status, retries }) => {
    let calls = 0
    const original = new ModelError('provider refused', code, {
      status, providerRetryAfterMs: 1250, requestId: ProviderRequestId('request-17'),
      cause: new Error('embedding/private-provider-body%2026-10-03'),
    })
    const ledger = createEmbeddingRetryLedger({ embedBatch: async () => {
      calls += 1
      throw original
    } }, { policy: resolveRetryPolicy({ mode: 'normal', maxRetries: 2 }, 'test.retryPolicy'), sleep: async () => true })
    const result = await ledger.dispatch(0, {
      provider: 'arbitrary-route', model: 'arbitrary-model', purpose: 'retrieval-query',
      truncation: 'reject', items: [{ index: 7, contentParts: [{ type: 'text', text: 'embedding/private-input%2026-10-03' }] }],
    })
    expect(calls).toBe(retries + 1)
    expect(result.attempts).toBe(retries + 1)
    expect(result.state.phase).toBe('failed')
    if (result.state.phase !== 'failed') throw new Error('expected failure')
    expect(result.state.error).toBeInstanceOf(EmbeddingError)
    expect(result.state.error).not.toBeInstanceOf(ModelError)
    expect(result.state.error.cause).toBe(original)
    expect(result.state.error.itemIndexes).toEqual([7])
    const facts = normalizeModelFailure(result.state.error)
    expect(facts).toEqual(normalizeModelFailure(original))
    expect(facts.status).toBe(status)
    expect(JSON.stringify(facts)).not.toContain('embedding/private-provider-body%2026-10-03')
    expect(JSON.stringify(facts)).not.toContain('embedding/private-input%2026-10-03')
    expect(Object.isFrozen(result.state.error.failure)).toBe(true)
    expect(normalizeModelFailure({ code, failure: structuredClone(facts) })).toEqual(facts)
  })

  it('preserves an existing embedding error identity and omits unavailable provider facts', async () => {
    const original = new EmbeddingError('invalid width', 'EMBEDDING_VECTOR_DIMENSIONS_MISMATCH', { limit: 3 })
    const ledger = createEmbeddingRetryLedger({ embedBatch: async () => { throw original } })
    const outcome = await ledger.dispatch(0, {
      provider: 'route', model: 'model', purpose: 'retrieval-query', truncation: 'reject',
      items: [{ index: 0, contentParts: [{ type: 'text', text: 'input' }] }],
    })
    if (outcome.state.phase !== 'failed') throw new Error('expected failure')
    expect(outcome.state.error).toBe(original)
    expect(normalizeModelFailure(original)).toEqual({ message: 'invalid width', code: original.code })
  })

  it('validates carried HTTP facts through the shared model failure contract', () => {
    expect(() => new EmbeddingError('failure', 'AUTH', { status: 600 })).toThrow('status')
    expect(() => new EmbeddingError('failure', 'RATE_LIMIT', { providerRetryAfterMs: -1 })).toThrow('providerRetryAfterMs')
  })
})
