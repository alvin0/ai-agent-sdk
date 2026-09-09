import { defineTool, type JsonObject, type JsonValue, type ToolDefinition } from '@ai-agent-sdk/core'
import {
  ResearchEvidenceLedger, type ResearchAuditInput, type ResearchAuditSnapshot,
} from './evidence.ts'
import { readResearchPage, type PageReadInput } from './page-reader.ts'

export interface LiveResearchTools {
  readonly ledger: ResearchEvidenceLedger
  readonly tools: readonly ToolDefinition[]
}

export function createLiveResearchTools(
  taskId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): LiveResearchTools {
  const ledger = new ResearchEvidenceLedger(taskId)
  const read = defineTool<PageReadInput>({
    name: 'read_web_page',
    description: 'Read one HTTPS source found during research and return a host-owned receipt plus a bounded text excerpt.',
    parameters: {
      type: 'object', properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        searchQuery: { type: 'string', minLength: 1, maxLength: 500 },
      }, required: ['url', 'searchQuery'], additionalProperties: false,
    },
    parse: parsePageRead,
    async execute(input, context) {
      const result = await readResearchPage(input, context, ledger, fetchImplementation)
      return {
        receiptId: result.receipt.receiptId, requestedUrl: result.receipt.requestedUrl,
        finalUrl: result.receipt.finalUrl, title: result.receipt.title,
        status: result.receipt.status, digest: result.receipt.digest,
        retrievedAt: result.receipt.retrievedAt, excerpt: result.excerpt,
      }
    },
    meta(value) {
      const receiptId = field(value, 'receiptId')
      const receipt = typeof receiptId === 'string' ? ledger.receipt(receiptId) : undefined
      return receipt === undefined ? { kind: 'web-page', status: 'failed' } : {
        kind: 'web-page', receiptId: receipt.receiptId, title: receipt.title,
        url: receipt.finalUrl, status: receipt.status, bytesRead: receipt.bytesRead,
        charsExtracted: receipt.charsExtracted, digest: receipt.digest,
      }
    },
    timeoutMs: 25_000,
    isConcurrencySafe: () => true,
  })
  const audit = defineTool<ResearchAuditInput>({
    name: 'audit_research_evidence',
    description: 'Validate claim provenance against successful read receipts. This checks evidence integrity and coverage floors, not semantic quality; an independent reviewer is still required.',
    parameters: auditSchema,
    parse: parseAudit,
    execute(input) { return auditJson(ledger.audit(input)) },
    meta(value) {
      return {
        kind: 'research-evidence-audit', round: field(value, 'round') ?? null,
        uniqueSources: field(value, 'uniqueSources') ?? null,
        independentDomains: field(value, 'independentDomains') ?? null,
        partialReads: field(value, 'partialReads') ?? null,
        coverageFloorMet: field(value, 'coverageFloorMet') ?? null,
        claimsTraceable: field(value, 'claimsTraceable') ?? null,
        eligibleForIndependentReview: field(value, 'eligibleForIndependentReview') ?? null,
        requiresIndependentReview: true,
      }
    },
  })
  return Object.freeze({ ledger, tools: Object.freeze([read, audit]) })
}

function parsePageRead(value: unknown): PageReadInput {
  const url = field(value, 'url')
  const searchQuery = field(value, 'searchQuery')
  if (typeof url !== 'string' || typeof searchQuery !== 'string') throw new TypeError('page read input is invalid')
  return { url, searchQuery }
}

function parseAudit(value: unknown): ResearchAuditInput {
  if (value === null || typeof value !== 'object') throw new TypeError('research audit input is invalid')
  return value as ResearchAuditInput
}

function field(value: unknown, name: string): JsonValue | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const selected: unknown = Reflect.get(value, name)
  return isJsonValue(selected) ? selected : undefined
}

function auditJson(snapshot: ResearchAuditSnapshot): JsonObject {
  return {
    kind: snapshot.kind, auditId: snapshot.auditId, taskId: snapshot.taskId,
    round: snapshot.round, auditedAt: snapshot.auditedAt,
    acceptedReceiptIds: [...snapshot.acceptedReceiptIds],
    rejectedReceiptIds: [...snapshot.rejectedReceiptIds],
    uniqueSources: snapshot.uniqueSources, independentDomains: snapshot.independentDomains,
    mirroredSources: snapshot.mirroredSources, partialReads: snapshot.partialReads,
    coverageFloorMet: snapshot.coverageFloorMet, claimsTraceable: snapshot.claimsTraceable,
    wholePageClaimsSupported: snapshot.wholePageClaimsSupported,
    hasUnresolvedGaps: snapshot.hasUnresolvedGaps,
    eligibleForIndependentReview: snapshot.eligibleForIndependentReview,
    requiresIndependentReview: true,
    criteria: [...snapshot.criteria],
    claims: snapshot.claims.map(claim => ({
      claim: claim.claim, receiptIds: [...claim.receiptIds], scope: claim.scope,
    })),
    contradictions: snapshot.contradictions.map(item => ({
      summary: item.summary, receiptIds: [...item.receiptIds], resolution: item.resolution,
    })),
    unresolvedGaps: [...snapshot.unresolvedGaps],
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return typeof value === 'object' && Object.values(value).every(isJsonValue)
}

const auditSchema = {
  type: 'object',
  properties: {
    round: { type: 'integer', minimum: 1, maximum: 12 },
    criteria: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 2000 } },
    claims: { type: 'array', minItems: 1, maxItems: 32, items: {
      type: 'object', properties: {
        claim: { type: 'string', minLength: 1, maxLength: 2000 },
        receiptIds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } },
        scope: { type: 'string', enum: ['retrieved-content', 'whole-page'] },
      }, required: ['claim', 'receiptIds', 'scope'], additionalProperties: false,
    } },
    contradictions: { type: 'array', maxItems: 16, items: {
      type: 'object', properties: {
        summary: { type: 'string', minLength: 1, maxLength: 2000 },
        receiptIds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } },
        resolution: { type: 'string', minLength: 1, maxLength: 2000 },
      }, required: ['summary', 'receiptIds', 'resolution'], additionalProperties: false,
    } },
    unresolvedGaps: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 2000 } },
  },
  required: ['round', 'criteria', 'claims', 'contradictions', 'unresolvedGaps'],
  additionalProperties: false,
} as const
