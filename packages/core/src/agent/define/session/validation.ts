import { type AgentSessionSnapshot } from './types.ts'
import { captureSkillReference } from '../../skill/provider/snapshot.ts'

export function validateSessionSnapshot(
  value: AgentSessionSnapshot,
  expectedAgentId: string,
  maxActivatedSkills: number,
): void {
  if (typeof value !== 'object' || value === null || value.version !== 1) {
    throw new TypeError('unsupported agent session snapshot')
  }
  snapshotString(value.conversationId, 'conversationId', 256)
  snapshotString(value.agentId, 'agentId', 256)
  if (value.agentId !== expectedAgentId) {
    throw new TypeError(
      `cannot resume conversation for agent '${value.agentId}' with agent '${expectedAgentId}'`,
    )
  }
  if (value.skills !== undefined) validateSkillSnapshot(value.skills, maxActivatedSkills)
}

export function validateSkillSnapshot(value: unknown, maxActivatedSkills: number): void {
  if (!record(value) || !Array.isArray(value.activated)) {
    throw new TypeError('agent session snapshot skills.activated must be an array')
  }
  if (value.activated.length > maxActivatedSkills) {
    throw new RangeError(
      `agent session snapshot exceeds the ${maxActivatedSkills}-activated-skill limit`,
    )
  }
  const ids = new Set<string>()
  for (let index = 0; index < value.activated.length; index++) {
    const activation = value.activated[index]
    const id = validateActivation(activation, index)
    if (ids.has(id)) throw new TypeError(`duplicate activated skill '${id}' in agent session snapshot`)
    ids.add(id)
  }
}

function validateActivation(value: unknown, index: number): string {
  if (!record(value)) throw new TypeError(`agent session snapshot skills.activated[${index}] must be an object`)
  if (Object.getOwnPropertyDescriptor(value, 'catalogRevision') !== undefined) {
    captureSkillReference(value)
    return snapshotString(value.id, `skills.activated[${index}].id`, 256)
  }
  const id = snapshotString(value.id, `skills.activated[${index}].id`, 256)
  snapshotString(value.provider, `skills.activated[${index}].provider`, 256)
  snapshotString(value.source, `skills.activated[${index}].source`, 8_192)
  validateResourceBase(value.resourceBase, index)
  return id
}

function validateResourceBase(value: unknown, index: number): void {
  if (value === undefined) return
  if (!record(value) || !['directory', 'url', 'opaque'].includes(String(value.kind))) {
    throw new TypeError(`agent session snapshot skills.activated[${index}].resourceBase is invalid`)
  }
  snapshotString(value.value, `skills.activated[${index}].resourceBase.value`, 8_192)
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function snapshotString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(
      `agent session snapshot ${path} must be a non-empty string of at most ${maxLength} characters`,
    )
  }
  return value
}
