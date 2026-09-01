/** Stateful multi-turn sessions over declarative agent definitions. */

import type { ApprovalBroker } from '../tool/approval.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import type { ToolInterceptor } from '../tool/pipeline.ts'
import { ToolRegistry, type ToolCatalog } from '../tool/registry.ts'
import { History, type HistoryLimits, type HistorySnapshot } from '../history/history.ts'
import { normalizeToolPairing } from '../history/normalize.ts'
import type { TurnHooks } from '../loop/types.ts'
import {
  ContextCompactor,
  type CompactionResult,
} from '../memory/compaction.ts'
import {
  resolveCompactionConfig,
  type AgentCompactionOptions,
} from '../memory/compaction-config.ts'
import { AgentMemory, type AgentMemorySnapshot } from '../memory/memory.ts'
import { runAgent, type AgentRunEvent, type AgentRunOutcome } from '../mode/run-agent.ts'
import type { UserInputBroker } from '../mode/user-input.ts'
import type { Message, UserMessage } from '@ai-agent-sdk/core'
import { createTextMessage, createUserMessage, freezeMessage } from '@ai-agent-sdk/core'
import type { ModelRegistry } from '@ai-agent-sdk/core'
import { waitForSettlement } from '@ai-agent-sdk/core'
import type { ObservationPort, ObservationResource, OperationStatus } from '@ai-agent-sdk/core'
import type { SpanId, TraceId } from '../trace/trace.ts'
import { RunEventBuffer } from '../accounting/event-buffer.ts'
import { RunLedger } from '../accounting/ledger.ts'
import { AgentRunError, AGENT_ACCOUNTING_ERROR_CODES } from '../accounting/error.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { RunLedgerLimits, RunReport, UsagePolicy } from '../accounting/report.ts'
import {
  SkillCatalog,
  createSkillTools,
  renderSkillCatalog,
  type SkillLookupOptions,
  type SkillResourceBase,
  type SkillSource,
} from '../skill/index.ts'
import type { AgentDefinition } from './definition.ts'

export type AgentInput = string | UserMessage

/** Deployment-neutral resource guards for normal model/tool turns in one session. */
export interface AgentRuntimeLimits {
  readonly teardownTimeoutMs?: number
  readonly modelTimeoutMs?: number
  readonly maxModelRequestBytes?: number
  readonly maxModelResponseBytes?: number
  readonly maxModelStreamEvents?: number
  readonly maxToolResultBytes?: number
  readonly maxToolDurationMs?: number
  readonly toolTeardownTimeoutMs?: number
  readonly maxParallelToolCalls?: number
  readonly maxConsecutiveToolErrors?: number
  readonly repeatToolWarningAt?: number
  readonly repeatToolLimit?: number
  readonly toolCycleWarningAt?: number
  readonly toolCycleLimit?: number
  readonly maxToolCycleLength?: number
  /** Hard stop over aggregate usage reported by model adapters. */
  readonly maxTotalTokens?: number
  readonly hookTimeoutMs?: number
  readonly hookTeardownTimeoutMs?: number
  /** Maximum time granted to each invocation event observer. Defaults to 30 seconds. */
  readonly observerTimeoutMs?: number
}

export interface AgentSessionOptions {
  readonly registry: ModelRegistry
  /** Stable application-facing id; generated automatically when omitted. */
  readonly conversationId?: string
  /** Resume an existing history; otherwise the session starts empty. */
  readonly history?: History
  /** In-memory append-only history resource limits. */
  readonly historyLimits?: HistoryLimits
  /** Per-session model/tool resource guards; safe defaults apply when omitted. */
  readonly runtimeLimits?: AgentRuntimeLimits
  /** Application tools added to the tools declared by the agent. */
  readonly tools?: ToolCatalog | readonly ToolDefinition<any>[]
  /** Per-session sources, filtered by the definition's skillIds when declared. */
  readonly skills?: readonly SkillSource[]
  /** Workspace selector forwarded to cwd-sensitive skill providers. */
  readonly skillCwd?: string
  readonly userInput?: UserInputBroker
  readonly approvals?: ApprovalBroker
  readonly interceptors?: readonly ToolInterceptor[]
  readonly hooks?: TurnHooks
  /** Pluggable delivery backend for canonical run/model/tool observations. */
  readonly observation?: ObservationPort
  /** Deployment metadata attached to every canonical observation event. */
  readonly observationResource?: ObservationResource
  /** Missing provider-usage behavior; defaults to a warning with unknown totals. */
  readonly usagePolicy?: UsagePolicy
  /** Hard resource limits for the in-memory canonical run ledger. */
  readonly ledgerLimits?: RunLedgerLimits
  /** Resume explicit task memory; otherwise definition seeds are used. */
  readonly memory?: AgentMemory | AgentMemorySnapshot
  /** Override the definition's compaction policy for this conversation. */
  readonly compaction?: AgentCompactionOptions | false
  readonly trace?: {
    readonly traceId?: TraceId
    readonly parentSpanId?: SpanId
  }
  /** Join one shared local/remote agent team and optionally expose its model tools. */
  readonly team?: AgentTeamMemberOptions
}

