/** Reading workloads: source corpora only go to the model; expectations stay with the host. */
import type { Task } from './tasks.ts'
import { auditFile, migrationFile, migrationEdits } from './volume-code.ts'

const pick = <T>(random: () => number, values: T[]): T => values[Math.floor(random() * values.length)]!
const services = ['checkout', 'identity', 'search', 'ledger', 'notifications', 'catalog']
const teams = ['commerce', 'trust', 'discovery', 'finance', 'messaging', 'platform']
const causes = ['configuration', 'dependency', 'capacity', 'deployment']
const causalFacts: Record<string, string[]> = {
  configuration: ['an incorrect runtime setting selected the wrong region',
    'a stale feature toggle routed traffic to a retired endpoint'],
  dependency: ['the upstream provider rejected otherwise healthy calls',
    'the external gateway was unavailable despite healthy local workers'],
  capacity: ['the worker pool exhausted its available execution slots',
    'the queue reached its hard resource limit under normal traffic'],
  deployment: ['the newly released binary corrupted its request routing table',
    'the release introduced an incompatible parser into the serving binary'],
}

function timeline(random: () => number, incident: number): string {
  return Array.from({ length: 20 }, (_, entry) => {
    const service = pick(random, services), team = pick(random, teams)
    const observation = pick(random, ['queue depth', 'retry rate', 'connection age', 'cache residency'])
    return `### Observation ${entry + 1}: ${service}, checkpoint ${incident * 31 + entry}\n`
      + `The ${team} observer reviewed ${observation} in the staging and production comparison. `
      + `The staging exercise mentioned ${pick(random, causes)}, but that exercise belongs to the previous `
      + `release and is not a finding for this incident. The observer retained the original event order, `
      + `checked the control cohort, and compared the retry window with the preceding deployment. `
      + `A neighboring ${pick(random, services)} dashboard showed a short alert during the same window. `
      + `That alert was traced to a synthetic probe rather than a separate service outage. `
      + `This checkpoint records an investigative lead, not an approved cause or ownership transfer. `
      + `Ticket DRAFT-${incident * 100 + entry} tracks the discarded hypothesis only.\n`
  }).join('\n')
}

function incident(random: () => number, index: number) {
  let category = pick(random, causes), service = pick(random, services), team = pick(random, teams)
  const impact = random() > 0.4, loss = impact && random() > 0.75, workaround = random() > 0.5
  let ticket = `FIX-${10000 + Math.floor(random() * 80000)}`
  const notes = timeline(random, index).split('\n\n')
  const cause = pick(random, causalFacts[category]!)
  notes.splice(3, 0, pick(random, [
    `Final causal review: ${cause}; all earlier theories were rejected.`,
    `At closure the board confirmed that ${cause}, superseding the preliminary diagnosis.`,
  ]))
  notes.splice(9, 0, `The production failure boundary was ${service}. Other named services were comparison cohorts.`)
  notes.splice(14, 0, impact ? 'Real customer requests failed during the window.'
    : 'Only synthetic requests failed; no real customer experienced an error.')
  notes.splice(17, 0, loss ? 'The integrity review confirmed permanent loss of customer records.'
    : 'The integrity review confirmed that no customer records were permanently lost.')
  notes.splice(20, 0, workaround ? 'An effective customer workaround was available throughout the incident.'
    : 'No effective customer workaround existed during the incident.')
  notes.push(`Accepted action register: ${ticket} is the sole approved follow-up. The accountable team is ${team}. `
    + `The earlier DRAFT tickets are closed without action. Related report incident-${(index + 7) % 72} `
    + 'shares the probe infrastructure only; do not inherit its cause, severity, or owner.')
  category = causes[(causes.indexOf(category) + 1) % causes.length]!
  service = services[(services.indexOf(service) + 1) % services.length]!
  team = teams[(teams.indexOf(team) + 1) % teams.length]!
  ticket = `FIX-${100000 + index}`
  notes.push('## Correction notice: approved after closure\n'
    + `This notice supersedes the earlier causal review, production boundary and action register. `
    + `The corrected causal review confirmed ${pick(random, causalFacts[category]!)}. `
    + `The corrected production failure boundary was ${service}. `
    + `The accountable team is ${team}; ${ticket} is the sole approved follow-up.`)
  const corrected = correctSeverity(notes, index, { impact, loss, workaround })
  return { text: `# Incident ${index}\n\n${notes.join('\n\n')}\n`,
    answer: { rootCause: category, service, customerImpact: corrected.impact, owningTeam: team, ticket,
      severity: corrected.severity } }
}

