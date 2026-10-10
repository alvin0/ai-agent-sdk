import { renderSkillCatalog, type SkillCatalog } from '../../skill/index.ts'
import type { AgentDefinition } from '../definition.ts'
import { appendRunInstructions } from '../instructions.ts'
import type { AgentSessionOptions } from './types.ts'

interface SessionInstructionInput {
  readonly definition: AgentDefinition
  readonly skills: SkillCatalog | undefined
  readonly team: AgentSessionOptions['team']
}

export function sessionSystemInstructions(input: SessionInstructionInput, additionalInstructions?: string): string {
  const { definition, skills, team } = input
  const base = skills === undefined
    ? definition.instructions
    : renderSkillCatalog(definition.instructions, skills.summaries(), definition.skillOptions)
  const composed = team === undefined
    ? base
    : `${base}\n\n${team.team.instructionsFor(team.name ?? definition.id)}`
  return appendRunInstructions(composed, additionalInstructions)
}
