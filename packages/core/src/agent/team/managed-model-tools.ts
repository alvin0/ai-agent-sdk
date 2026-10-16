/** Compact model controls; host requests and lifecycle views remain unchanged. */
import { filterToolsByDepth } from './managed-capabilities.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import { buildDelegationStrategy, managedLeadInstructions, type ManagedControlsHost } from './managed-controls.ts'
import { parseSpawnTool } from './managed-tool-input.ts'
import { asJson } from './managed-outcomes.ts'
import { memberName, object } from './common.ts'
import type { JsonValue } from '../../primitives/index.ts'
import type { ContentBlock } from '../../message/index.ts'
import { progressiveTeamTools } from './managed-lazy-tools.ts'

export function renderModelResult(value: JsonValue | undefined): readonly ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value ?? null) }]
}

export function leanLeadInstructions(options: ManagedControlsHost['options']): string {
  buildDelegationStrategy(options.delegationMode) // Preserve mode validation for the short prompt too.
  if (progressiveTeamTools(options)) {
    return (options.delegationMode === 'explicit'
      ? 'Delegate only when the user or host explicitly asks. '
      : 'Do small or sequential work directly; workers add context and synthesis cost. ')
      + 'Use spawn_agent for one worthwhile side task or fresh-context check; '
      + 'spawn_agents only for many independent items that exceed one context or need many sequential steps. '
      + 'Brief objective, inputs, output, disjoint writes and verification. Do not redo delegated work. '
      + 'After spawning, controls appear and results are pushed. '
      + (options.autoLeadCoordination === false
        ? 'Use wait_agents when blocked; the host controls later turns.'
        : 'End your turn when only waiting remains; synthesize reports before the final answer.')
  }
  return managedLeadInstructions(options) + ' Use send_input for follow-up work. '
    + 'Close retained agents only when no longer needed.'
}

export function leanControlTools(host: ManagedControlsHost): readonly ToolDefinition<any>[] {
  const eager = host.options.progressiveToolDisclosure === false
  return filterToolsByDepth([defineTool({
    name: 'spawn_agent',
    render: renderModelResult,
    description: eager
      ? 'Delegate one worthwhile side task or fresh-context check. Brief objective, output, writes and verification. '
        + 'Keep blockers local; do not redo work. '
        + 'Returns a target; results are pushed automatically.'
      : 'Delegate one worthwhile side task or fresh-context check; small tasks stay local. '
      + 'Returns target; results pushed.',
    parameters: spawnParameters(host),
    // Accept earlier spellings for in-flight histories, without advertising them.
    parse: parseSpawnTool,
    execute: async (request, ctx) => {
      const worker = await host.spawn(request, ctx.signal)
      // Append detailed strategy once as a tool result, preserving the short system prefix.
      const guidance = host.spawnGuidance()
      const status = worker.status === 'pending' ? 'running' : worker.status
      return asJson({ target: worker.name, status: status === 'closed' ? 'failed' : status,
        ...(guidance === undefined ? {} : { guidance }),
        ...worker.error === undefined ? {} : { error: worker.error } })
    },
    timeoutMs: host.spawnTimeoutMs,
    isConcurrencySafe: () => true,
  }), defineTool({
    name: 'close_agent', budgetExempt: true,
    render: renderModelResult,
    description: host.options.allowModelWorkerCancellation === false
      ? 'Close a finished worker. Unfinished work is protected by the host.'
      : 'Close a worker. This cancels unfinished work.',
    parameters: { type: 'object', properties: {
      target: { type: 'string', description: 'Id returned by spawn_agent.' } },
      required: ['target'], additionalProperties: false },
    parse: raw => {
      const input = object(raw, 'close_agent arguments')
      if (Object.keys(input).some(key => key !== 'target')) throw new TypeError('unknown close_agent field')
      return { target: memberName(input.target) }
    },
    execute: async ({ target }) => {
      const runtime = host.workerRuntime(target)
      if (runtime === undefined) throw new Error(`unknown worker '${target}'`)
      if (host.options.allowModelWorkerCancellation === false
        && (host.workerBusy?.(target) === true || runtime.status === 'pending'
          || runtime.status === 'running' || runtime.session.isRunning)) {
        return asJson({ target, closed: false, status: 'running', error: 'Wait for this worker to finish.' })
      }
      await host.closeWorker(target)
      return asJson({ target, closed: true })
    },
    timeoutMs: host.workerTimeoutMs,
  })], host.options)
}

function spawnParameters(host: ManagedControlsHost): ToolDefinition['parameters'] {
  const eager = host.options.progressiveToolDisclosure === false
  return { type: 'object', properties: {
      task: { type: 'string', description: eager
        ? 'Task and requested output.' : 'Objective, output, scope, verification.' },
      context: { type: 'string', enum: ['fresh', 'fork'],
        description: eager ? 'fresh: only the task; include everything needed.'
          + ' fork: inherits the completed conversation; state only what is new.'
          : 'fresh: self-contained task. fork: copies completed turns, not this turn.' },
      writes: { type: 'array', items: { type: 'string' },
        description: eager ? 'Disjoint workspace write scope; omit for read-only.'
          : 'Disjoint relative write scopes; omit for read-only. No permission grant.' },
      dependsOn: { type: 'array', items: { type: 'string' },
        description: eager ? 'Producer targets to join before starting.'
          : 'Existing producer targets; start after settlement.' },
      ...host.roleSchema(),
    }, required: ['task'], additionalProperties: false }
}
