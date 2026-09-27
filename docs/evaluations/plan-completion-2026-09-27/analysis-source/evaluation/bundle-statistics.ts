import type { BundleRecord } from './bundle-integrity.ts'

export interface ReviewScore {
  readonly variantId: string
  readonly repeat: number
  readonly arm: string
  readonly passed: boolean
}
export const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
export const quantile = (values: readonly number[], q: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]! : null
}
export function reportedTokens(row: BundleRecord): number {
  type Usage = { reported?: { totalTokens?: number }; authoritative?: boolean }
  const usages = [...(row.history as { usage?: Usage }[] ?? []).map(turn => turn.usage), row.usage as Usage | undefined]
  return usages.reduce((sum, usage) => sum + (usage?.reported?.totalTokens ?? 0), 0)
}
function usageTotals(list: readonly BundleRecord[]) {
  const result = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, logicalModelCalls: 0, attempts: 0, possiblyBilledAttemptsWithoutUsage: 0 }
  for (const row of list) {
    type Usage = { reported?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; totalTokens?: number }; coverage?: { logicalCalls?: number; attempts?: number; possiblyBilledAttemptsWithoutUsage?: number } }
    const usages = [...(row.history as { usage?: Usage }[] ?? []).map(turn => turn.usage), row.usage as Usage | undefined]
    for (const usage of usages) {
      result.inputTokens += usage?.reported?.inputTokens ?? 0
      result.outputTokens += usage?.reported?.outputTokens ?? 0
      result.cacheReadTokens += usage?.reported?.cacheReadTokens ?? 0
      result.cacheWriteTokens += usage?.reported?.cacheWriteTokens ?? 0
      result.reasoningTokens += usage?.reported?.reasoningTokens ?? 0
      result.totalTokens += usage?.reported?.totalTokens ?? 0
      result.logicalModelCalls += usage?.coverage?.logicalCalls ?? 0
      result.attempts += usage?.coverage?.attempts ?? 0
      result.possiblyBilledAttemptsWithoutUsage += usage?.coverage?.possiblyBilledAttemptsWithoutUsage ?? 0
    }
  }
  return result
}
function checkSummary(list: readonly BundleRecord[]) {
  const checks: Record<string, { passed: number; failed: number }> = {}
  for (const row of list) for (const check of (row.grade as { checks?: { name: string; passed: boolean }[] } | undefined)?.checks ?? []) {
    const count = checks[check.name] ??= { passed: 0, failed: 0 }
    count[check.passed ? 'passed' : 'failed']++
  }
  const citations = Object.fromEntries(Object.entries(checks).filter(([name]) => /^semantic field:(source|sourceIds|nguon|trichDan)$/.test(name) || name.includes('source quote')))
  const factualFields = Object.fromEntries(Object.entries(checks).filter(([name]) => name.startsWith('semantic field:') && !Object.hasOwn(citations, name)))
  return { allChecks: checks, factualFieldChecks: factualFields, citationFieldChecks: citations,
    note: 'Separate check counts, not additional task passes; missing citations do not erase correct abstention facts. Semantic prose uses independent review.' }
}
const key = (row: Pick<BundleRecord, 'variantId' | 'repeat' | 'arm'>) => JSON.stringify([row.variantId, row.repeat, row.arm])

