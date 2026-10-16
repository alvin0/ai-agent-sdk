import { fileURLToPath } from 'node:url'
import * as agent from '../../packages/core/dist/agent.js'
import { ModelRegistry, ReasoningEffortId } from '../../packages/core/dist/index.js'
import type { ManagedAgentTeamOptions } from '../../packages/core/dist/agent.js'
import { FakeAdapter } from './fake.ts'
import { Collector, defaultLimits, type Limits, type Metrics } from './metrics.ts'
import { selectTasks, type Task, type Suite } from './tasks.ts'
import { Workspace, workspaceTools } from './workspace.ts'

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export type Arm = 'single' | 'team' | 'collab'
export interface Job extends Partial<Limits> {
  suite?: Suite; seed?: number; codexAuth?: string
  arm: Arm; task: string; rep: number; provider: 'fake' | 'codex'; model: string; timeoutMs: number
}
export interface Result extends Job {
  schemaVersion: 1
  status: 'completed' | 'failed' | 'timeout' | 'skipped' | 'cap-hit'
  score: number
  pass: boolean
  checks: boolean[]
  metrics: Metrics
  text: string
  artifacts: Record<string, string>
  graderError?: string
  error?: string
}
export const instructions = 'Complete the task using workspace evidence and the available tools. '
  + 'Write the requested artifacts, verify your work, then give a concise completion report. '
  + 'Choose your own approach and whether to use any available coordination tools.'

type TeamFactory = typeof agent.createManagedAgentTeam
// Feature detection, never branch names. Additional collaboration APIs can be adapted here.
export function collaborationFactory(exports: Record<string, unknown>): TeamFactory | undefined {
  const managed = exports.createManagedAgentTeam as TeamFactory | undefined
  if (typeof exports.CollaborationTaskBoard === 'function' && managed) {
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

async function runAgent(job: Job, workspace: Workspace, collector: Collector, signal: AbortSignal) {
  const registry = new ModelRegistry()
  registry.registerAdapter([job.provider], await adapter(job, workspace.task))
  const tools = workspaceTools(workspace)
  const definition = (name: string) => agent.defineAgent({ id: name, provider: job.provider, model: job.model,
    effort: ReasoningEffortId('medium'), mode: 'basic',
    maxTurns: collector.limits.maxTurns + 1, maxToolCalls: collector.limits.maxToolCalls + 1,
    instructions: `${instructions} Bench session: ${name}`, tools })
  if (job.arm === 'single') {
    const session = definition('lead').createSession({ ...collector.options('lead'), registry })
    const response = await session.run(workspace.task.prompt, { signal })
    if (!response.outcome.completed) throw new Error(`Lead incomplete: ${JSON.stringify(response.outcome.reason)}`)
    return
  }
  const factory = job.arm === 'collab' ? collaborationFactory(agent) : agent.createManagedAgentTeam
  if (!factory) throw new Error('Collaboration feature unavailable')
  const team = factory({ registry, lead: definition('lead'), maxWorkers: 4,
    team: { onEvent: event => {
      if (event.type === 'member-attached' && event.member.name !== 'lead') collector.spawns++
    } },
    leadSessionOptions: collector.options('lead'),
    workerFactory: request => definition(request.name),
    workerSessionOptionsFactory: request => collector.options(request.name),
    workerTimeoutMs: job.timeoutMs, workerTeamTools: 'full',
  })
  try {
    const response = await team.run(workspace.task.prompt, { signal })
    await team.whenQuiet(signal)
    if (!response.outcome.completed) throw new Error(`Lead incomplete: ${JSON.stringify(response.outcome.reason)}`)
    for (const worker of team.workers()) {
      if (worker.error) collector.errors.push(`${worker.name}: ${worker.error}`)
    }
  } finally { await team.dispose(); await team.team.dispose() }
}

export async function execute(job: Job, parent?: string): Promise<{ result: Result; audit: Collector }> {
  const task = selectTasks(job.suite, job.seed).find(task => task.id === job.task)
  if (!task) throw new Error(`Unknown task: ${job.task}`)
  const workspace = await Workspace.create(task, parent)
  const limits = Object.fromEntries(Object.keys(defaultLimits).map(key =>
    [key, job[key as keyof Limits] ?? defaultLimits[key as keyof Limits]]))
  const collector = new Collector(limits), started = performance.now()
  const timeout = AbortSignal.timeout(job.timeoutMs)
  const signal = AbortSignal.any([timeout, collector.controller.signal])
  let status: Result['status'] = 'completed', error: string | undefined
  try { await runAgent(job, workspace, collector, signal) } catch (caught) {
    status = timeout.aborted ? 'timeout' : 'failed'
    if (collector.controller.signal.aborted) status = 'cap-hit'
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
    collector.errors.push(error)
  }
  if (collector.controller.signal.aborted) status = 'cap-hit'
  const wallMs = performance.now() - started
  try {
    const grade = await workspace.grade()
    const metrics = collector.metrics(wallMs)
    const result: Result = { ...job, schemaVersion: 1, status, score: grade.score,
      pass: grade.pass && status === 'completed',
      checks: grade.checks, metrics, text: collector.lastText,
      artifacts: Object.fromEntries(await Promise.all((await workspace.files()).map(async path =>
        [path, await workspace.readAll(path)] as const))),
      ...('error' in grade ? { graderError: grade.error } : {}), ...(error ? { error } : {}) }
    return { result, audit: collector }
  } finally { await workspace.close() }
}
