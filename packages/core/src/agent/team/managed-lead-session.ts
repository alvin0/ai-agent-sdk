/** Lead session assembly, including host observations and the selected model port. */
import type { AgentSession, AgentSessionOptions } from '../define/session.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import type { TeamPort } from './contracts.ts'
import type { AgentTeam } from './team.ts'
import type { ManagedAgentTeamOptions } from './managed-types.ts'
import { managedLeadInstructions } from './managed-controls.ts'
import { leanLeadInstructions } from './managed-model-tools.ts'
import { observeTeamSession } from './team-observation-internal.ts'

export function createManagedLeadSession(options: ManagedAgentTeamOptions, control: {
  team: AgentTeam; name: string; port: TeamPort; tools: ToolCatalog; hooks: AgentSessionOptions['hooks']
}): AgentSession {
  return options.lead.createSession(observeTeamSession(control.team, control.name, {
    ...options.leadSessionOptions,
    runtimeLimits: { ...options.leadSessionOptions?.runtimeLimits,
      finalizeSteps: options.leadSessionOptions?.runtimeLimits?.finalizeSteps ?? 0 },
    ...control.hooks === undefined ? {} : { hooks: control.hooks }, registry: options.registry, tools: control.tools,
    team: {
      team: control.port, name: control.name, role: 'lead',
      instructions: options.modelToolSurface === 'legacy'
        ? managedLeadInstructions(options) : leanLeadInstructions(options),
      ...(options.leadDescription === undefined ? {} : { description: options.leadDescription }),
    },
  }))
}
