/** Compact model controls; host requests and lifecycle views remain unchanged. */
import { atManagedDepthLimit, filterToolsByDepth } from './managed-capabilities.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import { managedLeadInstructions, type ManagedControlsHost } from './managed-controls.ts'
import { parseSpawnTool } from './managed-tool-input.ts'
import { asJson } from './managed-outcomes.ts'
import { memberName, object } from './common.ts'
import type { JsonValue } from '../../primitives/index.ts'
import type { ContentBlock } from '../../message/index.ts'

export function renderModelResult(value: JsonValue | undefined): readonly ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value ?? null) }]
}

export function leanLeadInstructions(options: ManagedControlsHost['options']): string {
  return managedLeadInstructions(options) + (atManagedDepthLimit(options)
    ? ' Use send_input for follow-up work. '
    : ' Use spawn_agents for independent tasks, spawn_agent for one task, and send_input for follow-up work. ')
    + 'Close retained agents only when no longer needed.'
}

export function leanControlTools(host: ManagedControlsHost): readonly ToolDefinition<any>[] {
  return filterToolsByDepth([defineTool({
    name: 'spawn_agent',
    render: renderModelResult,
    description: 'Delegate a bounded sidecar task with objective, output, write scope and verification. '
      + 'Keep immediate blockers local; do not redo delegated work. '
      + 'Returns a target; results are pushed automatically.',
    parameters: { type: 'object', properties: {
      task: { type: 'string', description: 'Task and requested output.' },
      context: { type: 'string', enum: ['fresh', 'fork'],
        description: 'fresh: only the task; include everything needed.'
          + ' fork: inherits the completed conversation; state only what is new.' },
      writes: { type: 'array', items: { type: 'string' },
        description: 'Disjoint workspace write scope; omit for read-only.' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: 'Producer targets to join before starting.' },
      ...host.roleSchema(),
    }, required: ['task'], additionalProperties: false },
    // Accept earlier spellings for in-flight histories, without advertising them.
    parse: parseSpawnTool,
    execute: async (request, ctx) => {
      const worker = await host.spawn(request, ctx.signal)
      const status = worker.status === 'pending' ? 'running' : worker.status
      return asJson({ target: worker.name, status: status === 'closed' ? 'failed' : status,
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
