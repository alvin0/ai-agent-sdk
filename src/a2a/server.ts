import {
  A2A_PROTOCOL_VERSION,
  Role,
  TaskState,
  type AgentCard,
  type AgentProvider,
  type SecurityRequirement,
  type SecurityScheme,
  type AgentSkill,
  type Message as A2AMessage,
  type Part,
  type Task,
} from '@a2a-js/sdk'
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from '@a2a-js/sdk/server'
import type { ContentBlock, ImageMediaType } from '../core/message/content.ts'
import { createUserMessage } from '../core/message/message.ts'
import type { ModelRegistry } from '../core/runtime/registry.ts'
import { waitForSettlement } from '../core/async/settlement.ts'
import type { DefinedAgent } from '../agent/define/definition.ts'
import {
  AgentSession,
  type AgentSessionOptions,
} from '../agent/define/session.ts'

export interface DefinedAgentA2AExecutorOptions {
  readonly agent: DefinedAgent
  /** Required unless createSession supplies a fully configured session. */
  readonly registry?: ModelRegistry
  readonly sessionOptions?: Omit<AgentSessionOptions, 'conversationId' | 'registry'>
  /** Customize session construction for request-specific registries, tools, or policy. */
  readonly createSession?: (
    context: RequestContext,
    signal?: AbortSignal,
  ) => AgentSession | Promise<AgentSession>
  /** Opt-in host policy: reject calls without an authenticated A2A principal. */
  readonly requireAuthenticated?: boolean
  /**
   * Map a request to the host's ownership boundary (user, device, workspace,
   * API client, etc.). Defaults to the authenticated A2A principal.
   */
  readonly sessionOwner?: (context: RequestContext, signal?: AbortSignal) => string | Promise<string>
  /** Maximum retained context sessions. Defaults to 1,000. */
  readonly maxSessions?: number
  /** Maximum tasks executing or queued across the executor. Defaults to 1,000. */
  readonly maxRunningTasks?: number
  /** Maximum tasks executing or queued against one retained session. Defaults to 16. */
  readonly maxTasksPerSession?: number
  /** Idle session retention. Defaults to 30 minutes. */
  readonly sessionTtlMs?: number
  /** Maximum serialized inbound A2A message size. Defaults to 1 MiB. */
  readonly maxInputBytes?: number
  /** Maximum UTF-8 response size published to A2A. Defaults to 1 MiB. */
  readonly maxOutputBytes?: number
  /** Maximum time dispose waits for cooperative providers. Defaults to 30 seconds. */
  readonly disposeTimeoutMs?: number
  /** End-to-end bound for session creation, queueing, and agent execution. Defaults to 10 minutes. */
  readonly taskTimeoutMs?: number
  /** Maximum wait for the private error observer. Defaults to 5 seconds. */
  readonly observerTimeoutMs?: number
  /** Return raw internal error text to callers. Unsafe and disabled by default. */
  readonly exposeInternalErrors?: boolean
  /** Receives the original error for private logging/telemetry. */
  readonly onError?: (error: unknown, context: RequestContext) => void | Promise<void>
}

interface ContextSession {
  readonly session: AgentSession
  tail: Promise<void>
}

interface SessionSlot {
  readonly pending: Promise<ContextSession>
  active: number
  lastAccess: number
}

interface RunningTask {
  readonly controller: AbortController
  readonly contextId: string
  readonly eventBus: ExecutionEventBus
  canceled: boolean
}

/**
 * Adapt a provider-neutral DefinedAgent to the official A2A AgentExecutor contract.
 * Sessions are retained by A2A contextId, so protocol follow-ups preserve history.
 */
export class DefinedAgentA2AExecutor implements AgentExecutor {
  private readonly options: DefinedAgentA2AExecutorOptions
  private readonly sessions = new Map<string, SessionSlot>()
  private readonly running = new Map<string, RunningTask>()
  private readonly maxSessions: number
  private readonly maxRunningTasks: number
  private readonly maxTasksPerSession: number
  private readonly sessionTtlMs: number
  private readonly maxInputBytes: number
  private readonly maxOutputBytes: number
  private readonly disposeTimeoutMs: number
  private readonly taskTimeoutMs: number
  private readonly observerTimeoutMs: number
  private disposed = false
  private disposeTask: Promise<void> | undefined

