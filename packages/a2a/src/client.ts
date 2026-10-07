import { defaultLimit } from './common/limits.ts'
import { sendStreaming } from './client/stream.ts'
import { contentPart, normalizeResult } from './client/content.ts'
import { nonEmpty, positiveInteger, byteLength, combineSignals, raceWithSignal } from './client/values.ts'
import { validateAgentCard, snapshotLinkOptions, validateEndpoint, endpointFetch } from './client/endpoints.ts'
/** Official A2A Protocol client transport and AgentTeam linking helpers. */

import {
  Role,
  type AgentCard,
  type SendMessageRequest,
} from '@a2a-js/sdk'
import {
  DefaultAgentCardResolver,
  type Client,
  type RequestOptions,
} from '@a2a-js/sdk/client'
import type {
  LinkedAgentResult,
  LinkedAgentSendInput,
  LinkedAgentTransport,
} from '@alvin0/ai-agent-sdk-core/agent'
import { detachedFrozen } from '@alvin0/ai-agent-sdk-core'
import { a2aErrorCode, beginA2AIntegrationOperation } from './common/integration-operation.ts'
import { defaultFactory, unlinkReport } from './client/link-helpers.ts'
import type {
  A2AAgentLinkOptions, A2ALinkableTeam, A2AUnlinkReport, LinkA2AAgentOptions,
} from './client/types.ts'

export type {
  A2AAgentLinkOptions, A2ALinkableTeam, A2AUnlinkReport, LinkA2AAgentOptions,
} from './client/types.ts'

/** A resolved official SDK client presented as an AgentTeam transport. */
export class A2AAgentLink implements LinkedAgentTransport {
  readonly protocol = 'a2a/1.0'
  readonly agentId: string
  readonly client: Client
  readonly agentCard: AgentCard | undefined
  private readonly options: A2AAgentLinkOptions
  private readonly contexts = new Map<string, { readonly id: string; lastAccess: number }>()
  private readonly pendingContextKeys = new Set<string>()
  private readonly timeoutMs: number
  private readonly teardownTimeoutMs: number
  private readonly maxRequestBytes: number
  private readonly maxResponseBytes: number
  private readonly maxTransportBytes: number
  private readonly maxStreamEvents: number
  private readonly maxStreamBytes: number
  private readonly maxContexts: number
  private readonly contextTtlMs: number

  constructor(
    client: Client,
    options: A2AAgentLinkOptions,
    agentCard?: AgentCard,
  ) {
    this.client = client
    this.options = snapshotLinkOptions(options)
    this.agentCard = agentCard === undefined ? undefined : detachedFrozen(agentCard)
    this.agentId = nonEmpty(
      options.agentId ?? agentCard?.name ?? options.baseUrl,
      'A2A linked agent id',
    )
    this.timeoutMs = defaultLimit(options.timeoutMs, 120_000, 'timeoutMs')
    this.teardownTimeoutMs = defaultLimit(options.teardownTimeoutMs, 30_000, 'teardownTimeoutMs')
    this.maxRequestBytes = defaultLimit(options.maxRequestBytes, 1024 * 1024, 'maxRequestBytes')
    this.maxResponseBytes = defaultLimit(options.maxResponseBytes, 1024 * 1024, 'maxResponseBytes')
    this.maxTransportBytes = defaultLimit(options.maxTransportBytes, 16 * 1024 * 1024, 'maxTransportBytes')
    this.maxStreamEvents = defaultLimit(options.maxStreamEvents, 10_000, 'maxStreamEvents')
    this.maxStreamBytes = defaultLimit(options.maxStreamBytes, 8 * 1024 * 1024, 'maxStreamBytes')
    this.maxContexts = defaultLimit(options.maxContexts, 1_000, 'maxContexts')
    this.contextTtlMs = defaultLimit(options.contextTtlMs, 30 * 60_000, 'contextTtlMs')
    if (options.historyLength !== undefined) positiveInteger(options.historyLength, 'historyLength')
  }

