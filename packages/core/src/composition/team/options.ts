import { memberName } from '../../agent/team/common.ts'
import { arrayData, boundedText, objectValue, ownData } from '../common/data.ts'
import { captureRuntimeSessionOptions } from '../agent/options.ts'
import { capabilityIdentityError } from '../identity/error.ts'
import type { AgentTeamMemberInput, RuntimeAgentTeamEvent, RuntimeAgentTeamOptions } from './types.ts'
import { RUNTIME_TEAM_LIMITS } from './config.ts'

const ROOT_KEYS = new Set(['id', 'members', 'maxMessages', 'maxMessageBytes', 'operationTimeoutMs',
  'observerTimeoutMs', 'onEvent'])
const MEMBER_KEYS = new Set(['name', 'agent', 'description', 'instructions', 'role', 'tools', 'session'])

export interface CapturedTeamMember extends AgentTeamMemberInput {
  readonly role: 'lead' | 'peer'
  readonly session: NonNullable<AgentTeamMemberInput['session']>
}

export interface CapturedRuntimeTeamOptions extends RuntimeAgentTeamOptions {
  readonly members: readonly CapturedTeamMember[]
  readonly onEvent?: (event: RuntimeAgentTeamEvent) => void
}

export function captureRuntimeTeamOptions(value: unknown): CapturedRuntimeTeamOptions {
  const source = objectValue(value)
  rejectUnknown(source, ROOT_KEYS)
  const id = boundedText(ownData(source, 'id'), RUNTIME_TEAM_LIMITS.idBytes)
  const members = arrayData(ownData(source, 'members'), RUNTIME_TEAM_LIMITS.members)
  if (members.length === 0) throw new TypeError('Runtime team requires at least one member')
  const seen = new Map<string, number>()
  let leads = 0
  const captured = members.map((raw, index): CapturedTeamMember => {
    const member = objectValue(raw)
    rejectUnknown(member, MEMBER_KEYS)
    const name = memberName(ownData(member, 'name'))
    const first = seen.get(name)
    if (first !== undefined) throw capabilityIdentityError(
      'TEAM_MEMBER_CONFLICT', 'team-member-name', first, index,
    )
    seen.set(name, index)
    const role = ownData(member, 'role', false) ?? (index === 0 ? 'lead' : 'peer')
    if (role !== 'lead' && role !== 'peer') throw new TypeError('Runtime team member role is invalid')
    if (role === 'lead' && ++leads > 1) throw new TypeError('Runtime team has more than one lead')
    const description = optionalBounded(member, 'description')
    const instructions = optionalBounded(member, 'instructions')
    const tools = ownData(member, 'tools', false)
    if (tools !== undefined && typeof tools !== 'boolean'
      && tools !== 'full' && tools !== 'reporting') {
      throw new TypeError('Runtime team tools flag is invalid')
    }
    return Object.freeze({ name, agent: ownData(member, 'agent') as AgentTeamMemberInput['agent'], role,
      session: captureRuntimeSessionOptions(ownData(member, 'session', false)),
      ...(description === undefined ? {} : { description }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(tools === undefined ? {} : { tools }) })
  })
  const callback = ownData(source, 'onEvent', false)
  if (callback !== undefined && typeof callback !== 'function') throw new TypeError('Runtime team observer is invalid')
  const onEvent = callback === undefined ? undefined
    : (event: RuntimeAgentTeamEvent): void => { Reflect.apply(callback, source, [event]) }
  return Object.freeze({ id, members: Object.freeze(captured),
    ...copyPositive(source, ['maxMessages', 'maxMessageBytes', 'operationTimeoutMs', 'observerTimeoutMs']),
    ...(onEvent === undefined ? {} : { onEvent }) })
}

function optionalBounded(source: object, key: string): string | undefined {
  const value = ownData(source, key, false)
  return value === undefined ? undefined : boundedText(value, RUNTIME_TEAM_LIMITS.metadataBytes)
}

function copyPositive(source: object, keys: readonly string[]): Record<string, number> {
  const output: Record<string, number> = Object.create(null) as Record<string, number>
  for (const key of keys) {
    const value = ownData(source, key, false)
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`Runtime team ${key} is invalid`)
    output[key] = Number(value)
  }
  return output
}

function rejectUnknown(source: object, keys: ReadonlySet<string>): void {
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !keys.has(key))) {
    throw new TypeError('Runtime team options contain unsupported fields')
  }
}
