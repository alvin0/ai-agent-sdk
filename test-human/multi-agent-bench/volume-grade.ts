import type { Task } from './tasks.ts'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Exact fields, no aggregate histogram: absence of irrelevant zero summary keys never loses credit. */
export function extractionChecks(task: Task, value: unknown): boolean[] {
  const answer = record(value)
  return Object.entries(task.expected as Record<string, Record<string, unknown>>).flatMap(([file, fields]) =>
    Object.entries(fields).map(([key, expected]) => record(answer[file])[key] === expected))
}

const findingKey = (value: unknown) => {
  const item = record(value)
  return JSON.stringify([item.file, item.symbol, item.rule])
}

/** Fixed 2N checklist: recall plus precision-discounted matched findings (rounded down). */
export function auditChecks(task: Task, value: unknown) {
  const findings = record(value).findings
  const submitted = Array.isArray(findings) ? findings.map(findingKey) : []
  const unique = new Set(submitted), expected = task.auditFindings!.map(findingKey)
  const recallChecks = expected.map(key => unique.has(key))
  const truePositives = recallChecks.filter(Boolean).length
  const precision = submitted.length ? truePositives / submitted.length : 0
  let precisionCredits = Math.floor(truePositives * precision)
  return { checks: [...recallChecks, ...recallChecks.map(matched => matched && precisionCredits-- > 0)],
    precision, recall: truePositives / expected.length }
}
