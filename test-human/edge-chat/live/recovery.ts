export interface AcceptanceInvariant {
  readonly name?: unknown
  readonly passed?: unknown
}

export interface AcceptanceSummary {
  readonly status?: unknown
  readonly invariants?: unknown
}

const NATIVE_SEARCH_INVARIANT = 'Agent performs at least three provider-native searches'
const RESEARCH_INVARIANTS = new Set([
  NATIVE_SEARCH_INVARIANT,
  'Host records at least six successful page reads',
  'Read evidence crosses at least three independent domains',
  'Agent submits provenance audit after reading',
  'Final audit passes integrity/coverage floors but remains reviewer-gated',
  'Final Markdown report is substantial and cites read sources',
])
const FOUNDATIONAL_INVARIANTS = new Set([
  'Authenticated provider runs inside strict workerd',
  'Test-only relay performs bounded real upstream transport',
  'SSE has one support-safe terminal event',
  'Browser displays live agent/tool process',
  'Browser coalesces streamed commentary into readable progress rows',
  'Browser keeps the completed Markdown report in the message viewport',
  'Every model call reports authoritative usage',
  'Credential never appears in SSE or artifacts',
  'Runtime closes without unsettled work',
  'Browser emits no console/page error',
])

export type ResearchFallbackReason =
  | 'provider-native-search-acceptance-missing'
  | 'research-acceptance-incomplete'

export function researchFallbackReason(
  summary: AcceptanceSummary,
): ResearchFallbackReason | undefined {
  if (summary.status === 'passed' || !Array.isArray(summary.invariants)) return undefined
  const invariants = summary.invariants.filter(
    (candidate): candidate is AcceptanceInvariant => candidate !== null && typeof candidate === 'object',
  )
  if (invariants.some(invariant => FOUNDATIONAL_INVARIANTS.has(String(invariant.name))
    && invariant.passed !== true)) return undefined
  const failedResearch = invariants.filter(invariant => RESEARCH_INVARIANTS.has(String(invariant.name))
    && invariant.passed === false)
  if (failedResearch.length === 0) return undefined
  return failedResearch.some(invariant => invariant.name === NATIVE_SEARCH_INVARIANT)
    ? 'provider-native-search-acceptance-missing'
    : 'research-acceptance-incomplete'
}

export function fallbackRunId(runId: string, model: string): string {
  const suffix = model.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `${runId}-fallback-${suffix || 'model'}`.slice(0, 128)
}

export function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.lastIndexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

export function setOption(args: readonly string[], name: string, value: string): readonly string[] {
  const output: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) { index++; continue }
    output.push(args[index]!)
  }
  output.push(name, value)
  return output
}