interface AgentSessionTeamPort {
  attach(session: AgentSession, options?: AgentSessionTeamAttachmentOptions): void
  toolsFor(sender: string): readonly ToolDefinition<any>[]
  instructionsFor(name: string): string
}

interface AgentSessionTeamAttachmentOptions {
  readonly name?: string
  readonly description?: string
  readonly instructions?: string
  readonly role?: 'lead' | 'peer'
  readonly tools?: boolean
}

/** Attach a session to one shared local/remote agent control plane. */
export interface AgentTeamMemberOptions extends AgentSessionTeamAttachmentOptions {
  readonly team: AgentSessionTeamPort
}

/** One JSON-safe envelope containing everything needed to resume a conversation. */
export interface AgentSessionSnapshot {
  readonly version: 1
  readonly conversationId: string
  readonly agentId: string
  readonly history: HistorySnapshot
  readonly memory: AgentMemorySnapshot
  /** Optional in v1 so snapshots written before skill support remain valid. */
  readonly skills?: {
    /** Bodies/resources are never persisted here; current providers rehydrate them lazily. */
    readonly activated: readonly AgentSessionActivatedSkillSnapshot[]
  }
}

export interface AgentSessionActivatedSkillSnapshot {
  readonly id: string
  readonly provider: string
  readonly source: string
  /** Prevent a resumed session from silently switching scoped resource bundles. */
  readonly resourceBase?: SkillResourceBase
}

/** Runtime dependencies used when opening a persisted conversation. */
export interface AgentResumeSessionOptions
  extends Omit<AgentSessionOptions, 'conversationId' | 'history' | 'memory'> {
  readonly snapshot: AgentSessionSnapshot
}

export interface AgentInvocationOptions {
  readonly signal?: AbortSignal
  /** Observe events when using run()/runPending(); stream() already exposes them directly. */
  readonly onEvent?: (event: AgentRunEvent) => void | Promise<void>
}

export interface AgentResponse {
  readonly text: string
  readonly outcome: AgentRunOutcome
  readonly report: RunReport
  readonly message?: Message
}

/** Eager single-consumer event stream with independently awaitable terminal artifacts. */
export interface AgentRunHandle extends AsyncIterable<AgentRunEvent> {
  readonly runId: string
  readonly result: Promise<AgentResponse>
  readonly report: Promise<RunReport>
}

export class AgentSession {
  readonly definition: AgentDefinition
  private readonly options: AgentSessionOptions
  private readonly catalog: ToolCatalog | undefined
  private readonly skillCatalog: SkillCatalog | undefined
  private readonly runtimeLimits: Readonly<AgentRuntimeLimits>
  private currentHistory: History
  private currentMemory: AgentMemory
  private currentConversationId: string
  private compactor: ContextCompactor | undefined
  private pendingSkillActivations: readonly AgentSessionActivatedSkillSnapshot[] = Object.freeze([])
  private active = false
  private readonly idleWaiters = new Set<() => void>()

  constructor(definition: AgentDefinition, options: AgentSessionOptions) {
    if (definition.mode === 'deep-human-in-loop' && options.userInput === undefined) {
      throw new TypeError(`agent '${definition.id}' requires a userInput broker in deep-human-in-loop mode`)
    }
    this.definition = definition
    const historyLimits = options.historyLimits === undefined
      ? undefined
      : Object.freeze({ ...options.historyLimits })
    // Validate reset-time policy even when the initial History was supplied by
    // the host, and detach mutable option containers from the caller.
    if (options.history !== undefined && historyLimits !== undefined) void new History(historyLimits)
    const compaction = options.compaction === undefined || options.compaction === false
      ? options.compaction
      : Object.freeze({ ...options.compaction })
    const trace = options.trace === undefined ? undefined : Object.freeze({ ...options.trace })
    const team = options.team === undefined ? undefined : Object.freeze({ ...options.team })
    this.options = Object.freeze({
      ...options,
      ...(historyLimits === undefined ? {} : { historyLimits }),
      ...(compaction === undefined ? {} : { compaction }),
      ...(trace === undefined ? {} : { trace }),
      ...(team === undefined ? {} : { team }),
      ...(options.skills === undefined ? {} : { skills: Object.freeze([...options.skills]) }),
      ...(Array.isArray(options.tools) ? { tools: Object.freeze([...options.tools]) } : {}),
      ...(options.interceptors === undefined ? {} : { interceptors: Object.freeze([...options.interceptors]) }),
    })
    this.runtimeLimits = resolveRuntimeLimits(options.runtimeLimits)
    this.currentConversationId = conversationId(options.conversationId)
    this.currentHistory = options.history ?? new History(historyLimits)
    const skillSources = [...definition.skills, ...options.skills ?? []]
    const skillRuntimeDisabled = definition.skillIds?.length === 0
    const skillRuntimeConfigured = skillSources.length > 0 || (definition.skillIds?.length ?? 0) > 0
    this.skillCatalog = skillRuntimeDisabled || !skillRuntimeConfigured
      ? undefined
      : new SkillCatalog(skillSources, {
          ...(definition.skillIds === undefined ? {} : { allowedSkillIds: definition.skillIds }),
          maxSkills: definition.skillOptions.maxSkills,
          maxCatalogBytes: definition.skillOptions.maxDiscoveryBytes,
        })
    const skillTools = this.skillCatalog === undefined ? [] : createSkillTools(
      this.skillCatalog,
      definition.skillOptions,
      () => this.skillLookup(),
    )
    const teamTools = options.team?.tools === false
      ? []
      : options.team?.team.toolsFor(options.team.name ?? definition.id) ?? []
    this.catalog = toolCatalog(definition.tools, options.tools, [...skillTools, ...teamTools])
    this.currentMemory = options.memory instanceof AgentMemory
      ? options.memory
      : options.memory === undefined
        ? new AgentMemory(definition.memory.seed, definition.memory)
        : AgentMemory.fromSnapshot(options.memory, definition.memory)
    this.captureResumedObjective()
    this.compactor = this.createCompactor()
    options.team?.team.attach(this, {
      ...(options.team.name === undefined ? {} : { name: options.team.name }),
      ...(options.team.description === undefined ? {} : { description: options.team.description }),
      ...(options.team.instructions === undefined ? {} : { instructions: options.team.instructions }),
      ...(options.team.role === undefined ? {} : { role: options.team.role }),
      ...(options.team.tools === undefined ? {} : { tools: options.team.tools }),
    })
  }

