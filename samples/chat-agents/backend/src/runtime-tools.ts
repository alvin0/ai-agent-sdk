/**
 * Assemble the tool surface one run sees: the workspace tools, the tools every
 * enabled MCP server exposes, and the skill tools for the group's skill roots.
 *
 * `runTurn` accepts a single `ToolCatalog`, so the pieces are merged into one
 * read-only view here rather than inside the loop.
 */

import { SkillCatalog, createSkillTools, executionModeOf, renderSkillCatalog, resolveSkillOptions } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolCatalog, ToolDefinition, ToolExecutionMode } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolSchema } from '@alvin0/ai-agent-sdk-core'
import { fileSystemSkills } from '@alvin0/ai-agent-sdk-skill-filesystem'
import { listSkills, mcpTools } from './agents'

/**
 * Merge several tool collections into one catalog.
 *
 * Earlier entries win a name clash, so the workspace tools can never be
 * shadowed by a remote server.
 * @param sources - Catalogs and loose tool lists, in precedence order.
 * @returns A read-only merged catalog.
 */
export function mergeTools(
  ...sources: readonly (ToolCatalog | readonly ToolDefinition[])[]
): ToolCatalog {
  const tools = new Map<string, ToolDefinition>()
  for (const source of sources) {
    const list = Array.isArray(source)
      ? source as readonly ToolDefinition[]
      : (source as ToolCatalog).names().map(name => (source as ToolCatalog).get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
    for (const tool of list) if (!tools.has(tool.name)) tools.set(tool.name, tool)
  }
  return {
    get: (name: string) => tools.get(name),
    has: (name: string) => tools.has(name),
    names: () => [...tools.keys()],
    schemas: (): readonly ToolSchema[] => [...tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    executionMode: (name: string, args: unknown): ToolExecutionMode =>
      executionModeOf(tools.get(name), args),
  }
}

/** The extra tools and system-prompt text a group's configuration contributes. */
export interface GroupToolSurface {
  readonly tools: readonly ToolDefinition[]
  /** Skill catalogue block appended to the system prompt, or the empty string. */
  readonly systemSuffix: string
  readonly mcpStatuses: readonly { id: string; connected: boolean; toolCount: number; error?: string }[]
}

/**
 * Build the MCP and skill tools for one group.
 * @param groupId - Owning group.
 * @param workspaceRoot - Directory skills are discovered from.
 * @returns The tools, the catalogue block, and per-server status.
 */
export async function groupToolSurface(
  groupId: string,
  workspaceRoot: string,
): Promise<GroupToolSurface> {
  const { tools: remoteTools, statuses } = await mcpTools(groupId)
  const roots = (await listSkills(groupId)).filter(row => row.enabled === 1).map(row => row.rootPath)

  const options = resolveSkillOptions(undefined)
  // Two sources, because an explicit `roots` list disables the provider's own
  // project discovery: one reads the project's own `.agents/skills` (and
  // `.dsh/skills`) from the workspace up to its repository root, the other
  // reads the globally configured folders.
  const catalog = new SkillCatalog([
    fileSystemSkills({
      id: 'project',
      cwd: workspaceRoot,
      includeProjectAgents: true,
      includeProjectDsh: true,
    }),
    ...roots.length === 0 ? [] : [fileSystemSkills({ id: 'global', roots })],
  ])
  // Discovery runs before the turn so the model sees folders added since the
  // last run without restarting the server.
  const summaries = await catalog.discover({ cwd: workspaceRoot })
  if (summaries.length === 0) {
    // No skills anywhere: keep `load_skill` out of the tool list rather than
    // offering the model a tool with an empty catalogue.
    return { tools: remoteTools, systemSuffix: '', mcpStatuses: statuses }
  }
  const skillTools = createSkillTools(catalog, options, () => ({ cwd: workspaceRoot }))
  return {
    tools: [...remoteTools, ...skillTools],
    systemSuffix: renderSkillCatalog('', summaries, options),
    mcpStatuses: statuses,
  }
}
