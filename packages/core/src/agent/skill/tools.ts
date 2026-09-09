/** Progressive-disclosure prompt and tools for a SkillCatalog. */

import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import type { SkillCatalog } from './catalog.ts'
import type { SkillDefinition, SkillLookupOptions, SkillSummary } from './definition.ts'

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
  return Object.freeze({
    maxCatalogChars: integer(input?.maxCatalogChars, 8_000, 512, 100_000, 'maxCatalogChars'),
    searchLimit: integer(input?.searchLimit, 12, 1, 100, 'searchLimit'),
    maxWholeResourceChars: integer(
      input?.maxWholeResourceChars, 10_000, 256, 40_000, 'maxWholeResourceChars',
    ),
    maxManifestChars: integer(input?.maxManifestChars, 4_000, 256, 40_000, 'maxManifestChars'),
    maxSearchResultChars: integer(
      input?.maxSearchResultChars, 8_000, 256, 40_000, 'maxSearchResultChars',
    ),
    maxSearchResources: integer(
      input?.maxSearchResources, 32, 1, 256, 'maxSearchResources',
    ),
    maxSearchInputChars: integer(
      input?.maxSearchInputChars, 200_000, 256, 10_240_000, 'maxSearchInputChars',
    ),
    operationTimeoutMs: integer(input?.operationTimeoutMs, 120_000, 1, 2_147_483_647, 'operationTimeoutMs'),
    maxSkills: integer(input?.maxSkills, 1_024, 1, 100_000, 'maxSkills'),
    maxDiscoveryBytes: integer(
      input?.maxDiscoveryBytes, 4 * 1024 * 1024, 1_024, 128 * 1024 * 1024, 'maxDiscoveryBytes',
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
    'Skills contain instructions not loaded yet. When a request matches one, call load_skill before acting. Only the ids below are valid.',
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
  catalog: SkillCatalog,
  options: ResolvedAgentSkillOptions,
  lookup: () => SkillLookupOptions,
): readonly ToolDefinition<any>[] {
  const load = defineTool({
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

  const read = defineTool({
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

  const search = defineTool({
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
      requireActivatedModelSkill(catalog, skillId)
      const resources = catalog.activatedResources(skillId)
      if (resources === undefined) throw new Error(`skill '${skillId}' must be loaded before its resources are searched`)
      const hits: string[] = []
      let resultChars = 0
      let resourcesRead = 0
      let inputChars = 0
      let truncated = false
      const request = { ...lookup(), signal: context.signal }
      for (const resource of resources) {
        if (resourcesRead >= options.maxSearchResources
          || inputChars >= options.maxSearchInputChars) {
          truncated = true
          break
        }
        const path = resource.path
        resourcesRead++
        const content = await catalog.readResource(skillId, path, request)
        if (content === undefined) continue
        const remaining = options.maxSearchInputChars - inputChars
        const searchable = content.slice(0, remaining)
        inputChars += searchable.length
        if (searchable.length < content.length) truncated = true
        let heading = '(root)'
        const lines = searchable.split(/\r?\n/)
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index] ?? ''
          const parsedHeading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]
          if (parsedHeading !== undefined) heading = parsedHeading
          if (line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
            const hit = `${skillId}/${path}:${index + 1} [${heading}] ${line.trim()}`
            const appended = appendBoundedHit(hits, hit, resultChars, options.maxSearchResultChars)
            resultChars = appended.total
            if (!appended.complete || hits.length >= options.searchLimit) return hits.join('\n')
          }
        }
        if (truncated) break
      }
      const limit = truncated
        ? `Search stopped at the configured budget (${resourcesRead} resources, ${inputChars} characters). Narrow the query or read a named resource.`
        : undefined
      if (hits.length === 0) {
        return bounded([
          `No skill resource matched '${query}'.`,
          ...(limit === undefined ? [] : [limit]),
        ].join('\n'), options.maxSearchResultChars)
      }
      if (limit === undefined) return hits.join('\n')
      appendBoundedHit(hits, limit, resultChars, options.maxSearchResultChars)
      return hits.join('\n')
    },
    meta: (_value, { skillId }) => ({ kind: 'skill-search', skillId }),
    timeoutMs: options.operationTimeoutMs,
  })

  return Object.freeze([load, search, read])
}

async function activateModelSkill(
  catalog: SkillCatalog,
  id: string,
  lookup: SkillLookupOptions,
): Promise<SkillDefinition> {
  const summary = catalog.summaries().find(skill => skill.id === id)
  if (summary === undefined) throw new Error(`unknown skill '${id}'`)
  if (!summary.invocation.modelInvocable) throw new Error(`skill '${id}' is not model-invocable`)
  const skill = await catalog.activate(id, lookup)
  if (skill === undefined) throw new Error(`skill '${id}' is no longer available`)
  if (!skill.invocation.modelInvocable) throw new Error(`skill '${id}' is no longer model-invocable`)
  return skill
}

function requireActivatedModelSkill(catalog: SkillCatalog, id: string): void {
  const summary = catalog.summaries().find(skill => skill.id === id)
  if (summary === undefined) throw new Error(`unknown skill '${id}'`)
  if (!summary.invocation.modelInvocable) throw new Error(`skill '${id}' is not model-invocable`)
  if (!catalog.isActivated(id)) throw new Error(`skill '${id}' must be loaded with load_skill first`)
}

function renderSkill(skill: SkillDefinition, maxManifestChars: number): string {
  const resources = skill.resourceManifest
  const manifest = resources.length === 0
    ? 'Bundled resources: none.'
    : boundedManifest([
        'Bundled resources (use search_skill_resources or read_skill_resource):',
        ...resources.map(resource => `- ${escapePrompt(resource.path)}${resource.sizeChars === undefined
          ? resource.sizeBytes === undefined ? '' : `: ${resource.sizeBytes} bytes`
          : `: ${resource.sizeChars} chars`}`),
      ], maxManifestChars)
  return [
    `<skill_content id="${escapePrompt(skill.id)}">`, manifest,
    '<skill_instructions>', skill.instructions, '</skill_instructions>', '</skill_content>',
  ].join('\n')
}

function boundedManifest(lines: readonly string[], maxChars: number): string {
  if (lines.join('\n').length <= maxChars) return lines.join('\n')
  const kept = [lines[0] ?? 'Bundled resources:']
  let omitted = Math.max(0, lines.length - 1)
  for (const line of lines.slice(1)) {
    const marker = `- omitted: ${omitted - 1} additional resources`
    if ([...kept, line, marker].join('\n').length > maxChars) break
    kept.push(line)
    omitted--
  }
  if (omitted > 0) kept.push(`- omitted: ${omitted} additional resources`)
  return bounded(kept.join('\n'), maxChars)
}

function resourceChunk(content: string, offset: number, maxChars: number): string {
  if (offset > content.length) {
    throw new RangeError(`offset ${offset} exceeds resource length ${content.length}`)
  }
  if (offset === 0 && content.length <= maxChars) return content
  let end = Math.min(content.length, offset + Math.max(1, maxChars - 160))
  let header = chunkHeader(offset, end, content.length)
  end = Math.min(content.length, offset + Math.max(1, maxChars - header.length - 1))
  header = chunkHeader(offset, end, content.length)
  const body = content.slice(offset, end)
  return bounded(`${header}\n${body}`, maxChars)
}

function chunkHeader(offset: number, end: number, total: number): string {
  return `[resource chunk ${offset}:${end} of ${total}; ${end < total ? `next offset ${end}` : 'end'}]`
}

function boundedHeadings(headings: readonly string[]): string {
  return headings.length === 0 ? 'none' : bounded(headings.join(', '), 1_000)
}

function appendBoundedHit(
  hits: string[], hit: string, current: number, max: number,
): { total: number; complete: boolean } {
  const separator = hits.length === 0 ? 0 : 1
  const remaining = max - current - separator
  if (remaining <= 0) return { total: current, complete: false }
  const clipped = bounded(hit, remaining)
  hits.push(clipped)
  return { total: current + separator + clipped.length, complete: clipped.length === hit.length }
}

function bounded(value: string, max: number): string {
  if (value.length <= max) return value
  const suffix = '...[truncated]'
  if (max <= suffix.length) return value.slice(0, max)
  return value.slice(0, max - suffix.length) + suffix
}

function markdownSections(content: string): string[] {
  return content.split(/\r?\n/).flatMap(line => {
    const title = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]
    return title === undefined ? [] : [title]
  })
}

function extractSection(content: string, title: string): string | undefined {
  const lines = content.split(/\r?\n/)
  let start = -1
  let level = 0
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? '')
    if (match?.[2] === title) { start = index; level = match[1]?.length ?? 0; break }
  }
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    const match = /^(#{1,6})\s+/.exec(lines[index] ?? '')
    if (match !== null && (match[1]?.length ?? 7) <= level) { end = index; break }
  }
  return lines.slice(start, end).join('\n').trim()
}

