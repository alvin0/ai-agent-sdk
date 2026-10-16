import * as agent from '@alvin0/ai-agent-sdk-core/agent'
import { ModelRegistry, ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import type { ManagedAgentTeamOptions } from '@alvin0/ai-agent-sdk-core/agent'
import { FakeAdapter } from './fake.ts'
import { Collector, type Metrics } from './metrics.ts'
import { tasks } from './tasks.ts'
import { Workspace, workspaceTools } from './workspace.ts'

export type Arm = 'single' | 'team' | 'collab'
export interface Job {
  arm: Arm; task: string; rep: number; provider: 'fake' | 'codex'; model: string; timeoutMs: number
}
export interface Result extends Job {
  schemaVersion: 1
  status: 'completed' | 'failed' | 'timeout' | 'skipped'
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
  const factory = exports.createCollaborativeAgentTeam ?? exports.createCollaborationAgentTeam
  if (typeof factory === 'function') return factory as TeamFactory
  const modes = exports.MANAGED_AGENT_TEAM_MODES
  if (Array.isArray(modes) && modes.includes('collaboration')) {
    return options => agent.createManagedAgentTeam({ ...options, mode: 'collaboration' } as ManagedAgentTeamOptions)
  }
  return undefined
}
export const collabAvailable = () => collaborationFactory(agent) !== undefined

async function adapter(job: Job) {
  const task = tasks.find(task => task.id === job.task)!
  if (job.provider === 'fake') return new FakeAdapter(task)
  // Same Node auth store and Universal provider-codex adapter as the existing live worker.
  const { codexNodeAdapter } = await import('@alvin0/ai-agent-sdk-auth-node/codex')
  return codexNodeAdapter({ requestTimeoutMs: 90000, streamIdleTimeoutMs: 45000 })
}

async function runAgent(job: Job, workspace: Workspace, collector: Collector, signal: AbortSignal) {
  const registry = new ModelRegistry()
  registry.registerAdapter([job.provider], await adapter(job))
  const tools = workspaceTools(workspace)
  const definition = (name: string) => agent.defineAgent({ id: name, provider: job.provider, model: job.model,
    effort: ReasoningEffortId('medium'), mode: 'basic', maxTurns: 40, maxToolCalls: 80,
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
  const task = tasks.find(task => task.id === job.task)
  if (!task) throw new Error(`Unknown task: ${job.task}`)
  const workspace = await Workspace.create(task, parent)
  const collector = new Collector(), started = performance.now()
  const signal = AbortSignal.timeout(job.timeoutMs)
  let status: Result['status'] = 'completed', error: string | undefined
  try { await runAgent(job, workspace, collector, signal) } catch (caught) {
    status = signal.aborted ? 'timeout' : 'failed'
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
    collector.errors.push(error)
  }
  const wallMs = performance.now() - started
  try {
    const grade = await workspace.grade()
    const metrics = collector.metrics(wallMs)
    const result: Result = { ...job, schemaVersion: 1, status, score: grade.score,
      pass: grade.pass && status === 'completed',
      checks: grade.checks, metrics, text: collector.lastText,
      artifacts: Object.fromEntries(await Promise.all((await workspace.files()).map(async path =>
        [path, await workspace.read(path)] as const))),
      ...('error' in grade ? { graderError: grade.error } : {}), ...(error ? { error } : {}) }
    return { result, audit: collector }
  } finally { await workspace.close() }
}
