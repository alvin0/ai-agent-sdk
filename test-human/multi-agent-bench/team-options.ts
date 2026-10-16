/** JSON knobs are intentionally not validated against one SDK revision's option names. */
export type TeamOptions = Record<string, unknown>

export function parseTeamOptions(json: string): TeamOptions {
  const value: unknown = JSON.parse(json)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--team-options must be a JSON object')
  }
  return value as TeamOptions
}

export function effectiveTeamOptions(timeoutMs: number, options: TeamOptions = {}): TeamOptions {
  return { maxWorkers: 4, workerTimeoutMs: timeoutMs, workerTeamTools: 'full', ...options }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

export function validateResumeTeamOptions(saved: TeamOptions, requested?: TeamOptions) {
  if (requested !== undefined && JSON.stringify(canonical(saved)) !== JSON.stringify(canonical(requested))) {
    throw new Error('--team-options differs from the saved manifest; resume cannot override team options')
  }
}