  constructor(options: DefinedAgentA2AExecutorOptions) {
    if (options.registry === undefined && options.createSession === undefined) {
      throw new TypeError('A2A executor requires registry or createSession')
    }
    this.options = Object.freeze({
      ...options,
      ...(options.sessionOptions === undefined ? {} : {
        sessionOptions: snapshotSessionOptions(options.sessionOptions),
      }),
    })
    this.maxSessions = positiveInteger(options.maxSessions ?? 1_000, 'maxSessions')
    this.maxRunningTasks = positiveInteger(options.maxRunningTasks ?? 1_000, 'maxRunningTasks')
    this.maxTasksPerSession = positiveInteger(options.maxTasksPerSession ?? 16, 'maxTasksPerSession')
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs ?? 30 * 60_000, 'sessionTtlMs')
    this.maxInputBytes = positiveInteger(options.maxInputBytes ?? 1024 * 1024, 'maxInputBytes')
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 1024 * 1024, 'maxOutputBytes')
    this.disposeTimeoutMs = positiveInteger(options.disposeTimeoutMs ?? 30_000, 'disposeTimeoutMs')
    this.taskTimeoutMs = positiveInteger(options.taskTimeoutMs ?? 10 * 60_000, 'taskTimeoutMs')
    this.observerTimeoutMs = positiveInteger(options.observerTimeoutMs ?? 5_000, 'observerTimeoutMs')
  }

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const task = initialTask(context)
    eventBus.publish(AgentEvent.task(task))

    if (this.disposed) {
      this.publishFailure(context, eventBus, new Error('A2A executor is disposed'))
      return
    }
    if (this.running.has(context.taskId)) {
      this.publishFailure(context, eventBus, new Error(`A2A task '${context.taskId}' is already running`))
      return
    }
    if (this.running.size >= this.maxRunningTasks) {
      this.publishFailure(
        context, eventBus,
        new Error(`A2A executor reached its ${this.maxRunningTasks}-running-task limit`),
      )
      return
    }

    const running: RunningTask = {
      controller: new AbortController(),
      contextId: context.contextId,
      eventBus,
      canceled: false,
    }
    const taskSignal = AbortSignal.any([
      running.controller.signal,
      AbortSignal.timeout(this.taskTimeoutMs),
    ])
    this.running.set(context.taskId, running)
    let release: (() => void) | undefined
    let acquired: { readonly key: string; readonly slot: SessionSlot; readonly state: ContextSession } | undefined
    try {
      this.assertAccess(context)
      this.assertInputBudget(context)
      acquired = await this.acquireContextSession(context, taskSignal)
      const state = acquired.state
      const previous = state.tail
      state.tail = new Promise<void>(resolve => { release = resolve })
      await abortable(previous, taskSignal)
      taskSignal.throwIfAborted()

      eventBus.publish(AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId: context.contextId,
        status: status(TaskState.TASK_STATE_WORKING),
        metadata: undefined,
      }))

      const input = createUserMessage({
        content: partsToContent(context.userMessage.parts),
        source: {
          kind: 'a2a-message',
          contextId: context.contextId,
          messageId: context.userMessage.messageId,
          taskId: context.taskId,
        },
      })
      const response = await abortable(state.session.run(input, { signal: taskSignal }), taskSignal)
      taskSignal.throwIfAborted()
      if (!response.outcome.completed) {
        const reason = response.outcome.reason
        const detail = reason.kind === 'error'
          ? reason.failure.message
          : `agent run ended with ${reason.kind}`
        throw new Error(detail)
      }
      if (utf8Bytes(response.text) > this.maxOutputBytes) {
        throw new Error(`A2A response exceeds the ${this.maxOutputBytes}-byte limit`)
      }

      const reply = agentMessage(context, response.text)
      eventBus.publish(AgentEvent.artifactUpdate({
        taskId: context.taskId,
        contextId: context.contextId,
        artifact: {
          artifactId: crypto.randomUUID(),
          name: `${this.options.agent.name} result`,
          description: `Final result produced by ${this.options.agent.name}`,
          parts: [{
            content: { $case: 'text', value: response.text },
            mediaType: 'text/plain',
            filename: '',
            metadata: undefined,
          }],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }))
      eventBus.publish(AgentEvent.statusUpdate({
        taskId: context.taskId,
        contextId: context.contextId,
        status: status(TaskState.TASK_STATE_COMPLETED, reply),
        metadata: undefined,
      }))
    } catch (error: unknown) {
      if (!running.canceled) {
        await this.reportError(error, context)
        this.publishFailure(context, eventBus, error)
      }
    } finally {
      release?.()
      if (acquired !== undefined) this.releaseContextSession(acquired.key, acquired.slot)
      if (this.running.get(context.taskId) === running) this.running.delete(context.taskId)
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const running = this.running.get(taskId)
    if (running === undefined || running.canceled) return
    running.canceled = true
    running.controller.abort(new Error(`A2A task '${taskId}' was canceled`))
    eventBus.publish(AgentEvent.statusUpdate({
      taskId,
      contextId: running.contextId,
      status: status(TaskState.TASK_STATE_CANCELED),
      metadata: undefined,
    }))
  }

  /** Cancel active work and permanently release retained context sessions. */
  async dispose(reason: unknown = new Error('A2A executor disposed')): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.disposed = true
    for (const [taskId, running] of this.running) {
      running.canceled = true
      running.controller.abort(reason)
      try {
        running.eventBus.publish(AgentEvent.statusUpdate({
          taskId,
          contextId: running.contextId,
          status: status(TaskState.TASK_STATE_CANCELED),
          metadata: undefined,
        }))
      } catch { /* shutdown continues even if a transport observer has failed */ }
    }
    const settling = Promise.allSettled(
      [...this.sessions.values()].map(slot => slot.pending.then(state => state.tail)),
    ).then(() => { this.sessions.clear() })
    this.disposeTask = withTimeout(
      settling,
      this.disposeTimeoutMs,
      `A2A executor did not dispose within ${this.disposeTimeoutMs}ms`,
    ).finally(() => {
      this.sessions.clear()
      this.running.clear()
    })
    return this.disposeTask
  }

  private async acquireContextSession(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<{ readonly key: string; readonly slot: SessionSlot; readonly state: ContextSession }> {
    const key = await abortable(this.resolveSessionKey(context, signal), signal)
    const now = Date.now()
    this.pruneSessions(now)
    let slot = this.sessions.get(key)
    if (slot === undefined) {
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`A2A executor reached its ${this.maxSessions}-session limit`)
      }
      const pending = this.createContextSession(context, key, signal)
      slot = { pending, active: 0, lastAccess: now }
      this.sessions.set(key, slot)
      pending.catch(() => {
        if (this.sessions.get(key) === slot) this.sessions.delete(key)
      })
    }
    if (slot.active >= this.maxTasksPerSession) {
      throw new Error(`A2A session reached its ${this.maxTasksPerSession}-task limit`)
    }
    slot.active++
    slot.lastAccess = now
    try {
      return { key, slot, state: await abortable(slot.pending, signal) }
    } catch (error: unknown) {
      slot.active--
      if (slot.active === 0 && signal.aborted && this.sessions.get(key) === slot) {
        this.sessions.delete(key)
      }
      throw error
    }
  }

  private releaseContextSession(key: string, slot: SessionSlot): void {
    slot.active--
    slot.lastAccess = Date.now()
    if (slot.active < 0 && this.sessions.get(key) === slot) {
      this.sessions.delete(key)
      throw new Error('A2A session reference count underflow')
    }
  }

  private pruneSessions(now: number): void {
    for (const [key, slot] of this.sessions) {
      if (slot.active === 0 && now - slot.lastAccess >= this.sessionTtlMs) this.sessions.delete(key)
    }
  }

  private async resolveSessionKey(context: RequestContext, signal: AbortSignal): Promise<string> {
    const custom = this.options.sessionOwner
    const user = context.context.user
    const owner = custom === undefined
      ? user?.isAuthenticated === true
        ? boundedKey(user.userName, 'A2A principal')
        : 'anonymous'
      : boundedKey(await custom(context, signal), 'A2A session owner')
    return JSON.stringify([owner, boundedKey(context.contextId, 'A2A context id')])
  }

  private assertAccess(context: RequestContext): void {
    const user = context.context.user
    if (this.options.requireAuthenticated === true && user?.isAuthenticated !== true) {
      throw new Error('A2A authentication is required')
    }
  }

  private assertInputBudget(context: RequestContext): void {
    if (byteLength(context.userMessage) > this.maxInputBytes) {
      throw new Error(`A2A input exceeds the ${this.maxInputBytes}-byte limit`)
    }
  }

  private publishFailure(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    error: unknown,
  ): void {
    const text = this.options.exposeInternalErrors === true
      ? errorMessage(error)
      : 'Agent execution failed'
    eventBus.publish(AgentEvent.statusUpdate({
      taskId: context.taskId,
      contextId: context.contextId,
      status: status(TaskState.TASK_STATE_FAILED, agentMessage(context, text)),
      metadata: undefined,
    }))
  }

  private async reportError(error: unknown, context: RequestContext): Promise<void> {
    if (this.options.onError === undefined) return
    const observer = Promise.resolve().then(() => this.options.onError?.(error, context))
    await waitForSettlement(observer, this.observerTimeoutMs)
  }

  private async createContextSession(
    context: RequestContext,
    key: string,
    signal: AbortSignal,
  ): Promise<ContextSession> {
    const custom = this.options.createSession
    const session = custom === undefined
      ? this.options.agent.createSession({
          ...this.options.sessionOptions,
          registry: requiredRegistry(this.options.registry),
          conversationId: await scopedConversationId(key),
        })
      : await custom(context, signal)
    return { session, tail: Promise.resolve() }
  }
}