/** Languages and repetitions are clustered inside families before domain averaging. */
export function bundleStatistics(rows: readonly BundleRecord[], reviews: readonly ReviewScore[] = []) {
  const reviewByKey = new Map(reviews.map(review => [key(review), review]))
  const supported = rows.filter(row => row.comparison === 'common' && row.status !== 'unsupported')
  const pending = supported.filter(row => row.status === 'needs-review' && !reviewByKey.has(key(row)))
  const pass = (row: BundleRecord) => row.status === 'passed' || row.status === 'needs-review' && reviewByKey.get(key(row))?.passed === true
  const rate = (list: readonly BundleRecord[]) => list.length ? list.filter(pass).length / list.length : null
  const families = [...new Set(supported.map(row => row.familyId))].sort()
  const domains = [...new Set(supported.map(row => row.domain))].sort()
  const arms = [...new Set(supported.map(row => row.arm))].sort()
  const macro = (arm: string, sample: readonly string[]) => {
    const perDomain = domains.map(domain => {
      const familyRates = sample.filter(id => id.startsWith(`${domain}-`)).map(id => rate(supported.filter(row => row.familyId === id && row.arm === arm))).filter((value): value is number => value !== null)
      return familyRates.length ? familyRates.reduce((a, b) => a + b, 0) / familyRates.length : null
    }).filter((value): value is number => value !== null)
    return perDomain.length ? perDomain.reduce((a, b) => a + b, 0) / perDomain.length : null
  }
  const perArm = Object.fromEntries(arms.map(arm => {
    const list = supported.filter(row => row.arm === arm)
    return [arm, { attempts: list.length, passed: list.filter(pass).length, passRate: rate(list), macro: macro(arm, families),
      statuses: list.reduce<Record<string, number>>((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts }, {}),
      totalTokens: list.reduce((sum, row) => sum + reportedTokens(row), 0), usageTotals: usageTotals(list), medianTokens: median(list.map(reportedTokens)),
      gradingBreakdown: checkSummary(list),
      latencyMs: { p50: median(list.map(row => Number(row.elapsedMs ?? 0))), p95: quantile(list.map(row => Number(row.elapsedMs ?? 0)), .95) },
      effects: list.reduce((sum, row) => sum + Number(row.effects ?? 0), 0),
      privateLeaks: list.filter(row => row.privateDataLeaked === true).length,
      privacyUnobservedAttempts: list.filter(row => typeof row.privateDataLeaked !== 'boolean').length,
      effectUnobservedAttempts: list.filter(row => typeof row.effects !== 'number').length,
      auditSnapshotAndEventBytes: { p50: median(list.filter(row => typeof row.modelVisibleBytes === 'number').map(row => Number(row.modelVisibleBytes))), p95: quantile(list.filter(row => typeof row.modelVisibleBytes === 'number').map(row => Number(row.modelVisibleBytes)), .95),
        note: 'The legacy raw modelVisibleBytes field includes canonical history and host events, including hidden children; it is not the actual model request size.' },
      blockedMutationRequests: list.reduce((sum, row) => sum + (row.calls as { denied?: boolean }[] ?? []).filter(call => call.denied === true).length, 0),
      rootOuterAndChildDispatches: list.reduce((sum, row) => sum + Number((row.rootToolCalls as { total?: number } | undefined)?.total ?? 0), 0),
      hostReadBodies: list.reduce((sum, row) => sum + (row.calls as { denied?: boolean; tool?: string }[] ?? []).filter(call => !call.denied && call.tool !== 'perform_operation').length, 0),
      runtimeErrors: list.filter(row => row.status.startsWith('runtime-')).length,
      usageAuthoritative: list.every(row => (row.usage as { authoritative?: boolean } | undefined)?.authoritative === true && (row.history as { usage?: { authoritative?: boolean } }[] ?? []).every(turn => turn.usage?.authoritative === true)),
    }]
  }))
  const changes = families.map(id => {
    const base = rate(supported.filter(row => row.familyId === id && row.arm === 'BASE'))
    const candidate = rate(supported.filter(row => row.familyId === id && row.arm === 'CANDIDATE'))
    return { id, BASE: base, CANDIDATE: candidate, delta: base === null || candidate === null ? null : candidate - base }
  })
  let state = 260927
  const random = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296 }
  const draws: number[] = []
  const familyUncertaintyEstimable = domains.length > 0 && domains.every(domain => families.filter(id => id.startsWith(`${domain}-`)).length >= 2)
  if (familyUncertaintyEstimable && arms.includes('BASE') && arms.includes('CANDIDATE')) for (let index = 0; index < 4000; index++) {
    const sample = domains.flatMap(domain => {
      const group = families.filter(id => id.startsWith(`${domain}-`))
      return group.map(() => group[Math.floor(random() * group.length)]!)
    })
    draws.push(macro('CANDIDATE', sample)! - macro('BASE', sample)!)
  }
  const completePairs = new Map<string, BundleRecord[]>()
  for (const row of supported) { const pair = completePairs.get(row.pairId) ?? []; pair.push(row); completePairs.set(row.pairId, pair) }
  const pairedSuccess = [...completePairs.values()].filter(pair => pair.length === 2 && pair.every(pass)).flat()
  const efficiency = Object.fromEntries(['BASE', 'CANDIDATE'].map(arm => {
    const list = pairedSuccess.filter(row => row.arm === arm)
    return [arm, { attempts: list.length, medianTokens: median(list.map(reportedTokens)), totalTokens: list.reduce((sum, row) => sum + reportedTokens(row), 0), latencyMs: { p50: median(list.map(row => Number(row.elapsedMs ?? 0))), p95: quantile(list.map(row => Number(row.elapsedMs ?? 0)), .95) } }]
  }))
  const lower = quantile(draws, .025), upper = quantile(draws, .975)
  return { families: families.length, domains: domains.length, perArm,
    usageDefinition: 'inputTokens are uncached; cacheReadTokens/cacheWriteTokens are separate; reasoningTokens are a subset of outputTokens. Use reported totalTokens without summing reasoning again.',
    modelAndGuestByteEfficiency: 'not measured by this neutral worker; do not use auditSnapshotAndEventBytes as model or guest byte savings',
    applicability: { commonAttempts: supported.length, featureUnsupportedRecords: rows.filter(row => row.status === 'unsupported').length },
    semanticReview: { pending: pending.map(row => ({ variantId: row.variantId, arm: row.arm, repeat: row.repeat })), scores: reviews.length },
    macroDifference: { point: macro('CANDIDATE', families) === null || macro('BASE', families) === null ? null : macro('CANDIDATE', families)! - macro('BASE', families)!, ci95: [lower, upper], familyUncertaintyEstimable,
      method: familyUncertaintyEstimable ? '4000 stratified paired family bootstrap draws; languages and repeats clustered; seed 260927' : 'Not estimated: fewer than two independent families in at least one domain; pilot and small ablation are descriptive' },
    perDomain: domains.map(domain => ({ domain, ...Object.fromEntries(arms.map(arm => [arm, rate(supported.filter(row => row.domain === domain && row.arm === arm))])) })),
    perLanguage: ['en', 'vi'].map(language => ({ language, families: new Set(supported.filter(row => row.language === language).map(row => row.familyId)).size, ...Object.fromEntries(arms.map(arm => [arm, rate(supported.filter(row => row.language === language && row.arm === arm))])) })),
    familyChanges: changes, newLosses: changes.filter(change => change.delta !== null && change.delta < 0),
    rawNewLosses: [...completePairs.values()].filter(pair => pair.some(row => row.arm === 'BASE' && pass(row)) && pair.some(row => row.arm === 'CANDIDATE' && !pass(row))).map(pair => pair[0]!.pairId),
    pairedSuccessEfficiency: { pairs: pairedSuccess.length / 2, arms: efficiency },
    gates: { allProseReviewed: pending.length === 0, qualityNonInferiorAtMargin5pp: pending.length === 0 && lower !== null && lower > -.05,
      newLossReviewRequired: [...completePairs.values()].some(pair => pair.some(row => row.arm === 'BASE' && pass(row)) && pair.some(row => row.arm === 'CANDIDATE' && !pass(row))),
      zeroObservedEffectsOrPrivateLeaks: supported.every(row => Number(row.effects ?? 0) === 0 && row.privateDataLeaked !== true),
      currencyCost: 'inconclusive: no tariff; tokens are descriptive', generalization: 'limited to this exposed synthetic cohort and evaluated models; no population guarantee' },
  }
}
