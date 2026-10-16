/** Worker application tools are inherited separately from parent-bound coordination tools. */
import type { DefinedAgent } from '../define/definition.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { ToolRegistry, type ToolCatalog } from '../tool/registry.ts'
import { AGENT_CONTROL_TOOLS } from '../mode/control-tools.ts'
import { TEAM_TOOL_NAMES } from './common.ts'
import type { ManagedAgentRole, ManagedAgentTeamOptions } from './managed-types.ts'

type DepthOptions = Pick<ManagedAgentTeamOptions, 'depth' | 'maxDepth'>

export function managedDepth(options: DepthOptions): { depth: number; maxDepth: number } {
  const depth = options.depth ?? 0
  const maxDepth = options.maxDepth ?? 1
  for (const [name, value] of Object.entries({ depth, maxDepth })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`)
  }
  return { depth, maxDepth }
}

export function atManagedDepthLimit(options: DepthOptions, child = false): boolean {
  const { depth, maxDepth } = managedDepth(options)
  return depth + Number(child) >= maxDepth
}

/** Apply the same spawn guard to any model-facing control or application tool list. */
export function filterToolsByDepth<T extends { readonly name: string }>(
  tools: readonly T[], options: DepthOptions, child = false,
): readonly T[] {
  return atManagedDepthLimit(options, child) ? tools.filter(tool => tool.name !== 'spawn_agent') : tools
}

export function toolDefinitions(
  tools: ToolCatalog | readonly ToolDefinition<any>[] | undefined,
): readonly ToolDefinition<any>[] {
  if (tools === undefined) return []
  return 'names' in tools
    ? tools.names().map(name => tools.get(name)).filter((tool): tool is ToolDefinition => tool !== undefined)
    : tools
}

/** A host override is a replacement; a role is only an intersection, never a tool supplier. */
export function managedWorkerTools(
  options: ManagedAgentTeamOptions, definition: DefinedAgent,
  supplied: ManagedAgentTeamOptions['workerSessionOptions'], role: ManagedAgentRole | undefined,
): ToolRegistry {
  const override = supplied?.tools
  const candidates = override === undefined
    ? defaultWorkerTools(options, definition, supplied)
    : toolDefinitions(override)
  const allowed = role?.tools === undefined ? undefined : new Set(role.tools)
  const registry = new ToolRegistry()
  const unique = new Map(candidates.map(tool => [tool.name, tool]))
  for (const tool of filterToolsByDepth([...unique.values()], options, true)) {
    if (allowed !== undefined && !allowed.has(tool.name)) continue
    registry.register(tool)
  }
  return registry
}

function defaultWorkerTools(
  options: ManagedAgentTeamOptions, definition: DefinedAgent,
  supplied: ManagedAgentTeamOptions['workerSessionOptions'],
): readonly ToolDefinition<any>[] {
  if (options.workerFactory !== undefined || options.workerTemplate !== undefined) return definition.tools
  if (options.inheritLeadTools === false) return []
  const excluded = new Set<string>([
    ...Object.values(TEAM_TOOL_NAMES), ...Object.values(AGENT_CONTROL_TOOLS),
    'spawn_agent', 'close_agent', 'send_input', 'wait_agents', 'get_agent_result',
    'request_user_input_async', 'ask_user', ...options.leadOnlyTools ?? [],
  ])
  const inherited = [...options.lead.tools, ...toolDefinitions(options.leadSessionOptions?.tools)]
    .filter(tool => !excluded.has(tool.name) && tool.awaitsPerson !== true)
  if (inherited.length > 0) assertInheritedToolSafeguards(options, supplied)
  return inherited
}

/** Refuse automatic sharing of guarded tools unless the host explicitly shares the same safeguards. */
function assertInheritedToolSafeguards(
  options: ManagedAgentTeamOptions, supplied: ManagedAgentTeamOptions['workerSessionOptions'],
): void {
  const lead = options.leadSessionOptions ?? {}
  const worker = supplied ?? {}
  const missing = []
  if (lead.interceptors?.length && worker.interceptors !== lead.interceptors) missing.push('interceptors')
  if (lead.approvals !== undefined && worker.approvals !== lead.approvals) missing.push('approvals')
  if (missing.length === 0) return
  throw new Error(`managed worker tool inheritance requires the lead's same ${missing.join(' and ')}; `
    + 'configure those workerSessionOptions explicitly, set inheritLeadTools: false, '
    + 'or supply worker tools/template/factory with its own policy')
}

export function managedWorkerInstructions(
  name: string, role: ManagedAgentRole | undefined,
): string {
  return [
    `You are managed worker '${name}'. Focus on your assigned task; the parent coordinates the overall work.`,
    'You share the workspace with others. Do not revert others\' edits. Stay within your assigned write scope. '
    + 'If no write scope is assigned, do not edit files; report proposed changes.',
    'Verify your work with appropriate checks. Return a concise report with the result, changed files, '
    + 'verification evidence, and remaining risks, respecting the requested output format.',
    'If blocked, report the blocker and what you tried instead of guessing. '
    + 'Your terminal result is delivered automatically; a message update does not replace it.',
    ...(role === undefined ? [] : [`Role '${role.name}': ${role.instructions ?? role.description}`]),
    'Keep inter-worker coordination in the parent.',
  ].join(' ')
}
