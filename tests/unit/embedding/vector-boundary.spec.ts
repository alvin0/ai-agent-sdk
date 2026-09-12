import { expect, it } from 'vitest'
import { validateBatchResult } from '../../../packages/core/src/embedding/validation.ts'

it('rejects sparse vectors from JavaScript adapters instead of accepting holes as numbers', () => {
  expect(() => validateBatchResult({
    provider: 'custom', model: 'embedding', purpose: 'retrieval-document', truncation: 'reject',
    dimensions: 2, items: [{ index: 0, contentParts: [{ type: 'text', text: 'hello' }] }],
  }, { vectors: [{ index: 0, values: new Array(2) }] })).toThrowError(
    expect.objectContaining({ code: 'EMBEDDING_VECTOR_VALUE_INVALID' }),
  )
})
