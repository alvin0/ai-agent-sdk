import type { HumanArtifactInvariant } from '../../artifacts.ts'

const FOUNDRY_PROMPT_NAME = 'microsoft-foundry-agent-service.vi.md'
const REQUIRED_COVERAGE = [
  ['product boundary', ['foundry', 'agent service', 'classic', 'responses api']],
  ['agent forms', ['prompt agent', 'hosted agent']],
  ['tools/protocols', ['toolbox', 'skills', 'mcp', 'a2a']],
  ['orchestration', ['workflow', 'multi agent']],
  ['state/data', ['memory', 'rag', 'knowledge']],
  ['operations', ['observability', 'evaluation']],
  ['security/network', ['identity', 'network', 'private']],
  ['scale/deployment', ['scal', 'deployment', 'version']],
  ['economics/portability', ['cost', 'lock in', 'portabil']],
  ['lifecycle/migration', ['preview', 'retire', 'migration']],
] as const
const MATRIX_CAPABILITIES = [
  'agent service', 'prompt agent', 'hosted agent', 'toolbox', 'skills', 'mcp', 'a2a',
  'workflow', 'memory', 'evaluation', 'agent optimizer', 'observability',
  'private networking',
] as const
const ALLOWED_STATUSES = new Set([
  'ga', 'preview', 'deprecated', 'retiring', 'unknown / insufficient evidence',
])

export function isFoundryBenchmark(promptSource: string): boolean {
  return promptSource.replaceAll('\\', '/').endsWith(`/${FOUNDRY_PROMPT_NAME}`)
}

export function foundryBenchmarkInvariants(report: string): readonly HumanArtifactInvariant[] {
  const headings = report.split(/\r?\n/gu)
    .filter(line => /^#{1,6}\s+/u.test(line))
    .map(normalize)
  const normalized = normalize(report)
  const missingCoverage = REQUIRED_COVERAGE.filter(([, terms]) => (
    !terms.every(term => normalized.includes(term))
  )).map(([group]) => group)
  const matrix = matrixStatusMap(report)
  const missingMatrixRows = MATRIX_CAPABILITIES.filter(capability => !matrix.has(capability))
  const invalidStatuses = [...matrix].filter(([, status]) => !ALLOWED_STATUSES.has(status))
    .map(([capability, status]) => `${capability}=${status || '<empty>'}`)
  const hasDecisionDistinction = (
    normalized.includes('technically possible') || /kha thi.{0,40}ky thuat/u.test(normalized)
  ) && (
    normalized.includes('recommended for production') || /khuyen nghi.{0,40}production/u.test(normalized)
  )
  const hasArchitectures = (
    normalized.includes('prompt agent') || normalized.includes('fully managed')
  ) && normalized.includes('hosted agent') && (
    normalized.includes('self-hosted') || normalized.includes('external runtime')
      || normalized.includes('runtime ben ngoai')
  )
  const traceHeading = headings.some(heading => heading.includes('research trace summary'))
  const trace = normalized.slice(Math.max(0, normalized.lastIndexOf('research trace summary')))
  const traceFields = ['query', 'nguon', 'primary', 'contradiction', 'chua the xac minh']
  const missingTraceFields = traceFields.filter(field => !trace.includes(field))

  return Object.freeze([
    {
      name: 'Foundry benchmark covers the required architecture research breadth',
      passed: missingCoverage.length === 0,
      detail: missingCoverage.length === 0
        ? `${REQUIRED_COVERAGE.length}/${REQUIRED_COVERAGE.length} groups`
        : `missing: ${missingCoverage.join(', ')}`,
    },
    {
      name: 'Foundry evidence matrix covers every capability with an allowed status',
      passed: missingMatrixRows.length === 0 && invalidStatuses.length === 0,
      detail: [
        missingMatrixRows.length === 0 ? undefined : `missing: ${missingMatrixRows.join(', ')}`,
        invalidStatuses.length === 0 ? undefined : `invalid: ${invalidStatuses.join(', ')}`,
      ].filter(Boolean).join('; ') || `${MATRIX_CAPABILITIES.length}/${MATRIX_CAPABILITIES.length} rows`,
    },
    {
      name: 'Foundry recommendation distinguishes feasibility, production, and A/B/C',
      passed: hasDecisionDistinction && hasArchitectures,
      detail: `decision=${String(hasDecisionDistinction)}, architectures=${String(hasArchitectures)}`,
    },
    {
      name: 'Foundry report includes the requested verifiable research trace',
      passed: traceHeading && missingTraceFields.length === 0,
      detail: missingTraceFields.length === 0 ? 'trace fields present' : `missing: ${missingTraceFields.join(', ')}`,
    },
  ])
}

function matrixStatusMap(report: string): ReadonlyMap<string, string> {
  const rows = new Map<string, string>()
  let insideEvidenceMatrix = false
  for (const line of report.split(/\r?\n/gu)) {
    if (!line.trimStart().startsWith('|')) {
      if (insideEvidenceMatrix && line.trim().length > 0) break
      continue
    }
    const cells = line.split('|').slice(1, -1).map(cell => normalize(cell.replace(/[*`_]/gu, '')))
    if (cells.length < 2) continue
    if (!insideEvidenceMatrix) {
      insideEvidenceMatrix = cells[0] === 'capability' && cells[1] === 'status'
        && cells.includes('evidence') && cells.includes('updated')
      continue
    }
    if (cells.every(cell => /^:?-{3,}:?$/u.test(cell))) continue
    const capability = MATRIX_CAPABILITIES.find(candidate => cells[0] === candidate)
    if (capability !== undefined) rows.set(capability, cells[1] ?? '')
  }
  return rows
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[-\u2013\u2014]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
}