function parseSkillId(raw: unknown): { skillId: string } {
  const value = record(raw)
  return { skillId: requiredString(value.skillId, 'skillId') }
}

function parseResourceRead(raw: unknown): {
  skillId: string; path: string; section: string | null; offset: number; maxChars?: number
} {
  const value = record(raw)
  return {
    skillId: requiredString(value.skillId, 'skillId'),
    path: requiredString(value.path, 'path'),
    section: value.section === undefined || value.section === null
      ? null : requiredString(value.section, 'section'),
    offset: optionalInteger(value.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
    ...(value.maxChars === undefined ? {} : {
      maxChars: optionalInteger(value.maxChars, 0, 1, 40_000, 'maxChars'),
    }),
  }
}

function parseSearch(raw: unknown): { query: string; skillId: string } {
  const value = record(raw)
  return {
    query: boundedInputString(value.query, 'query', 1_024),
    skillId: requiredString(value.skillId, 'skillId'),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('arguments must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function boundedInputString(value: unknown, name: string, max: number): string {
  const result = requiredString(value, name)
  if (result.length > max) throw new RangeError(`${name} must not exceed ${max} characters`)
  return result
}

function optionalInteger(
  value: unknown, fallback: number, min: number, max: number, name: string,
): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return resolved
}

function integer(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`skill ${name} must be an integer between ${min} and ${max}`)
  }
  return resolved
}

function escapePrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
