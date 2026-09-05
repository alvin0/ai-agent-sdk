import {
  createAgentRuntime,
  defineAgent,
  defineSkill,
  defineTool,
  type RunReport,
  type RuntimeAgent,
  type RuntimeAgentSession,
  type SdkLogger,
} from '@ai-agent-sdk/core'
import type { AgentSession, ManagedAgentTeam } from '@ai-agent-sdk/core/agent'
import type { Observability } from '@ai-agent-sdk/core/observability'

/** Normal applications get the complete everyday agent path from the root. */
export const rootAgentHelpers = {
  createAgentRuntime,
  defineAgent,
  defineSkill,
  defineTool,
}

/** Advanced compatibility APIs remain reachable through focused subpaths. */
export type FocusedAdvancedSurfaces = {
  readonly runtimeAgent: RuntimeAgent
  readonly runtimeSession: RuntimeAgentSession
  readonly report: RunReport
  readonly logger: SdkLogger
  readonly legacySession: AgentSession
  readonly managedTeam: ManagedAgentTeam
  readonly observability: Observability
}

// @ts-expect-error Managed worker orchestration is not part of the curated root.
export type RootMustNotExposeManagedAgentTeam = import('@ai-agent-sdk/core').ManagedAgentTeam

// @ts-expect-error Mutable observability construction is an advanced focused API.
export type RootMustNotExposeObservability = import('@ai-agent-sdk/core').Observability
