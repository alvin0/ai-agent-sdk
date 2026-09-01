#!/usr/bin/env node
/** Automated real-provider, multi-skill AgentCode release acceptance run. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface, type Interface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AgentSession } from '../../../src/agent/define/index.ts'
import {
  createUserInputBroker,
  type AgentRunEvent,
  type AgentRunOutcome,
  type InteractiveUserInputBroker,
} from '../../../src/agent/mode/index.ts'
import { errorMessage, label } from '../../console.ts'
import { createHumanModelRegistry } from '../../providers.ts'
import { prepareSkillStressFixtures, type PreparedSkillStressFixtures } from '../../skill-stress/prepare.ts'
import { renderHumanRun } from '../../terminal.ts'
import { createAgentCodeAgent } from '../agent.ts'
import {
  agentCodeCliHelp,
  parseAgentCodeCliArgs,
  resolveAgentCodeModel,
  type AgentCodeCliConfig,
} from '../config.ts'
import {
  AgentCodeSkillReportRecorder,
  isAgentCodeSkillEvidenceComplete,
  withAgentCodeSkillReportHooks,
  type AgentCodeSkillReport,
} from '../skill-report.ts'
import { createAgentCodeToolRegistry } from '../tools.ts'
import { prepareSignalDeskWorkspace, type SignalDeskPreparationReport } from './prepare.ts'
import {
  SIGNAL_DESK_PROMPT,
  SIGNAL_DESK_REQUIRED_SKILLS,
  SIGNAL_DESK_REVIEW_PROMPT,
} from './prompt.ts'
import { seedSignalDeskWorkspace, type SeedSignalDeskWorkspaceResult } from './seed.ts'
import {
  formatSignalDeskVerificationSummary,
  runSignalDeskCommand,
  verifySignalDeskWorkspace,
  type SignalDeskCommandRequest,
  type SignalDeskCommandResult,
  type SignalDeskVerificationReport,
} from './verify.ts'

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(MODULE_DIRECTORY, '..', '..', '..')
const DEFAULT_WORKSPACE = join(PROJECT_ROOT, 'test-human', 'workspaces', 'agentcode-multiskill')
const DEFAULT_REPORT_DIRECTORY = join(PROJECT_ROOT, 'test-human', 'results', 'agentcode-multiskill')
const DEFAULT_SKILLS_ROOT = join(PROJECT_ROOT, 'test-human', 'skill-stress', '.cache', 'skills')
const DEFAULT_REPAIR_TURNS = 1
const COMMAND_TIMEOUT_MS = 120_000
const MAX_COMMAND_OUTPUT_CHARS = 64_000
const MAX_REPORT_STRING_CHARS = 64_000
const MAX_REPORT_ARRAY_ITEMS = 2_000
const MAX_REPORT_OBJECT_KEYS = 500
const MAX_REPORT_DEPTH = 12
const AGENT_VALUE_FLAGS = new Set([
  '--provider', '--model', '--mode', '--scenario', '--effort', '--max-turns',
  '--prompt', '--image', '--workdir', '--skills-root', '--max-input-tokens',
  '--retain-tokens', '--max-tool-calls',
])

export interface MultiSkillCliConfig {
  readonly agent: AgentCodeCliConfig
  readonly model: string
  readonly reportDirectory: string
  readonly repairTurns: number
}

export interface MultiSkillAcceptance {
  readonly baselineRed: boolean
  readonly functionalVerifier: boolean
  readonly expectedSkillsBehaviorallyApplied: boolean
  readonly skillEvidenceComplete: boolean
  readonly traceComplete: boolean
  readonly deepOutcomeCompleted: boolean
  readonly compactionCompleted: boolean
}

export interface MultiSkillRunSummary {
  readonly schemaVersion: 1
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly passed: boolean
  readonly config: {
    readonly provider: string
    readonly model: string
    readonly effort: string
    readonly maxTurns: number
    readonly maxToolCalls: number
    readonly maxInputTokens: number
    readonly retainTokens: number
    readonly workspace: string
    readonly reportDirectory: string
    readonly providerLogs: string | null
    readonly repairTurns: number
  }
  readonly requiredSkills: readonly string[]
  readonly discoveredSkills: readonly string[]
  readonly skillsCache?: {
    readonly root: string
    readonly reused: boolean
    readonly sources: readonly string[]
  }
  readonly preparation?: {
    readonly passed: boolean
    readonly dependenciesReady: boolean
    readonly browserReady: boolean
    readonly report: string
  }
  readonly baseline?: {
    readonly red: boolean
    readonly exitCode: number | null
    readonly timedOut: boolean
    readonly aborted: boolean
    readonly report: string
  }
  readonly runs: readonly MultiSkillTurnSummary[]
  readonly verifications: readonly {
    readonly attempt: number
    readonly passed: boolean
    readonly failedChecks: readonly string[]
    readonly commands: Readonly<Record<string, number | null>>
    readonly report: string
  }[]
  readonly acceptance: MultiSkillAcceptance
  readonly skillReport: string
  readonly errors: readonly string[]
}

export interface MultiSkillTurnSummary {
  readonly label: string
  readonly completed: boolean
  readonly reason?: string
  readonly steps?: number
  readonly toolCalls?: number
  readonly traceId?: string
  readonly error?: string
}

interface HarnessFlags {
  readonly reportDirectory: string
  readonly repairTurns: number
  readonly agentArgs: readonly string[]
}

interface TurnResult {
  readonly label: string
  readonly outcome?: AgentRunOutcome
  readonly error?: string
}

/** Parse harness-only flags, then delegate every AgentCode flag to its canonical parser. */
export function parseMultiSkillCliArgs(
  argv: readonly string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): MultiSkillCliConfig {
  const harness = extractHarnessFlags(argv, cwd)
  const separator = harness.agentArgs.indexOf('--')
  const positionalTail = separator < 0 ? [] : harness.agentArgs.slice(separator)
  const presets = separator < 0
    ? [...harness.agentArgs]
    : [...harness.agentArgs.slice(0, separator)]
  const promptProvided = hasPromptInput(harness.agentArgs)
  addValuePreset(presets, '--workdir', DEFAULT_WORKSPACE)
  addValuePreset(presets, '--provider', 'codex')
  if ((argumentValue(presets, '--provider') ?? 'codex') === 'codex') {
    addValuePreset(presets, '--model', 'gpt-5.6-luna')
  }
  addValuePreset(presets, '--effort', 'medium')
  addValuePreset(presets, '--max-turns', '48')
  addValuePreset(presets, '--max-tool-calls', '128')
  addValuePreset(presets, '--max-input-tokens', '12000')
  addValuePreset(presets, '--retain-tokens', '3000')
  if (!promptProvided) presets.push('--prompt', SIGNAL_DESK_PROMPT)
  if (!hasSwitch(presets, '--once')) presets.push('--once')
  if (!hasPathValue(presets, '--skills-root', DEFAULT_SKILLS_ROOT, cwd)) {
    presets.push('--skills-root', DEFAULT_SKILLS_ROOT)
  }
  presets.push(...positionalTail)
  const agent = parseAgentCodeCliArgs(presets, cwd)
  return Object.freeze({
    agent,
    model: resolveAgentCodeModel(agent, env),
    reportDirectory: harness.reportDirectory,
    repairTurns: harness.repairTurns,
  })
}

