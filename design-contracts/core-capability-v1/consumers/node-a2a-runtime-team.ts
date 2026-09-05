import type {
  AgentRuntime,
  DefinedAgent,
  RuntimeAgentTeam,
  RuntimeCloseReport,
} from '@ai-agent-sdk/core/agent'
import {
  linkA2AAgent,
  type A2AUnlinkReport,
} from '@ai-agent-sdk/a2a/client'
import {
  createDefinedAgentA2AServer,
  type A2ADisposeReport,
  type AgentCard,
  type DefinedAgentA2AServer,
} from '@ai-agent-sdk/a2a/server'

export interface RemoteRuntimeTeamLink {
  readonly unlink: () => void
  readonly unlinkWithReport: () => A2AUnlinkReport
}

/** Compile-only proof that the Node A2A capability links into the new runtime team. */
export async function linkRemoteRuntimeTeam(
  runtime: AgentRuntime,
  team: RuntimeAgentTeam,
): Promise<RemoteRuntimeTeamLink> {
  const logger = runtime.logger({ fields: { integration: 'a2a-client-link' } })
  const { link, unlink, unlinkWithReport } = await linkA2AAgent(team, {
    logger,
    name: 'remote-reviewer',
    agentId: 'reviewer',
    baseUrl: 'https://a2a.example.test',
    allowedOrigins: ['https://a2a.example.test'],
    allowRedirects: false,
    maxStreamEvents: 10_000,
  })
  void link.protocol
  return { unlink, unlinkWithReport }
}

/** Server-side A2A operations receive the same runtime-bound logger explicitly. */
export function createRemoteRuntimeServer(
  runtime: AgentRuntime,
  agent: DefinedAgent,
  agentCard: AgentCard,
): DefinedAgentA2AServer {
  const logger = runtime.logger({ fields: { integration: 'a2a-server' } })
  return createDefinedAgentA2AServer({ agent, agentCard, logger })
}

export interface A2ARuntimeCloseResult {
  readonly runtime: RuntimeCloseReport
  readonly a2a: A2AUnlinkReport
}

/** Runtime close removes the team link; the report handle remains idempotent. */
export async function closeRemoteRuntimeTeam(
  runtime: AgentRuntime,
  unlinkWithReport: () => A2AUnlinkReport,
  signal: AbortSignal,
): Promise<A2ARuntimeCloseResult> {
  let runtimeReport: RuntimeCloseReport | undefined
  let a2aReport: A2AUnlinkReport | undefined
  try {
    runtimeReport = await runtime.close({ signal })
  } finally {
    a2aReport = unlinkWithReport()
  }
  return { runtime: runtimeReport, a2a: a2aReport }
}

export interface A2ARuntimeServerCloseResult {
  readonly runtime: RuntimeCloseReport
  readonly a2a: A2ADisposeReport
}

export async function closeRemoteRuntimeServer(
  runtime: AgentRuntime,
  server: DefinedAgentA2AServer,
  signal: AbortSignal,
): Promise<A2ARuntimeServerCloseResult> {
  let runtimeReport: RuntimeCloseReport | undefined
  let a2aReport: A2ADisposeReport | undefined
  try {
    runtimeReport = await runtime.close({ signal })
  } finally {
    a2aReport = await server.executor.disposeWithReport('runtime closed')
  }
  return { runtime: runtimeReport, a2a: a2aReport }
}