function snapshotSessionOptions(
  options: Omit<AgentSessionOptions, 'conversationId' | 'registry'>,
): Omit<AgentSessionOptions, 'conversationId' | 'registry'> {
  return Object.freeze({
    ...options,
    ...(options.historyLimits === undefined ? {} : {
      historyLimits: Object.freeze({ ...options.historyLimits }),
    }),
    ...(options.runtimeLimits === undefined ? {} : {
      runtimeLimits: Object.freeze({ ...options.runtimeLimits }),
    }),
    ...(Array.isArray(options.tools) ? { tools: Object.freeze([...options.tools]) } : {}),
    ...(options.skills === undefined ? {} : { skills: Object.freeze([...options.skills]) }),
    ...(options.interceptors === undefined ? {} : {
      interceptors: Object.freeze([...options.interceptors]),
    }),
    ...(options.hooks === undefined ? {} : { hooks: Object.freeze({ ...options.hooks }) }),
    ...(options.compaction === undefined || options.compaction === false
      ? {}
      : { compaction: Object.freeze({ ...options.compaction }) }),
    ...(options.trace === undefined ? {} : { trace: Object.freeze({ ...options.trace }) }),
    ...(options.team === undefined ? {} : { team: Object.freeze({ ...options.team }) }),
  })
}

