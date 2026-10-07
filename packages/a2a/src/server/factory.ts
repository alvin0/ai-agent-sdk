import type { AgentCard } from '@a2a-js/sdk'
import { DefaultRequestHandler, InMemoryTaskStore, type TaskStore } from '@a2a-js/sdk/server'
import { DefinedAgentA2AExecutor } from './executor.ts'
import type { DefinedAgentA2AExecutorOptions } from './types.ts'
import { assertSecurityRequirements } from './agent-card.ts'

export interface DefinedAgentA2AServerOptions extends DefinedAgentA2AExecutorOptions {
  readonly agentCard: AgentCard
  readonly taskStore?: TaskStore
}

export interface DefinedAgentA2AServer {
  readonly agentCard: AgentCard
  readonly executor: DefinedAgentA2AExecutor
  readonly taskStore: TaskStore
  readonly requestHandler: DefaultRequestHandler
}

/** Assemble the transport-neutral official A2A server components. */
export function createDefinedAgentA2AServer(
  options: DefinedAgentA2AServerOptions,
): DefinedAgentA2AServer {
  assertSecurityRequirements(
    options.agentCard.securitySchemes,
    options.agentCard.securityRequirements,
  )
  const taskStore = options.taskStore ?? new InMemoryTaskStore()
  const executor = new DefinedAgentA2AExecutor(options)
  return {
    agentCard: options.agentCard,
    executor,
    taskStore,
    requestHandler: new DefaultRequestHandler(options.agentCard, taskStore, executor),
  }
}
