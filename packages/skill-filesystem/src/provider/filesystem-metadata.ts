import { readFrontMatter, readTextFileBounded } from './filesystem-io.ts'
import { discoverResourceManifest } from './filesystem-resources.ts'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { type SkillCandidate, type SkillInvocationPolicy } from '@alvin0/ai-agent-sdk-core/skills'
import { validateCandidate } from '@alvin0/ai-agent-sdk-core/skills'
import {
  MAX_OPENAI_METADATA_BYTES, MAX_OPENAI_METADATA_DEPTH, MAX_OPENAI_METADATA_NODES, MAX_SKILL_FILE_BYTES,
} from './filesystem-constants.ts'
import type {
  FileSystemSkillIoPhase, FileLocator, ParsedSkillFile, FileSystemIoOptions,
} from './filesystem-types.ts'
import { normalize, unquote, isMissing, throwIfAborted, booleanField } from './filesystem-support.ts'

export async function parseSkillFile(
  locator: FileLocator,
  skillId: string,
  provenance: { source: string; provider: string },
  io: FileSystemIoOptions,
): Promise<ParsedSkillFile> {
  const { source, provider } = provenance
  const { signal, onIo } = io
  throwIfAborted(signal)
  const contents = normalize(await readTextFileBounded(
    locator.skillFile,
    MAX_SKILL_FILE_BYTES,
    `skill '${locator.skillFile}'`,
    { signal, onIo, context: { phase: 'activation', skillId } },
  ))
  const { fields, body, metadata } = parseFrontMatter(contents, locator.skillFile)
  const id = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  const whenToUse = fields.get('metadata.when_to_use')
  const allowImplicit = await readImplicitPolicy(
    locator.directory,
    { signal, onIo },
    { phase: 'activation', skillId },
  )
  const invocation: SkillInvocationPolicy = {
    modelInvocable: booleanField(fields, 'disable-model-invocation', false) !== true
      && allowImplicit !== false,
    userInvocable: booleanField(fields, 'user-invocable', true),
  }
  const resourceManifest = await discoverResourceManifest(locator, signal, onIo, skillId)
  return {
    input: {
      id,
      name: fields.get('display-name') ?? id,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      instructions: body,
      resourceManifest,
      invocation,
      source,
      provider,
      resourceBase: { kind: 'directory', value: locator.directory },
      path: locator.skillFile,
      metadata,
    },
  }
}

export async function parseSkillMetadata(
  locator: FileLocator,
  provenance: { source: string; provider: string },
  io: FileSystemIoOptions,
): Promise<SkillCandidate> {
  const { source, provider } = provenance
  const { signal, onIo } = io
  const frontMatter = await readFrontMatter(locator.skillFile, signal, onIo)
  const fileRevision = await stat(locator.skillFile)
  const { fields } = parseFrontMatter(frontMatter, locator.skillFile)
  const id = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  const whenToUse = fields.get('metadata.when_to_use')
  const allowImplicit = await readImplicitPolicy(
    locator.directory,
    { signal, onIo },
    { phase: 'discovery', skillId: id },
  )
  const candidate: SkillCandidate = Object.freeze({
    id,
    name: fields.get('display-name') ?? id,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation: Object.freeze({
      modelInvocable: booleanField(fields, 'disable-model-invocation', false) !== true
        && allowImplicit !== false,
      userInvocable: booleanField(fields, 'user-invocable', true),
    }),
    source,
    provider,
    resourceBase: Object.freeze({ kind: 'directory' as const, value: locator.directory }),
    locator: Object.freeze({
      ...locator,
      revision: Object.freeze({ sizeBytes: fileRevision.size, modifiedMs: fileRevision.mtimeMs }),
    }),
    path: locator.skillFile,
  })
  validateCandidate(candidate, provider)
  return candidate
}

