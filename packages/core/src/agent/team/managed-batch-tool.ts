/** One model call for independent fan-out, optionally collecting through the shared join ledger. */
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import type { ManagedWorkerSpawning } from './managed-spawn.ts'
import type { AgentTeam } from './team.ts'
import { modelResults } from './team-results.ts'
import { object } from './managed-validation.ts'
import { parseSpawnTool } from './managed-tool-input.ts'
import { asJson } from './managed-outcomes.ts'
import { renderModelResult } from './managed-model-tools.ts'
import type { WorkerRuntime } from './managed-types.ts'

interface BatchToolHost {
  readonly spawning: ManagedWorkerSpawning
  readonly team: AgentTeam
  readonly leadName: string
  readonly maxWorkers: number
  readonly spawnTimeoutMs: number
  readonly wait: ToolDefinition<any>
  readonly waitTimeoutMs: number
  roleSchema(): Record<string, unknown>
  readonly workers: ReadonlyMap<string, WorkerRuntime>
  owner(): Set<WorkerRuntime> | undefined
}

export function batchSpawnTool(host: BatchToolHost): ToolDefinition<any> {
  return defineTool({ name: 'spawn_agents', render: renderModelResult,
    description: 'Plan the split first; do not read bulk data yourself. Start all independent workers in one call. '
      + 'Brief each with objective, input locations, output, disjoint writes and verification. '
      + 'Rejects the whole batch if it exceeds available maxWorkers slots. '
      + 'join=true returns compact results together without duplicate notices; otherwise results are pushed. '
      + 'Setup failures are reported per worker; timeout or user interruption can return partial results.',
    parameters: { type: 'object', properties: {
      tasks: { type: 'array', minItems: 1, maxItems: host.maxWorkers, items: {
        type: 'object', properties: {
          name: { type: 'string', description: 'Optional unique address.' },
          task: { type: 'string', description: 'Self-contained brief; let the worker read its inputs.' },
          context: { type: 'string', enum: ['fresh', 'fork'] },
          writes: { type: 'array', items: { type: 'string' }, description: 'Omit for read-only.' },
          ...host.roleSchema(),
        }, required: ['task'], additionalProperties: false,
      } },
      join: { type: 'boolean', description: 'Wait for this batch in the same call. Default false.' },
    }, required: ['tasks'], additionalProperties: false },
    parse: raw => {
      const input = object(raw, 'spawn_agents arguments')
      if (Object.keys(input).some(key => key !== 'tasks' && key !== 'join')) {
        throw new TypeError('unknown spawn_agents field')
      }
      if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
        throw new TypeError('spawn_agents tasks must be a non-empty array')
      }
      if (input.join !== undefined && typeof input.join !== 'boolean') throw new TypeError('join must be a boolean')
      const tasks = input.tasks.map(raw => {
        const task = object(raw, 'spawn_agents task')
        if (Object.keys(task).some(key => !['name', 'task', 'context', 'role', 'writes'].includes(key))) {
          throw new TypeError('unknown spawn_agents task field')
        }
        return parseSpawnTool(task)
      })
      return { tasks, join: input.join === true }
    },
    execute: async ({ tasks, join }, ctx) => {
      let capture: ReturnType<AgentTeam['captureResults']> | undefined
      const owner = host.owner()
      try {
        const workers = await host.spawning.spawnBatch(tasks, ctx.signal, {
          reserved: targets => { if (join) capture = host.team.captureResults(host.leadName, targets, false) },
          started: name => {
            const runtime = host.workers.get(name)
            if (runtime !== undefined) owner?.add(runtime)
          },
        })
        ctx.signal.throwIfAborted()
        if (!join) return asJson({ workers })
        const targets = workers.filter(worker => host.workers.has(worker.target)).map(worker => worker.target)
        const waited = targets.length === 0 ? { timed_out: false }
          : await host.wait.execute(host.wait.parse!({ targets }), ctx) as { timed_out: boolean; interrupted?: boolean }
        return asJson({ workers, ...waited, results: modelResults(capture?.take() ?? []) })
      } finally { capture?.close() }
    },
    timeoutMs: host.spawnTimeoutMs + host.waitTimeoutMs,
    isConcurrencySafe: () => true,
  })
}
