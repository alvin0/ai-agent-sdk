import {
  A2AAgentLink,
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createA2AAgentLink,
  linkA2AAgent,
  type A2AAgentLinkOptions,
  type LinkA2AAgentOptions,
} from '@compat/a2a-client'
import {
  A2A_PROTOCOL_VERSION,
  DefaultExecutionEventBus,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  DefinedAgentA2AExecutor,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  Role,
  ServerCallContext,
  TaskState,
  createAgentCardFromDefinition,
  createDefinedAgentA2AServer,
  type AgentCardFromDefinitionOptions,
  type DefinedAgentA2AExecutorOptions,
  type DefinedAgentA2AServer,
  type DefinedAgentA2AServerOptions,
} from '@compat/a2a-server'
import * as Root from '@compat/a2a-root'

export type A2aCompatibilityTypes = [
  A2AAgentLinkOptions,
  LinkA2AAgentOptions,
  AgentCardFromDefinitionOptions,
  DefinedAgentA2AExecutorOptions,
  DefinedAgentA2AServer,
  DefinedAgentA2AServerOptions,
]

export const a2aCompatibilityValues = {
  A2AAgentLink,
  A2A_PROTOCOL_VERSION,
  ClientFactory,
  DefaultAgentCardResolver,
  DefaultExecutionEventBus,
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  DefinedAgentA2AExecutor,
  InMemoryTaskStore,
  JsonRpcTransportFactory,
  JsonRpcTransportHandler,
  RestTransportFactory,
  Role,
  ServerCallContext,
  TaskState,
  createA2AAgentLink,
  createAgentCardFromDefinition,
  createDefinedAgentA2AServer,
  linkA2AAgent,
  Root,
}

const clientOptions: A2AAgentLinkOptions = {
  baseUrl: 'https://a2a.example.test',
  allowedOrigins: ['https://a2a.example.test'],
  maxStreamEvents: 10_000,
  allowRedirects: false,
}

/** Representative existing client lifecycle and bound controls. */
export async function exerciseA2aClient(): Promise<void> {
  const link = await createA2AAgentLink(clientOptions)
  void link.protocol
  void link.agentCard
  void link.client
}

/** Representative existing server lifecycle, including its explicit disposer. */
export async function exerciseA2aServer(
  executor: DefinedAgentA2AExecutor,
): Promise<void> {
  await executor.dispose('compatibility')
}
