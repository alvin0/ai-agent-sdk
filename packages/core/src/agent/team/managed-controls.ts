import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import {
  parseCloseTool, parseSpawnTool,
} from './managed-tool-input.ts'
import {
  asJson,
} from './managed-outcomes.ts'
import { atManagedDepthLimit, filterToolsByDepth } from './managed-capabilities.ts'
import type { ManagedAgentDelegationMode, ManagedAgentRole, ManagedAgentSpawnRequest, ManagedAgentTeamOptions,
  ManagedAgentWorker, ManagedAgentWorkerStatus, WorkerRuntime } from './managed-types.ts'

/** Shared delegation strategy; host-selected mode and runtime details are appended below. */
export const DELEGATION_STRATEGY = [
  'Plan the split first; do not read bulk data yourself before delegating. '
  + 'Keep immediate critical-path blockers and tightly coupled work local.',
  'Delegate bounded sidecar tasks that can run alongside your work. Start independent delegations together '
  + 'in one batch when supported. Give each worker an objective, input locations, expected output, '
  + 'write scope, and verification.',
  'Use disjoint write sets, including your own. Do not redo delegated work; continue useful non-overlapping work.',
  'For fresh context, give a self-contained brief. For fork, state only new information; '
  + 'the worker sees completed conversation turns, not this in-flight turn.',
  'Stay responsive to user updates. Keep coordination in the parent. Child output is a report to synthesize: '
  + 'review evidence, resolve gaps, and return the caller-requested result in the requested format.',
  'Wait sparingly, only when a result blocks your next step. Do not busy-poll status or repeat short waits.',
].join(' ')

/** Runtime-independent strategy for managed, lean, or host-composed tool surfaces. */
export function buildDelegationStrategy(mode: ManagedAgentDelegationMode = 'proactive'): string {
  if (mode !== 'explicit' && mode !== 'proactive') throw new TypeError('invalid managed delegationMode')
  return [
    mode === 'explicit'
      ? 'Delegate only when the user or host instructions explicitly ask for agents, delegation, or parallel work.'
      : 'Use your managed team proactively when parallel work will improve the result or save time. '
        + 'Answer quick questions and do small or sequential tasks directly.',
    DELEGATION_STRATEGY,
  ].join(' ')
}

/** Scheduling facts for this control plane; replace independently when changing result delivery. */
export const MANAGED_DELEGATION_RUNTIME = 'Runtime: results are pushed automatically; '
  + 'wait_agents joins selected workers and returns only new results. '
  + 'Finished workers auto-release slots; get_agent_result reads capped retained pages.'

export function managedLeadInstructions(options: ManagedAgentTeamOptions): string {
  const strategy = buildDelegationStrategy(options.delegationMode).replace('Keep coordination in the parent.',
    options.collaboration ? 'Coordinate shared work through the task board and bounded peer messages.'
      : 'Keep coordination in the parent.')
  return [
    atManagedDepthLimit(options)
      ? 'Delegation depth limit reached. Do the work directly; do not spawn agents. '
        + 'Stay responsive to user updates. Review worker reports, resolve gaps, and synthesize the '
        + 'caller-requested result in the requested format. Wait sparingly when a result blocks your next step; '
        + 'do not busy-poll status or repeat short waits.'
      : strategy,
    MANAGED_DELEGATION_RUNTIME,
    ...atManagedDepthLimit(options) ? []
      : ['Use spawn_agents for independent tasks; overflow queues FIFO within host limits.'],
    options.autoLeadCoordination === false
      ? 'Use wait_agents when blocked on a worker result; the host controls later turns.'
      : 'When only waiting remains, end your turn instead of polling; managed coordination collects worker reports '
        + 'and continues synthesis. Do not present a final answer before needed reports arrive.',
  ].join(' ')
}

export interface ManagedControlsHost {
  readonly options: ManagedAgentTeamOptions
  readonly spawnTimeoutMs: number
  readonly workerTimeoutMs: number
  spawnGuidance(): string | undefined
  roleSchema(): Record<string, unknown>
  spawn(request: ManagedAgentSpawnRequest, signal?: AbortSignal): Promise<ManagedAgentWorker>
  workerBusy?(name: string): boolean
  workerRuntime(name: string): WorkerRuntime | undefined
  closeWorker(name: string): Promise<ManagedAgentWorkerStatus>
}

export function managedControlTools(host: ManagedControlsHost): readonly ToolDefinition<any>[] {
  return Object.freeze(filterToolsByDepth([spawnControlTool(host), closeControlTool(host)], host.options))
}

function spawnControlTool(host: ManagedControlsHost): ToolDefinition<any> {
  return defineTool({
    name: 'spawn_agent',
    description: [
      'Delegate a bounded task that can run alongside your next local step; keep immediate blockers local.',
      'Brief: objective, expected output, write scope, verification. Start independent workers in one message '
      + 'with spawn_agents and disjoint write sets. Continue your own non-overlapping work; do not redo theirs.',
      'Returns a worker address and status, not a final report. Reports are injected automatically; '
      + 'use get_agent_result for retained pages or wait_agents when blocked. Synthesize the result before answering.',
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
      'Cancel unfinished work or remove a worker you no longer need.',
      'Finished workers release slots automatically; closing removes their retained address.',
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
    + (role.context === undefined ? '' : ` Context: ${role.context}.`)
    + (role.whenToUse === undefined ? '' : ` Use when: ${role.whenToUse}`))
  return {
    role: {
      type: 'string',
      enum: [...roles.keys()],
      description: `Which kind of worker this is.\n${lines.join('\n')}`,
    },
  }
}

