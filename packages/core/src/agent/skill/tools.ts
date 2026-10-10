/** Progressive-disclosure prompt and tools for a SkillCatalog. */

import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import type { SkillCatalog } from './catalog.ts'
import type { SkillLookupOptions, SkillSummary } from './definition.ts'
import {
  activateModelSkill, appendBoundedHit, bounded, boundedHeadings, escapePrompt, extractSection,
  integer, markdownSections, parseResourceRead, parseSearch,
  parseSkillId, renderSkill, requiredResources, requireActivatedModelSkill,
  resourceChunk, scanSkillResource, searchLimitText,
} from './tool-helpers.ts'

export const SKILL_TOOL_NAMES = Object.freeze([
  'load_skill', 'search_skill_resources', 'read_skill_resource',
] as const)

export interface AgentSkillOptions {
  /** Maximum catalog characters appended to system instructions. Defaults to 8000. */
  readonly maxCatalogChars?: number
  /** Search matches returned per call. Defaults to 12. */
  readonly searchLimit?: number
  /** Maximum resource text returned by one tool call. Defaults to 10000. */
  readonly maxWholeResourceChars?: number
  /** Maximum resource-manifest text returned by load_skill. Defaults to 4000. */
  readonly maxManifestChars?: number
  /** Maximum search result text returned by one tool call. Defaults to 8000. */
  readonly maxSearchResultChars?: number
  /** Maximum resource files hydrated by one search. Defaults to 32. */
  readonly maxSearchResources?: number
  /** Maximum resource characters inspected by one search. Defaults to 200000. */
  readonly maxSearchInputChars?: number
  /** Deadline for one skill discovery/load/read/search operation. Defaults to 120 seconds. */
  readonly operationTimeoutMs?: number
  /** Maximum entries accepted in the merged skill catalog. Defaults to 1,024. */
  readonly maxSkills?: number
  /** Maximum serialized bytes accepted while discovering a catalog. Defaults to 4 MiB. */
  readonly maxDiscoveryBytes?: number
}

export interface ResolvedAgentSkillOptions {
  readonly maxCatalogChars: number
  readonly searchLimit: number
  readonly maxWholeResourceChars: number
  readonly maxManifestChars: number
  readonly maxSearchResultChars: number
  readonly maxSearchResources: number
  readonly maxSearchInputChars: number
  readonly operationTimeoutMs: number
  readonly maxSkills: number
  readonly maxDiscoveryBytes: number
}

export function resolveSkillOptions(input: AgentSkillOptions | undefined): ResolvedAgentSkillOptions {
  const source = input ?? {}
  return Object.freeze({
    maxCatalogChars: integer(source.maxCatalogChars, 8_000,
      { min: 512, max: 100_000, name: 'maxCatalogChars' }),
    searchLimit: integer(source.searchLimit, 12, { min: 1, max: 100, name: 'searchLimit' }),
    maxWholeResourceChars: integer(
      source.maxWholeResourceChars, 10_000,
      { min: 256, max: 40_000, name: 'maxWholeResourceChars' },
    ),
    maxManifestChars: integer(source.maxManifestChars, 4_000, { min: 256, max: 40_000, name: 'maxManifestChars' }),
    maxSearchResultChars: integer(
      source.maxSearchResultChars, 8_000,
      { min: 256, max: 40_000, name: 'maxSearchResultChars' },
    ),
    maxSearchResources: integer(
      source.maxSearchResources, 32, { min: 1, max: 256, name: 'maxSearchResources' },
    ),
    maxSearchInputChars: integer(
      source.maxSearchInputChars, 200_000,
      { min: 256, max: 10_240_000, name: 'maxSearchInputChars' },
    ),
    operationTimeoutMs: integer(source.operationTimeoutMs, 120_000,
      { min: 1, max: 2_147_483_647, name: 'operationTimeoutMs' }),
    maxSkills: integer(source.maxSkills, 1_024, { min: 1, max: 100_000, name: 'maxSkills' }),
    maxDiscoveryBytes: integer(
      source.maxDiscoveryBytes, 4 * 1024 * 1024,
      { min: 1_024, max: 128 * 1024 * 1024, name: 'maxDiscoveryBytes' },
    ),
  })
}

export function renderSkillCatalog(
  instructions: string,
  summaries: readonly SkillSummary[],
  options: ResolvedAgentSkillOptions,
): string {
  const available = summaries.filter(skill => skill.invocation.modelInvocable)
  if (available.length === 0) return instructions
  const header = [
    '<available_skills>',
    'Skills contain instructions not loaded yet. When a request matches one, '
    + 'call load_skill before acting. Only the ids below are valid.',
  ]
  const footer = '</available_skills>'
  const entries: string[][] = []
  let omitted = 0
  for (const skill of available) {
    const entry = [
      `- id: ${escapePrompt(skill.id)}`,
      `  name: ${escapePrompt(skill.name)}`,
      `  description: ${escapePrompt(skill.description)}`,
      ...(skill.whenToUse === undefined ? [] : [`  when_to_use: ${escapePrompt(skill.whenToUse)}`]),
    ]
    const omission = `- omitted: ${omitted + 1} additional skills; ask the host to narrow the catalog`
    if ([...header, ...entries.flat(), ...entry, omission, footer].join('\n').length > options.maxCatalogChars) {
      omitted++
      continue
    }
    entries.push(entry)
  }
  while (omitted > 0) {
    const omission = `- omitted: ${omitted} additional skills; ask the host to narrow the catalog`
    const rendered = [...header, ...entries.flat(), omission, footer].join('\n')
    if (rendered.length <= options.maxCatalogChars || entries.length === 0) break
    entries.pop()
    omitted++
  }
  const lines = [...header, ...entries.flat()]
  if (omitted > 0) lines.push(`- omitted: ${omitted} additional skills; ask the host to narrow the catalog`)
  lines.push(footer)
  return `${instructions}\n\n${lines.join('\n')}`
}