function correctSeverity(notes: string[], index: number,
  facts: { impact: boolean; loss: boolean; workaround: boolean }) {
  let { impact, loss, workaround } = facts
  if (index % 2 === 0) {
    impact = !impact
    notes.push('## Correction notice: customer evidence\n'
      + (impact ? 'Real customer requests failed during the window.'
        : 'Only synthetic requests failed; no real customer experienced an error.'))
  }
  if (index % 3 === 0) {
    loss = impact && !loss
    notes.push('## Correction notice: integrity evidence\n'
      + (loss ? 'The integrity review confirmed permanent loss of customer records.'
        : 'The integrity review confirmed that no customer records were permanently lost.'))
  }
  if (index % 4 === 0) {
    workaround = !workaround
    notes.push('## Correction notice: mitigation evidence\n'
      + (workaround ? 'An effective customer workaround was available throughout the incident.'
        : 'No effective customer workaround existed during the incident.'))
  }
  return { impact, severity: incidentSeverity(impact, loss, workaround) }
}

function incidentSeverity(impact: boolean, loss: boolean, workaround: boolean) {
  if (loss) return 'SEV1'
  return impact && !workaround ? 'SEV2' : 'SEV3'
}

export function incidentExtraction(random: () => number): Task {
  const files: Record<string, string> = {}, expected: Record<string, unknown> = {}
  for (let index = 0; index < 72; index++) {
    const path = `reports/incident-${String(index).padStart(2, '0')}.md`, report = incident(random, index)
    files[path] = report.text; expected[path] = report.answer
  }
  files['SPEC.md'] = 'Read every reports/*.md fully. Preliminary observations and DRAFT tickets are distractors. '
    + 'The closure review and accepted action register override earlier hypotheses. Cross-references do not '
    + 'transfer facts. Later correction notices supersede earlier facts for the fields they address; '
    + 'retain uncorrected fields. Severity inputs are spread across sections: use the latest customer, '
    + 'integrity and mitigation evidence independently. Write answer.json keyed by full relative filename, '
    + 'each value containing rootCause '
    + '(configuration|dependency|capacity|deployment), service, customerImpact (boolean), owningTeam, ticket, '
    + 'severity. Classify incorrect runtime settings or stale toggles as configuration; external upstream '
    + 'failures as dependency; exhausted pools or resource limits as capacity; defects in a newly released '
    + 'binary as deployment. Infer severity: SEV1 if permanent customer record loss; otherwise SEV2 if real customers '
    + 'experienced errors AND no effective workaround; otherwise SEV3. Grade each of six fields independently. '
    + 'No numeric aggregates or code execution are needed. Extra zero-valued summary keys are ignored.'
  return { id: 'extraction', kind: 'volume', category: '72 incident comprehension reports', files, expected,
    checks: [], prompt: 'Read SPEC.md and all 72 reports/*.md completely. Extract the six requested fields '
      + 'per report into answer.json. Resolve later correction notices, preliminary theories, cross-references, '
      + 'and inferred '
      + 'severity using SPEC.md. Each field earns independent credit.' }
}

