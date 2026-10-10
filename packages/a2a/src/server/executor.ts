import { executionOperations   } from './operations.ts'
import { runSession   } from './run-session.ts'
import type {
  DefinedAgentA2AExecutorOptions,
  A2ADisposeReport,
  ContextSession,
  SessionSlot,
  RunningTask,
} from './types.ts'
export type { DefinedAgentA2AExecutorOptions, A2ADisposeReport } from './types.ts'
import {
  initialTask,
  status,
  agentMessage,
  requiredRegistry,
  errorMessage,
  boundedKey,
  byteLength,
  scopedConversationId,
  abortable,
  disposeReport,
} from './support.ts'
import { defaultLimit   } from '../common/limits.ts'
import {
  TaskState,
} from '@a2a-js/sdk'
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import { waitForSettlement   } from '@alvin0/ai-agent-sdk-core'
import {
  a2aErrorCode,
  beginA2AIntegrationOperation ,
} from '../common/integration-operation.ts'
import { A2ATeardownTimeoutError, withTimeout   } from '../common/timeout.ts'
import { snapshotSessionOptions   } from './session-options.ts'

export { createAgentCardFromDefinition,
  type AgentCardFromDefinitionOptions } from './agent-card.ts'

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
  private disposeReport: A2ADisposeReport | undefined

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
    this.maxSessions = defaultLimit(options.maxSessions, 1_000, 'maxSessions')
    this.maxRunningTasks = defaultLimit(options.maxRunningTasks, 1_000, 'maxRunningTasks')
    this.maxTasksPerSession = defaultLimit(options.maxTasksPerSession, 16, 'maxTasksPerSession')
    this.sessionTtlMs = defaultLimit(options.sessionTtlMs, 30 * 60_000, 'sessionTtlMs')
    this.maxInputBytes = defaultLimit(options.maxInputBytes, 1024 * 1024, 'maxInputBytes')
    this.maxOutputBytes = defaultLimit(options.maxOutputBytes, 1024 * 1024, 'maxOutputBytes')
    this.disposeTimeoutMs = defaultLimit(options.disposeTimeoutMs, 30_000, 'disposeTimeoutMs')
    this.taskTimeoutMs = defaultLimit(options.taskTimeoutMs, 10 * 60_000, 'taskTimeoutMs')
    this.observerTimeoutMs = defaultLimit(options.observerTimeoutMs, 5_000, 'observerTimeoutMs')
  }

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const operations = executionOperations(this.options.logger)
    if (!this.admitExecution(context, eventBus, operations)) return

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

      await runSession({ context, eventBus, session: state.session, taskSignal }, {
        maxOutputBytes: this.maxOutputBytes, agentName: this.options.agent.name,
      })
      operations.success()
    } catch (error: unknown) {
      if (taskSignal.aborted) {
        operations.abort()
      } else {
        const code = a2aErrorCode(error)
        operations.fail(code)
      }
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

  private admitExecution(
    context: RequestContext, eventBus: ExecutionEventBus, operations: ReturnType<typeof executionOperations>,
  ): boolean {
    const task = initialTask(context)
    try { eventBus.publish(AgentEvent.task(task)) }
    catch (error: unknown) {
      const code = a2aErrorCode(error)
      operations.fail(code)
      throw error
    }

    const rejected = this.executionRejection(context)
    if (rejected !== undefined) {
      operations.fail(rejected.code)
      this.publishFailure(context, eventBus, rejected.error)
      return false
    }

    return true
  }

  private executionRejection(context: RequestContext): { code: string; error: Error } | undefined {
    if (this.disposed) return { code: 'A2A_EXECUTOR_DISPOSED', error: new Error('A2A executor is disposed') }
    if (this.running.has(context.taskId)) return {
      code: 'A2A_TASK_DUPLICATE', error: new Error(`A2A task '${context.taskId}' is already running`),
    }
    if (this.running.size >= this.maxRunningTasks) return {
      code: 'A2A_TASK_LIMIT',
      error: new Error(`A2A executor reached its ${this.maxRunningTasks}-running-task limit`),
    }
    return undefined
  }

  

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const running = this.running.get(taskId)
    if (running === undefined || running.canceled) return
    const operation = beginA2AIntegrationOperation(this.options.logger, 'a2a-server', 'cancel')
    const attempt = operation.attempt(1)
    try {
      running.canceled = true
      running.controller.abort(new Error(`A2A task '${taskId}' was canceled`))
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId: running.contextId,
        status: status(TaskState.TASK_STATE_CANCELED),
        metadata: undefined,
      }))
      attempt.success(); operation.success()
    } catch (error: unknown) {
      const code = a2aErrorCode(error)
      attempt.fail(code); operation.fail(code)
      throw error
    }
  }

  /** Cancel active work and permanently release retained context sessions. */
  async dispose(reason: unknown = new Error('A2A executor disposed')): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    const operation = beginA2AIntegrationOperation(this.options.logger, 'a2a-server', 'dispose')
    const attempt = operation.attempt(1)
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
    ).then(() => {
      attempt.success(); operation.success()
    }, error => {
      const code = a2aErrorCode(error)
      attempt.fail(code); operation.fail(code)
      throw error
    }).finally(() => {
      this.sessions.clear()
      this.running.clear()
    })
    return this.disposeTask
  }

  /** Return bounded support evidence while retaining dispose() compatibility. */
  async disposeWithReport(reason?: unknown): Promise<A2ADisposeReport> {
    if (this.disposeReport !== undefined) return disposeReport(this.disposeReport.status, true,
      this.disposeReport.error)
    const alreadyDisposed = this.disposeTask !== undefined
    try {
      await this.dispose(reason)
      return this.disposeReport = disposeReport('disposed', alreadyDisposed)
    } catch (error) {
      const timedOut = error instanceof A2ATeardownTimeoutError
      return this.disposeReport = disposeReport(timedOut ? 'timed-out' : 'failed', alreadyDisposed)
    }
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
    let owner: string
    if (custom === undefined) {
      owner = user?.isAuthenticated === true ? boundedKey(user.userName, 'A2A principal') : 'anonymous'
    } else owner = boundedKey(await custom(context, signal), 'A2A session owner')
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