export function multiSkillCliHelp(): string {
  return `Automated real-provider Signal Desk multi-skill acceptance

Usage:
  node test-human/agentcode/multi-skill/cli.ts [harness options] [AgentCode options]

Harness options:
  --report-dir <path>     Reports and isolated provider logs; default:
                          test-human/results/agentcode-multiskill
  --repair-turns <count>  Continuation repair turns in the same session; default: 1

AgentCode presets (all remain overridable):
  --workdir test-human/workspaces/agentcode-multiskill
  --provider codex --model gpt-5.6-luna --effort medium
  --max-turns 48 --max-tool-calls 128
  --max-input-tokens 12000 --retain-tokens 3000 --once

--help and --dry-run perform no filesystem mutation and make no network request.
All remaining options are parsed by the AgentCode CLI parser.

${agentCodeCliHelp()}`
}

/** Execute the full host-owned acceptance workflow. */
export async function runMultiSkillAcceptance(config: MultiSkillCliConfig): Promise<MultiSkillRunSummary> {
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const reportDirectory = config.reportDirectory
  const skillReportPath = join(reportDirectory, 'skill-report.json')
  const providerLogRoot = join(reportDirectory, 'providers')
  const report = new AgentCodeSkillReportRecorder({
    reportPath: skillReportPath,
    expectedSkillIds: SIGNAL_DESK_REQUIRED_SKILLS,
    maxTimelineEntries: 8_000,
  })
  const controller = new AbortController()
  const errors: string[] = []
  const turns: TurnResult[] = []
  const verifications: { report: SignalDeskVerificationReport; path: string }[] = []
  let preparedSkills: PreparedSkillStressFixtures | undefined
  let seeded: SeedSignalDeskWorkspaceResult | undefined
  let preparation: SignalDeskPreparationReport | undefined
  let baseline: SignalDeskCommandResult | undefined
  let baselineRed = false
  let discoveredSkills: readonly string[] = Object.freeze([])
  let fatalError: string | undefined
  let terminal: Interface | undefined
  let broker: InteractiveUserInputBroker | undefined
  let skillSnapshot: AgentCodeSkillReport = report.snapshot()
  const onInterrupt = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('multi-skill acceptance interrupted'))
  }
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onInterrupt)

  await mkdir(reportDirectory, { recursive: true })
  console.log(label('multiskill/config'), JSON.stringify(printableConfig(config, providerLogRoot), null, 2))

  try {
    preparedSkills = await prepareSkillStressFixtures({
      projectRoot: PROJECT_ROOT,
      signal: controller.signal,
      onProgress: message => console.log(label('skills/prepare'), message),
    })
    if (!samePath(preparedSkills.skillsRoot, DEFAULT_SKILLS_ROOT)) {
      throw new Error(
        `prepared skills root '${preparedSkills.skillsRoot}' does not match configured root '${DEFAULT_SKILLS_ROOT}'`,
      )
    }

    seeded = await seedSignalDeskWorkspace({
      workspace: config.agent.workdir,
      resetOwned: true,
    })
    console.log(label('workspace/seed'), seeded.workspace, seeded.baseline.digest)

    preparation = await prepareSignalDeskWorkspace({
      workspace: seeded.workspace,
      signal: controller.signal,
      onCommandStart: request => logCommandStart('prepare', request),
      onCommandEnd: command => logCommandEnd('prepare', command),
    })
    await writeBoundedJson(join(reportDirectory, 'preparation.json'), preparation)
    if (!preparation.passed) throw new Error('Signal Desk dependency preparation failed')

    baseline = await runSignalDeskCommand(baselineRequest(seeded.workspace, controller.signal))
    baselineRed = baseline.exitCode !== null
      && baseline.exitCode !== 0
      && !baseline.timedOut
      && !baseline.aborted
    await writeBoundedJson(join(reportDirectory, 'baseline.json'), {
      schemaVersion: 1,
      command: baseline,
      red: baselineRed,
    })
    console.log(label('baseline/npm-test'), `exit=${baseline.exitCode ?? 'spawn-error'}`, baselineRed ? 'RED as expected' : 'INVALID')
    if (!baselineRed) {
      throw new Error(
        `expected the seeded npm test baseline to fail normally; exit=${baseline.exitCode ?? 'spawn-error'}, timedOut=${baseline.timedOut}, aborted=${baseline.aborted}`,
      )
    }

    const registry = createHumanModelRegistry(config.agent, {
      requestLogRoot: providerLogRoot,
    })
    const tools = createAgentCodeToolRegistry(config.agent.workdir)
    const defined = createAgentCodeAgent(config.agent, config.model, {
      onSkillIo: event => report.recordSkillIo(event),
    })
    const session: AgentSession = defined.createSession({
      registry,
      tools,
      skillCwd: config.agent.workdir,
      hooks: withAgentCodeSkillReportHooks(report, undefined),
    })
    const discovered = await session.skills?.discover({
      cwd: config.agent.workdir,
      signal: controller.signal,
    }) ?? []
    discoveredSkills = Object.freeze(discovered.map(skill => skill.id).sort())
    const missing = SIGNAL_DESK_REQUIRED_SKILLS.filter(id => !discoveredSkills.includes(id))
    console.log(label('agentcode/skills'), discoveredSkills.join(', ') || 'none')
    if (missing.length > 0) {
      throw new Error(`required prepared skills were not discovered: ${missing.join(', ')}`)
    }

    broker = createUserInputBroker()
    terminal = createInterface({ input: stdin, output: stdout })
    turns.push(await runTurn(
      session, SIGNAL_DESK_PROMPT, 'initial', report, config.agent, broker, terminal,
      controller.signal,
    ))
    verifications.push(await verifyAndPersist(
      seeded, reportDirectory, verifications.length + 1, controller.signal,
    ))

    for (let repair = 1; repair <= config.repairTurns; repair++) {
      skillSnapshot = report.snapshot()
      if (acceptanceOf(baselineRed, verifications.at(-1)?.report, turns.at(-1)?.outcome, skillSnapshot).passed) break
      console.log(label('agentcode/repair'), `continuation ${repair}/${config.repairTurns}`)
      turns.push(await runTurn(
        session, SIGNAL_DESK_REVIEW_PROMPT, `repair-${repair}`, report, config.agent,
        broker, terminal, controller.signal,
      ))
      verifications.push(await verifyAndPersist(
        seeded, reportDirectory, verifications.length + 1, controller.signal,
      ))
    }
  } catch (error: unknown) {
    fatalError = boundedError(error)
    errors.push(fatalError)
    console.error(label('multiskill/error'), fatalError)
  } finally {
    broker?.abortAll()
    terminal?.close()
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onInterrupt)

    try {
      skillSnapshot = await report.flush()
    } catch (error: unknown) {
      const message = `skill report flush failed: ${boundedError(error)}`
      errors.push(message)
      fatalError ??= message
    }
    try {
      await preparedSkills?.cleanup()
    } catch (error: unknown) {
      const message = `skill fixture cleanup failed: ${boundedError(error)}`
      errors.push(message)
      fatalError ??= message
    }
  }

  const latestVerification = verifications.at(-1)?.report
  const latestOutcome = turns.at(-1)?.outcome
  const evaluated = acceptanceOf(baselineRed, latestVerification, latestOutcome, skillSnapshot)
  const finished = Date.now()
  const summary: MultiSkillRunSummary = Object.freeze({
    schemaVersion: 1 as const,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
    passed: fatalError === undefined && evaluated.passed,
    config: Object.freeze({
      provider: config.agent.provider,
      model: config.model,
      effort: config.agent.effort,
      maxTurns: config.agent.maxTurns,
      maxToolCalls: config.agent.maxToolCalls,
      maxInputTokens: config.agent.maxInputTokens,
      retainTokens: config.agent.retainTokens,
      workspace: config.agent.workdir,
      reportDirectory,
      providerLogs: config.agent.logs ? providerLogRoot : null,
      repairTurns: config.repairTurns,
    }),
    requiredSkills: Object.freeze([...SIGNAL_DESK_REQUIRED_SKILLS]),
    discoveredSkills,
    ...(preparedSkills === undefined ? {} : {
      skillsCache: Object.freeze({
        root: preparedSkills.skillsRoot,
        reused: preparedSkills.reused,
        sources: Object.freeze(preparedSkills.sources.map(item => item.source.id)),
      }),
    }),
    ...(preparation === undefined ? {} : {
      preparation: Object.freeze({
        passed: preparation.passed,
        dependenciesReady: preparation.dependenciesReady,
        browserReady: preparation.browserReady,
        report: join(reportDirectory, 'preparation.json'),
      }),
    }),
    ...(baseline === undefined ? {} : {
      baseline: Object.freeze({
        red: baselineRed,
        exitCode: baseline.exitCode,
        timedOut: baseline.timedOut,
        aborted: baseline.aborted,
        report: join(reportDirectory, 'baseline.json'),
      }),
    }),
    runs: Object.freeze(turns.map(summarizeTurn)),
    verifications: Object.freeze(verifications.map((item, index) => Object.freeze({
      attempt: index + 1,
      passed: item.report.passed,
      failedChecks: Object.freeze(item.report.checks
        .filter(check => check.required && !check.passed)
        .map(check => check.id)),
      commands: Object.freeze(Object.fromEntries(
        item.report.commands.map(command => [command.name, command.exitCode]),
      )),
      report: item.path,
    }))),
    acceptance: evaluated.acceptance,
    skillReport: skillReportPath,
    errors: Object.freeze(errors.slice(0, 100)),
  })
  await writeBoundedJson(join(reportDirectory, 'summary.json'), summary)
  console.log(label('multiskill/summary'), JSON.stringify({
    passed: summary.passed,
    acceptance: summary.acceptance,
    report: join(reportDirectory, 'summary.json'),
  }, null, 2))
  return summary
}

