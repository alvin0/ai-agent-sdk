/** Official A2A Protocol client transport and AgentTeam linking helpers. */

import {
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
} from '@a2a-js/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
  type RequestOptions,
} from '@a2a-js/sdk/client'
import type {
  AgentTeam,
  LinkedAgentResult,
  LinkedAgentSendInput,
  LinkedAgentTransport,
} from '@ai-agent-sdk/agent'
import type { ContentBlock } from '@ai-agent-sdk/core'
import { detachedFrozen } from '@ai-agent-sdk/core'
import { waitForSettlement } from '@ai-agent-sdk/core'

export interface A2AAgentLinkOptions {
  /** Stable id exposed in AgentTeam roster; defaults to card name or base URL. */
  readonly agentId?: string
  readonly baseUrl?: string
  readonly cardPath?: string
  readonly agentCard?: AgentCard
  readonly client?: Client
  readonly clientFactory?: ClientFactory
  readonly fetch?: typeof fetch
  /** Enables official v0.3 compatibility in JSON-RPC and REST factories. */
  readonly legacyCompat?: boolean
  /** Exact origins permitted for discovery and advertised interfaces. */
  readonly allowedOrigins?: readonly string[]
  /** Opt-in host policy requiring https:// endpoints. */
  readonly requireHttps?: boolean
  /** Set false for a public-internet policy that rejects local/private endpoint literals. */
  readonly allowPrivateNetwork?: boolean
  /** Set false to reject HTTP redirects at the fetch boundary. */
  readonly allowRedirects?: boolean
  /** Additional synchronous endpoint policy invoked after built-in validation. */
  readonly validateEndpoint?: (url: URL) => void
  /** Per-call timeout. Defaults to 120 seconds. */
  readonly timeoutMs?: number
  /** Maximum wait for an uncooperative stream/body teardown. Defaults to 30 seconds. */
  readonly teardownTimeoutMs?: number
  /** Maximum serialized outbound request size. Defaults to 1 MiB. */
  readonly maxRequestBytes?: number
  /** Maximum normalized response text size. Defaults to 1 MiB. */
  readonly maxResponseBytes?: number
  /** Maximum events accepted from one stream. Defaults to 10,000. */
  readonly maxStreamEvents?: number
  /** Maximum cumulative serialized stream bytes. Defaults to 8 MiB. */
  readonly maxStreamBytes?: number
  /** Maximum bytes read from one HTTP response body. Defaults to 16 MiB. */
  readonly maxTransportBytes?: number
  /** Maximum resumable sender contexts retained by this link. Defaults to 1,000. */
  readonly maxContexts?: number
  /** Idle context retention. Defaults to 30 minutes. */
  readonly contextTtlMs?: number
  /** Defaults to the discovered card's streaming capability. */
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
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, 'timeoutMs')
    this.teardownTimeoutMs = positiveInteger(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
    this.maxRequestBytes = positiveInteger(options.maxRequestBytes ?? 1024 * 1024, 'maxRequestBytes')
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes ?? 1024 * 1024, 'maxResponseBytes')
    this.maxTransportBytes = positiveInteger(options.maxTransportBytes ?? 16 * 1024 * 1024, 'maxTransportBytes')
    this.maxStreamEvents = positiveInteger(options.maxStreamEvents ?? 10_000, 'maxStreamEvents')
    this.maxStreamBytes = positiveInteger(options.maxStreamBytes ?? 8 * 1024 * 1024, 'maxStreamBytes')
    this.maxContexts = positiveInteger(options.maxContexts ?? 1_000, 'maxContexts')
    this.contextTtlMs = positiveInteger(options.contextTtlMs ?? 30 * 60_000, 'contextTtlMs')
    if (options.historyLength !== undefined) positiveInteger(options.historyLength, 'historyLength')
  }

  async send(input: LinkedAgentSendInput): Promise<LinkedAgentResult> {
    input.signal?.throwIfAborted()
    const contextKey = JSON.stringify([input.teamId, input.sender])
    const context = this.reserveContext(contextKey)
    const request = this.request(input, context?.id)
    if (byteLength(request) > this.maxRequestBytes) {
      this.pendingContextKeys.delete(contextKey)
      throw new Error(`A2A request exceeds the ${this.maxRequestBytes}-byte limit`)
    }
    const signal = combineSignals(input.signal, AbortSignal.timeout(this.timeoutMs))
    const requestOptions: RequestOptions = {
      signal,
      ...(this.options.serviceParameters === undefined
        ? {}
        : { serviceParameters: this.options.serviceParameters }),
    }
    const streaming = this.options.streaming
      ?? this.agentCard?.capabilities?.streaming
      ?? false
    try {
      let result: LinkedAgentResult
      if (streaming) {
        result = await this.sendStreaming(request, requestOptions)
      } else {
        const wireResult = await raceWithSignal(this.client.sendMessage(request, requestOptions), signal)
        if (byteLength(wireResult) > this.maxTransportBytes) {
          throw new Error(`A2A transport response exceeds the ${this.maxTransportBytes}-byte limit`)
        }
        result = normalizeResult(wireResult)
      }
      if (byteLength(result) > this.maxResponseBytes) {
        throw new Error(`A2A response exceeds the ${this.maxResponseBytes}-byte limit`)
      }
      if (result.contextId.length > 0) {
        this.contexts.set(contextKey, { id: result.contextId, lastAccess: Date.now() })
      }
      return result
    } finally {
      this.pendingContextKeys.delete(contextKey)
    }
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

  private async sendStreaming(
    request: SendMessageRequest,
    options: RequestOptions,
  ): Promise<LinkedAgentResult> {
    let lastTask: Task | undefined
    let lastMessage: Message | undefined
    let taskId = ''
    let contextId = request.message?.contextId ?? ''
    let state: TaskState | undefined
    const streamedArtifactText: string[] = []
    const streamedStatusText: string[] = []
    let eventCount = 0
    let streamBytes = 0
    const iterator = this.client.sendMessageStream(request, options)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const next = await raceWithSignal(iterator.next(), options.signal)
        if (next.done === true) {
          exhausted = true
          break
        }
        const rawEvent = next.value
        eventCount++
        streamBytes += byteLength(rawEvent)
        if (eventCount > this.maxStreamEvents) {
          throw new Error(`A2A stream exceeds the ${this.maxStreamEvents}-event limit`)
        }
        if (streamBytes > this.maxStreamBytes) {
          throw new Error(`A2A stream exceeds the ${this.maxStreamBytes}-byte limit`)
        }
        // A diagnostic observer must never be able to mutate the protocol value
        // before transport state is reduced from it.
        const event = detachedFrozen(rawEvent)
        try { this.options.onStreamEvent?.(event) } catch { /* observers do not own transport correctness */ }
        const payload = event.payload
        if (payload?.$case === 'task') {
          lastTask = payload.value
          taskId = payload.value.id
          contextId = payload.value.contextId
          state = payload.value.status?.state
        } else if (payload?.$case === 'message') {
          lastMessage = payload.value
          contextId = payload.value.contextId
          taskId = payload.value.taskId
        } else if (payload?.$case === 'statusUpdate') {
          taskId = payload.value.taskId
          contextId = payload.value.contextId
          state = payload.value.status?.state
          const text = textOfMessage(payload.value.status?.message)
          if (text.length > 0) streamedStatusText.push(text)
        } else if (payload?.$case === 'artifactUpdate') {
          taskId = payload.value.taskId
          contextId = payload.value.contextId
          const text = textOfParts(payload.value.artifact?.parts ?? [])
          if (text.length > 0) streamedArtifactText.push(text)
        }
      }
    } finally {
      if (!exhausted) {
        const close = iterator.return?.bind(iterator)
        if (close !== undefined) {
          const settled = await waitForSettlement(
            Promise.resolve().then(async () => { await close() }),
            this.teardownTimeoutMs,
          )
          if (!settled) {
            throw new Error(`A2A stream teardown exceeded ${this.teardownTimeoutMs}ms`)
          }
        }
      }
    }
    if (lastMessage !== undefined && (state === undefined || taskId.length === 0)) {
      return normalizeMessage(lastMessage)
    }
    if (lastMessage !== undefined) {
      return Object.freeze({
        kind: 'task',
        succeeded: state === TaskState.TASK_STATE_COMPLETED,
        text: textOfMessage(lastMessage) || streamedArtifactText.join('') || streamedStatusText.at(-1) || '',
        contextId,
        taskId,
        ...(state === undefined ? {} : { state: taskStateName(state) }),
      })
    }
    if (lastTask !== undefined) {
      const normalized = normalizeTask(lastTask)
      const streamed = streamedArtifactText.join('') || streamedStatusText.at(-1) || ''
      const effectiveState = state ?? lastTask.status?.state
      return Object.freeze({
        ...normalized,
        succeeded: effectiveState === TaskState.TASK_STATE_COMPLETED,
        text: normalized.text || streamed,
        ...(effectiveState === undefined ? {} : { state: taskStateName(effectiveState) }),
      })
    }
    if (taskId.length === 0) throw new Error('A2A stream ended without a message or task')
    return Object.freeze({
      kind: 'task',
      succeeded: state === TaskState.TASK_STATE_COMPLETED,
      text: streamedArtifactText.join('') || streamedStatusText.at(-1) || '',
      contextId,
      taskId,
      ...(state === undefined ? {} : { state: taskStateName(state) }),
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
  options = snapshotLinkOptions(options)
  const sources = [options.client, options.agentCard, options.baseUrl].filter(value => value !== undefined)
  if (sources.length !== 1) {
    throw new TypeError('createA2AAgentLink requires exactly one of client, agentCard, or baseUrl')
  }
  if (options.client !== undefined) return new A2AAgentLink(options.client, options)
  if (options.agentCard !== undefined) {
    const cardOptions: A2AAgentLinkOptions = { ...options }
    validateAgentCard(options.agentCard, cardOptions)
    const guardedFetch = endpointFetch(options.fetch ?? globalThis.fetch, cardOptions)
    const factory = options.clientFactory ?? defaultFactory({ ...cardOptions, fetch: guardedFetch })
    const signal = AbortSignal.timeout(positiveInteger(options.timeoutMs ?? 120_000, 'timeoutMs'))
    return new A2AAgentLink(
      await raceWithSignal(factory.createFromAgentCard(options.agentCard), signal),
      cardOptions,
      options.agentCard,
    )
  }
  const baseUrl = validateEndpoint(options.baseUrl as string, options)
  const discoveryOptions: A2AAgentLinkOptions = { ...options }
  const guardedFetch = endpointFetch(options.fetch ?? globalThis.fetch, discoveryOptions)
  const resolver = new DefaultAgentCardResolver({
    fetchImpl: guardedFetch,
    legacyCompat: { enabled: options.legacyCompat ?? false },
  })
  const signal = AbortSignal.timeout(positiveInteger(options.timeoutMs ?? 120_000, 'timeoutMs'))
  const agentCard = await raceWithSignal(resolver.resolve(baseUrl.href, options.cardPath), signal)
  validateAgentCard(agentCard, discoveryOptions)
  const factory = options.clientFactory ?? defaultFactory({ ...discoveryOptions, fetch: guardedFetch })
  const client = await raceWithSignal(factory.createFromAgentCard(agentCard), signal)
  return new A2AAgentLink(client, discoveryOptions, agentCard)
}

/** Discover and add a remote A2A peer to the same roster local agents use. */
export async function linkA2AAgent(
  team: AgentTeam,
  options: LinkA2AAgentOptions,
): Promise<{ readonly link: A2AAgentLink; readonly unlink: () => void }> {
  const link = await createA2AAgentLink(options)
  const unlink = team.linkAgent({
    name: options.name,
    transport: link,
    ...(options.description === undefined ? {} : { description: options.description }),
  })
  return Object.freeze({ link, unlink })
}

function defaultFactory(options: A2AAgentLinkOptions): ClientFactory {
  const transportOptions = {
    ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
    legacyCompat: { enabled: options.legacyCompat ?? false },
  }
  return new ClientFactory({
    transports: [
      new JsonRpcTransportFactory(transportOptions),
      new RestTransportFactory(transportOptions),
    ],
  })
}

function contentPart(block: ContentBlock): Part {
  if (block.type === 'text') return part({ $case: 'text', value: block.text }, 'text/plain')
  if (block.type === 'image') {
    if (block.source.kind === 'url') return part({ $case: 'url', value: block.source.url }, 'image/*')
    if (block.source.kind === 'base64') {
      return part(
        { $case: 'url', value: `data:${block.source.mediaType};base64,${block.source.data}` },
        block.source.mediaType,
      )
    }
    return part({ $case: 'data', value: { type: 'image-file', fileId: block.source.fileId } }, 'application/json')
  }
  return part({ $case: 'data', value: structuredClone(block) }, 'application/json')
}

function part(content: NonNullable<Part['content']>, mediaType: string): Part {
  return { content, metadata: undefined, filename: '', mediaType }
}

function normalizeResult(result: Message | Task): LinkedAgentResult {
  return 'messageId' in result ? normalizeMessage(result) : normalizeTask(result)
}

function normalizeMessage(message: Message): LinkedAgentResult {
  return Object.freeze({
    kind: 'message', succeeded: message.role === Role.ROLE_AGENT,
    text: textOfMessage(message), contextId: message.contextId,
    ...(message.taskId.length === 0 ? {} : { taskId: message.taskId }),
  })
}

function normalizeTask(task: Task): LinkedAgentResult {
  const state = task.status?.state
  const artifactText = task.artifacts.map(artifact => textOfParts(artifact.parts)).filter(Boolean).join('\n')
  const statusText = textOfMessage(task.status?.message)
  const historyText = [...task.history].reverse()
    .find(message => message.role === Role.ROLE_AGENT)
  return Object.freeze({
    kind: 'task',
    succeeded: state === TaskState.TASK_STATE_COMPLETED,
    text: artifactText || statusText || textOfMessage(historyText),
    contextId: task.contextId,
    taskId: task.id,
    ...(state === undefined ? {} : { state: taskStateName(state) }),
  })
}

function textOfMessage(message: Message | undefined): string {
  return message === undefined ? '' : textOfParts(message.parts)
}

function textOfParts(parts: readonly Part[]): string {
  return parts.flatMap(item => item.content?.$case === 'text' ? [item.content.value] : []).join('')
}

function taskStateName(state: TaskState): string {
  return TaskState[state] ?? String(state)
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`)
  if (value.length > 256) throw new TypeError(`${label} must be at most 256 characters`)
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function byteLength(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('A2A value is not JSON serializable')
  return utf8Bytes(serialized)
}

function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 1) return active[0]!
  return AbortSignal.any(active)
}

async function raceWithSignal<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending
  if (signal.aborted) throw signal.reason ?? new Error('A2A operation aborted')
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('A2A operation aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

function validateAgentCard(card: AgentCard, options: A2AAgentLinkOptions): void {
  const maxBytes = positiveInteger(options.maxResponseBytes ?? 1024 * 1024, 'maxResponseBytes')
  if (byteLength(card) > maxBytes) {
    throw new RangeError(`A2A Agent Card exceeds the ${maxBytes}-byte limit`)
  }
  if (card.supportedInterfaces.length === 0) {
    throw new TypeError('A2A Agent Card must advertise at least one interface')
  }
  for (const item of card.supportedInterfaces) validateEndpoint(item.url, options)
}

function snapshotLinkOptions(options: A2AAgentLinkOptions): A2AAgentLinkOptions {
  return Object.freeze({
    ...options,
    ...(options.allowedOrigins === undefined ? {} : {
      allowedOrigins: Object.freeze([...options.allowedOrigins]),
    }),
    ...(options.acceptedOutputModes === undefined ? {} : {
      acceptedOutputModes: Object.freeze([...options.acceptedOutputModes]),
    }),
    ...(options.serviceParameters === undefined ? {} : {
      serviceParameters: detachedFrozen(options.serviceParameters),
    }),
    ...(options.agentCard === undefined ? {} : { agentCard: detachedFrozen(options.agentCard) }),
  })
}

function validateEndpoint(value: string, options: A2AAgentLinkOptions): URL {
  const url = new URL(value)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('A2A endpoint URL must not contain credentials')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('A2A endpoint URL must use http or https')
  }
  if (options.requireHttps === true && url.protocol !== 'https:') {
    throw new TypeError('A2A endpoint URL must use https under the configured policy')
  }
  const allowedOrigins = options.allowedOrigins?.map(origin => new URL(origin).origin)
  if (allowedOrigins !== undefined && !allowedOrigins.includes(url.origin)) {
    throw new TypeError(`A2A endpoint origin '${url.origin}' is not allowed`)
  }
  if (options.allowPrivateNetwork === false && isPrivateHostname(url.hostname)) {
    throw new TypeError(`A2A endpoint host '${url.hostname}' is private or local`)
  }
  options.validateEndpoint?.(new URL(url))
  return url
}

function endpointFetch(baseFetch: typeof fetch, options: A2AAgentLinkOptions): typeof fetch {
  if (typeof baseFetch !== 'function') throw new TypeError('A2A endpoint resolution requires fetch')
  const maxBytes = positiveInteger(options.maxTransportBytes ?? 16 * 1024 * 1024, 'maxTransportBytes')
  const timeoutMs = positiveInteger(options.timeoutMs ?? 120_000, 'timeoutMs')
  const teardownTimeoutMs = positiveInteger(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const value = typeof input === 'string' || input instanceof URL ? input.toString() : input.url
    validateEndpoint(value, options)
    const signal = combineSignals(init?.signal ?? undefined, AbortSignal.timeout(timeoutMs))
    const response = await raceWithSignal(baseFetch(input, {
      ...init,
      signal,
      ...(options.allowRedirects === false ? { redirect: 'error' as const } : {}),
    }), signal)
    if (response.url.length > 0) validateEndpoint(response.url, options)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      if (response.body !== null) {
        await waitForSettlement(response.body.cancel().catch(() => undefined), teardownTimeoutMs)
      }
      throw new Error(`A2A HTTP response exceeds the ${maxBytes}-byte limit`)
    }
    if (response.body === null) return response
    let received = 0
    const limited = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > maxBytes) {
          controller.error(new Error(`A2A HTTP response exceeds the ${maxBytes}-byte limit`))
          return
        }
        controller.enqueue(chunk)
      },
    }))
    return new Response(limited, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }) as typeof fetch
}

function isPrivateHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa') || !hostname.includes('.')) return true
  if (hostname.includes(':')) return true
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false
  }
  const [first = 0, second = 0] = octets
  return first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
}
