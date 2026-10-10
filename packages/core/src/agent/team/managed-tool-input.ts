import type { ToolDefinition } from '../tool/definition.ts'
import { ToolRegistry, type ToolCatalog } from '../tool/registry.ts'
import type { ManagedAgentSpawnRequest } from './managed-types.ts'
import { object, memberName, nonEmpty, stringArray, spawnContext } from './managed-validation.ts'

export function mergeTools(
  supplied: ToolCatalog | readonly ToolDefinition<any>[] | undefined,
  generated: readonly ToolDefinition<any>[],
): ToolRegistry {
  const registry = new ToolRegistry()
  if (supplied !== undefined) {
    const tools = 'names' in supplied
      ? supplied.names().map(name => supplied.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
      : supplied
    for (const tool of tools) registry.register(tool)
  }
  for (const tool of generated) registry.register(tool)
  return registry
}

export function parseCloseTool(value: unknown): { name: string; cancelRunning: boolean } {
  const input = object(value, 'close_agent arguments')
  if (Object.keys(input).some(key => key !== 'name' && key !== 'cancelRunning')) {
    throw new TypeError('close_agent arguments contain unknown fields')
  }
  if (input.cancelRunning !== undefined && typeof input.cancelRunning !== 'boolean') {
    throw new TypeError('close_agent cancelRunning must be a boolean')
  }
  return { name: memberName(input.name), cancelRunning: input.cancelRunning === true }
}

export function parseSpawnTool(value: unknown): ManagedAgentSpawnRequest {
  const input = object(value, 'spawn_agent arguments')
  const known = new Set([
    'name', 'task', 'specialty', 'context', 'role', 'dependsOn', 'writes',
  ])
  if (Object.keys(input).some(key => !known.has(key))) {
    throw new TypeError('spawn_agent arguments contain unknown fields')
  }
  return {
    task: nonEmpty(input.task, 'worker task'),
    ...(input.name === undefined ? {} : { name: memberName(input.name) }),
    ...(input.specialty === undefined
      ? {}
      : { specialty: nonEmpty(input.specialty, 'worker specialty') }),
    ...(input.context === undefined ? {} : { context: spawnContext(input.context) }),
    ...(input.role === undefined ? {} : { role: nonEmpty(input.role, 'worker role') }),
    ...(input.dependsOn === undefined
      ? {}
      : { dependsOn: stringArray(input.dependsOn, 'dependsOn') }),
    ...(input.writes === undefined ? {} : { writes: stringArray(input.writes, 'writes') }),
  }
}
