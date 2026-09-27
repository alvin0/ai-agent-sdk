import type { EvaluationCaseV2 } from './cohort-v2.ts'

export const BUNDLE_LIMITS = Object.freeze({ maxTurns: 12, maxToolCalls: 24, timeoutMs: 120000, maxTotalTokens: 40000, maxToolResultTokens: 2048, maxToolResultBytes: 65536 })

/** Raw-result admission and model-facing spill are different limits. Every fixture
 * must be readable in the common host API before judging either SDK/model. */
export function fixtureSizeAudit(tests: readonly EvaluationCaseV2[], rawLimit = BUNDLE_LIMITS.maxToolResultBytes) {
  const results: { variantId: string; resource: string; bytes: number }[] = []
  for (const test of tests) {
    for (const [name, value] of Object.entries(test.resources)) results.push({ variantId: test.variantId, resource: name, bytes: Buffer.byteLength(JSON.stringify(value)) })
    for (const [name, values] of Object.entries(test.collections)) for (let offset = 0; offset < values.length; offset += 40) {
      const page = { records: values.slice(offset, offset + 40), nextOffset: offset + 40 < values.length ? offset + 40 : null, total: values.length }
      results.push({ variantId: test.variantId, resource: `${name}:${offset}`, bytes: Buffer.byteLength(JSON.stringify(page)) })
    }
  }
  // Reserve a factor of two for structured content and serialization envelopes.
  const inaccessible = results.filter(result => result.bytes * 2 + 1024 > rawLimit)
  if (inaccessible.length) throw new Error(`Fixture raw result cannot be read within common host limit: ${inaccessible.map(result => `${result.variantId}/${result.resource}`).join(', ')}`)
  return { rawLimit, modelFacingTokenLimit: BUNDLE_LIMITS.maxToolResultTokens, largestRawResult: results.toSorted((a, b) => b.bytes - a.bytes)[0] ?? null, outputsAudited: results.length }
}
