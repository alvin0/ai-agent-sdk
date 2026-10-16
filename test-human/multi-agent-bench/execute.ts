import { fileURLToPath } from 'node:url'
import * as agent from '../../packages/core/dist/agent.js'
import { ModelRegistry, ReasoningEffortId, normalizeModelFailure,
  type ModelAdapter } from '../../packages/core/dist/index.js'
import type { ManagedAgentTeamOptions } from '../../packages/core/dist/agent.js'
import { reliableAdapter, type Acquire } from './reliability.ts'
import { settleCompletion, outstandingWorkers } from './completion.ts'
import { FakeAdapter } from './fake.ts'
import { Collector, defaultLimits, errorMessage, type Limits, type Metrics } from './metrics.ts'
import { selectTasks, type Task, type Suite } from './tasks.ts'
import { Workspace, workspaceTools } from './workspace.ts'

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export type Arm = 'single' | 'team' | 'collab'
export interface Job extends Partial<Limits> {
  suite?: Suite; seed?: number; codexAuth?: string; workerTimeoutMs?: number; orphanGraceMs?: number
  arm: Arm; task: string; rep: number; provider: 'fake' | 'codex'; model: string; timeoutMs: number
}
export interface Result extends Job {
  kind: Task['kind']
  schemaVersion: 1
  status: 'completed' | 'completed-orphans' | 'failed' | 'timeout' | 'skipped' | 'cap-hit' | 'infra-failed'
  score: number
  pass: boolean
  precision?: number
  recall?: number
  checks: boolean[]
  metrics: Metrics
  text: string
  artifacts: Record<string, string>
  graderError?: string
  error?: string
  infraFailures?: Collector['infraFailures']
  attempts?: RunAttempt[]
}
export interface RunAttempt {
  attempt: number; status: string; file: string; metrics: Metrics | null; error?: string
}
export interface ExecutionOptions {
  adapterFactory?: (job: Job, task: Task) => ModelAdapter | Promise<ModelAdapter>
  acquire?: Acquire
}
export const instructions = 'Complete the task using workspace evidence and the available tools. '
  + 'Write the requested artifacts, verify your work, then give a concise completion report. '
  + 'Choose your own approach and whether to use any available coordination tools. '
  + 'Keep going until every file/document is covered; do not stop early.'

export function budgetInstructions(job: Job, limits: Limits): string {
  return `${instructions} Budget: ${job.timeoutMs / 1000} seconds job time; `
    + `${(job.workerTimeoutMs ?? job.timeoutMs) / 1000} seconds per worker; `
    + `${limits.maxTotalTokens} aggregate cost-weighted tokens (uncached input + cache writes + output `
    + `+ 0.1 * cache reads); ${limits.maxTurns} model calls; ${limits.maxToolCalls} tool calls. `
    + 'Token, model-call and tool-call limits are shared across all sessions; time caps include waiting.'
}

type TeamFactory = typeof agent.createManagedAgentTeam
// Feature detection, never branch names. Additional collaboration APIs can be adapted here.
export function collaborationFactory(exports: Record<string, unknown>): TeamFactory | undefined {
  const managed = exports.createManagedAgentTeam as TeamFactory | undefined
  const features = exports.MANAGED_TEAM_FEATURES as { collaboration?: unknown } | undefined
  if ((features?.collaboration === true || typeof exports.CollaborationTaskBoard === 'function') && managed) {
    return options => managed({ ...options, collaboration: true } as ManagedAgentTeamOptions)
  }
  const factory = exports.createCollaborativeAgentTeam ?? exports.createCollaborationAgentTeam
  if (typeof factory === 'function') return factory as TeamFactory
  const modes = exports.MANAGED_AGENT_TEAM_MODES
  if (managed && Array.isArray(modes) && modes.includes('collaboration')) {
    return options => managed({ ...options, mode: 'collaboration' } as ManagedAgentTeamOptions)
  }
  return undefined
}
export const collabAvailable = () => collaborationFactory(agent) !== undefined

async function adapter(job: Job, task: Task) {
  if (job.provider === 'fake') return new FakeAdapter(task)
  const { fileCodexCredentialStore } = await import('../../packages/auth-node/dist/codex.mjs')
  const { codexAdapter } = await import('../../packages/provider-codex/dist/index.js')
  return codexAdapter({ authStore: fileCodexCredentialStore(job.codexAuth, { cwd: repoRoot }),
    requestTimeoutMs: 90000, streamIdleTimeoutMs: 45000 })
}

