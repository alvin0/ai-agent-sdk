// Live smoke for lead-scheduled progress updates.
// usage: node --experimental-strip-types progress-smoke.ts <scenario> <codexAuth> [model]
// scenarios: basic | host-stop | abort | throw-sink
import * as agent from '../../packages/core/dist/agent.js'
import type { ManagedAgentTeamOptions } from '../../packages/core/dist/agent.js'
import { execute } from './execute.ts'
import { createHook } from 'node:async_hooks'
import { isProgressTimer } from './progress-timers.ts'

const timerStacks = new Map<number, string>()
Error.stackTraceLimit = 60
createHook({ init(id, type) { if (type === 'Timeout') timerStacks.set(id, new Error().stack!.split('\n').slice(2).join(' | ')) },
  destroy(id) { timerStacks.delete(id) } }).enable()

const [scenario = 'basic', codexAuth, model = 'gpt-6-luna'] = process.argv.slice(2)
if (!codexAuth) throw new Error('codexAuth path required')
const ask = ' While the workers run, update me on their status every 20 seconds.'
  + ' Continue useful non-overlapping work and do not poll.'
const started = Date.now()
const log: Record<string, unknown>[] = []
let managed: ReturnType<typeof agent.createManagedAgentTeam> | undefined
const abort = new AbortController()
let reports = 0

const leadCalls = () => managed?.snapshot().members.find(member => member.name === 'lead')?.modelCalls

const teamFactory = ((options: ManagedAgentTeamOptions) => {
  const prior = options.team instanceof agent.AgentTeam ? undefined : options.team?.onEvent
  const lead = options.leadSessionOptions ?? {}
  const progressCalls = { name: 'smoke-progress-calls', around: async (call: { toolName: string; args: unknown },
    next: () => Promise<{ isError?: boolean; content?: unknown; error?: { message: string } }>) => {
    const result = await next()
    if (call.toolName === 'progress_updates') log.push({ t: Date.now() - started, tool: 'progress_updates',
      args: call.args, isError: result.isError === true, result: JSON.stringify(result.isError ? result.error?.message : result.content).slice(0, 200) })
    return result
  } }
  const m = agent.createManagedAgentTeam({ ...options,
    leadSessionOptions: { ...lead, interceptors: [...(lead.interceptors ?? []), progressCalls] },
    ...(scenario === 'throw-sink' ? { progressUpdates: { maxConsecutiveFailures: 1 } } : {}), team: { ...options.team, onEvent: event => {
    prior?.(event)
    if (event.type === 'team-progress') {
      log.push({ t: Date.now() - started, phase: event.phase, reason: event.reason, scheduleId: event.scheduleId,
        reportsSent: event.reportsSent, leadCalls: leadCalls(), targets: event.targets.length,
        members: event.members.map(member => `${member.name}:${member.status}`).join(','),
        text: event.text.slice(0, 160) })
      if (event.phase !== 'report') return
      reports++
      if (scenario === 'host-stop' && reports === 1) managed!.stopProgressUpdates()
      if (scenario === 'abort' && reports === 1) abort.abort(new Error('smoke abort'))
      if (scenario === 'throw-sink') throw new Error('sink failure')
    }
  } } } as ManagedAgentTeamOptions)
  managed = m
  const run = m.run.bind(m)
  m.run = ((prompt: string, opts: { signal?: AbortSignal } = {}) => run(prompt + ask,
    { ...opts, signal: AbortSignal.any([opts.signal ?? new AbortController().signal, abort.signal]) })) as typeof m.run
  return m
}) as typeof agent.createManagedAgentTeam

const { result } = await execute({ arm: 'team', task: 'multi-module-audit', rep: 0, provider: 'codex', model,
  timeoutMs: 900000, codexAuth }, undefined, { teamFactory })
// Let async_hooks destroy callbacks retire cleared timers after execute() disposes the team.
await new Promise<void>(resolve => setImmediate(resolve))
const progressTimers = [...timerStacks.values()].filter(isProgressTimer).length
const timers = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo()
  .filter(kind => kind === 'Timeout')
console.log(JSON.stringify({ scenario, status: result.status, score: result.score, error: result.error,
  wallMs: result.metrics.wallMs, leadCalls: result.metrics.leadModelCalls, spawns: result.metrics.spawns,
  finalState: managed?.progressUpdates(), progressTimers, liveTimeoutsAfterDispose: timers.length,
  timerStacks: [...timerStacks.values()], events: log }, null, 1))
