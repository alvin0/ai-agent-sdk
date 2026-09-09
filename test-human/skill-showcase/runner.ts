import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { defineAgent } from '@ai-agent-sdk/core/agent'
import type { AgentRunEvent, AgentRunOutcome } from '@ai-agent-sdk/core/agent'
import { fileSystemSkills } from '@ai-agent-sdk/skill-filesystem'
import type { HumanCliConfig, HumanProvider } from '../config.ts'
import { resolveHumanModel } from '../config.ts'
import { createHumanModelRegistry } from '../providers.ts'
import { createAgentCodeToolRegistry } from '../agentcode/tools.ts'
import { prepareSkillStressFixtures } from '../skill-stress/prepare.ts'
import { StressObserver } from '../skill-stress/observer.ts'

const PROJECT_ROOT = resolve(process.cwd())
const HERE = join(PROJECT_ROOT, 'test-human', 'skill-showcase')
const DEFAULT_WORKSPACE_ROOT = join(PROJECT_ROOT, 'test-human', 'workspaces', 'skill-showcase')
const DEFAULT_RESULTS_ROOT = join(PROJECT_ROOT, 'test-human', 'results', 'skill-showcase')
const SKILL_CACHE_ROOT = join(HERE, '.cache')
export const SHOWCASE_SKILL_LOCK = join(HERE, 'skill-sources.lock.json')
export const EXTERNAL_SKILL_ID = 'frontend-design'
const UPSTREAM_BODY_PROBE = 'Spend your boldness in one place.'

const DEFAULT_BRIEF = [
  'Build a polished, working one-page website for Nocturne Rail, a fictional independent',
  'overnight train service between Bangkok and Chiang Mai. Its audience is creative',
  'professionals who want a calm overnight journey. The page has one job: let a visitor',
  'compare three cabin options, choose a departure, and save that preference locally.',
  '',
  'Use only dependency-free HTML, CSS, and JavaScript. Create index.html, styles.css,',
  'app.js, server.mjs, package.json, tests/site.test.mjs, and design-rationale.md. Use available skills',
  'when relevant, but never inspect their folder through workspace file tools. Make the',
  'website responsive and accessible. Run npm test through the command tool, inspect its',
  'result, fix failures, and read back key files before submitting the deep-mode completion',
  'gate. Do not merely describe the website; create it in the workspace.',
].join('\n')

export interface SkillShowcaseOptions {
  readonly runId?: string
  readonly workspace?: string
  readonly workspaceRoot?: string
  readonly resultsRoot?: string
  readonly provider?: HumanProvider
  readonly model?: string
  readonly effort?: string
  readonly maxTurns?: number
  readonly logs?: boolean
  readonly onProgress?: (message: string) => void
  readonly onEvent?: (event: AgentRunEvent) => void
}

export interface SkillShowcaseCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface SkillShowcaseSourceProof {
  readonly id: string
  readonly registry: string
  readonly revision: string
  readonly computedHash: string
  readonly fileCount: number
  readonly cacheReused: boolean
}

export interface SkillShowcaseResult {
  readonly runId: string
  readonly passed: boolean
  readonly workspace: string
  readonly report: string
  readonly artifactFiles: readonly string[]
  readonly toolSequence: readonly string[]
  readonly checks: readonly SkillShowcaseCheck[]
  readonly source: SkillShowcaseSourceProof
  readonly repairTurns: number
  readonly outcome: AgentRunOutcome
}