  async send(input: LinkedAgentSendInput): Promise<LinkedAgentResult> {
    const operation = beginA2AIntegrationOperation(input.logger, 'a2a-client-link', 'send')
    const attempt = operation.attempt(1)
    let contextKey: string | undefined
    let signal = input.signal
    try {
      input.signal?.throwIfAborted()
      contextKey = JSON.stringify([input.teamId, input.sender])
      const context = this.reserveContext(contextKey)
      const request = this.request(input, context?.id)
      if (byteLength(request) > this.maxRequestBytes) {
        throw new Error(`A2A request exceeds the ${this.maxRequestBytes}-byte limit`)
      }
      signal = combineSignals(input.signal, AbortSignal.timeout(this.timeoutMs))
      const requestOptions = this.requestOptions(signal)
      const result = await this.dispatchRequest(request, requestOptions, input.logger)
      if (byteLength(result) > this.maxResponseBytes) {
        throw new Error(`A2A response exceeds the ${this.maxResponseBytes}-byte limit`)
      }
      if (result.contextId.length > 0) {
        this.contexts.set(contextKey, { id: result.contextId, lastAccess: Date.now() })
      }
      attempt.success(); operation.success()
      return result
    } catch (error: unknown) {
      if (signal?.aborted === true) { attempt.abort(); operation.abort() }
      else {
        const code = a2aErrorCode(error)
        attempt.fail(code); operation.fail(code)
      }
      throw error
    } finally {
      if (contextKey !== undefined) this.pendingContextKeys.delete(contextKey)
    }
  }

  private requestOptions(signal: AbortSignal): RequestOptions {
    return {
      signal,
      ...(this.options.serviceParameters === undefined
        ? {}
        : { serviceParameters: this.options.serviceParameters }),
    }
  }

  private async dispatchRequest(
    request: SendMessageRequest, requestOptions: RequestOptions, logger: LinkedAgentSendInput['logger'],
  ): Promise<LinkedAgentResult> {
    const signal = requestOptions.signal!
    const streaming = this.options.streaming
      ?? this.agentCard?.capabilities?.streaming
      ?? false
    let result: LinkedAgentResult
    if (streaming) {
      const stream = beginA2AIntegrationOperation(logger, 'a2a-client-link', 'stream')
      const streamAttempt = stream.attempt(1)
      try {
        result = await this.sendStreaming(request, requestOptions)
        streamAttempt.success(); stream.success()
      } catch (error: unknown) {
        if (signal.aborted) { streamAttempt.abort(); stream.abort() }
        else {
          const code = a2aErrorCode(error)
          streamAttempt.fail(code); stream.fail(code)
        }
        throw error
      }
    } else {
      const wireResult = await raceWithSignal(this.client.sendMessage(request, requestOptions), signal)
      if (byteLength(wireResult) > this.maxTransportBytes) {
        throw new Error(`A2A transport response exceeds the ${this.maxTransportBytes}-byte limit`)
      }
      result = normalizeResult(wireResult)
    }
    return result
  }

  private request(input: LinkedAgentSendInput, contextId: string | undefined): SendMessageRequest {
    return {
      // Required by the generated A2A request shape; the SDK does not attach a
      // deployment tenancy model to protocol messages.
      tenant: '',
      message: {
        messageId: input.messageId,
        contextId: contextId ?? '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: input.content.map(contentPart),
        metadata: {
          teamId: input.teamId,
          sender: input.sender,
          senderAgentId: input.senderAgentId,
        },
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: [...this.options.acceptedOutputModes ?? ['text/plain', 'application/json']],
        taskPushNotificationConfig: undefined,
        ...(this.options.historyLength === undefined ? {} : { historyLength: this.options.historyLength }),
        returnImmediately: false,
      },
      metadata: { teamId: input.teamId, sender: input.sender },
    }
  }

  private sendStreaming(request: SendMessageRequest, options: RequestOptions): Promise<LinkedAgentResult> {
    return sendStreaming(this.client, request, options, {
      maxStreamEvents: this.maxStreamEvents, maxStreamBytes: this.maxStreamBytes,
      teardownTimeoutMs: this.teardownTimeoutMs, onStreamEvent: this.options.onStreamEvent,
    })
  }

  private reserveContext(key: string): { readonly id: string; lastAccess: number } | undefined {
    const now = Date.now()
    for (const [candidate, value] of this.contexts) {
      if (now - value.lastAccess >= this.contextTtlMs) this.contexts.delete(candidate)
    }
    const existing = this.contexts.get(key)
    if (existing !== undefined) {
      existing.lastAccess = now
      return existing
    }
    if (!this.pendingContextKeys.has(key)
      && this.contexts.size + this.pendingContextKeys.size >= this.maxContexts) {
      throw new Error(`A2A link reached its ${this.maxContexts}-context limit`)
    }
    this.pendingContextKeys.add(key)
    return undefined
  }
}

/** Discover an Agent Card and construct a protocol link with official transports. */
export async function createA2AAgentLink(options: A2AAgentLinkOptions): Promise<A2AAgentLink> {
  const operation = beginA2AIntegrationOperation(options.logger, 'a2a-client-link', 'agent-card-resolve')
  const attempt = operation.attempt(1)
  try {
    const link = await resolveAgentLink(options)
    attempt.success(); operation.success()
    return link
  } catch (error: unknown) {
    const code = a2aErrorCode(error)
    attempt.fail(code); operation.fail(code)
    throw error
  }
}