async function runTurn(
  session: AgentSession,
  prompt: string,
  runLabel: string,
  report: AgentCodeSkillReportRecorder,
  config: AgentCodeCliConfig,
  broker: InteractiveUserInputBroker,
  terminal: Interface,
  signal: AbortSignal,
): Promise<TurnResult> {
  let outcome: AgentRunOutcome | undefined
  let failure: string | undefined
  const capture = async function * (events: AsyncIterable<AgentRunEvent>): AsyncIterable<AgentRunEvent> {
    for await (const event of events) {
      if (event.type === 'agent-end') outcome = event.outcome
      yield event
    }
  }
  try {
    const stream = report.observe(capture(session.stream(prompt, { signal })), runLabel)
    await renderHumanRun(stream, config, broker, terminal)
    if (outcome === undefined) failure = 'agent stream ended without agent-end'
  } catch (error: unknown) {
    failure = boundedError(error)
    console.error(label(`agentcode/${runLabel}/error`), failure)
  }
  return Object.freeze({
    label: runLabel,
    ...(outcome === undefined ? {} : { outcome }),
    ...(failure === undefined ? {} : { error: failure }),
  })
}

async function verifyAndPersist(
  seeded: SeedSignalDeskWorkspaceResult,
  reportDirectory: string,
  attempt: number,
  signal: AbortSignal,
): Promise<{ report: SignalDeskVerificationReport; path: string }> {
  const report = await verifySignalDeskWorkspace({
    workspace: seeded.workspace,
    baseline: seeded.baseline,
    // Recreate node_modules from the protected lockfile before every host gate
    // so workspace-local binaries cannot be used to manufacture green output.
    installDependencies: true,
    signal,
    onCommandStart: request => logCommandStart(`verify-${attempt}`, request),
    onCommandEnd: result => logCommandEnd(`verify-${attempt}`, result),
  })
  const path = join(reportDirectory, `verification-${attempt}.json`)
  await writeBoundedJson(path, report)
  console.log(formatSignalDeskVerificationSummary(report))
  return Object.freeze({ report, path })
}