export function createSkillTools(
  catalog: SkillCatalog, options: ResolvedAgentSkillOptions, lookup: () => SkillLookupOptions,
): readonly ToolDefinition<any>[] {
  const load = createLoadSkillTool(catalog, options, lookup)
  const read = createReadSkillTool(catalog, options, lookup)
  const search = createSearchSkillTool(catalog, options, lookup)
  return Object.freeze([load, search, read])
}

function createLoadSkillTool(
  catalog: SkillCatalog, options: ResolvedAgentSkillOptions, lookup: () => SkillLookupOptions,
): ToolDefinition<any> {
  return defineTool({
    name: 'load_skill',
    description: 'Load the complete instructions for one available skill before following it.',
    parameters: {
      type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'], additionalProperties: false,
    },
    parse: parseSkillId,
    async execute({ skillId }, context) {
      const skill = await activateModelSkill(catalog, skillId, { ...lookup(), signal: context.signal })
      return renderSkill(skill, options.maxManifestChars)
    },
    meta: (_value, { skillId }) => ({ kind: 'skill', skillId, resourcePath: null }),
    timeoutMs: options.operationTimeoutMs,
  })
}

function createReadSkillTool(
  catalog: SkillCatalog, options: ResolvedAgentSkillOptions, lookup: () => SkillLookupOptions,
): ToolDefinition<any> {
  return defineTool({
    name: 'read_skill_resource',
    description: 'Read one text resource or one Markdown section bundled with a loaded skill.',
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string' }, path: { type: 'string' },
        section: { type: ['string', 'null'], description: 'Exact Markdown heading, or null for the whole file.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset within the file or selected section.' },
        maxChars: { type: 'integer', minimum: 1, description: 'Requested chunk size, capped by the agent policy.' },
      },
      required: ['skillId', 'path'], additionalProperties: false,
    },
    parse: parseResourceRead,
    async execute({ skillId, path, section, offset, maxChars }, context) {
      const request = { ...lookup(), signal: context.signal }
      requireActivatedModelSkill(catalog, skillId)
      const resource = await catalog.readResource(skillId, path, request)
      if (resource === undefined) throw new Error(`skill '${skillId}' has no resource '${path}'`)
      const headings = markdownSections(resource)
      let selected = resource
      if (section !== null) {
        const sectionText = extractSection(resource, section)
        if (sectionText === undefined) {
          throw new Error(`resource '${path}' has no section '${section}'; sections: ${boundedHeadings(headings)}`)
        }
        selected = sectionText
      }
      return resourceChunk(
        selected, offset, Math.min(maxChars ?? options.maxWholeResourceChars, options.maxWholeResourceChars),
      )
    },
    meta: (_value, { skillId, path, section }) => ({
      kind: 'skill', skillId, resourcePath: section === null ? path : `${path}#${section}`,
    }),
    timeoutMs: options.operationTimeoutMs,
  })
}

function createSearchSkillTool(
  catalog: SkillCatalog, options: ResolvedAgentSkillOptions, lookup: () => SkillLookupOptions,
): ToolDefinition<any> {
  return defineTool({
    name: 'search_skill_resources',
    description: 'Search resources from one skill already loaded with load_skill; never searches the whole catalog.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        skillId: { type: 'string', description: 'One skill already activated with load_skill.' },
      },
      required: ['query', 'skillId'], additionalProperties: false,
    },
    parse: parseSearch,
    async execute({ query, skillId }, context) {
      return searchSkillResources({ catalog, options, lookup, query, skillId, signal: context.signal })
    },
    meta: (_value, { skillId }) => ({ kind: 'skill-search', skillId }),
    timeoutMs: options.operationTimeoutMs,
  })
}

async function searchSkillResources(
  context: {
    catalog: SkillCatalog; options: ResolvedAgentSkillOptions; lookup: () => SkillLookupOptions
    query: string; skillId: string; signal: AbortSignal
  },
): Promise<string> {
      const { catalog, options, lookup, query, skillId, signal } = context
      requireActivatedModelSkill(catalog, skillId)
      const resources = requiredResources(catalog, skillId)
      const hits: string[] = []
      let resultChars = 0
      let resourcesRead = 0
      let inputChars = 0
      let truncated = false
      const request = { ...lookup(), signal: signal }
      for (const resource of resources) {
        if (resourcesRead >= options.maxSearchResources || inputChars >= options.maxSearchInputChars) {
          truncated = true; break
        }
        resourcesRead++
        const scan = await scanSkillResource({ catalog, resource, skillId, query, request,
          inputLimit: options.maxSearchInputChars - inputChars, hits, resultChars,
          resultLimit: options.maxSearchResultChars, searchLimit: options.searchLimit })
        inputChars += scan.inputChars
        resultChars = scan.resultChars
        truncated ||= scan.truncated
        if (scan.complete === false) return hits.join('\n')
        if (truncated) break
      }
      const limit = searchLimitText(truncated, resourcesRead, inputChars)
      if (hits.length === 0) {
        return bounded([
          `No skill resource matched '${query}'.`,
          ...(limit === undefined ? [] : [limit]),
        ].join('\n'), options.maxSearchResultChars)
      }
      if (limit === undefined) return hits.join('\n')
      appendBoundedHit(hits, limit, resultChars, options.maxSearchResultChars)
      return hits.join('\n')
}

