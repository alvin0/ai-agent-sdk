import type { AgentCard, Message, Part, SendMessageRequest, StreamResponse, Task } from '@a2a-js/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
  type RequestOptions,
} from '@a2a-js/sdk/client'
import type {
  LinkAgentOptions,
  LinkedAgentResult,
  LinkedAgentSendInput,
  LinkedAgentTransport,
  SdkLogger,
  SupportSafeError,
} from '@ai-agent-sdk/core/agent'

export type { AgentCard, Message, Part, SendMessageRequest, StreamResponse, Task }
export {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
  type RequestOptions,
}

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

/** Structural bridge accepted by both legacy AgentTeam and RuntimeAgentTeam. */
export interface A2ALinkableTeam {
  linkAgent(options: LinkAgentOptions): () => void
}

export interface A2AUnlinkReport {
  readonly status: 'unlinked' | 'failed'
  readonly alreadyUnlinked: boolean
  readonly error?: SupportSafeError
}

export declare class A2AAgentLink implements LinkedAgentTransport {
  readonly protocol = 'a2a/1.0'
  readonly agentId: string
  readonly client: Client
  readonly agentCard: AgentCard | undefined
  constructor(client: Client, options: A2AAgentLinkOptions, agentCard?: AgentCard)
  send(input: LinkedAgentSendInput): Promise<LinkedAgentResult>
}

export declare function createA2AAgentLink(
  options: A2AAgentLinkOptions,
): Promise<A2AAgentLink>

export declare function linkA2AAgent(
  team: A2ALinkableTeam,
  options: LinkA2AAgentOptions,
): Promise<{
  readonly link: A2AAgentLink
  /** Preserved compatibility handle. */
  readonly unlink: () => void
  /** Support-safe idempotent evidence for teardown after runtime close. */
  readonly unlinkWithReport: () => A2AUnlinkReport
}>
