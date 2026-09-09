import type { NativeToolSchema } from '../../contract/tool.ts'
import { SKILL_TOOL_NAMES } from '../../agent/skill/tools.ts'
import type { ToolDefinition } from '../../agent/tool/definition.ts'
import type { RuntimeSkillSource } from '../skill-provider/types.ts'
import { assertCapabilityIdentityNamespace } from './error.ts'

interface AgentIdentitySnapshot {
  readonly tools?: readonly ToolDefinition[]
  readonly nativeTools?: readonly NativeToolSchema[]
  readonly skills?: readonly RuntimeSkillSource[]
  readonly allowedSkillIds?: readonly string[]
  readonly additionalToolNames?: readonly string[]
}

/** Validate the executable identities visible in one immutable agent/session snapshot. */
export function assertAgentIdentitySnapshot(input: AgentIdentitySnapshot): void {
  const skills = input.skills ?? []
  const skillRuntimeEnabled = input.allowedSkillIds?.length !== 0
    && (skills.length > 0 || (input.allowedSkillIds?.length ?? 0) > 0)
  assertCapabilityIdentityNamespace('TOOL_NAME_CONFLICT', 'tool-name', [
    ...input.tools?.map(tool => tool.name) ?? [],
    ...input.nativeTools?.map(tool => tool.name) ?? [],
    ...input.additionalToolNames ?? [],
    ...(skillRuntimeEnabled ? SKILL_TOOL_NAMES : []),
  ])
  assertCapabilityIdentityNamespace('SKILL_ID_CONFLICT', 'skill-id', skills
    .filter(source => source.kind === 'skill').map(source => source.id))
  assertCapabilityIdentityNamespace('SKILL_PROVIDER_ID_CONFLICT', 'skill-provider-id', skills
    .filter(source => source.kind === 'skill-provider').map(source => source.id))
}