export async function runSkillShowcase(
  options: SkillShowcaseOptions = {},
): Promise<SkillShowcaseResult> {
  const runId = normalizeRunId(options.runId ?? timestampId())
  const workspace = resolve(options.workspace ?? join(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT, runId))
  const reportDirectory = resolve(options.resultsRoot ?? DEFAULT_RESULTS_ROOT, runId)
  const observer = new StressObserver(reportDirectory, { upstreamBody: UPSTREAM_BODY_PROBE })
  const provider = options.provider ?? 'codex'
  const effort = options.effort ?? 'medium'
  const maxTurns = options.maxTurns ?? 24
  const config: HumanCliConfig = {
    provider,
    ...(options.model === undefined ? {} : { model: options.model }),
    mode: 'deep', scenario: 'chat', effort, maxTurns,
    showReasoning: true, forceTool: false, logs: options.logs ?? true,
    help: false, dryRun: false,
  }
  const model = resolveHumanModel(config, process.env)
  options.onProgress?.(`acquire pinned ${EXTERNAL_SKILL_ID} from skills.sh`)
  const prepared = await prepareSkillStressFixtures({
    projectRoot: PROJECT_ROOT,
    workspaceRoot: SKILL_CACHE_ROOT,
    lockPath: SHOWCASE_SKILL_LOCK,
    onProgress: message => options.onProgress?.(message),
  })
  const preparedSource = prepared.sources.find(item => item.source.id === EXTERNAL_SKILL_ID)
  if (preparedSource === undefined) throw new Error(`prepared corpus is missing ${EXTERNAL_SKILL_ID}`)

  try {
    const agent = defineAgent({
      id: 'external_skill_showcase',
      name: 'External skill website showcase',
      description: 'Builds a real website from a pinned third-party skills.sh capability.',
      provider, model, effort,
      mode: 'deep', maxTurns, maxToolCalls: 80, commentary: 'concise',
      skillIds: [EXTERNAL_SKILL_ID],
      skills: [fileSystemSkills({
        id: 'pinned-skills-sh-corpus',
        roots: [{ path: prepared.skillsRoot, source: 'skills.sh-pinned' }],
        includeProjectAgents: false,
        includeProjectDsh: false,
        includeUserAgents: false,
        onIo: event => observer.recordSkillIo(event),
      })],
      instructions: [
        'You are an autonomous product engineer working inside an isolated showcase workspace.',
        'Activate a listed skill only when the request matches it, then follow its instructions.',
        'Use workspace tools for every read and write. Never read the skill cache with file tools.',
        'Public commentary may explain intent and design decisions but never private chain-of-thought.',
        'Do not claim success until executable tests pass and their result has been observed.',
      ].join(' '),
      memory: {
        autoCaptureObjective: true,
        seed: [{ kind: 'constraint', content: 'All mutations stay inside the assigned showcase workspace.' }],
      },
      compaction: {
        auto: true,
        maxInputTokens: 28_000,
        retainTokens: 12_000,
        maxSummaryTokens: 2_000,
      },
    })
    const registry = createHumanModelRegistry(config, {
      requestLogRoot: join(reportDirectory, 'providers'),
    })
    const session = agent.createSession({
      registry,
      tools: createAgentCodeToolRegistry(workspace),
      skillCwd: workspace,
      hooks: {
        checkpoint(context) {
          if (context.kind === 'before-model-request') observer.recordRequest(context.request)
        },
      },
    })
    const discovered = await session.skills?.discover({ cwd: workspace }) ?? []
    if (discovered.length !== 1 || discovered[0]?.id !== EXTERNAL_SKILL_ID) {
      throw new Error(`expected only ${EXTERNAL_SKILL_ID}; discovered ${discovered.map(item => item.id).join(', ') || 'none'}`)
    }

    const consume = async (input: string): Promise<AgentRunOutcome> => {
      let turnOutcome: AgentRunOutcome | undefined
      for await (const event of session.stream(input)) {
        observer.recordEvent(event)
        options.onEvent?.(event)
        if (event.type === 'agent-end') turnOutcome = event.outcome
      }
      if (turnOutcome === undefined) throw new Error('showcase turn ended without an agent outcome')
      return turnOutcome
    }
    let outcome = await consume(DEFAULT_BRIEF)
    let artifactChecks = await verifyGeneratedWebsite(workspace)
    let repairTurns = 0
    while (repairTurns < 2 && artifactChecks.some(check => !check.passed)) {
      repairTurns++
      const failures = artifactChecks.filter(check => !check.passed)
        .map(check => `- ${check.name}${check.detail === undefined ? '' : `: ${check.detail}`}`)
        .join('\n')
      options.onProgress?.(`host verifier requested repair ${repairTurns}/2`)
      outcome = await consume([
        'The independent host verifier rejected the current artifact:', failures,
        'Continue in the same workspace. Revisit the already-loaded upstream skill instructions,',
        'fix the actual artifacts rather than explaining away the checks, run npm test again,',
        'read back every changed file, and submit the deep completion gate only after it is green.',
      ].join('\n'))
      artifactChecks = await verifyGeneratedWebsite(workspace)
    }

    const artifactFiles = await listArtifactFiles(workspace)
    const checks = [
      ...artifactChecks,
      ...verifySkillCausality(observer, outcome),
    ]
    const toolSequence = observer.toolNames()
    const source: SkillShowcaseSourceProof = Object.freeze({
      id: preparedSource.source.id,
      registry: preparedSource.source.registry,
      revision: preparedSource.source.revision,
      computedHash: preparedSource.computedHash,
      fileCount: preparedSource.fileCount,
      cacheReused: prepared.reused,
    })
    const result: SkillShowcaseResult = Object.freeze({
      runId,
      passed: checks.every(check => check.passed),
      workspace,
      report: join(reportDirectory, 'summary.json'),
      artifactFiles: Object.freeze(artifactFiles),
      toolSequence,
      checks: Object.freeze(checks),
      source,
      repairTurns,
      outcome,
    })
    await observer.flush()
    await writeFile(result.report, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    return result
  } finally {
    await prepared.cleanup()
  }
}

/** Host-owned artifact checks derived from the pinned upstream skill, not model-authored tests. */
export async function verifyGeneratedWebsite(workspace: string): Promise<SkillShowcaseCheck[]> {
  const checks: SkillShowcaseCheck[] = []
  const check = (name: string, passed: boolean, detail?: string): void => {
    checks.push(Object.freeze({ name, passed, ...(detail === undefined ? {} : { detail }) }))
  }
  const required = [
    'index.html', 'styles.css', 'app.js', 'server.mjs', 'package.json',
    'tests/site.test.mjs', 'design-rationale.md',
  ]
  const content = new Map<string, string>()
  for (const path of required) {
    try { content.set(path, await readFile(join(workspace, path), 'utf8')) }
    catch (error: unknown) { check(`artifact exists: ${path}`, false, errorMessage(error)) }
  }
  check('all requested website files exist', content.size === required.length, `${content.size}/${required.length}`)
  const html = content.get('index.html') ?? ''
  const css = content.get('styles.css') ?? ''
  const app = content.get('app.js') ?? ''
  const rationale = content.get('design-rationale.md') ?? ''
  const packageJson = parseJson(content.get('package.json'))

  check('site uses real brief-specific content', /Nocturne Rail/i.test(html)
    && /Bangkok/i.test(html) && /Chiang Mai/i.test(html) && /cabin/i.test(html))
  check('visitor can compare and choose a departure', /<form\b/i.test(html)
    && /<(select|input)\b/i.test(html) && /departure/i.test(html))
  check('preference is implemented with localStorage', /localStorage\.(getItem|setItem)/.test(app)
    && /addEventListener/.test(app))
  check('responsive and keyboard/reduced-motion safeguards exist', /@media/.test(css)
    && /focus-visible/.test(css) && /prefers-reduced-motion/.test(css))
  check('design has an intentional token system', /--[a-zA-Z][\w-]*\s*:/.test(css)
    && new Set(css.match(/#[0-9a-fA-F]{6}\b/g) ?? []).size >= 4)
  check('upstream two-pass design process left evidence', /palette|color/i.test(rationale)
    && /typograph|typeface|font/i.test(rationale)
    && /layout/i.test(rationale)
    && /signature/i.test(rationale)
    && /critique|revis|generic/i.test(rationale))
  const scripts = asRecord(packageJson?.scripts)
  check('generated project exposes an executable npm test', typeof scripts?.test === 'string')
  check('generated project has a dependency-free preview command', typeof scripts?.start === 'string')
  return checks
}

function verifySkillCausality(
  observer: StressObserver,
  outcome: AgentRunOutcome,
): SkillShowcaseCheck[] {
  const events = observer.events()
  const toolNames = observer.toolNames()
  const results = events.filter((event): event is Extract<AgentRunEvent, { type: 'tool-result' }> =>
    event.type === 'tool-result')
  const loadIndex = toolNames.indexOf('load_skill')
  const firstWrite = toolNames.indexOf('write_file')
  const loadResult = results.find(event => event.call.toolName === 'load_skill')
  const npmTestResults = results.filter(event => event.call.toolName === 'run_command')
    .filter(event => !event.result.isError && commandWasGreenTest(event.result.value))
  const requests = observer.requests().filter(request => request.kind === 'model')
  const initial = requests[0]
  const afterLoad = requests.find(request => request.probes.upstreamBody?.messages === true)
  const checks: SkillShowcaseCheck[] = []
  const check = (name: string, passed: boolean, detail?: string): void => {
    checks.push(Object.freeze({ name, passed, ...(detail === undefined ? {} : { detail }) }))
  }
  check('initial request exposes metadata without upstream body', initial?.systemHasCatalog === true
    && initial.probes.upstreamBody?.system === false && initial.probes.upstreamBody?.messages === false)
  check('model activated the pinned external skill', loadIndex >= 0 && loadResult !== undefined
    && !loadResult.result.isError)
  check('upstream body reached model context before implementation', afterLoad !== undefined
    && firstWrite > loadIndex, toolNames.join(' → '))
  check('model ran and observed a green npm test', npmTestResults.length > 0)
  check('all tool results succeeded', results.every(event => !event.result.isError))
  check('trace is complete', observer.traceProblems().length === 0, observer.traceProblems().join('; '))
  check('deep-mode completion gate passed', outcome.mode === 'deep' && outcome.completed)
  return checks
}

function commandWasGreenTest(value: unknown): boolean {
  const result = asRecord(value)
  if (result?.exitCode !== 0 || !Array.isArray(result.args)) return false
  return result.args.some(argument => argument === 'test')
}

async function listArtifactFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const pending = [resolve(root)]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  return files.sort()
}

function parseJson(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  try { return asRecord(JSON.parse(value) as unknown) }
  catch { return undefined }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timestampId(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function normalizeRunId(value: string): string {
  const normalized = value.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(normalized)) {
    throw new TypeError('runId must contain only letters, numbers, dot, underscore, or dash')
  }
  return normalized
}

export function relativeShowcasePath(path: string): string {
  const fromRepo = relative(PROJECT_ROOT, path)
  return fromRepo.startsWith('..') ? path : fromRepo
}
