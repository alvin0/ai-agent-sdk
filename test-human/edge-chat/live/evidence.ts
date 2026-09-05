export interface ResearchReadReceipt {
  readonly taskId: string
  readonly callId: string
  readonly receiptId: string
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly canonicalSource: string
  readonly domain: string
  readonly title: string
  readonly searchQuery: string
  readonly retrievedAt: string
  readonly digest: string
  readonly extraction: 'html-text' | 'plain-text'
  readonly status: 'complete' | 'partial'
  readonly bytesRead: number
  readonly charsExtracted: number
}

export interface ResearchClaimInput {
  readonly claim: string
  readonly receiptIds: readonly string[]
  readonly scope: 'retrieved-content' | 'whole-page'
}

export interface ResearchContradictionInput {
  readonly summary: string
  readonly receiptIds: readonly string[]
  readonly resolution: string
}

export interface ResearchAuditInput {
  readonly round: number
  readonly criteria: readonly string[]
  readonly claims: readonly ResearchClaimInput[]
  readonly contradictions: readonly ResearchContradictionInput[]
  readonly unresolvedGaps: readonly string[]
}

export interface ResearchAuditSnapshot {
  readonly kind: 'research-evidence-audit'
  readonly auditId: string
  readonly taskId: string
  readonly round: number
  readonly auditedAt: string
  readonly acceptedReceiptIds: readonly string[]
  readonly rejectedReceiptIds: readonly string[]
  readonly uniqueSources: number
  readonly independentDomains: number
  readonly mirroredSources: number
  readonly partialReads: number
  readonly coverageFloorMet: boolean
  readonly claimsTraceable: boolean
  readonly wholePageClaimsSupported: boolean
  readonly hasUnresolvedGaps: boolean
  readonly eligibleForIndependentReview: boolean
  readonly requiresIndependentReview: true
  readonly criteria: readonly string[]
  readonly claims: readonly ResearchClaimInput[]
  readonly contradictions: readonly ResearchContradictionInput[]
  readonly unresolvedGaps: readonly string[]
}

export class ResearchEvidenceLedger {
  private readonly receiptsById = new Map<string, ResearchReadReceipt>()
  private readonly audits: ResearchAuditSnapshot[] = []

  constructor(readonly taskId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u.test(taskId)) {
      throw new TypeError('research task id is invalid')
    }
  }

  record(receipt: ResearchReadReceipt): void {
    if (receipt.taskId !== this.taskId) throw new TypeError('read receipt belongs to another research task')
    if (this.receiptsById.has(receipt.receiptId)) throw new TypeError('read receipt id is duplicated')
    this.receiptsById.set(receipt.receiptId, Object.freeze({ ...receipt }))
  }

  receipt(receiptId: string): ResearchReadReceipt | undefined {
    return this.receiptsById.get(receiptId)
  }

  snapshot(): readonly ResearchReadReceipt[] {
    return Object.freeze([...this.receiptsById.values()])
  }

  audit(input: ResearchAuditInput, now = new Date()): ResearchAuditSnapshot {
    validateAuditInput(input)
    const referenced = unique([
      ...input.claims.flatMap(claim => claim.receiptIds),
      ...input.contradictions.flatMap(item => item.receiptIds),
    ])
    const accepted = referenced.flatMap(id => this.receiptsById.has(id) ? [id] : [])
    const rejected = referenced.filter(id => !this.receiptsById.has(id))
    const receipts = accepted.map(id => this.receiptsById.get(id)!)
    const sources = new Set(receipts.map(receipt => `${receipt.canonicalSource}\u0000${receipt.digest}`))
    const digestDomains = new Map<string, Set<string>>()
    for (const receipt of receipts) {
      const domains = digestDomains.get(receipt.digest) ?? new Set<string>()
      domains.add(receipt.domain)
      digestDomains.set(receipt.digest, domains)
    }
    const independentDomains = new Set(
      [...digestDomains.values()].flatMap(domains => domains.size === 1 ? [...domains] : []),
    ).size
    const mirroredSources = [...digestDomains.values()].reduce(
      (total, domains) => total + Math.max(0, domains.size - 1), 0,
    )
    const claimsTraceable = input.claims.length > 0
      && input.claims.every(claim => claim.receiptIds.length > 0
        && claim.receiptIds.every(id => this.receiptsById.has(id)))
    const wholePageClaimsSupported = input.claims.every(claim => claim.scope !== 'whole-page'
      || claim.receiptIds.every(id => this.receiptsById.get(id)?.status === 'complete'))
    const coverageFloorMet = sources.size >= 6 && independentDomains >= 3
    const hasUnresolvedGaps = input.unresolvedGaps.length > 0
    const snapshot = Object.freeze({
      kind: 'research-evidence-audit' as const,
      auditId: `audit-${crypto.randomUUID()}`, taskId: this.taskId, round: input.round,
      auditedAt: now.toISOString(), acceptedReceiptIds: Object.freeze(accepted),
      rejectedReceiptIds: Object.freeze(rejected), uniqueSources: sources.size,
      independentDomains, mirroredSources,
      partialReads: receipts.filter(receipt => receipt.status === 'partial').length,
      coverageFloorMet, claimsTraceable, wholePageClaimsSupported, hasUnresolvedGaps,
      // Honest unresolved gaps are reviewer input, not a reason to suppress the
      // report. Eligibility means provenance and minimum coverage are sound;
      // only the independent reviewer may decide whether disclosed gaps matter.
      eligibleForIndependentReview: coverageFloorMet && claimsTraceable
        && wholePageClaimsSupported && rejected.length === 0,
      requiresIndependentReview: true as const,
      criteria: Object.freeze([...input.criteria]),
      claims: Object.freeze(input.claims.map(claim => Object.freeze({
        ...claim, receiptIds: Object.freeze([...claim.receiptIds]),
      }))),
      contradictions: Object.freeze(input.contradictions.map(item => Object.freeze({
        ...item, receiptIds: Object.freeze([...item.receiptIds]),
      }))),
      unresolvedGaps: Object.freeze([...input.unresolvedGaps]),
    })
    this.audits.push(snapshot)
    return snapshot
  }

  auditHistory(): readonly ResearchAuditSnapshot[] {
    return Object.freeze([...this.audits])
  }
}

function validateAuditInput(input: ResearchAuditInput): void {
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > 12) invalid()
  validateTextList(input.criteria, 1, 12)
  validateTextList(input.unresolvedGaps, 0, 12)
  if (!Array.isArray(input.claims) || input.claims.length < 1 || input.claims.length > 32) invalid()
  if (!Array.isArray(input.contradictions) || input.contradictions.length > 16) invalid()
  for (const claim of input.claims) {
    validateText(claim.claim)
    validateReceiptIds(claim.receiptIds)
    if (claim.scope !== 'retrieved-content' && claim.scope !== 'whole-page') invalid()
  }
  for (const item of input.contradictions) {
    validateText(item.summary)
    validateText(item.resolution)
    validateReceiptIds(item.receiptIds)
  }
}

function validateReceiptIds(values: readonly string[]): void {
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) invalid()
  if (values.some(value => typeof value !== 'string' || !/^read-[A-Za-z0-9_-]{1,160}$/u.test(value))) invalid()
}

function validateTextList(values: readonly string[], minimum: number, maximum: number): void {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) invalid()
  for (const value of values) validateText(value)
}

function validateText(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2_000) invalid()
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

function invalid(): never { throw new TypeError('research audit input is invalid') }