export interface AgentCardFromDefinitionOptions {
  readonly url: string
  readonly protocolBinding?: 'JSONRPC' | 'HTTP+JSON' | 'GRPC' | (string & {})
  readonly version?: string
  readonly provider?: AgentProvider
  readonly documentationUrl?: string
  readonly iconUrl?: string
  readonly tags?: readonly string[]
  readonly examples?: readonly string[]
  readonly securitySchemes?: Readonly<Record<string, SecurityScheme>>
  readonly securityRequirements?: readonly SecurityRequirement[]
  /** Opt-in host policy requiring an https:// interface URL. */
  readonly requireHttps?: boolean
}

/** Create a v1 Agent Card directly from a DefinedAgent. */
export function createAgentCardFromDefinition(
  agent: DefinedAgent,
  options: AgentCardFromDefinitionOptions,
): AgentCard {
  const url = endpointUrl(options.url, options.requireHttps === true)
  const securitySchemes = structuredClone(options.securitySchemes ?? {})
  const securityRequirements: SecurityRequirement[] = structuredClone([
    ...options.securityRequirements ?? [],
  ])
  assertSecurityRequirements(securitySchemes, securityRequirements)
  const description = agent.description ?? `${agent.name} powered by ai-agent-sdk`
  const skill: AgentSkill = {
    id: agent.id,
    name: agent.name,
    description,
    tags: [...options.tags ?? [agent.id]],
    examples: [...options.examples ?? []],
    inputModes: ['text/plain', 'image/*', 'application/json'],
    outputModes: ['text/plain'],
    securityRequirements: structuredClone(securityRequirements),
  }
  return {
    name: agent.name,
    description,
    supportedInterfaces: [{
      url: url.href,
      protocolBinding: options.protocolBinding ?? 'JSONRPC',
      // Required by the generated A2A interface shape. Deployment scoping is
      // deliberately left to the host through authentication and sessionOwner.
      tenant: '',
      protocolVersion: A2A_PROTOCOL_VERSION,
    }],
    provider: options.provider,
    version: options.version ?? '1.0.0',
    ...(options.documentationUrl === undefined ? {} : { documentationUrl: options.documentationUrl }),
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes,
    securityRequirements,
    defaultInputModes: ['text/plain', 'image/*', 'application/json'],
    defaultOutputModes: ['text/plain'],
    skills: [skill],
    signatures: [],
    ...(options.iconUrl === undefined ? {} : { iconUrl: options.iconUrl }),
  }
}

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