async function runAgent(job: Job, workspace: Workspace, collector: Collector,
  runtime: { signal: AbortSignal; registry: ModelRegistry }) {
  const { signal, registry } = runtime
  const tools = workspaceTools(workspace)
  const definition = (name: string) => agent.defineAgent({ id: name, provider: job.provider, model: job.model,
    effort: ReasoningEffortId('medium'), mode: 'basic',
    maxTurns: collector.limits.maxTurns + 1, maxToolCalls: collector.limits.maxToolCalls + 1,
    instructions: `${budgetInstructions(job, collector.limits)} Bench session: ${name}`, tools })
  if (job.arm === 'single') {
    const session = definition('lead').createSession({ ...collector.options('lead'), registry })
    const response = await session.run(workspace.task.prompt, { signal })
    if (!response.outcome.completed) throw new Error(`Lead incomplete: ${JSON.stringify(response.outcome.reason)}`)
    return 'completed' as const
  }
  const factory = job.arm === 'collab' ? collaborationFactory(agent) : agent.createManagedAgentTeam
  if (!factory) throw new Error('Collaboration feature unavailable')
  const team = factory({ registry, lead: definition('lead'), maxWorkers: 4,
    team: { onEvent: event => {
      collector.teamEvent(event)
      if (event.type === 'member-attached' && event.member.name !== 'lead') collector.spawns++
    } },
    leadSessionOptions: collector.options('lead'),
    workerFactory: request => definition(request.name),
    workerSessionOptionsFactory: request => collector.options(request.name),
    workerTimeoutMs: job.workerTimeoutMs ?? job.timeoutMs, workerTeamTools: 'full',
  })
  collector.rootTeamId = team.team.id
  try {
    const response = await team.run(workspace.task.prompt, { signal })
    collector.orphanWorkers = outstandingWorkers(team)
    const completion = await settleCompletion(team, response.outcome, signal, job.orphanGraceMs ?? 30000)
    collector.orphanWorkers = completion.orphanWorkers
    collector.orphanWorkersAfterGrace = completion.orphanWorkersAfterGrace
    for (const worker of team.workers()) {
      if (worker.error) collector.errors.push(`${worker.name}: ${errorMessage(worker.error)}`)
    }
    return completion.status
  } finally { await team.dispose(); await team.team.dispose() }
}

export async function execute(job: Job, parent?: string, options: ExecutionOptions = {}):
Promise<{ result: Result; audit: Collector }> {
  job = resolvedJob(job)
  const task = selectTasks(job.suite, job.seed).find(task => task.id === job.task)
  if (!task) throw new Error(`Unknown task: ${job.task}`)
  const workspace = await Workspace.create(task, parent)
  const limits = Object.fromEntries(Object.keys(defaultLimits).map(key =>
    [key, job[key as keyof Limits] ?? task.limits?.[key as keyof Limits] ?? defaultLimits[key as keyof Limits]]))
  const collector = new Collector(limits), started = performance.now()
  const timeout = AbortSignal.timeout(job.timeoutMs)
  const signal = AbortSignal.any([timeout, collector.controller.signal])
  let status: Result['status'] = 'completed', error: string | undefined
  try {
    const registry = new ModelRegistry()
    registry.registerAdapter([job.provider], reliableAdapter(
      await (options.adapterFactory ?? adapter)(job, workspace.task), collector, options.acquire))
    status = await runAgent(job, workspace, collector, { signal, registry })
  } catch (caught) {
    recordCaughtFailure(caught, collector)
    status = timeout.aborted ? 'timeout' : 'failed'
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
    collector.errors.push(error)
  }
  status = finalStatus(status, collector)
  const wallMs = performance.now() - started
  try {
    const grade = await workspace.grade()
    const metrics = collector.metrics(wallMs)
    const result: Result = { ...job, ...collector.limits, schemaVersion: 1, kind: task.kind,
      status, score: grade.score,
      pass: grade.pass && ['completed', 'completed-orphans'].includes(status),
      ...quality(grade),
      checks: grade.checks, metrics, infraFailures: collector.infraFailures, text: collector.lastText,
      artifacts: Object.fromEntries(await Promise.all((await workspace.files()).map(async path =>
        [path, await workspace.readAll(path)] as const))),
      ...('error' in grade ? { graderError: grade.error } : {}), ...(error ? { error } : {}) }
    return { result, audit: collector }
  } finally { await workspace.close() }
}

function recordCaughtFailure(error: unknown, collector: Collector) {
  const failure = normalizeModelFailure(error)
  collector.recordInfraFailure(failure)
}
function finalStatus(status: Result['status'], collector: Collector): Result['status'] {
  if (collector.controller.signal.aborted) return 'cap-hit'
  return collector.infraFailures.length ? 'infra-failed' : status
}

function quality(grade: { precision?: number; recall?: number }): Partial<Result> {
  return grade.precision === undefined ? {} : { precision: grade.precision, recall: grade.recall! }
}

function resolvedJob(job: Job): Job {
  return { ...job, workerTimeoutMs: job.workerTimeoutMs ?? job.timeoutMs, orphanGraceMs: job.orphanGraceMs ?? 30000 }
}
