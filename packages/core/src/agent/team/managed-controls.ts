import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import {
  parseCloseTool, parseSpawnTool,
} from './managed-tool-input.ts'
import {
  asJson,
} from './managed-outcomes.ts'
import type { ManagedAgentRole, ManagedAgentSpawnRequest, ManagedAgentTeamOptions,
  ManagedAgentWorker, ManagedAgentWorkerStatus, WorkerRuntime } from './managed-types.ts'

/** Protocol facts only; task strategy and output contracts belong to the host. */
export const LEAD_INSTRUCTIONS = [
  'You have access to a managed team. Your task and coordination strategy are defined by the host instructions.',
  'Return only the caller-requested result in the caller’s format; include explanation only when requested.',
  'spawn_agent returns a worker lifecycle view, not its final result. list_agents exposes status and retained results; '
  + 'wait_agents waits within its timeout.',
  'dependsOn references already registered producer instances. Pending dependents start after those producers settle '
  + 'and receive their results or failure status, even if a producer address is later closed or reused.',
  'fresh starts from the assigned task; fork also copies the completed lead conversation.',
  'writes declares relative scheduling scopes under the host conflict policy; '
  + 'it does not grant filesystem permissions. Omit it when no write scope is needed.',
  'send_message is an update, not terminal completion. completed and failed are terminal worker states; '
  + 'pending and running are not.',
  'Finished workers occupy slots until close_agent. '
  + 'Closing unfinished work requires cancelRunning: true and host authorization.',
].join(' ')

export interface ManagedControlsHost {
  readonly options: ManagedAgentTeamOptions
  readonly spawnTimeoutMs: number
  readonly workerTimeoutMs: number
  roleSchema(): Record<string, unknown>
  spawn(request: ManagedAgentSpawnRequest, signal?: AbortSignal): Promise<ManagedAgentWorker>
  workerRuntime(name: string): WorkerRuntime | undefined
  closeWorker(name: string): Promise<ManagedAgentWorkerStatus>
}

export function managedControlTools(host: ManagedControlsHost): readonly ToolDefinition<any>[] {
  return Object.freeze([spawnControlTool(host), closeControlTool(host)])
}

function spawnControlTool(host: ManagedControlsHost): ToolDefinition<any> {
  return defineTool({
    name: 'spawn_agent',
    description: [
      'Create a managed worker for the supplied task.',
      'Returns a lifecycle view after setup; a dependent may still be pending.',
      'Use list_agents for retained status/results and wait_agents for bounded waits.',
      'dependsOn binds already registered producer instances; '
      + 'writes declares relative scheduling scopes under host policy.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Optional unique worker address; omitted generates worker_N.',
        },
        task: {
          type: 'string',
          description: 'Task and any output contract assigned to the worker.',
        },
        specialty: {
          type: 'string',
          description: 'Optional worker role or domain specialization.',
        },
        context: {
          type: 'string',
          enum: ['fresh', 'fork'],
          description: 'fresh starts from the task; fork also copies the completed lead conversation.',
        },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of workers that must finish before this one starts.'
            + ' The worker is created now and held until they do, then given what they'
            + ' produced. Register the producers first; a dependency cannot name a'
            + ' future or still-preparing worker. Failed producers also release dependents with failure status.',
        },
        writes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace-relative scheduling scopes. Overlaps are rejected, warned or allowed'
            + ' according to host writeScopePolicy. This is not filesystem authorization.'
            + ' Omit when no writes are declared; placeholder paths claim real scopes.',
        },
        ...host.roleSchema(),
      },
      required: ['task'],
      additionalProperties: false,
    },
    parse: parseSpawnTool,
    execute: async (request, context) => asJson(await host.spawn(request, context.signal)),
    // Seconds, not the worker's whole deadline: this call only starts the
    // worker now. Leaving it at workerTimeoutMs would let a stuck SETUP
    // hold the lead for ten minutes.
    timeoutMs: host.spawnTimeoutMs,
    isConcurrencySafe: () => true,
  })
}

function closeControlTool(host: ManagedControlsHost): ToolDefinition<any> {
  return defineTool({
    name: 'close_agent',
    budgetExempt: true,
    description: [
      'Close a worker you no longer need and free its slot.',
      'A finished worker still occupies one until closed, so close it once you have read its result.',
      'A running or pending worker is kept alive by default so it can finish its final report.',
      host.options.allowModelWorkerCancellation === false
        ? 'The host requires worker reports: you cannot cancel unfinished workers. Wait for their result.'
        : 'Set cancelRunning: true only to deliberately abandon unfinished work and cancel it.',
      'Returns the status it held before closing.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker address returned by spawn_agent.' },
        cancelRunning: { type: 'boolean',
          description: 'Explicitly cancel an unfinished worker. Defaults to false.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    parse: parseCloseTool,
    execute: async ({ name, cancelRunning }) => {
      const runtime = host.workerRuntime(name)
      if (runtime !== undefined && (!cancelRunning || host.options.allowModelWorkerCancellation === false)
        && (runtime.status === 'pending' || runtime.status === 'running' || runtime.session.isRunning)) {
        return asJson({
          worker: name, closed: false,
          status: runtime.status === 'pending' ? 'pending' : 'running',
          instruction: 'The worker has not finished its final report. '
            + 'Use wait_agents and read its completed result before closing.'
            + (host.options.allowModelWorkerCancellation === false ? ' Model cancellation is disabled by the host.'
              : ' To deliberately abandon this work, call close_agent with cancelRunning: true.'),
        })
      }
      return asJson({ worker: name, closed: true, previousStatus: await host.closeWorker(name) })
    },
    timeoutMs: host.workerTimeoutMs,
  })
}

export function managedRoleSchema(roles: ReadonlyMap<string, ManagedAgentRole>): Record<string, unknown> {
  if (roles.size === 0) return {}
  const lines = [...roles.values()].map(role =>
    `- ${role.name}: ${role.description}`
    + (role.whenToUse === undefined ? '' : ` Use when: ${role.whenToUse}`))
  return {
    role: {
      type: 'string',
      enum: [...roles.keys()],
      description: `Which kind of worker this is.\n${lines.join('\n')}`,
    },
  }
}

