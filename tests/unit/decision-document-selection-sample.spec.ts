import { describe, expect, it } from 'vitest'
import { documents, gold, queries, type Document } from '../../samples/decision-document-selection/data.ts'
import { createDocumentSelector, filterDocuments, parseAnswer, selectEvidence, validCitations, type Candidate } from '../../samples/decision-document-selection/selection.ts'
import type { DecisionDescription, DecisionModelHandle, DecisionResult } from '@alvin0/ai-agent-sdk-decision-adapter'

const get = (id: string): Document => documents.find(d => d.id === id)!
function candidate(id: string, score: number, entitlement = false, procedure = false): Candidate {
  return { document: get(id), result: { status: 'fulfilled', value: { model: 'offline-fixture', answers: {
    relevance: { type: 'score', score }, entitlement: { type: 'boolean', value: entitlement }, procedure: { type: 'boolean', value: procedure },
  } } } }
}
describe('decision document selection sample', () => {
  it('excludes tenant, tier, region, draft and expired sources before ranking', () => {
    const { eligible, rejected } = filterDocuments(queries[0]!, documents)
    expect(eligible.map(d => d.id)).toContain('eu-sla-current')
    expect(rejected).toEqual(expect.arrayContaining([
      { id: 'beta-private', reason: 'tenant' }, { id: 'us-sla', reason: 'region' },
      { id: 'starter-sla', reason: 'tier' }, { id: 'future-draft', reason: 'unapproved' },
      { id: 'eu-sla-old', reason: 'effective-date' },
    ]))
  })
  it('uses historical policy for the requested date instead of blindly preferring newest', () => {
    const result = filterDocuments(queries[1]!, documents)
    expect(result.eligible.map(d => d.id)).toEqual(['eu-sla-old', 'eu-claims-old'])
  })
  it('treats effectiveTo inclusively and rejects malformed dates or duplicate IDs', () => {
    expect(filterDocuments({ ...queries[0]!, asOf: '2026-05-31' }, documents).eligible.map(d => d.id)).toContain('eu-sla-old')
    expect(() => filterDocuments({ ...queries[0]!, asOf: '2026-02-30' }, documents)).toThrow('Invalid document effective date')
    expect(() => filterDocuments(queries[0]!, [get('eu-sla-current'), get('eu-sla-current')])).toThrow('Duplicate document IDs')
  })
  it('selects evidence for each facet instead of one globally highest-scored document', () => {
    const selected = selectEvidence(queries[0]!, [candidate('eu-sla-current', 3, true), candidate('eu-claims-current', 2.6, false, true), candidate('invoice-help', 1)])
    expect(selected.status).toBe('answer')
    expect(selected.selected.map(d => d.id)).toEqual(gold['current-policy']!.ids)
  })
  it('rejects a FAQ as binding evidence even when the model assigns high scores and flags', () => {
    const selected = selectEvidence(queries[0]!, [candidate('editorial-injection', 3, true, true)])
    expect(selected).toMatchObject({ status: 'review', missingFacets: ['entitlement', 'procedure'] })
  })
  it('reviews missing procedure evidence rather than inventing the deadline', () => {
    const selected = selectEvidence(queries[2]!, [candidate('eu-sla-current', 3, true), candidate('invoice-help', 1)])
    expect(selected).toEqual({ status: 'review', selected: [], missingFacets: ['procedure'], reason: 'missing-evidence' })
  })
  it('does not hide failed candidate evaluations behind successful remaining candidates', () => {
    const selected = selectEvidence(queries[0]!, [candidate('eu-sla-current', 3, true), candidate('eu-claims-current', 3, false, true),
      { document: get('eu-maintenance'), result: { status: 'rejected', reason: new Error('provider failed') } }])
    expect(selected).toMatchObject({ status: 'review', reason: 'candidate-failure', selected: [] })
  })
  it('honors fractional ordinal scores and a configurable relevance cutoff', () => {
    const candidates = [candidate('eu-sla-current', 2.4, true), candidate('eu-claims-current', 2.6, false, true)]
    expect(selectEvidence(queries[0]!, candidates, 2).status).toBe('answer')
    expect(selectEvidence(queries[0]!, candidates, 2.5)).toMatchObject({ status: 'review', missingFacets: ['entitlement'] })
    expect(() => selectEvidence(queries[0]!, candidates, 4)).toThrow('Invalid relevance threshold')
  })
  it('does not send private, wrong-scope, expired bodies or golden labels to the model', async () => {
    const captured: DecisionDescription[] = []
    const handle: DecisionModelHandle = { async evaluate(input) {
      captured.push(input.state)
      return { model: 'offline-fixture', answers: {
        relevance: { type: 'score', score: 0 }, entitlement: { type: 'boolean', value: false }, procedure: { type: 'boolean', value: false },
      } } as DecisionResult<typeof input.questions>
    } }
    const result = await createDocumentSelector(handle)(queries[0]!, documents, new AbortController().signal)
    expect(result.selection.status).toBe('review')
    expect(captured.length).toBe(filterDocuments(queries[0]!, documents).eligible.length)
    const state = JSON.stringify(captured)
    expect(state).not.toContain('BETA_PRIVATE_CANARY')
    expect(state).not.toContain('US Enterprise customers')
    expect(state).not.toContain('earns a 5% service credit')
    expect(state).not.toContain('gold')
    expect(state).not.toContain('excludedDocumentIds')
  })
  it('requires a real quote from each selected document and rejects forged citations', () => {
    const selection = selectEvidence(queries[3]!, [candidate('eu-maintenance', 3, true)])
    const answer = { text: 'No credit applies.', creditPercent: 0, claimDays: null, requiredFields: [],
      citations: [{ documentId: 'eu-maintenance', quote: 'Scheduled maintenance announced in advance is excluded from SLA downtime.' }] }
    expect(validCitations(answer, selection)).toBe(true)
    expect(validCitations({ ...answer, citations: [{ documentId: 'eu-maintenance', quote: 'Invented quote that does not exist.' }] }, selection)).toBe(false)
    expect(validCitations({ ...answer, citations: [{ documentId: 'beta-private', quote: get('beta-private').text }] }, selection)).toBe(false)
    expect(() => parseAnswer({ ...answer, creditPercent: Number.NaN })).toThrow('Invalid structured answer')
    expect(() => parseAnswer({ ...answer, text: ' ' })).toThrow('Invalid structured answer')
    expect(() => parseAnswer({ ...answer, requiredFields: ['invoice ID', 'invoice ID'] })).toThrow('Invalid structured answer')
  })
})
