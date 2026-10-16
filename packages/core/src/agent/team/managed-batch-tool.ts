/** One model call for bounded FIFO fan-out and compact per-item accountability. */
import { defineTool, type ToolDefinition, type ToolRunContext } from '../tool/definition.ts'
import type { ManagedWorkerSpawning } from './managed-spawn.ts'
import type { AgentTeam } from './team.ts'
import { modelResults } from './team-results.ts'
import { boundedString, object } from './managed-validation.ts'
import { parseSpawnTool } from './managed-tool-input.ts'
import { asJson } from './managed-outcomes.ts'
import { renderModelResult } from './managed-model-tools.ts'
import type { WorkerRuntime } from './managed-types.ts'
import { abortable, combineSignals } from './managed-cancellation.ts'
import { ManagedBatchCoverage, type BatchCoverage } from './managed-batch-coverage.ts'
import { assertBatchMetadataBudget, batchPayload } from './managed-batch-payload.ts'

interface BatchToolHost {
  readonly spawning: ManagedWorkerSpawning
  readonly team: AgentTeam
  readonly leadName: string
  readonly maxWorkers: number
  readonly maxQueued: number
  readonly spawnTimeoutMs: number
  readonly waitTimeoutMs: number
  roleSchema(): Record<string, unknown>
  readonly workers: ReadonlyMap<string, WorkerRuntime>
  owner(): Set<WorkerRuntime> | undefined
  signal(): AbortSignal
  resume(targets: readonly string[]): void
  notice(coverage: Promise<BatchCoverage>): void
}

export function batchSpawnTool(host: BatchToolHost): ToolDefinition<any> {
  return defineTool({ name: 'spawn_agents', render: renderModelResult,
    description: 'Plan the split; let workers read inputs. Brief tasks with objective, inputs, output, '
      + 'disjoint writes and verification. Starts free slots; queues the rest FIFO without slots. '
      + 'Overflow reports free slots and queued count. No dependencies or peer waits on queued tasks. '
      + 'join=true returns results and coverage; otherwise results and final coverage are pushed. '
      + 'omitted targets: use get_agent_result. Abort returns addresses; queued tasks cancel.',
    parameters: { type: 'object', properties: {
      tasks: { type: 'array', minItems: 1, maxItems: host.maxWorkers + host.maxQueued, items: {
        type: 'object', properties: {
          name: { type: 'string', description: 'Optional unique address.' },
          item_id: { type: 'string', description: 'Unique coverage id; defaults to address.' },
          task: { type: 'string', description: 'Self-contained brief; let the worker read its inputs.' },
          context: { type: 'string', enum: ['fresh', 'fork'] },
          writes: { type: 'array', items: { type: 'string' }, description: 'Omit for read-only.' },
          ...host.roleSchema(),
        }, required: ['task'], additionalProperties: false,
      } },
      join: { type: 'boolean', description: 'Wait for this batch in the same call. Default false.' },
    }, required: ['tasks'], additionalProperties: false },
    parse: parseBatch,
    execute: (args, ctx) => executeBatch(host, args, ctx),
    timeoutMs: host.spawnTimeoutMs + host.waitTimeoutMs,
    isConcurrencySafe: () => true,
  })
}

function parseBatch(raw: unknown) {
  const input = object(raw, 'spawn_agents arguments')
  if (Object.keys(input).some(key => key !== 'tasks' && key !== 'join')) {
    throw new TypeError('unknown spawn_agents field')
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new TypeError('spawn_agents tasks must be a non-empty array')
  }
  if (input.join !== undefined && typeof input.join !== 'boolean') throw new TypeError('join must be a boolean')
  const ids: (string | undefined)[] = []
  const tasks = input.tasks.map(raw => {
    const task = object(raw, 'spawn_agents task')
    if (Object.keys(task).some(key => !['name', 'item_id', 'task', 'context', 'role', 'writes'].includes(key))) {
      throw new TypeError('batch tasks are independent: unknown field (dependencies are not allowed)')
    }
    ids.push(task.item_id === undefined ? undefined : boundedString(task.item_id, 'item_id', 128))
    const { item_id: _id, ...spawn } = task
    return parseSpawnTool(spawn)
  })
  return { tasks, ids, join: input.join === true }
}

async function executeBatch(host: BatchToolHost, { tasks, ids, join }: ReturnType<typeof parseBatch>,
  ctx: ToolRunContext) {
  let capture: ReturnType<AgentTeam['captureResults']> | undefined
  const coverage = new ManagedBatchCoverage()
  const owner = host.owner()
  const signal = combineSignals(ctx.signal, host.signal())
  let targets: readonly string[] = []
  try {
    const workers = await host.spawning.spawnBatch(tasks, signal, {
      reserved: names => {
        targets = names
        reserveCoverage(coverage, names, ids)
        if (join) capture = host.team.captureResults(host.leadName, names, false)
      },
      started: name => {
        coverage.update(name, 'running')
        const runtime = host.workers.get(name)
        registerOwner(owner, runtime)
      },
      queued: name => { coverage.update(name, 'queued') },
      settled: (name, status, usable) => { coverage.update(name, status, usable) },
    })
    if (!join) {
      host.notice(coverage.settled().then(() => coverage.view()))
      return asJson(batchPayload(workers, coverage.view(), [], signal.aborted ? { cancelled: true } : {}))
    }
    try {
      const waited = await host.team.waitForBatch(host.leadName, targets,
        (target, waitSignal) => abortable(coverage.wait(target), waitSignal), { ...ctx, signal }) as {
          timedOut: boolean; interrupted?: boolean
        }
      signal.throwIfAborted()
      return asJson(batchPayload(workers, coverage.view(), modelResults(takeCaptured(capture)), {
        timed_out: waited.timedOut, ...waited.interrupted ? { interrupted: true } : {},
      }))
    } catch (error: unknown) {
      if (!signal.aborted) throw error
      // The aborted call returns addresses, not evidence. Roll back its exact outcome claims.
      capture?.close()
      capture?.release()
      host.resume(targets)
      return asJson(batchPayload(workers, coverage.view(), [], { cancelled: true }))
    }
  } finally { capture?.close() }
}

function reserveCoverage(coverage: ManagedBatchCoverage, names: readonly string[],
  ids: readonly (string | undefined)[]) {
  const itemIds = names.map((name, index) => ids[index] ?? name)
  if (new Set(itemIds).size !== itemIds.length) throw new TypeError('duplicate batch item_id')
  assertBatchMetadataBudget(names, itemIds)
  coverage.assign(names, ids)
}

function registerOwner(owner: Set<WorkerRuntime> | undefined, runtime: WorkerRuntime | undefined): void {
  if (runtime !== undefined) owner?.add(runtime)
}

function takeCaptured(capture: ReturnType<AgentTeam['captureResults']> | undefined) {
  return capture?.take() ?? []
}
