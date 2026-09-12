/**
 * Unit gate for the shared embedding route configuration.
 *
 * Feature: embedding-support — Requirements 10.5, 14.3, 15.3, 15.5.
 *
 * Three claims live here:
 *
 *  - Requirement 10.5: a declared field translates to `supported`, an omitted one
 *    to `unknown`, and `'unsupported'` stays distinct from omission. No default
 *    is ever promoted into a `supported` claim on the route's behalf.
 *  - Requirement 15.3: `compatibilityIdentity` is required by the type, so a
 *    self-hosted endpoint's space is declared rather than assumed.
 *  - Requirement 15.5: `EmbeddingHttpConnection` extends the transport snapshot,
 *    so cleartext HTTP goes through the same `allowInsecureHttp` opt-in the
 *    generation pipeline already enforces — no second copy of the rule.
 */

import { describe, expect, it } from 'vitest'
import { resolveRetryPolicy } from '../../../packages/core/src/index.ts'
import { endpointUrl } from '../../../packages/provider-http/src/transport/http.ts'
import {
  embeddingCatalogModelInfo,
  resolvedEmbeddingCatalogModelInfo,
  type EmbeddingCatalogModel,
  type EmbeddingHttpConnection,
} from '../../../packages/provider-http/src/transport/embedding-connection.ts'

const RETRY_POLICY = resolveRetryPolicy({ mode: 'normal', maxRetries: 1 }, 'test.retryPolicy')

const MINIMAL: EmbeddingCatalogModel = { id: 'text-embedding-3-small', compatibilityIdentity: 'openai:text-embedding-3' }

const FULL: EmbeddingCatalogModel = {
  id: 'gemini-embedding-001',
  name: 'Gemini Embedding 001',
  description: 'first generation',
  dimensions: [768, 1536, 3072],
  defaultDimensions: 3072,
  maxInputTokens: 2_048,
  maxBatchItems: 100,
  maxBatchTokens: 20_000,
  maxBatchBytes: 512 * 1024,
  purposeHandling: { kind: 'wire-parameter', parameter: 'taskType' },
  normalization: 'unit-l2',
  compatibilityIdentity: 'google:gemini-embedding-001',
}

function connectionOf(overrides: Partial<EmbeddingHttpConnection> = {}): EmbeddingHttpConnection {
  return {
    baseUrl: 'https://api.example.test',
    headers: { authorization: 'Bearer secret-token' },
    retryPolicy: RETRY_POLICY,
    models: [MINIMAL],
    ...overrides,
  }
}

describe('embeddingCatalogModelInfo (Requirement 10.5)', () => {
  it('leaves every undeclared capability unknown', () => {
    const info = embeddingCatalogModelInfo('openai', MINIMAL)
    expect(info.dimensions).toEqual({ state: 'unknown' })
    expect(info.defaultDimensions).toEqual({ state: 'unknown' })
    expect(info.maxInputTokens).toEqual({ state: 'unknown' })
    expect(info.maxBatchItems).toEqual({ state: 'unknown' })
    expect(info.maxBatchTokens).toEqual({ state: 'unknown' })
    expect(info.maxBatchBytes).toEqual({ state: 'unknown' })
    expect(info.purposeHandling).toEqual({ state: 'unknown' })
    expect(info.normalization).toEqual({ state: 'unknown' })
    expect(info.inputTypes).toEqual({ state: 'unknown' })
    expect(info.representation).toEqual({ state: 'unknown' })
    expect(info.name).toBe(MINIMAL.id)
    expect(info).not.toHaveProperty('description')
  })

  it('translates every declared capability to supported with the declared value', () => {
    const info = embeddingCatalogModelInfo('google', FULL)
    expect(info).toMatchObject({
      provider: 'google',
      id: 'gemini-embedding-001',
      name: 'Gemini Embedding 001',
      description: 'first generation',
      dimensions: { state: 'supported', value: [768, 1536, 3072] },
      defaultDimensions: { state: 'supported', value: 3072 },
      maxInputTokens: { state: 'supported', value: 2_048 },
      maxBatchItems: { state: 'supported', value: 100 },
      maxBatchTokens: { state: 'supported', value: 20_000 },
      maxBatchBytes: { state: 'supported', value: 512 * 1024 },
      purposeHandling: { state: 'supported', value: { kind: 'wire-parameter', parameter: 'taskType' } },
      normalization: { state: 'supported', value: 'unit-l2' },
    })
  })

  it('keeps an unsupported purpose declaration distinct from an omitted one', () => {
    const declaredNegative = embeddingCatalogModelInfo('openai', { ...MINIMAL, purposeHandling: 'unsupported' })
    expect(declaredNegative.purposeHandling).toEqual({ state: 'unsupported' })
    expect(embeddingCatalogModelInfo('openai', MINIMAL).purposeHandling).toEqual({ state: 'unknown' })
  })

  it('carries compatibilityIdentity as an explicit declaration (Requirement 15.3)', () => {
    expect(embeddingCatalogModelInfo('self-hosted', {
      id: 'bge-m3',
      compatibilityIdentity: 'acme-internal:bge-m3',
    }).compatibilityIdentity).toEqual({ state: 'supported', value: 'acme-internal:bge-m3' })
  })
})

describe('resolvedEmbeddingCatalogModelInfo (Requirement 10.3)', () => {
  it('resolves an exact catalog entry', () => {
    const info = resolvedEmbeddingCatalogModelInfo('google', 'gemini-embedding-001', [MINIMAL, FULL])
    expect(info.compatibilityIdentity).toEqual({ state: 'supported', value: 'google:gemini-embedding-001' })
  })

  it('keeps an id outside the catalog usable with everything unknown', () => {
    const info = resolvedEmbeddingCatalogModelInfo('openai', 'some-future-model', [MINIMAL])
    expect(info).toMatchObject({ provider: 'openai', id: 'some-future-model', name: 'some-future-model' })
    expect(info.compatibilityIdentity).toEqual({ state: 'unknown' })
    expect(info.dimensions).toEqual({ state: 'unknown' })
  })
})

describe('EmbeddingHttpConnection cleartext opt-in (Requirement 15.5)', () => {
  it('rejects a cleartext self-hosted endpoint when the caller did not opt in', () => {
    const connection = connectionOf({ baseUrl: 'http://localhost:8080' })
    expect(() => endpointUrl(connection.baseUrl, '/embeddings', connection.allowInsecureHttp ?? false))
      .toThrow(/must use HTTPS unless allowInsecureHttp is explicitly enabled/)
  })

  it('accepts the same endpoint once the opt-in is explicit', () => {
    const connection = connectionOf({ baseUrl: 'http://localhost:8080', allowInsecureHttp: true })
    expect(endpointUrl(connection.baseUrl, '/embeddings', connection.allowInsecureHttp ?? false).href)
      .toBe('http://localhost:8080/embeddings')
  })
})