function acceptanceOf(
  baselineRed: boolean,
  verification: SignalDeskVerificationReport | undefined,
  outcome: AgentRunOutcome | undefined,
  skillReport: AgentCodeSkillReport,
): { readonly passed: boolean; readonly acceptance: MultiSkillAcceptance } {
  const trace = skillReport.summary.trace
  const traceComplete = trace.auditComplete
    && trace.openSpans === 0
    && trace.duplicateStarts === 0
    && trace.duplicateEnds === 0
    && trace.endsWithoutStart === 0
    && trace.orphanStarts === 0
    && trace.spansStarted > 0
    && trace.spansStarted === trace.spansEnded
  const acceptance: MultiSkillAcceptance = Object.freeze({
    baselineRed,
    functionalVerifier: verification?.passed === true,
    expectedSkillsBehaviorallyApplied:
      skillReport.summary.allExpectedSkillsBehaviorallyApplied,
    skillEvidenceComplete: isAgentCodeSkillEvidenceComplete(skillReport),
    traceComplete,
    deepOutcomeCompleted: outcome?.mode === 'deep' && outcome.completed,
    compactionCompleted: skillReport.summary.compactionsCompleted > 0,
  })
  return Object.freeze({
    passed: Object.values(acceptance).every(value => value === true),
    acceptance,
  })
}

