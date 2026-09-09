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
    if (!record(activation)) {
      throw new TypeError(`agent session snapshot skills.activated[${index}] must be an object`)
    }
    if (Object.getOwnPropertyDescriptor(activation, 'catalogRevision') !== undefined) {
      captureSkillReference(activation)
      const id = snapshotString(activation.id, `skills.activated[${index}].id`, 256)
      if (ids.has(id)) throw new TypeError(`duplicate activated skill '${id}' in agent session snapshot`)
      ids.add(id)
      continue
    }
    const id = snapshotString(activation.id, `skills.activated[${index}].id`, 256)
    snapshotString(activation.provider, `skills.activated[${index}].provider`, 256)
    snapshotString(activation.source, `skills.activated[${index}].source`, 8_192)
    if (activation.resourceBase !== undefined) {
      if (!record(activation.resourceBase)
        || !['directory', 'url', 'opaque'].includes(String(activation.resourceBase.kind))) {
        throw new TypeError(
          `agent session snapshot skills.activated[${index}].resourceBase is invalid`,
        )
      }
      snapshotString(
        activation.resourceBase.value,
        `skills.activated[${index}].resourceBase.value`,
        8_192,
      )
    }
    if (ids.has(id)) throw new TypeError(`duplicate activated skill '${id}' in agent session snapshot`)
    ids.add(id)
  }
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
