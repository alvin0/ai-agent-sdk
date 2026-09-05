import type { AgentRuntime, RuntimeAgentDefinition } from '@ai-agent-sdk/core/agent'
import { MEMORY_STORE_API_VERSION, type MemoryStore } from '@ai-agent-sdk/core/memory'
import { OBSERVATION_EXPORTER_API_VERSION, type ObservationExporterPlugin } from '@ai-agent-sdk/core/observability'
import {
  CREDENTIAL_CAPABILITY_API_VERSION,
  PROVIDER_PLUGIN_API_VERSION,
  type ComposableModelProviderPlugin,
  type CredentialSource,
  type CredentialStore,
  type ModelProviderPlugin,
} from '@ai-agent-sdk/core/provider'
import { SKILL_PROVIDER_API_VERSION, type SkillProviderPlugin } from '@ai-agent-sdk/core/skills'
import { TOOL_SOURCE_API_VERSION, type ToolSource } from '@ai-agent-sdk/core/tools'

/** Compile-only proof that advanced/package authors need no deep internal imports. */
export interface CoreSubpathSurface {
  readonly runtime: AgentRuntime
  readonly agent: RuntimeAgentDefinition
  readonly provider: ModelProviderPlugin
  readonly composableProvider: ComposableModelProviderPlugin
  readonly credentialSource: CredentialSource
  readonly credentialStore: CredentialStore<unknown>
  readonly skills: SkillProviderPlugin
  readonly memory: MemoryStore
  readonly exporter: ObservationExporterPlugin
  readonly toolSource: ToolSource
}

export const coreFamilyVersions = Object.freeze({
  provider: PROVIDER_PLUGIN_API_VERSION,
  credentials: CREDENTIAL_CAPABILITY_API_VERSION,
  skills: SKILL_PROVIDER_API_VERSION,
  memory: MEMORY_STORE_API_VERSION,
  exporter: OBSERVATION_EXPORTER_API_VERSION,
  toolSource: TOOL_SOURCE_API_VERSION,
})