function summarizeTurn(turn: TurnResult): MultiSkillTurnSummary {
  return Object.freeze({
    label: turn.label,
    completed: turn.outcome?.completed === true,
    ...(turn.outcome === undefined ? {} : {
      reason: turn.outcome.reason.kind,
      steps: turn.outcome.steps,
      toolCalls: turn.outcome.toolCalls,
      traceId: turn.outcome.traceId,
    }),
    ...(turn.error === undefined ? {} : { error: turn.error }),
  })
}

function baselineRequest(workspace: string, signal: AbortSignal): SignalDeskCommandRequest {
  return Object.freeze({
    name: 'unit',
    command: 'npm',
    args: Object.freeze(['test']),
    cwd: workspace,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputChars: MAX_COMMAND_OUTPUT_CHARS,
    env: Object.freeze({
      ...process.env,
      CI: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    }),
    signal,
  })
}

function logCommandStart(scope: string, request: SignalDeskCommandRequest): void {
  console.log(label(`${scope}/command`), ['npm', ...request.args].join(' '))
}

function logCommandEnd(scope: string, result: SignalDeskCommandResult): void {
  console.log(label(`${scope}/result`), `${result.name} exit=${result.exitCode ?? 'spawn-error'} durationMs=${result.durationMs}`)
}

