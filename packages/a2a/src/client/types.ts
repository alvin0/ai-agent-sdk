import type { AgentCard, StreamResponse } from '@a2a-js/sdk'
import type { Client, ClientFactory, RequestOptions } from '@a2a-js/sdk/client'
import type { LinkAgentOptions } from '@ai-agent-sdk/core/agent'
import type { SdkLogger, SupportSafeError } from '@ai-agent-sdk/core'

export interface A2AAgentLinkOptions {
  readonly logger?: SdkLogger
  readonly agentId?: string
  readonly baseUrl?: string
  readonly cardPath?: string
  readonly agentCard?: AgentCard
  readonly client?: Client
  readonly clientFactory?: ClientFactory
  readonly fetch?: typeof fetch
  readonly legacyCompat?: boolean
  readonly allowedOrigins?: readonly string[]
  readonly requireHttps?: boolean
  readonly allowPrivateNetwork?: boolean
  readonly allowRedirects?: boolean
  readonly validateEndpoint?: (url: URL) => void
  readonly timeoutMs?: number
  readonly teardownTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxStreamEvents?: number
  readonly maxStreamBytes?: number
  readonly maxTransportBytes?: number
  readonly maxContexts?: number
  readonly contextTtlMs?: number
  readonly streaming?: boolean
  readonly acceptedOutputModes?: readonly string[]
  readonly historyLength?: number
  readonly serviceParameters?: RequestOptions['serviceParameters']
  readonly onStreamEvent?: (event: StreamResponse) => void
}

export interface LinkA2AAgentOptions extends A2AAgentLinkOptions {
  readonly name: string
  readonly description?: string
}

export interface A2ALinkableTeam {
  linkAgent(options: LinkAgentOptions): () => void
}

export interface A2AUnlinkReport {
  readonly status: 'unlinked' | 'failed'
  readonly alreadyUnlinked: boolean
  readonly error?: SupportSafeError
}
