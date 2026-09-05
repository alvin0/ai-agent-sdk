import { describe, expect, it } from 'vitest'
import { ResearchEvidenceLedger, type ResearchReadReceipt } from '../../test-human/edge-chat/live/evidence.ts'
import { readResearchPage } from '../../test-human/edge-chat/live/page-reader.ts'

function receipt(
  taskId: string,
  index: number,
  overrides: Partial<ResearchReadReceipt> = {},
): ResearchReadReceipt {
  return {
    taskId, callId: `call-${index}`, receiptId: `read-call-${index}`,
    requestedUrl: `https://source${index}.example/article`,
    finalUrl: `https://source${index}.example/article`,
    canonicalSource: `https://source${index}.example/article`,
    domain: `source${index}.example`, title: `Source ${index}`, searchQuery: 'test query',
    retrievedAt: '2026-09-05T00:00:00.000Z', digest: `digest-${index}`,
    extraction: 'html-text', status: 'complete', bytesRead: 100, charsExtracted: 80,
    ...overrides,
  }
}

describe('real research evidence ledger', () => {
  it('accepts only scoped receipts and exposes coverage separately from independent review', () => {
    const ledger = new ResearchEvidenceLedger('task-a')
    for (let index = 0; index < 6; index++) ledger.record(receipt('task-a', index))
    const audit = ledger.audit({
      round: 1, criteria: ['Compare current behavior and limitations.'],
      claims: [{ claim: 'Six current sources support the comparison.',
        receiptIds: Array.from({ length: 6 }, (_, index) => `read-call-${index}`),
        scope: 'retrieved-content' }],
      contradictions: [], unresolvedGaps: [],
    })
    expect(audit).toMatchObject({ uniqueSources: 6, independentDomains: 6,
      coverageFloorMet: true, claimsTraceable: true,
      eligibleForIndependentReview: true, requiresIndependentReview: true })
  })

  it('rejects foreign/missing receipts, mirrors and whole-page claims over partial reads', () => {
    const ledger = new ResearchEvidenceLedger('task-b')
    ledger.record(receipt('task-b', 1, { digest: 'same', status: 'partial' }))
    ledger.record(receipt('task-b', 2, { digest: 'same' }))
    const audit = ledger.audit({
      round: 1, criteria: ['Find limits.'],
      claims: [{ claim: 'The complete pages establish the limit.',
        receiptIds: ['read-call-1', 'read-call-2', 'read-foreign'], scope: 'whole-page' }],
      contradictions: [], unresolvedGaps: ['A primary source is missing.'],
    })
    expect(audit).toMatchObject({ rejectedReceiptIds: ['read-foreign'],
      mirroredSources: 1, claimsTraceable: false, wholePageClaimsSupported: false,
      hasUnresolvedGaps: true, eligibleForIndependentReview: false })
    expect(() => ledger.record(receipt('another-task', 3))).toThrow('another research task')
  })

  it('preserves honest gaps without blocking an independently reviewed report', () => {
    const ledger = new ResearchEvidenceLedger('task-with-gap')
    for (let index = 0; index < 6; index++) ledger.record(receipt('task-with-gap', index))
    const audit = ledger.audit({
      round: 1, criteria: ['Compare current platform behavior.'],
      claims: [{ claim: 'The retrieved material supports the bounded comparison.',
        receiptIds: Array.from({ length: 6 }, (_, index) => `read-call-${index}`),
        scope: 'retrieved-content' }],
      contradictions: [], unresolvedGaps: ['One vendor does not publish a plan-specific wall-clock cap.'],
    })
    expect(audit).toMatchObject({
      coverageFloorMet: true, claimsTraceable: true, hasUnresolvedGaps: true,
      eligibleForIndependentReview: true, requiresIndependentReview: true,
    })
  })
})

describe('bounded Internet page reader', () => {
  it('records a complete host-owned receipt without retaining the page body', async () => {
    const ledger = new ResearchEvidenceLedger('page-task')
    const fetch = async () => new Response('<html><head><title>Example</title></head><body>Hello <b>world</b></body></html>', {
      headers: { 'content-type': 'text/html' },
    })
    const result = await readResearchPage(
      { url: 'https://example.com/article?utm_source=test', searchQuery: 'example research' },
      { callId: 'page-1', signal: new AbortController().signal }, ledger, fetch,
    )
    expect(result.excerpt).toContain('Hello world')
    expect(result.receipt).toMatchObject({ receiptId: 'read-page-1', title: 'Example',
      canonicalSource: 'https://example.com/article', status: 'complete' })
    expect(JSON.stringify(ledger.snapshot())).not.toContain('Hello world')
  })

  it.each(['http://example.com', 'https://127.0.0.1/page', 'https://localhost/page'])(
    'rejects an ineligible research URL: %s', async url => {
      const ledger = new ResearchEvidenceLedger('rejected-page')
      await expect(readResearchPage({ url, searchQuery: 'query' },
        { callId: 'blocked', signal: new AbortController().signal }, ledger,
        async () => new Response('should not run'))).rejects.toThrow()
      expect(ledger.snapshot()).toHaveLength(0)
    },
  )
})