function extractHarnessFlags(argv: readonly string[], cwd: string): HarnessFlags {
  const agentArgs: string[] = []
  let reportDirectory = DEFAULT_REPORT_DIRECTORY
  let repairTurns = DEFAULT_REPAIR_TURNS
  let positional = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (positional) {
      agentArgs.push(token)
      continue
    }
    if (token === '--') {
      positional = true
      agentArgs.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const key = equals > 0 ? token.slice(0, equals) : token
    if (key !== '--report-dir' && key !== '--repair-turns') {
      agentArgs.push(token)
      continue
    }
    const value = equals > 0 ? token.slice(equals + 1) : argv[++index]
    if (value === undefined || value.length === 0 || (equals < 0 && value.startsWith('--'))) {
      throw new Error(`${key} requires a value`)
    }
    if (key === '--report-dir') reportDirectory = resolve(cwd, value)
    else repairTurns = boundedRepairTurns(value)
  }
  return Object.freeze({
    reportDirectory: resolve(reportDirectory),
    repairTurns,
    agentArgs: Object.freeze(agentArgs),
  })
}

function addValuePreset(argv: string[], flag: string, value: string): void {
  if (!hasValueFlag(argv, flag)) argv.push(flag, value)
}

function hasValueFlag(argv: readonly string[], flag: string): boolean {
  return argv.some(token => token === flag || token.startsWith(`${flag}=`))
}

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = argv.length - 1; index >= 0; index--) {
    const token = argv[index]
    if (token === undefined) continue
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
    if (token === flag) return argv[index + 1]
  }
  return undefined
}

