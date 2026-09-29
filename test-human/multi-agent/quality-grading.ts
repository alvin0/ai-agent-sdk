/** Primary oracle for future cohorts; archived cohorts retain their original grader. */
export function grade(raw: unknown, expected: Record<string, unknown>) {
  const result = (raw !== null && typeof raw === 'object' ? raw : {}) as { text?: string; status?: string }
  let actual: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse((result.text ?? '').trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) actual = parsed as Record<string, unknown>
  } catch { /* invalid output retained */ }
  // JSON encoding preserves element boundaries, empty strings and delimiters.
  const ids = (value: unknown) => Array.isArray(value) && value.every(v => typeof v === 'string') ? JSON.stringify([...value].sort()) : null
  const identity = actual !== undefined && ids(actual.sourceIds) !== null && ids(actual.sourceIds) === ids(expected.sourceIds)
  const numbers = ['totalObserved', 'totalBaseline', 'changePercent'].every(key => expected[key] === null ? actual?.[key] === null : typeof actual?.[key] === 'number' && Number.isFinite(actual[key]) && Math.abs((actual[key] as number) - (expected[key] as number)) < 1e-6)
  const correct = result.status === 'completed' && actual !== undefined && JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(Object.keys(expected).sort()) && actual.status === expected.status && identity && numbers
  return { correct, exactSourceIdentity: identity, falseCompletion: actual?.status === 'completed' && !correct, ...(actual === undefined ? {} : { actual }) }
}
