import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { createManagedAgentTeam, defineAgent, defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import { NOTES, OfflineTeamAdapter } from './adapter.ts'
import type { TeamMode } from './adapter.ts'

export async function runOfflineTeam(mode: TeamMode) {
  const adapter = new OfflineTeamAdapter(mode)
  const registry = new ModelRegistry()
  registry.registerAdapter(['offline'], adapter)
  const readNote = defineTool({
    name: 'read_note', description: 'Read a local cache rollout measurement.',
    parameters: { type: 'object', properties: { id: { type: 'string', enum: Object.keys(NOTES) } },
      required: ['id'], additionalProperties: false },
    parse(raw): { id: keyof typeof NOTES } {
      if (raw === null || typeof raw !== 'object' || !('id' in raw)
        || (raw.id !== 'latency' && raw.id !== 'errors')) throw new TypeError('Unknown note')
      return { id: raw.id }
    },
    execute: ({ id }) => NOTES[id],
  })
  const team = createManagedAgentTeam({
    registry,
    lead: defineAgent({
      id: 'lead', provider: 'offline', model: 'scripted-team', mode: 'basic', maxTurns: 12,
      instructions: 'Compare the cache rollout measurements. Delegate independent checks; synthesize evidence.',
      tools: [readNote],
    }),
    delegationMode: 'explicit', // the caller explicitly requests workers below
    inheritLeadTools: true,
    maxWorkers: 2,
    workerTimeoutMs: 10_000,
    collaboration: mode === 'collaboration'
      ? { maxPeerTurnsPerPair: 2, joinTimeoutMs: 10_000, maxTasks: 4 }
      : false,
  })
  try {
    const response = await team.run('Use two workers to verify latency and errors, then summarize.', {
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.outcome.completed) throw new Error(`Lead did not complete: ${response.outcome.reason.kind}`)
    const workers = team.workers()
    if (workers.length !== 2 || workers.some(worker => !worker.result?.succeeded)) {
      throw new Error('Both workers must complete successfully')
    }
    const tasks = team.collaboration?.board.list() ?? []
    if (mode === 'collaboration' && (tasks.length !== 2 || tasks.some(task => task.status !== 'completed'))) {
      throw new Error('Both shared tasks must complete successfully')
    }
    return { mode, text: response.text, workers, tasks, requests: adapter.requests }
  } finally {
    await team.dispose()
    await team.team.dispose()
  }
}
