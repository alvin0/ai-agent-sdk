/** Explicit retained-result reads are repeatable, but always bounded and paged. */
import { asJson, memberName, object } from './common.ts'
import { prefixWithinBytes, truncate } from './managed-report-text.ts'
import { statusOnly } from './team-results.ts'
import type { AgentMemberOutcome } from './types.ts'
import type { TeamToolsHost } from './team-tool-host.ts'
import { defineTool } from '../tool/definition.ts'

export function resultTool(host: TeamToolsHost) {
  return defineTool({
    name: 'get_agent_result', budgetExempt: true,
    description: 'Fetch a capped page of retained output (default 6 KiB, maximum 16 KiB). '
      + 'Follow page.nextOffset with the same field to read more. Fields: text, structured, error. '
      + 'This explicit read may repeat previously delivered output.',
    parameters: { type: 'object', properties: { target: { type: 'string' },
      field: { type: 'string', enum: ['text', 'structured', 'error'] },
      offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 256, maximum: 16384 } },
    required: ['target'], additionalProperties: false },
    parse: parseResultPage,
    execute: args => readResultPage(host, args),
    isConcurrencySafe: () => true,
  })
}

interface ResultPageRequest {
  target: string
  field: 'text' | 'structured' | 'error'
  offset: number
  maxBytes: number
}

function parseResultPage(raw: unknown): ResultPageRequest {
  const value = object(raw, 'get_agent_result arguments')
  if (Object.keys(value).some(key => !['target', 'field', 'offset', 'maxBytes'].includes(key))) {
    throw new TypeError('unknown result argument')
  }
  const field = value.field ?? 'text'
  if (field !== 'text' && field !== 'structured' && field !== 'error') throw new TypeError('invalid result field')
  return { target: memberName(value.target), field,
    offset: pageInteger(value.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    maxBytes: pageInteger(value.maxBytes, 6144, 256, 16384) }
}

function pageInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`result page argument must be an integer between ${min} and ${max}`)
  }
  return value
}

function readResultPage(host: TeamToolsHost, args: ReturnType<typeof parseResultPage>) {
  const member = host.members().find(candidate => candidate.name === args.target) ?? host.retainedResult(args.target)
  if (member === undefined) throw new Error(`unknown A2A member '${args.target}'`)
  const outcome = member.outcome
  if (outcome === undefined) return asJson({ ...statusOnly(member), result: null })
  const raw = resultFields(outcome)[args.field]
  if (args.offset > raw.length || splitsSurrogate(raw, args.offset)) throw new TypeError('invalid result page offset')
  const text = prefixWithinBytes(raw.slice(args.offset), args.maxBytes)
  const next = args.offset + text.length
  return asJson({ ...statusOnly(member),
    ...(member.error === undefined ? {} : { error: truncate(member.error, args.maxBytes) }),
    result: { ...resultMetadata(outcome, args.maxBytes),
    text: args.field === 'text' ? text : '',
    ...structuredPage(outcome.structured, args, text),
    ...(args.field === 'error' ? { message: text } : {}) },
  page: { field: args.field, offset: args.offset, nextOffset: next < raw.length ? next : null,
    totalChars: raw.length } })
}

function resultFields(outcome: AgentMemberOutcome) {
  return { text: outcome.text ?? '', structured: JSON.stringify(outcome.structured) ?? '',
    error: outcome.kind === 'failed' ? outcome.message : '' }
}

function resultMetadata(outcome: AgentMemberOutcome, maxBytes: number) {
  return { kind: outcome.kind, status: outcome.status ?? outcome.kind,
    ...(outcome.kind === 'failed' ? { message: truncate(outcome.message, maxBytes) } : {}) }
}

function splitsSurrogate(text: string, offset: number): boolean {
  const code = text.charCodeAt(offset)
  return code >= 0xdc00 && code <= 0xdfff
}

function structuredPage(value: unknown, args: ReturnType<typeof parseResultPage>, text: string) {
  if (value === undefined) return {}
  const serialized = JSON.stringify(value)
  if (args.field === 'structured') return {
    structuredTruncated: args.offset > 0 || text.length < serialized.length, structuredPreview: text,
  }
  return new TextEncoder().encode(serialized).byteLength <= args.maxBytes
    ? { structured: value } : { structuredTruncated: true, structuredPreview: truncate(serialized, args.maxBytes) }
}