  /** Restore a JSON-round-tripped session snapshot with fresh runtime dependencies. */
  static fromSnapshot(
    definition: AgentDefinition,
    options: AgentResumeSessionOptions,
  ): AgentSession {
    const { snapshot, ...runtime } = options
    validateSessionSnapshot(snapshot, definition.id, definition.skillOptions.maxSkills)
    const session = new AgentSession(definition, {
      ...runtime,
      conversationId: snapshot.conversationId,
      history: History.fromSnapshot(snapshot.history, runtime.historyLimits),
      memory: AgentMemory.fromSnapshot(snapshot.memory, definition.memory),
    })
    session.pendingSkillActivations = Object.freeze(
      [...snapshot.skills?.activated ?? []].map(activation => Object.freeze({
        id: activation.id,
        provider: activation.provider,
        source: activation.source,
        ...activation.resourceBase === undefined ? {} : {
          resourceBase: Object.freeze({
            kind: activation.resourceBase.kind,
            value: activation.resourceBase.value,
          }),
        },
      })),
    )
    return session
  }

  /** Stable identity for persistence keys, URLs, logs, and GUI trace grouping. */
  get conversationId(): string { return this.currentConversationId }

  /** Mutable append-only history owned by this conversation. */
  get history(): History { return this.currentHistory }

  /** Durable task facts injected into every request outside compactable history. */
  get memory(): AgentMemory { return this.currentMemory }

  /** Refreshable skill catalog for host UIs and explicit user invocation surfaces. */
  get skills(): SkillCatalog | undefined { return this.skillCatalog }

  /** Whether a model/tool turn currently owns this session. */
  get isRunning(): boolean { return this.active }

  /** Capture one JSON-safe envelope that can be passed to `agent.resumeSession()`. */
  snapshot(): AgentSessionSnapshot {
    const activated = this.activationSnapshot()
    return Object.freeze({
      version: 1 as const,
      conversationId: this.currentConversationId,
      agentId: this.definition.id,
      history: this.currentHistory.snapshot(),
      memory: this.currentMemory.snapshot(),
      ...activated.length === 0 ? {} : {
        skills: Object.freeze({ activated }),
      },
    })
  }

  /** Start a fresh conversation without rebuilding provider/tool configuration. */
  reset(): void {
    if (this.active) throw new Error('cannot reset an agent session while a run is active')
    this.currentConversationId = newConversationId()
    this.currentHistory = new History(this.options.historyLimits)
    this.currentMemory = new AgentMemory(this.definition.memory.seed, this.definition.memory)
    this.pendingSkillActivations = Object.freeze([])
    this.skillCatalog?.clearActivations()
    this.compactor = this.createCompactor()
  }

  /** Create one explicit context checkpoint while the session is idle. */
  async compact(invocation: AgentInvocationOptions = {}): Promise<CompactionResult | null> {
    if (this.active) throw new Error('cannot compact an agent session while a run is active')
    this.active = true
    try {
      await this.prepareSkills(invocation.signal)
      return await this.compactor?.compactNow(invocation.signal) ?? null
    } finally {
      this.releaseRun()
    }
  }

  /**
   * Append attributed context without starting a turn.
   *
   * A2A quiet delivery uses this primitive. The returned history sequence is a
   * delivery receipt and lets wake-up schedulers coalesce messages safely.
   */
  inject(input: AgentInput): number {
    const message = userMessage(input)
    this.currentHistory.append({ kind: 'user', message })
    return this.currentHistory.entries().length
  }

