import type { SkillSummary } from './definition.ts'
import type { CatalogEntry } from './catalog-entries.ts'

/**
 * Preserve activation only when shallow discovery describes the same definition.
 * Providers can put an etag/version in locator or metadata to invalidate an
 * activated body without making discovery hydrate that body again.
 */
export function sameCatalogEntry(previous: CatalogEntry, current: CatalogEntry): boolean {
  if (previous.direct !== undefined || current.direct !== undefined) {
    return previous.direct === current.direct
  }
  if (previous.provider !== current.provider) return false
  if (previous.runtimeProvider !== undefined || current.runtimeProvider !== undefined) {
    return sameRuntimeEntry(previous, current)
  }
  if (!sameSummary(previous.summary, current.summary)) return false
  return sameCandidate(previous.candidate, current.candidate)
}

function sameCandidate(left: CatalogEntry['candidate'], right: CatalogEntry['candidate']): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.path === right.path
    && sameRevisionValue(left.locator, right.locator)
    && sameRevisionValue(left.metadata, right.metadata)
}

function sameRuntimeEntry(previous: CatalogEntry, current: CatalogEntry): boolean {
  if (previous.runtimeProvider !== current.runtimeProvider) return false
  const fields = ['id', 'source', 'provider', 'catalogRevision'] as const
  return fields.every(key => previous.reference?.[key] === current.reference?.[key])
    && sameRevisionValue(previous.reference?.locator, current.reference?.locator)
}

function sameSummary(left: SkillSummary, right: SkillSummary): boolean {
  const fields = ['id', 'name', 'description', 'whenToUse', 'source', 'provider'] as const
  return fields.every(key => left[key] === right[key])
    && sameInvocation(left, right)
    && sameResourceBase(left, right)
}

function sameInvocation(left: SkillSummary, right: SkillSummary): boolean {
  return left.invocation.modelInvocable === right.invocation.modelInvocable
    && left.invocation.userInvocable === right.invocation.userInvocable
}

function sameResourceBase(left: SkillSummary, right: SkillSummary): boolean {
  return left.resourceBase?.kind === right.resourceBase?.kind
    && left.resourceBase?.value === right.resourceBase?.value
}

/** Bounded structural equality for provider-owned JSON-like revision handles. */
interface RevisionComparison {
  readonly pending: [unknown, unknown][]
  readonly seen: WeakMap<object, WeakSet<object>>
  visited: number
}

function sameRevisionValue(left: unknown, right: unknown): boolean {
  const comparison: RevisionComparison = {
    pending: [[left, right]], seen: new WeakMap(), visited: 0,
  }
  try {
    while (comparison.pending.length > 0) {
      const pair = comparison.pending.pop()
      if (pair === undefined) break
      if (!compareRevisionPair(pair, comparison)) return false
    }
    return true
  } catch {
    // A getter/proxy or exotic provider handle is not a stable revision signal.
    return false
  }
}

function compareRevisionPair(pair: [unknown, unknown], comparison: RevisionComparison): boolean {
  const [a, b] = pair
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  if (++comparison.visited > 2_048) return false
  if (alreadyCompared(a, b, comparison.seen)) return true
  return enqueueRevisionChildren(a, b, comparison.pending)
}

function alreadyCompared(a: object, b: object, seen: RevisionComparison['seen']): boolean {
  let matches = seen.get(a)
  if (matches?.has(b) === true) return true
  if (matches === undefined) { matches = new WeakSet<object>(); seen.set(a, matches) }
  matches.add(b)
  return false
}

function enqueueRevisionChildren(a: object, b: object, pending: RevisionComparison['pending']): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index++) pending.push([a[index], b[index]])
    return true
  }
  const aPrototype = Object.getPrototypeOf(a) as unknown
  const bPrototype = Object.getPrototypeOf(b) as unknown
  if (aPrototype !== bPrototype
    || (aPrototype !== Object.prototype && aPrototype !== null)) return false
  return enqueueRecordChildren(a as Record<string, unknown>, b as Record<string, unknown>, pending)
}

function enqueueRecordChildren(
  a: Record<string, unknown>, b: Record<string, unknown>, pending: RevisionComparison['pending'],
): boolean {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) return false
  for (const key of aKeys) pending.push([a[key], b[key]])
  return true
}