function hasPromptInput(argv: readonly string[]): boolean {
  let positional = false
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (positional) return true
    if (token === '--') {
      positional = true
      continue
    }
    const equals = token.indexOf('=')
    const key = equals > 0 ? token.slice(0, equals) : token
    if (key === '--prompt') return true
    if (AGENT_VALUE_FLAGS.has(key)) {
      if (equals < 0) index++
      continue
    }
    if (!token.startsWith('-')) return true
  }
  return false
}

function hasSwitch(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag)
}

function hasPathValue(
  argv: readonly string[],
  flag: string,
  expected: string,
  cwd: string,
): boolean {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (token.startsWith(`${flag}=`)) {
      if (samePath(resolve(cwd, token.slice(flag.length + 1)), expected)) return true
    } else if (token === flag) {
      const value = argv[index + 1]
      if (value !== undefined && samePath(resolve(cwd, value), expected)) return true
    }
  }
  return false
}

function boundedRepairTurns(raw: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || value > 4) {
    throw new Error('--repair-turns must be an integer between 0 and 4')
  }
  return value
}

function printableConfig(config: MultiSkillCliConfig, providerLogs: string): Record<string, unknown> {
  return {
    provider: config.agent.provider,
    model: config.model,
    effort: config.agent.effort,
    maxTurns: config.agent.maxTurns,
    maxToolCalls: config.agent.maxToolCalls,
    compaction: {
      maxInputTokens: config.agent.maxInputTokens,
      retainTokens: config.agent.retainTokens,
    },
    workspace: config.agent.workdir,
    skillsRoots: config.agent.skillRoots,
    reportDirectory: config.reportDirectory,
    providerLogs: config.agent.logs ? providerLogs : null,
    repairTurns: config.repairTurns,
    promptChars: config.agent.prompt?.length ?? 0,
  }
}

async function writeBoundedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(boundReportValue(value), null, 2)}\n`, 'utf8')
}

function boundReportValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length <= MAX_REPORT_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_REPORT_STRING_CHARS - 32)}... <${value.length} chars>`
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return String(value)
  if (value === undefined) return undefined
  if (depth >= MAX_REPORT_DEPTH) return '<max-depth>'
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_REPORT_ARRAY_ITEMS)
      .map(item => boundReportValue(item, depth + 1))
    if (value.length > bounded.length) bounded.push(`<${value.length - bounded.length} items omitted>`)
    return bounded
  }
  if (typeof value !== 'object') return String(value)
  const entries = Object.entries(value as Record<string, unknown>)
    .slice(0, MAX_REPORT_OBJECT_KEYS)
    .map(([key, child]) => [key, boundReportValue(child, depth + 1)] as const)
  const output = Object.fromEntries(entries)
  if (Object.keys(value as object).length > entries.length) {
    output._omittedKeys = Object.keys(value as object).length - entries.length
  }
  return output
}

function boundedError(error: unknown): string {
  const message = errorMessage(error)
  return message.length <= 2_000 ? message : `${message.slice(0, 1_968)}... <${message.length} chars>`
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

async function main(): Promise<void> {
  let config: MultiSkillCliConfig
  try {
    config = parseMultiSkillCliArgs(process.argv.slice(2))
  } catch (error: unknown) {
    console.error(errorMessage(error))
    console.error(`\n${multiSkillCliHelp()}`)
    process.exitCode = 2
    return
  }
  if (config.agent.help) {
    console.log(multiSkillCliHelp())
    return
  }
  if (config.agent.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      ...printableConfig(config, join(config.reportDirectory, 'providers')),
      requiredSkills: SIGNAL_DESK_REQUIRED_SKILLS,
    }, null, 2))
    return
  }
  const summary = await runMultiSkillAcceptance(config)
  if (!summary.passed) process.exitCode = 1
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url
}

if (isMainModule()) {
  main().catch(error => {
    console.error(label('multiskill/fatal'), boundedError(error))
    process.exitCode = 1
  })
}