  /** Resolve after the current run releases the session. */
  whenIdle(signal?: AbortSignal): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.idleWaiters.delete(finish)
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        if (settled) return
        settled = true
        this.idleWaiters.delete(finish)
        reject(signal?.reason)
      }
      this.idleWaiters.add(finish)
      signal?.addEventListener('abort', abort, { once: true })
      if (!this.active) finish()
    })
  }

  /** Start an eager run and expose both public events and its canonical terminal report. */
  stream(input: AgentInput, invocation: AgentInvocationOptions = {}): AgentRunHandle {
    return this.createRunHandle(input, invocation)
  }

  /** Process context already appended with {@link inject} without duplicating it. */
  streamPending(invocation: AgentInvocationOptions = {}): AgentRunHandle {
    return this.createRunHandle(undefined, invocation)
  }

  /** Run one user turn and return the terminal response. */
  async run(input: AgentInput, invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    const handle = this.stream(input, invocation)
    await this.consumeEvents(handle, invocation.onEvent)
    return await handle.result
  }

  /** Run one turn over already-injected context and return its terminal response. */
  async runPending(invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    const handle = this.streamPending(invocation)
    await this.consumeEvents(handle, invocation.onEvent)
    return await handle.result
  }

  private async consumeEvents(
    events: AsyncIterable<AgentRunEvent>,
    onEvent?: (event: AgentRunEvent) => void | Promise<void>,
  ): Promise<void> {
    for await (const event of events) {
      if (onEvent !== undefined) {
        const observation = Promise.resolve().then(() => onEvent(event))
        await waitForSettlement(observation, this.runtimeLimits.observerTimeoutMs ?? 30_000)
      }
    }
  }

  private createRunHandle(
    input: AgentInput | undefined,
    invocation: AgentInvocationOptions,
  ): AgentRunHandle {
    if (this.active) throw new Error(`agent session '${this.definition.id}' is already running`)
    const firstTurnSeq = this.currentHistory.entries().length + 1
    const owned = new AbortController()
    const signal = invocation.signal === undefined
      ? owned.signal
      : AbortSignal.any([invocation.signal, owned.signal])
    const buffer = new RunEventBuffer<AgentRunEvent>()
    const reportDeferred = deferred<RunReport>()
    const resultDeferred = deferred<AgentResponse>()
    const ledger = new RunLedger({
      ...this.options.observation === undefined ? {} : { observation: this.options.observation },
      ...this.options.observationResource === undefined ? {} : { resource: this.options.observationResource },
      conversationId: this.currentConversationId,
      sessionId: this.currentConversationId,
      agentId: this.definition.id,
      mode: this.definition.mode,
      maxTurns: this.definition.maxTurns,
      ...this.options.usagePolicy === undefined ? {} : { usagePolicy: this.options.usagePolicy },
      cumulativeTokenBudget: this.options.runtimeLimits?.maxTotalTokens !== undefined,
      ...this.options.ledgerLimits === undefined ? {} : { limits: this.options.ledgerLimits },
    })
    this.active = true
    const spanOperations = new Map<string, string>()

    const task = (async (): Promise<void> => {
      let failure: unknown
      let outcome: AgentRunOutcome | undefined
      try {
        await this.prepareSkills(signal, ledger)
        if (input !== undefined) {
          const message = userMessage(input)
          if (this.definition.memory.autoCaptureObjective) {
            const operation = ledger.startOperation('memory', { data: { action: 'capture-objective' } })
            try {
              this.currentMemory.captureOriginalObjective(message)
              ledger.endOperation(operation, 'success')
            } catch (error) {
              ledger.endOperation(operation, 'error', { error })
              throw error
            }
          }
          this.currentHistory.append({ kind: 'user', message })
        }
        for await (const event of this.runDefinition({ ...invocation, signal }, ledger)) {
          this.accountTraceEvent(ledger, spanOperations, event)
          if (event.type === 'agent-end') outcome = event.outcome
          buffer.push(event)
        }
        if (outcome === undefined) {
          throw new Error(`agent session '${this.definition.id}' ended without agent-end`)
        }
        if (signal.aborted) throw signal.reason ?? new Error('agent run was aborted')
        if (outcome.reason.kind === 'error' && outcome.reason.failure.code === 'USAGE_REQUIRED') {
          const error = new Error(outcome.reason.failure.message) as Error & { code: string }
          error.code = 'USAGE_REQUIRED'
          throw error
        }
      } catch (error: unknown) {
        failure = error
      }

      let report: RunReport
      try {
        const status: OperationStatus = signal.aborted || outcome?.reason.kind === 'aborted'
          ? 'aborted'
          : failure !== undefined || outcome?.reason.kind === 'error'
            ? 'error'
            : 'success'
        report = await ledger.finalize(status, outcome?.completed ?? false, failure)
        reportDeferred.resolve(report)
      } catch (finalizeError: unknown) {
        reportDeferred.reject(finalizeError)
        resultDeferred.reject(finalizeError)
        buffer.fail(finalizeError)
        this.releaseRun()
        return
      }

      if (failure === undefined && ledger.terminalAuditFailure) {
        const error = new Error('audit observation checkpoint failed after run finalization') as Error & { code: string }
        error.code = 'OBSERVABILITY_AUDIT_UNAVAILABLE'
        failure = error
      }
      if (failure !== undefined) {
        const error = new AgentRunError(
          messageOf(failure),
          errorCodeOf(failure) ?? AGENT_ACCOUNTING_ERROR_CODES.RUN_FAILED,
          report,
          { cause: failure },
        )
        resultDeferred.reject(error)
        buffer.fail(error)
      } else {
        const terminal = outcome as AgentRunOutcome
        const historyEvent = [...this.currentHistory.entries()].reverse()
          .find(entry => entry.seq >= firstTurnSeq && entry.event.kind === 'assistant')
          ?.event
        const assistantMessage = historyEvent?.kind === 'assistant' ? historyEvent.message : undefined
        const response: AgentResponse = Object.freeze({
          text: terminal.text,
          outcome: terminal,
          report,
          ...assistantMessage === undefined ? {} : { message: assistantMessage },
        })
        resultDeferred.resolve(response)
        buffer.close()
      }
      this.releaseRun()
    })()
    void task.catch(error => {
      reportDeferred.reject(error)
      resultDeferred.reject(error)
      buffer.fail(error)
      this.releaseRun()
    })
    void resultDeferred.promise.catch(() => undefined)
    void reportDeferred.promise.catch(() => undefined)

    let iterated = false
    return Object.freeze({
      runId: ledger.runId,
      result: resultDeferred.promise,
      report: reportDeferred.promise,
      [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
        if (iterated) return (async function* () { throw new Error('an agent run handle can only be iterated once') })()
        iterated = true
        return (async function* () {
          let exhausted = false
          try {
            while (true) {
              const item = await buffer.take()
              if (item.done) { exhausted = true; break }
              yield item.value
            }
          } finally {
            if (!exhausted) {
              owned.abort(new Error('agent event consumer stopped'))
              buffer.stop()
              await waitForSettlement(task, 30_000)
            }
          }
        })()
      },
    })
  }

  private releaseRun(): void {
    this.active = false
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  private accountTraceEvent(
    accounting: RunAccountingPort,
    spans: Map<string, string>,
    event: AgentRunEvent,
  ): void {
    if (event.type === 'span-start') {
      if (event.kind !== 'execute_tool' && event.kind !== 'compact') return
      const kind = event.kind === 'execute_tool' ? 'tool' : 'compaction'
      const toolCallId = typeof event.attributes?.['gen_ai.tool.call.id'] === 'string'
        ? event.attributes['gen_ai.tool.call.id']
        : undefined
      const operationId = accounting.startOperation(kind, {
        data: { name: event.name },
        ...toolCallId === undefined ? {} : { toolCallId },
      })
      spans.set(event.trace.spanId, operationId)
      return
    }
    if (event.type !== 'span-end') return
    const operationId = spans.get(event.trace.spanId)
    if (operationId === undefined) return
    spans.delete(event.trace.spanId)
    accounting.endOperation(operationId, event.status, {
      ...event.error === undefined ? {} : { error: event.error },
    })
  }

  private runDefinition(
    invocation: AgentInvocationOptions,
    accounting?: RunAccountingPort,
  ): AsyncIterable<AgentRunEvent> {
    const definition = this.definition
    const hooks = this.combinedHooks(accounting)
    const common = {
      registry: this.options.registry,
      config: {
        provider: definition.provider,
        model: definition.model,
        reasoningEffort: definition.effort,
        ...definition.maxTokens === undefined ? {} : { maxTokens: definition.maxTokens },
      },
      history: this.history,
      ...this.catalog === undefined ? {} : { tools: this.catalog },
      ...definition.nativeTools.length === 0 ? {} : { nativeTools: definition.nativeTools },
      ...definition.toolChoice === undefined ? {} : { toolChoice: definition.toolChoice },
      system: this.systemInstructions(),
      maxTurns: definition.maxTurns,
      bounds: {
        maxToolCalls: definition.maxToolCalls,
        ...this.runtimeLimits.maxParallelToolCalls === undefined
          ? {}
          : { maxParallel: this.runtimeLimits.maxParallelToolCalls },
        ...this.runtimeLimits.maxConsecutiveToolErrors === undefined
          ? {}
          : { maxConsecutiveToolErrors: this.runtimeLimits.maxConsecutiveToolErrors },
        ...this.runtimeLimits.repeatToolWarningAt === undefined
          ? {}
          : { repeatToolWarningAt: this.runtimeLimits.repeatToolWarningAt },
        ...this.runtimeLimits.repeatToolLimit === undefined
          ? {}
          : { repeatToolLimit: this.runtimeLimits.repeatToolLimit },
        ...this.runtimeLimits.toolCycleWarningAt === undefined
          ? {}
          : { toolCycleWarningAt: this.runtimeLimits.toolCycleWarningAt },
        ...this.runtimeLimits.toolCycleLimit === undefined
          ? {}
          : { toolCycleLimit: this.runtimeLimits.toolCycleLimit },
        ...this.runtimeLimits.maxToolCycleLength === undefined
          ? {}
          : { maxToolCycleLength: this.runtimeLimits.maxToolCycleLength },
        ...this.runtimeLimits.maxTotalTokens === undefined
          ? {}
          : { maxTotalTokens: this.runtimeLimits.maxTotalTokens },
        ...this.runtimeLimits.maxToolResultBytes === undefined
          ? {}
          : { maxToolResultBytes: this.runtimeLimits.maxToolResultBytes },
        ...this.runtimeLimits.maxToolDurationMs === undefined
          ? {}
          : { maxToolDurationMs: this.runtimeLimits.maxToolDurationMs },
        ...this.runtimeLimits.toolTeardownTimeoutMs === undefined
          ? {}
          : { toolTeardownTimeoutMs: this.runtimeLimits.toolTeardownTimeoutMs },
      },
      commentary: definition.commentary,
      ...this.runtimeLimits.teardownTimeoutMs === undefined ? {} : { teardownTimeoutMs: this.runtimeLimits.teardownTimeoutMs },
      ...this.runtimeLimits.modelTimeoutMs === undefined ? {} : { modelTimeoutMs: this.runtimeLimits.modelTimeoutMs },
      ...this.runtimeLimits.maxModelRequestBytes === undefined ? {} : { maxModelRequestBytes: this.runtimeLimits.maxModelRequestBytes },
      ...this.runtimeLimits.maxModelResponseBytes === undefined ? {} : { maxModelResponseBytes: this.runtimeLimits.maxModelResponseBytes },
      ...this.runtimeLimits.maxModelStreamEvents === undefined ? {} : { maxModelStreamEvents: this.runtimeLimits.maxModelStreamEvents },
      ...this.runtimeLimits.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: this.runtimeLimits.hookTimeoutMs },
      ...this.runtimeLimits.hookTeardownTimeoutMs === undefined ? {} : { hookTeardownTimeoutMs: this.runtimeLimits.hookTeardownTimeoutMs },
      ...this.options.approvals === undefined ? {} : { approvals: this.options.approvals },
      ...this.options.interceptors === undefined ? {} : { interceptors: this.options.interceptors },
      ...hooks === undefined ? {} : { hooks },
      ...invocation.signal === undefined ? {} : { signal: invocation.signal },
      ...accounting === undefined ? {} : { accounting },
      trace: {
        ...this.options.trace,
        conversationId: this.currentConversationId,
        agentId: definition.id,
        agentName: definition.name,
      },
    }
    if (definition.mode === 'deep-human-in-loop') {
      return runAgent({
        ...common, mode: definition.mode, userInput: this.options.userInput as UserInputBroker,
      })
    }
    if (definition.mode === 'deep') {
      return runAgent({
        ...common, mode: definition.mode,
        ...this.options.userInput === undefined ? {} : { userInput: this.options.userInput },
      })
    }
    return runAgent({ ...common, mode: 'basic' })
  }

  private memoryMessages(accounting?: RunAccountingPort): readonly UserMessage[] {
    const operation = accounting?.startOperation('memory', { data: { action: 'render' } })
    try {
      const memory = this.currentMemory.render(this.definition.memory.maxInjectedChars)
      if (operation !== undefined) accounting?.endOperation(operation, 'success')
      return memory.length === 0 ? [] : [createUserMessage({
        source: { kind: 'app', producer: 'agent-task-memory' },
        content: [{ type: 'text', text: memory }],
      })]
    } catch (error) {
      if (operation !== undefined) accounting?.endOperation(operation, 'error', { error })
      throw error
    }
  }

  private createCompactor(): ContextCompactor | undefined {
    const configured = this.options.compaction === false
      ? false
      : this.options.compaction === undefined
        ? this.definition.compaction
        : resolveCompactionConfig(this.options.compaction)
    if (configured === false) return undefined
    return new ContextCompactor({
      registry: this.options.registry,
      config: {
        provider: this.definition.provider,
        model: this.definition.model,
        reasoningEffort: this.definition.effort,
        ...this.definition.maxTokens === undefined ? {} : { maxTokens: this.definition.maxTokens },
      },
      history: () => this.currentHistory,
      system: () => this.systemInstructions(),
      pinnedMessages: () => this.memoryMessages(),
      tools: () => [
        ...this.catalog?.schemas() ?? [],
        ...this.definition.nativeTools,
      ],
      policy: configured,
    })
  }

  private combinedHooks(accounting?: RunAccountingPort): TurnHooks | undefined {
    const user = this.options.hooks
    if (this.compactor === undefined
      && user === undefined
      && this.currentMemory.items().length === 0) return undefined
    return {
      ...user,
      beforeStep: async context => {
        const generation = this.currentHistory.generation()
        await this.compactor?.beforeStep(context)
        const refreshed = this.currentHistory.generation() === generation
          ? context
          : {
            ...context,
            messages: normalizeToolPairing(this.currentHistory.messages()),
            snapshot: this.currentHistory.snapshot(),
          }
        const memory = this.memoryMessages(accounting)
        const current = memory.length === 0
          ? refreshed
          : { ...refreshed, messages: Object.freeze([...memory, ...refreshed.messages]) }
        const decision = await user?.beforeStep?.(current) ?? { kind: 'proceed' as const }
        if (decision.kind === 'reject') return decision
        const prepend = [...memory, ...decision.prepend ?? []]
        return prepend.length === 0 ? decision : { kind: 'proceed' as const, prepend }
      },
      onRequestError: async context => {
        const recovery = await this.compactor?.onRequestError(context)
        if (recovery === 'retry') return 'retry'
        return await user?.onRequestError?.(context) ?? 'fail'
      },
    }
  }

  private systemInstructions(): string {
    const base = this.skillCatalog === undefined
      ? this.definition.instructions
      : renderSkillCatalog(
          this.definition.instructions,
          this.skillCatalog.summaries(),
          this.definition.skillOptions,
        )
    const team = this.options.team
    return team === undefined
      ? base
      : `${base}\n\n${team.team.instructionsFor(team.name ?? this.definition.id)}`
  }

  private skillLookup(signal?: AbortSignal): SkillLookupOptions {
    return {
      ...(this.options.skillCwd === undefined ? {} : { cwd: this.options.skillCwd }),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  private activationSnapshot(): readonly AgentSessionActivatedSkillSnapshot[] {
    const activated = new Map<string, AgentSessionActivatedSkillSnapshot>()
    for (const entry of this.pendingSkillActivations) activated.set(entry.id, entry)
    for (const summary of this.skillCatalog?.activatedSummaries() ?? []) {
      activated.set(summary.id, Object.freeze({
        id: summary.id, provider: summary.provider, source: summary.source,
        ...summary.resourceBase === undefined ? {} : {
          resourceBase: Object.freeze({ ...summary.resourceBase }),
        },
      }))
    }
    return Object.freeze([...activated.values()].sort((left, right) => left.id.localeCompare(right.id)))
  }

  private async prepareSkills(signal?: AbortSignal, accounting?: RunAccountingPort): Promise<void> {
    const operation = accounting?.startOperation('skill', { data: { action: 'discover-and-restore' } })
    const operationSignal = AbortSignal.any([
      AbortSignal.timeout(this.definition.skillOptions.operationTimeoutMs),
      ...signal === undefined ? [] : [signal],
    ])
    const catalog = this.skillCatalog
    try {
      if (catalog === undefined) {
        if (this.pendingSkillActivations.length > 0) {
          throw new Error(`agent '${this.definition.id}' cannot restore activated skills without skill sources`)
        }
        if (operation !== undefined) accounting?.endOperation(operation, 'success')
        return
      }
      const lookup = this.skillLookup(operationSignal)
      await catalog.discover(lookup)
      if (this.pendingSkillActivations.length === 0) {
        if (operation !== undefined) accounting?.endOperation(operation, 'success')
        return
      }
      const pending = this.pendingSkillActivations
      for (const activation of pending) {
        const summary = catalog.summaries().find(candidate => candidate.id === activation.id)
        if (summary === undefined) {
          throw new Error(`cannot restore activated skill '${activation.id}'; it is no longer available`)
        }
        if (summary.provider !== activation.provider || summary.source !== activation.source) {
          throw new Error(
            `cannot restore activated skill '${activation.id}'; its provider or source changed`,
          )
        }
        if (summary.resourceBase?.kind !== activation.resourceBase?.kind
          || summary.resourceBase?.value !== activation.resourceBase?.value) {
          throw new Error(
            `cannot restore activated skill '${activation.id}'; its resource location changed`,
          )
        }
        if (await catalog.activate(activation.id, lookup) === undefined) {
          throw new Error(`cannot restore activated skill '${activation.id}'; its definition is unavailable`)
        }
      }
      this.pendingSkillActivations = Object.freeze([])
      if (operation !== undefined) accounting?.endOperation(operation, 'success')
    } catch (error: unknown) {
      catalog?.clearActivations()
      if (operation !== undefined) accounting?.endOperation(
        operation,
        operationSignal.aborted ? 'aborted' : 'error',
        { error },
      )
      throw error
    }
  }

  private captureResumedObjective(): void {
    if (!this.definition.memory.autoCaptureObjective) return
    const entry = this.currentHistory.entries().find(entry =>
      entry.event.kind === 'user'
      && entry.event.message.role === 'user'
      && entry.event.message.source.kind === 'user')
    if (entry?.event.kind === 'user' && isUserMessage(entry.event.message)) {
      this.currentMemory.captureOriginalObjective(entry.event.message)
    }
  }
}

function validateSessionSnapshot(
  value: AgentSessionSnapshot,
  expectedAgentId: string,
  maxActivatedSkills: number,
): void {
  if (typeof value !== 'object' || value === null || value.version !== 1) {
    throw new TypeError('unsupported agent session snapshot')
  }
  snapshotString(value.conversationId, 'conversationId', 256)
  snapshotString(value.agentId, 'agentId', 256)
  if (value.agentId !== expectedAgentId) {
    throw new TypeError(
      `cannot resume conversation for agent '${value.agentId}' with agent '${expectedAgentId}'`,
    )
  }
  if (value.skills !== undefined) validateSkillSnapshot(value.skills, maxActivatedSkills)
}

function validateSkillSnapshot(value: unknown, maxActivatedSkills: number): void {
  if (!record(value) || !Array.isArray(value.activated)) {
    throw new TypeError('agent session snapshot skills.activated must be an array')
  }
  if (value.activated.length > maxActivatedSkills) {
    throw new RangeError(
      `agent session snapshot exceeds the ${maxActivatedSkills}-activated-skill limit`,
    )
  }
  const ids = new Set<string>()
  for (let index = 0; index < value.activated.length; index++) {
    const activation = value.activated[index]
    if (!record(activation)) {
      throw new TypeError(`agent session snapshot skills.activated[${index}] must be an object`)
    }
    const id = snapshotString(activation.id, `skills.activated[${index}].id`, 256)
    snapshotString(activation.provider, `skills.activated[${index}].provider`, 256)
    snapshotString(activation.source, `skills.activated[${index}].source`, 8_192)
    if (activation.resourceBase !== undefined) {
      if (!record(activation.resourceBase)
        || !['directory', 'url', 'opaque'].includes(String(activation.resourceBase.kind))) {
        throw new TypeError(
          `agent session snapshot skills.activated[${index}].resourceBase is invalid`,
        )
      }
      snapshotString(
        activation.resourceBase.value,
        `skills.activated[${index}].resourceBase.value`,
        8_192,
      )
    }
    if (ids.has(id)) throw new TypeError(`duplicate activated skill '${id}' in agent session snapshot`)
    ids.add(id)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snapshotString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(
      `agent session snapshot ${path} must be a non-empty string of at most ${maxLength} characters`,
    )
  }
  return value
}

function conversationId(value: string | undefined): string {
  if (value === undefined) return newConversationId()
  if (value.trim().length === 0 || value.length > 256) {
    throw new TypeError('agent conversationId must be a non-empty string of at most 256 characters')
  }
  return value
}

function resolveRuntimeLimits(input: AgentRuntimeLimits | undefined): Readonly<AgentRuntimeLimits> {
  if (input === undefined) return Object.freeze({})
  const values = { ...input }
  for (const key of [
    'teardownTimeoutMs', 'modelTimeoutMs', 'maxModelRequestBytes',
    'maxModelResponseBytes', 'maxModelStreamEvents', 'maxToolResultBytes',
    'maxToolDurationMs', 'toolTeardownTimeoutMs', 'maxParallelToolCalls',
    'maxConsecutiveToolErrors', 'repeatToolWarningAt', 'repeatToolLimit',
    'toolCycleWarningAt', 'toolCycleLimit', 'maxToolCycleLength', 'maxTotalTokens',
    'hookTimeoutMs', 'hookTeardownTimeoutMs',
    'observerTimeoutMs',
  ] as const) {
    const value = values[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`agent runtimeLimits.${key} must be a positive safe integer`)
    }
  }
  if ((values.repeatToolLimit ?? 6) < (values.repeatToolWarningAt ?? 3)) {
    throw new RangeError('agent runtimeLimits.repeatToolLimit must be >= repeatToolWarningAt')
  }
  if ((values.toolCycleLimit ?? 3) < (values.toolCycleWarningAt ?? 2)) {
    throw new RangeError('agent runtimeLimits.toolCycleLimit must be >= toolCycleWarningAt')
  }
  return Object.freeze(values)
}

function newConversationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function userMessage(input: AgentInput): UserMessage {
  if (typeof input === 'string') return createTextMessage(input)
  if (input.role !== 'user') throw new TypeError('agent input message must have role user')
  return freezeMessage(input)
}

function isUserMessage(message: Message): message is UserMessage { return message.role === 'user' }

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function toolCatalog(
  defined: readonly ToolDefinition<any>[],
  additional: ToolCatalog | readonly ToolDefinition<any>[] | undefined,
  generated: readonly ToolDefinition<any>[] = [],
): ToolCatalog | undefined {
  if (defined.length === 0 && additional === undefined && generated.length === 0) return undefined
  const registry = new ToolRegistry()
  for (const tool of defined) registry.register(tool)
  if (additional !== undefined) {
    const tools = 'names' in additional
      ? additional.names().map(name => additional.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
      : additional
    for (const tool of tools) registry.register(tool)
  }
  for (const tool of generated) registry.register(tool)
  return registry
}