export function moduleAudit(random: () => number): Task {
  const files: Record<string, string> = {}, auditFindings: NonNullable<Task['auditFindings']> = []
  for (let module = 0; module < 6; module++) for (let file = 0; file < 10; file++) {
    const path = `modules/module-${module}/flow-${file}.cjs`
    const generated = auditFile(random, path)
    files[path] = generated.text; auditFindings.push(...generated.findings)
  }
  files['POLICY.md'] = 'Audit every exported operation in all six modules (ten files each). '
    + 'Three rules apply to actual API calls, not historical examples in comments: '
    + 'external-consent: api.publish with audience external requires consent === true. '
    + 'write-key: api.retry with mode write requires a nonempty idempotencyKey. '
    + 'legal-hold: api.remove with retention hold requires archiveOnly === true. '
    + 'Internal publish, read retries, and released retention are exempt. Report every violating call as '
    + '{file,symbol,rule} in findings.json {findings:[...]}; symbol is the enclosing exported operation. '
    + 'Do not modify sources. Duplicate and invented findings reduce precision. Each real finding has '
    + 'one recall check and one precision-adjusted check; see coverage and precision separately in results.'
  return { id: 'multi-module-audit', kind: 'volume', category: 'six independent module audits', checks: [],
    files, auditFindings, prompt: 'Audit all 60 modules/**/*.cjs files against POLICY.md. Read the operation '
      + 'contracts and actual calls. Write findings.json {findings:[{file,symbol,rule}]} for every violation. '
      + 'Preserve source. Findings earn partial credit; false positives and duplicates reduce precision.' }
}

export function migration(random: () => number): Task {
  const files: Record<string, string> = {}, repairs: Record<string, string> = {}
  const moduleChecks: Record<string, string[]> = {}
  for (let pkg = 0; pkg < 5; pkg++) {
    const checks: string[] = []
    for (let file = 0; file < 8; file++) {
      const path = `packages/pkg-${pkg}/handler-${file}.cjs`, generated = migrationFile(random, path)
      files[path] = generated.before; repairs[path] = generated.after; checks.push(...generated.checks)
    }
    moduleChecks[`pkg-${pkg}`] = checks
  }
  files['SPEC.md'] = 'Migrate every operation in all 40 packages/**/*.cjs files. Only edit source files. '
    + 'Replace client.send(route,payload,options) with client.request({route,body:payload,...}). '
    + 'options.timeout is seconds; request timeoutMs is milliseconds. Writes use retry: "idempotent" '
    + 'only with a nonempty stable key; writes without a key use retry: "never". Reads use retry: "safe". '
    + 'Preserve a nonempty key as idempotencyKey; omit that property for an empty key. '
    + 'Return response.body for contracts returning the body; return response.status for status contracts. '
    + 'Preserve route, payload transformation, export names and caller inputs. Each operation has its own '
    + 'contract in its preceding comment. No imports. shell test [pkg-0..pkg-4] runs hidden behavioral checks '
    + 'against a request-only fake client, including multiple inputs. Each check earns partial credit.'
  const editBytes = Buffer.byteLength(JSON.stringify(Object.entries(repairs).map(([path, after]) =>
    ({ path, edits: migrationEdits(files[path]!, after) }))))
  return { outputBudget: { estimatedTokens: Math.ceil(editBytes / 3), tokensPerSecond: 80, maxTimeFraction: 0.3,
    estimate: 'UTF-8 edit arguments / 3 bytes per token; planning estimate, not measured provider throughput' },
    id: 'migration' , kind: 'volume', category: '40-file five-package API migration', files, repairs,
    moduleChecks, checks: Object.values(moduleChecks).flat(),
    prompt: 'Migrate all 40 source files across five packages from client.send to client.request, following '
      + 'SPEC.md and every operation contract. Use edit_file to batch exact replacements per file. '
      + 'Preserve behavior and choose retries by read/write and stable '
      + 'key rules. Verify using shell test <package> and shell test. Every hidden check earns partial credit.' }
}
