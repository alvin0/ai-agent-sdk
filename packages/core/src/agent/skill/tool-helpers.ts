import type { SkillCatalog } from './catalog.ts'
import type { SkillDefinition, SkillLookupOptions } from './definition.ts'

export function requiredResources(catalog: SkillCatalog,
  skillId: string): readonly SkillDefinition['resourceManifest'][number][] {
  const resources = catalog.activatedResources(skillId)
  if (resources === undefined) throw new Error(`skill '${skillId}' must be loaded before its resources are searched`)
  return resources
}

interface ScanContext {
  catalog: SkillCatalog; resource: SkillDefinition['resourceManifest'][number]; skillId: string; query: string
  request: SkillLookupOptions; inputLimit: number; hits: string[]; resultChars: number
  resultLimit: number; searchLimit: number
}

export async function scanSkillResource(context: ScanContext): Promise<{
  inputChars: number; resultChars: number; truncated: boolean; complete: boolean
}> {
  const content = await context.catalog.readResource(context.skillId, context.resource.path, context.request)
  if (content === undefined) return { inputChars: 0, resultChars: context.resultChars, truncated: false,
    complete: true }
  const searchable = content.slice(0, context.inputLimit)
  const state = { resultChars: context.resultChars, heading: '(root)', complete: true }
  const lines = searchable.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]
    if (heading !== undefined) state.heading = heading
    if (!line.toLocaleLowerCase().includes(context.query.toLocaleLowerCase())) continue
    const hit = `${context.skillId}/${context.resource.path}:${index + 1} [${state.heading}] ${line.trim()}`
    const appended = appendBoundedHit(context.hits, hit, state.resultChars, context.resultLimit)
    state.resultChars = appended.total
    if (!appended.complete || context.hits.length >= context.searchLimit) state.complete = false
    if (!state.complete) break
  }
  return { inputChars: searchable.length, resultChars: state.resultChars,
    truncated: searchable.length < content.length, complete: state.complete }
}

export function searchLimitText(truncated: boolean, resources: number, chars: number): string | undefined {
  if (!truncated) return undefined
  return `Search stopped at the configured budget (${resources} resources, ${chars} characters). `
    + 'Narrow the query or read a named resource.'
}


export async function activateModelSkill(
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

export function requireActivatedModelSkill(catalog: SkillCatalog, id: string): void {
  const summary = catalog.summaries().find(skill => skill.id === id)
  if (summary === undefined) throw new Error(`unknown skill '${id}'`)
  if (!summary.invocation.modelInvocable) throw new Error(`skill '${id}' is not model-invocable`)
  if (!catalog.isActivated(id)) throw new Error(`skill '${id}' must be loaded with load_skill first`)
}

export function renderSkill(skill: SkillDefinition, maxManifestChars: number): string {
  const resources = skill.resourceManifest
  const manifest = resources.length === 0
    ? 'Bundled resources: none.'
    : boundedManifest([
        'Bundled resources (use search_skill_resources or read_skill_resource):',
        ...resources.map(resource => `- ${escapePrompt(resource.path)}${resourceLabel(resource)}`),
      ], maxManifestChars)
  return [
    `<skill_content id="${escapePrompt(skill.id)}">`, manifest,
    '<skill_instructions>', skill.instructions, '</skill_instructions>', '</skill_content>',
  ].join('\n')
}

export function resourceLabel(resource: SkillDefinition['resourceManifest'][number]): string {
  if (resource.sizeChars !== undefined) return `: ${resource.sizeChars} chars`
  return resource.sizeBytes === undefined ? '' : `: ${resource.sizeBytes} bytes`
}

export function parseSection(value: unknown): string | null {
  return value === undefined || value === null ? null : requiredString(value, 'section')
}

export function boundedManifest(lines: readonly string[], maxChars: number): string {
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

export function resourceChunk(content: string, offset: number, maxChars: number): string {
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

export function chunkHeader(offset: number, end: number, total: number): string {
  return `[resource chunk ${offset}:${end} of ${total}; ${end < total ? `next offset ${end}` : 'end'}]`
}

export function boundedHeadings(headings: readonly string[]): string {
  return headings.length === 0 ? 'none' : bounded(headings.join(', '), 1_000)
}

export function appendBoundedHit(
  hits: string[], hit: string, current: number, max: number,
): { total: number; complete: boolean } {
  const separator = hits.length === 0 ? 0 : 1
  const remaining = max - current - separator
  if (remaining <= 0) return { total: current, complete: false }
  const clipped = bounded(hit, remaining)
  hits.push(clipped)
  return { total: current + separator + clipped.length, complete: clipped.length === hit.length }
}

export function bounded(value: string, max: number): string {
  if (value.length <= max) return value
  const suffix = '...[truncated]'
  if (max <= suffix.length) return value.slice(0, max)
  return value.slice(0, max - suffix.length) + suffix
}

export function markdownSections(content: string): string[] {
  return content.split(/\r?\n/).flatMap(line => {
    const title = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]
    return title === undefined ? [] : [title]
  })
}

export function extractSection(content: string, title: string): string | undefined {
  const lines = content.split(/\r?\n/)
  const heading = findHeading(lines, title)
  if (heading === undefined) return undefined
  const end = findSectionEnd(lines, heading.index, heading.level)
  return lines.slice(heading.index, end).join('\n').trim()
}

function findHeading(lines: readonly string[], title: string): { index: number; level: number } | undefined {
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? '')
    if (match?.[2] === title) return { index, level: match[1]?.length ?? 0 }
  }
  return undefined
}

function findSectionEnd(lines: readonly string[], start: number, level: number): number {
  for (let index = start + 1; index < lines.length; index++) {
    const match = /^(#{1,6})\s+/.exec(lines[index] ?? '')
    if (match !== null && (match[1]?.length ?? 7) <= level) return index
  }
  return lines.length
}

export function parseSkillId(raw: unknown): { skillId: string } {
  const value = record(raw)
  return { skillId: requiredString(value.skillId, 'skillId') }
}

export function parseResourceRead(raw: unknown): {
  skillId: string; path: string; section: string | null; offset: number; maxChars?: number
} {
  const value = record(raw)
  return {
    skillId: requiredString(value.skillId, 'skillId'),
    path: requiredString(value.path, 'path'),
    section: parseSection(value.section),
    offset: optionalInteger(value.offset, 0, Number.MAX_SAFE_INTEGER, 'offset'),
    ...(value.maxChars === undefined ? {} : {
      maxChars: optionalInteger(value.maxChars, 1, 40_000, 'maxChars'),
    }),
  }
}

export function parseSearch(raw: unknown): { query: string; skillId: string } {
  const value = record(raw)
  return {
    query: boundedInputString(value.query, 'query', 1_024),
    skillId: requiredString(value.skillId, 'skillId'),
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null
    || Array.isArray(value)) throw new TypeError('arguments must be an object')
  return value as Record<string, unknown>
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

export function boundedInputString(value: unknown, name: string, max: number): string {
  const result = requiredString(value, name)
  if (result.length > max) throw new RangeError(`${name} must not exceed ${max} characters`)
  return result
}

export function optionalInteger(value: unknown, min: number, max: number, name: string): number {
  const resolved = value ?? 0
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return resolved
}

export function integer(value: number | undefined, fallback: number,
  bounds: { min: number; max: number; name: string }): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < bounds.min || resolved > bounds.max) {
    throw new RangeError(`skill ${bounds.name} must be an integer between ${bounds.min} and ${bounds.max}`)
  }
  return resolved
}

export function escapePrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
