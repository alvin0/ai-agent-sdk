import { captureContextSections } from '../context/section.ts'
import type { ContextSection } from '../context/types.ts'
import { SkillCatalog, createSkillTools, type SkillLookupOptions } from '../skill/index.ts'
import type { AgentDefinition } from './definition.ts'
import type { AgentSessionOptions } from './session/types.ts'
import { type ToolCatalog } from '../tool/registry.ts'
import { toolCatalog } from './session/common.ts'

export function sessionContextSections(
  definition: AgentDefinition, options: AgentSessionOptions,
): readonly ContextSection[] | undefined {
  const overrides = captureContextSections(options.contextSections) ?? []
  const base = captureContextSections(definition.contextSections) ?? []
  const merged = [
    ...base.map(section => overrides.find(override => override.id === section.id) ?? section),
    ...overrides.filter(override => !base.some(section => section.id === override.id)),
  ]
  return merged.length === 0 ? undefined : Object.freeze(merged)
}

export function sessionSkills(
  definition: AgentDefinition, options: AgentSessionOptions,
): SkillCatalog | undefined {
  const sources = [...definition.skills, ...options.skills ?? []]
  if (definition.skillIds?.length === 0
    || (sources.length === 0 && (definition.skillIds?.length ?? 0) === 0)) return undefined
  return new SkillCatalog(sources, {
    ...(definition.skillIds === undefined ? {} : { allowedSkillIds: definition.skillIds }),
    maxSkills: definition.skillOptions.maxSkills, maxCatalogBytes: definition.skillOptions.maxDiscoveryBytes,
  })
}

export function sessionCatalog(
  definition: AgentDefinition, options: AgentSessionOptions, skills: SkillCatalog | undefined,
  lookup: () => SkillLookupOptions,
): ToolCatalog | undefined {
  const skillTools = skills === undefined ? [] : createSkillTools(skills, definition.skillOptions, lookup)
  const access = options.team?.tools === 'reporting' ? 'reporting' as const : 'full' as const
  const teamTools = options.team?.tools === false
    ? [] : options.team?.team.toolsFor(options.team.name ?? definition.id, access) ?? []
  return toolCatalog(definition.tools, options.tools, [...skillTools, ...teamTools])
}

export function teamAttachmentOptions(options: AgentSessionOptions): Record<string, unknown> {
  const team = options.team
  if (team === undefined) return {}
  return {
    ...(team.name === undefined ? {} : { name: team.name }),
    ...(team.description === undefined ? {} : { description: team.description }),
    ...(team.instructions === undefined ? {} : { instructions: team.instructions }),
    ...(team.role === undefined ? {} : { role: team.role }),
    ...(team.tools === undefined ? {} : { tools: team.tools }),
  }
}