function initialTask(context: RequestContext): Task {
  return context.task ?? {
    id: context.taskId,
    contextId: context.contextId,
    status: status(TaskState.TASK_STATE_SUBMITTED),
    artifacts: [],
    history: [structuredClone(context.userMessage)],
    metadata: context.request.metadata,
  }
}

function status(state: TaskState, message?: A2AMessage): NonNullable<Task['status']> {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  }
}

function agentMessage(context: RequestContext, text: string): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    contextId: context.contextId,
    taskId: context.taskId,
    role: Role.ROLE_AGENT,
    parts: [{
      content: { $case: 'text', value: text },
      mediaType: 'text/plain',
      filename: '',
      metadata: undefined,
    }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function partsToContent(parts: readonly Part[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of parts) {
    const content = part.content
    if (content?.$case === 'text') {
      blocks.push({ type: 'text', text: content.value })
    } else if (content?.$case === 'url' && isImageMediaType(part.mediaType)) {
      blocks.push({ type: 'image', source: { kind: 'url', url: content.value } })
    } else if (content?.$case === 'raw' && isImageMediaType(part.mediaType)) {
      blocks.push({
        type: 'image',
        source: { kind: 'base64', mediaType: part.mediaType, data: bytesToBase64(content.value) },
      })
    } else if (content?.$case === 'data') {
      blocks.push({ type: 'text', text: JSON.stringify(content.value) })
    } else if (content !== undefined) {
      const location = content.$case === 'url' ? `: ${content.value}` : ''
      blocks.push({
        type: 'text',
        text: `[A2A attachment${part.mediaType.length === 0 ? '' : ` ${part.mediaType}`}${location}]`,
      })
    }
  }
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks
}

function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/jpeg' || value === 'image/png'
    || value === 'image/gif' || value === 'image/webp'
}

function bytesToBase64(value: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function requiredRegistry(registry: ModelRegistry | undefined): ModelRegistry {
  if (registry === undefined) throw new TypeError('A2A executor requires registry')
  return registry
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  if (utf8Bytes(value) > 1024) throw new TypeError(`${label} must not exceed 1024 bytes`)
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
  return utf8Bytes(JSON.stringify(value))
}

async function scopedConversationId(sessionKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionKey))
  const hex = [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('')
  return `a2a-${hex}`
}

function endpointUrl(value: string, requireHttps: boolean): URL {
  const url = new URL(value)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('A2A interface URL must not contain credentials')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('A2A interface URL must use http or https')
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new TypeError('A2A interface URL must use https under the configured policy')
  }
  return url
}

function assertSecurityRequirements(
  schemes: Record<string, SecurityScheme>,
  requirements: readonly SecurityRequirement[],
): void {
  for (const requirement of requirements) {
    const names = Object.keys(requirement.schemes)
    for (const name of names) {
      if (schemes[name] === undefined) {
        throw new TypeError(`A2A security requirement references unknown scheme '${name}'`)
      }
      if (schemes[name]?.scheme === undefined) {
        throw new TypeError(`A2A security scheme '${name}' has no concrete definition`)
      }
    }
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