export function parseFrontMatter(
  contents: string,
  path: string,
): { fields: Map<string, string>; body: string; metadata: Readonly<Record<string, unknown>> } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(contents)
  if (match === null) throw new Error(`skill '${path}' must start with YAML front matter`)
  const fields = new Map<string, string>()
  let section = ''
  for (const line of (match[1] ?? '').split('\n')) {
    if (ignorableFrontMatterLine(line)) continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const indented = /^\s/.test(line)
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    if (!indented && raw.length === 0) { section = key; continue }
    fields.set(indented && section.length > 0 ? `${section}.${key}` : key, unquote(raw))
  }
  return {
    fields,
    body: contents.slice(match[0].length).trim(),
    metadata: Object.freeze(Object.fromEntries(fields)),
  }
}

export async function readImplicitPolicy(
  directory: string,
  io: FileSystemIoOptions,
  context: { phase: Exclude<FileSystemSkillIoPhase, 'resource'>; skillId: string },
): Promise<boolean | undefined> {
  const { signal, onIo } = io
  const { phase, skillId } = context
  throwIfAborted(signal)
  try {
    const path = join(directory, 'agents', 'openai.yaml')
    const contents = normalize(await readTextFileBounded(
      path,
      MAX_OPENAI_METADATA_BYTES,
      `skill metadata '${path}'`,
      { signal, onIo, context: { phase, skillId } },
    ))
    return implicitPolicyValue(decodeMetadata(contents, path), path)
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export function assertMetadataBounds(value: unknown, path: string): void {
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    nodes++
    if (nodes > MAX_OPENAI_METADATA_NODES) {
      throw new RangeError(`skill metadata '${path}' exceeds ${MAX_OPENAI_METADATA_NODES} YAML nodes`)
    }
    if (depth > MAX_OPENAI_METADATA_DEPTH) {
      throw new RangeError(`skill metadata '${path}' exceeds YAML depth ${MAX_OPENAI_METADATA_DEPTH}`)
    }
    if (Array.isArray(current)) { for (const item of current) visit(item, depth + 1); return }
    if (isStringRecord(current)) { for (const item of Object.values(current)) visit(item, depth + 1) }
  }
  visit(value, 0)
}

export function containsImplicitPolicyKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImplicitPolicyKey)
  if (!isStringRecord(value)) return false
  return Object.prototype.hasOwnProperty.call(value, 'allow_implicit_invocation')
    || Object.values(value).some(containsImplicitPolicyKey)
}

export function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ignorableFrontMatterLine(line: string): boolean {
  return line.trim().length === 0 || line.trimStart().startsWith('#')
}

function decodeMetadata(contents: string, path: string): unknown {
  const document = parseDocument(contents, { strict: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new TypeError(`skill metadata '${path}' is invalid YAML: ${document.errors[0]?.message ?? 'parse failed'}`)
  }
  let value: unknown
  try { value = document.toJS({ maxAliasCount: 0 }) }
  catch (error: unknown) {
    throw new TypeError(`skill metadata '${path}' contains unsupported YAML aliases`, { cause: error })
  }
  return value
}

function implicitPolicyValue(value: unknown, path: string): boolean | undefined {
  assertMetadataBounds(value, path)
  if (value === null || value === undefined) return undefined
  if (!isStringRecord(value)) throw new TypeError(`skill metadata '${path}' must be a YAML mapping`)
  const policy = value.policy
  if (policy === undefined) {
    if (containsImplicitPolicyKey(value)) {
      throw new TypeError(`skill metadata '${path}' must place allow_implicit_invocation under policy`)
    }
    return undefined
  }
  if (!isStringRecord(policy)) throw new TypeError(`skill metadata '${path}' policy must be a YAML mapping`)
  const allowImplicit = policy.allow_implicit_invocation
  if (allowImplicit === undefined) {
    if (containsImplicitPolicyKey(value)) {
      throw new TypeError(`skill metadata '${path}' has an invalid allow_implicit_invocation policy`)
    }
    return undefined
  }
  if (typeof allowImplicit !== 'boolean') {
    throw new TypeError(`skill metadata '${path}' policy.allow_implicit_invocation must be true or false`)
  }
  return allowImplicit
}