/** Discover and add a remote A2A peer to the same roster local agents use. */
export async function linkA2AAgent(
  team: A2ALinkableTeam,
  options: LinkA2AAgentOptions,
): Promise<{ readonly link: A2AAgentLink; readonly unlink: () => void;
  readonly unlinkWithReport: () => A2AUnlinkReport }> {
  const linkOperation = beginA2AIntegrationOperation(options.logger, 'a2a-client-link', 'link')
  const linkAttempt = linkOperation.attempt(1)
  let link: A2AAgentLink
  let removeLink: () => void
  try {
    link = await createA2AAgentLink(options)
    removeLink = team.linkAgent({
      name: options.name,
      transport: link,
      ...(options.description === undefined ? {} : { description: options.description }),
    })
    linkAttempt.success(); linkOperation.success()
  } catch (error: unknown) {
    const code = a2aErrorCode(error)
    linkAttempt.fail(code); linkOperation.fail(code)
    throw error
  }
  let report: A2AUnlinkReport | undefined
  const unlink = (): void => {
    if (report !== undefined) return
    const operation = beginA2AIntegrationOperation(options.logger, 'a2a-client-link', 'unlink')
    const attempt = operation.attempt(1)
    try {
      removeLink()
      report = unlinkReport('unlinked', false)
      attempt.success(); operation.success()
    } catch (error) {
      report = unlinkReport('failed', false)
      const code = a2aErrorCode(error)
      attempt.fail(code); operation.fail(code)
      throw error
    }
  }
  const unlinkWithReport = (): A2AUnlinkReport => {
    if (report !== undefined) return unlinkReport(report.status, true, report.error)
    const operation = beginA2AIntegrationOperation(options.logger, 'a2a-client-link', 'unlink')
    const attempt = operation.attempt(1)
    try {
      removeLink()
      report = unlinkReport('unlinked', false)
      attempt.success(); operation.success()
    } catch (error: unknown) {
      report = unlinkReport('failed', false)
      const code = a2aErrorCode(error)
      attempt.fail(code); operation.fail(code)
    }
    return report
  }
  return Object.freeze({ link, unlink, unlinkWithReport })
}

export {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
  type RequestOptions,
} from '@a2a-js/sdk/client'
export type {
  AgentCard,
  Message,
  Part,
  SendMessageRequest,
  StreamResponse,
  Task,
} from '@a2a-js/sdk'

async function resolveAgentLink(options: A2AAgentLinkOptions): Promise<A2AAgentLink> {
  options = snapshotLinkOptions(options)
  const sources = [options.client, options.agentCard, options.baseUrl].filter(value => value !== undefined)
  if (sources.length !== 1) {
    throw new TypeError('createA2AAgentLink requires exactly one of client, agentCard, or baseUrl')
  }
  if (options.client !== undefined) {
    const link = new A2AAgentLink(options.client, options)
    return link
  }
  if (options.agentCard !== undefined) {
    const cardOptions: A2AAgentLinkOptions = { ...options }
    validateAgentCard(options.agentCard, cardOptions)
    const guardedFetch = endpointFetch(options.fetch ?? globalThis.fetch, cardOptions)
    const factory = options.clientFactory ?? defaultFactory({ ...cardOptions, fetch: guardedFetch })
    const signal = AbortSignal.timeout(defaultLimit(options.timeoutMs, 120_000, 'timeoutMs'))
    const link = new A2AAgentLink(
      await raceWithSignal(factory.createFromAgentCard(options.agentCard), signal),
      cardOptions,
      options.agentCard,
    )
    return link
  }
  const baseUrl = validateEndpoint(options.baseUrl as string, options)
  const discoveryOptions: A2AAgentLinkOptions = { ...options }
  const guardedFetch = endpointFetch(options.fetch ?? globalThis.fetch, discoveryOptions)
  const resolver = new DefaultAgentCardResolver({
    fetchImpl: guardedFetch,
    legacyCompat: { enabled: options.legacyCompat ?? false },
  })
  const signal = AbortSignal.timeout(defaultLimit(options.timeoutMs, 120_000, 'timeoutMs'))
  const agentCard = await raceWithSignal(resolver.resolve(baseUrl.href, options.cardPath), signal)
  validateAgentCard(agentCard, discoveryOptions)
  const factory = options.clientFactory ?? defaultFactory({ ...discoveryOptions, fetch: guardedFetch })
  const client = await raceWithSignal(factory.createFromAgentCard(agentCard), signal)
  const link = new A2AAgentLink(client, discoveryOptions, agentCard)
  return link
}
