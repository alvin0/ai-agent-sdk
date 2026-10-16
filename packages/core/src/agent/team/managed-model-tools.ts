/** Compact model verbs; host requests and lifecycle views remain unchanged. */
import { filterToolsByDepth } from './managed-capabilities.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import { buildDelegationStrategy, managedLeadInstructions, type ManagedControlsHost } from './managed-controls.ts'
import { parseSpawnTool } from './managed-tool-input.ts'
import { asJson } from './managed-outcomes.ts'
import { memberName, object } from './common.ts'
import type { JsonValue } from '../../primitives/index.ts'
import type { ContentBlock } from '../../message/index.ts'
import { DISCLOSED_TEAM_GUIDANCE, progressiveTeamTools } from './managed-lazy-tools.ts'

export function renderModelResult(value: JsonValue | undefined): readonly ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value ?? null) }]
}

export function leanLeadInstructions(options: ManagedControlsHost['options']): string {
  buildDelegationStrategy(options.delegationMode) // Preserve mode validation for the short prompt too.
  if (progressiveTeamTools(options)) {
    return (options.delegationMode === 'explicit'
      ? 'Delegate only when the user or host explicitly asks. '
      : 'Keep quick/sequential work local; delegate useful parallel sidecars. ')
      + 'spawn_agent briefs need objective, output, disjoint write scope and verification; do not redo their work. '
      + 'After spawning, controls appear and results are pushed automatically. '
      + (options.autoLeadCoordination === false
        ? 'Use wait_agents when blocked; the host controls later turns.'
        : 'End your turn when only waiting remains; synthesize reports before the final answer.')
  }
  return managedLeadInstructions(options) + ' Use spawn_agent for tasks and send_input for follow-up work. '
    + 'Close retained agents only when no longer needed.'
}

export function leanControlTools(host: ManagedControlsHost): readonly ToolDefinition<any>[] {
  let guidanceSent = false
  return filterToolsByDepth([defineTool({
    name: 'spawn_agent',
    render: renderModelResult,
    description: 'Start a parallel sidecar; returns target, not result. Results are pushed. '
      + 'Keep immediate blockers local.',
    parameters: { type: 'object', properties: {
      task: { type: 'string', description: 'Objective, output, scope, verification.' },
      context: { type: 'string', enum: ['fresh', 'fork'],
        description: 'fresh: self-contained task. fork: copies completed turns, not this turn.' },
      writes: { type: 'array', items: { type: 'string' },
        description: 'Disjoint relative write scopes; omit for read-only. No permission grant.' },
      dependsOn: { type: 'array', items: { type: 'string' },
        description: 'Existing producer targets; start after settlement.' },
      ...host.roleSchema(),
    }, required: ['task'], additionalProperties: false },
    // Accept earlier spellings for in-flight histories, without advertising them.
    parse: parseSpawnTool,
    execute: async (request, ctx) => {
      const worker = await host.spawn(request, ctx.signal)
      // Append detailed strategy once as a tool result, preserving the short system prefix.
      const guidance = progressiveTeamTools(host.options) && !guidanceSent
        ? DISCLOSED_TEAM_GUIDANCE : undefined
      guidanceSent = true
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
      target: { type: 'string' } },
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
