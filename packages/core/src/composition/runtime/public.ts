import { createRuntimeCompositionOwner } from './owner.ts'
import type { AgentRuntime, AgentRuntimeOptions } from './types.ts'

/** Construct the immutable public composition facade; mutable internals stay closure-owned. */
export async function createAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const owner = await createRuntimeCompositionOwner(options)
  const facade: AgentRuntime = {
    providers: () => owner.providers(),
    modelCatalog: (route, catalogOptions) => owner.modelCatalog(route, catalogOptions),
    agent: definition => owner.agent(definition),
    team: teamOptions => owner.team(teamOptions),
    logger: context => owner.logger(context),
    diagnostics: () => owner.diagnostics(),
    close: closeOptions => owner.close(closeOptions),
  }
  return Object.freeze(facade)
}
