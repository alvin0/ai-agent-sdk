/** Assemble model controls without changing the initial lazy catalog. */
import type { ToolDefinition } from '../tool/definition.ts'
import type { ManagedAgentTeamOptions, ManagedAgentRole, WorkerRuntime,
  ManagedAgentSpawnRequest, ManagedAgentWorker, ManagedAgentWorkerStatus } from './managed-types.ts'
import type { AgentTeam } from './team.ts'
import type { ManagedLazyTools } from './managed-lazy-tools.ts'
import type { ManagedWorkerSpawning } from './managed-spawn.ts'
import type { ManagedSettlements } from './managed-settlements.ts'
import type { ManagedProgress } from './managed-progress.ts'
import { progressTool } from './managed-progress-tool.ts'
import { leanControlTools } from './managed-model-tools.ts'
import { managedControlTools, managedRoleSchema } from './managed-controls.ts'
import { batchSpawnTool } from './managed-batch-tool.ts'
import { filterToolsByDepth } from './managed-capabilities.ts'

interface ManagedToolsHost {
  options: ManagedAgentTeamOptions; team: AgentTeam; leadName: string; lazyTools: ManagedLazyTools
  spawning: ManagedWorkerSpawning; settlements: ManagedSettlements; roles: Map<string, ManagedAgentRole>
  maxWorkers: number; maxQueued: number; spawnTimeoutMs: number | undefined; workerTimeoutMs: number | undefined
  workers: Map<string, WorkerRuntime>; progress: ManagedProgress
  owner(): Set<WorkerRuntime> | undefined
  signal(): AbortSignal
  spawn(request: ManagedAgentSpawnRequest, signal?: AbortSignal): Promise<ManagedAgentWorker>
  busy(name: string): boolean
  close(name: string): Promise<ManagedAgentWorkerStatus>
}
export function managedTools(host: ManagedToolsHost): readonly ToolDefinition<any>[] {
  const controls = host.options.modelToolSurface === 'legacy' ? managedControlTools : leanControlTools
  const tools = controls({
    options: host.options, spawnTimeoutMs: host.spawnTimeoutMs, workerTimeoutMs: host.workerTimeoutMs,
    roleSchema: () => managedRoleSchema(host.roles),
    spawnGuidance: () => host.lazyTools.takeGuidance(host.options),
    spawn: async (request, signal) => {
      const owner = host.owner()
      const worker = await host.spawn(request, signal)
      const runtime = host.workers.get(worker.name)
      if (runtime !== undefined) owner?.add(runtime)
      return worker
    },
    workerBusy: name => host.busy(name),
    workerRuntime: name => host.workers.get(name),
    closeWorker: name => host.close(name),
  })
  const batch = batchSpawnTool({
    spawning: host.spawning, team: host.team, leadName: host.leadName,
    maxWorkers: host.maxWorkers, maxQueued: host.maxQueued, spawnTimeoutMs: host.spawnTimeoutMs,
    waitTimeoutMs: host.team.toolsFor(host.leadName).find(tool => tool.name === 'wait_agents')!.timeoutMs,
    roleSchema: () => managedRoleSchema(host.roles),
    spawnGuidance: () => host.lazyTools.takeGuidance(host.options),
    guidanceBudget: () => host.lazyTools.guidanceBudget(host.options),
    owner: () => host.owner(), workers: host.workers,
    signal: () => host.signal(),
    resume: targets => host.settlements.resumeCaptured(targets),
    notice: coverage => host.settlements.trackBatch(coverage),
  })
  return filterToolsByDepth([...tools.slice(0, 1), batch, ...tools.slice(1),
    ...host.progress.enabled ? [progressTool(host.progress)] : []], host.options)
}
