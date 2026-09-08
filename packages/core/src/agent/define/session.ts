import { type ToolCatalog } from '../tool/registry.ts'
import { History } from '../history/history.ts'
import { normalizeToolPairing } from '../history/normalize.ts'
import type { TurnHooks } from '../loop/types.ts'
import { ContextCompactor, type CompactionResult } from '../memory/compaction.ts'
import { bindCompactionAccounting } from '../memory/accounting-binding.ts'
import { resolveCompactionConfig } from '../memory/compaction-config.ts'
import { AgentMemory } from '../memory/memory.ts'
import { runAgent, type AgentRunEvent, type AgentRunOutcome } from '../mode/run-agent.ts'
import type { UserInputBroker } from '../mode/user-input.ts'
import { waitForSettlement } from '../../async/index.ts'
import type { OperationStatus } from '../../observation/index.ts'
import { RunEventBuffer } from '../accounting/event-buffer.ts'
import { AgentRunError, AGENT_ACCOUNTING_ERROR_CODES } from '../accounting/error.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { LegacyRunReport } from '../accounting/report.ts'
import type { RunReport } from '../accounting/delivery-types.ts'
import { createRunTerminalRecord, withTerminalDelivery } from '../accounting/delivery/terminal.ts'
import { SkillCatalog, createSkillTools, renderSkillCatalog, type SkillLookupOptions } from '../skill/index.ts'
import type { AgentDefinition } from './definition.ts'
import {
  type AgentInput, type AgentRuntimeLimits, type AgentSessionOptions, type AgentSessionSnapshot,
  type AgentSessionActivatedSkillSnapshot, type AgentResumeSessionOptions,
  type AgentInvocationOptions, type AgentResponse, type AgentRunHandle,
} from './session/types.ts'
import { validateSessionSnapshot } from './session/validation.ts'
import { resolveRuntimeLimits } from './session/config.ts'
import {
  conversationId, newConversationId, userMessage, deferred, messageOf, errorCodeOf,
  toolCatalog,
} from './session/common.ts'
import { captureResumedSkillActivations, prepareSkills } from './session/skills.ts'
import { appendRunInstructions } from './instructions.ts'
import type { ToolSourceRunReference } from '../tool/source-types.ts'
import { accountTraceEvent } from './session/trace-accounting.ts'
import {
  captureResumedObjective, commitRuntimeMemory, loadRuntimeMemory, renderRuntimeMemory,
} from './session/runtime-memory.ts'
import { attachRuntimeSession, runtimeSessionConfiguration } from './session/runtime-binding.ts'
import { bindSkillProviderLogger } from '../skill/provider/context.ts'
import { createSessionLedger } from './session/accounting.ts'
import { runRuntimeCompaction } from './session/runtime-compaction.ts'
import { sessionCallConfig } from './session/model-config.ts'
import { consumeSessionEvents } from './session/observer.ts'
import { sealRuntimeRun } from './session/run-seal.ts'

export class AgentSession {
  readonly definition: AgentDefinition
  private readonly options: AgentSessionOptions
  private readonly catalog: ToolCatalog | undefined
  private activeRuntimeCatalog: ToolCatalog | undefined
  private readonly skillCatalog: SkillCatalog | undefined
  private readonly runtimeLimits: Readonly<AgentRuntimeLimits>
  private currentHistory: History
  private currentMemory: AgentMemory
  private currentConversationId: string
  private compactor: ContextCompactor | undefined
  private pendingSkillActivations: readonly AgentSessionActivatedSkillSnapshot[] = Object.freeze([])
  private active = false
  private activeAdditionalInstructions: string | undefined
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
    const ledgerLimits = options.ledgerLimits === undefined ? undefined : Object.freeze({ ...options.ledgerLimits })
    const eventBufferLimits = options.eventBufferLimits === undefined
      ? undefined
      : Object.freeze({ ...options.eventBufferLimits })
    this.options = Object.freeze({
      ...options,
      ...(historyLimits === undefined ? {} : { historyLimits }),
      ...(compaction === undefined ? {} : { compaction }),
      ...(trace === undefined ? {} : { trace }),
      ...(team === undefined ? {} : { team }),
      ...(ledgerLimits === undefined ? {} : { ledgerLimits }),
      ...(eventBufferLimits === undefined ? {} : { eventBufferLimits }),
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
    const teamAccess = options.team?.tools === 'reporting' ? 'reporting' as const : 'full' as const
    const teamTools = options.team?.tools === false
      ? []
      : options.team?.team.toolsFor(options.team.name ?? definition.id, teamAccess) ?? []
    this.catalog = toolCatalog(definition.tools, options.tools, [...skillTools, ...teamTools])
    this.currentMemory = options.memory instanceof AgentMemory
      ? options.memory
      : options.memory === undefined
        ? new AgentMemory(definition.memory.seed, definition.memory)
        : AgentMemory.fromSnapshot(options.memory, definition.memory)
    captureResumedObjective(this.currentMemory, this.currentHistory, this.definition.memory.autoCaptureObjective)
    this.compactor = this.createCompactor()
    attachRuntimeSession(this, (input, invocation, additionalInstructions) =>
      this.createRunHandle(input, invocation, additionalInstructions), invocation =>
      this.createRunHandle(undefined, invocation), invocation =>
      this.compactForRuntime(invocation), () => {
      this.compactor = this.createCompactor()
    })
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
    session.pendingSkillActivations = captureResumedSkillActivations(snapshot.skills, session.skillCatalog)
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
      ...runtimeSessionConfiguration(this)?.memory === undefined ? {} : {
        memoryBindingId: runtimeSessionConfiguration(this)!.memory!.bindingId,
      },
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

  private async compactForRuntime(invocation: AgentInvocationOptions): Promise<{
    readonly result: CompactionResult | null
    readonly report: LegacyRunReport
    readonly failure?: unknown
  }> {
    if (this.active) throw new Error('cannot compact an agent session while a run is active')
    const ledger = this.createLedger()
    this.active = true
    if (this.compactor !== undefined) bindCompactionAccounting(this.compactor, ledger)
    if (this.skillCatalog !== undefined) bindSkillProviderLogger(this.skillCatalog, ledger.modelInvocation.logger)
    try { return await runRuntimeCompaction({
      ...(this.compactor === undefined ? {} : { compactor: this.compactor }),
      invocation,
      accounting: ledger,
      prepare: () => this.prepareSkills(invocation.signal, ledger),
    }) } finally { this.releaseRun() }
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
    await consumeSessionEvents(handle, invocation.onEvent, this.runtimeLimits.observerTimeoutMs ?? 30_000)
    return await handle.result
  }

  /** Run one turn over already-injected context and return its terminal response. */
  async runPending(invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    const handle = this.streamPending(invocation)
    await consumeSessionEvents(handle, invocation.onEvent, this.runtimeLimits.observerTimeoutMs ?? 30_000)
    return await handle.result
  }

  private createRunHandle(
    input: AgentInput | undefined,
    invocation: AgentInvocationOptions,
    additionalInstructions?: string,
  ): AgentRunHandle {
    if (this.active) throw new Error(`agent session '${this.definition.id}' is already running`)
    const firstTurnSeq = this.currentHistory.entries().length + 1
    const owned = new AbortController()
    let terminal = false
    const signal = invocation.signal === undefined
      ? owned.signal
      : AbortSignal.any([invocation.signal, owned.signal])
    const buffer = new RunEventBuffer<AgentRunEvent>(
      this.options.eventBufferLimits?.maxEvents,
      this.options.eventBufferLimits?.maxBytes,
    )
    const reportDeferred = deferred<RunReport>()
    const resultDeferred = deferred<AgentResponse>()
    const toolSourcesDeferred = deferred<readonly ToolSourceRunReference[]>()
    const ledger = this.createLedger()
    let toolSourceReferences: readonly ToolSourceRunReference[] = Object.freeze([])
    if (this.compactor !== undefined) bindCompactionAccounting(this.compactor, ledger)
    if (this.skillCatalog !== undefined) {
      bindSkillProviderLogger(this.skillCatalog, ledger.modelInvocation.logger)
    }
    this.active = true
    this.activeAdditionalInstructions = additionalInstructions
    const spanOperations = new Map<string, string>()
    const task = (async (): Promise<void> => {
      let failure: unknown
      let outcome: AgentRunOutcome | undefined
      let memoryState: Awaited<ReturnType<typeof loadRuntimeMemory>>['state'] | undefined
      try {
        const runtime = runtimeSessionConfiguration(this)
        if (runtime?.memory !== undefined) {
          const prepared = await loadRuntimeMemory(
            runtime.memory, this.currentConversationId, this.definition.memory, signal, ledger,
          )
          memoryState = prepared.state
          if (prepared.memory !== undefined) this.currentMemory = prepared.memory
        }
        if (runtime?.prepareTools !== undefined) {
          const logger = ledger.modelInvocation.logger
          if (logger === undefined) throw new Error('runtime tool source logger is unavailable')
          const generation = runtime.prepareTools(signal, logger, [...this.catalog?.names() ?? [], ...this.definition.nativeTools.map(tool => tool.name)])
          this.activeRuntimeCatalog = toolCatalog([], this.catalog, generation.tools)
          toolSourceReferences = generation.references
        }
        toolSourcesDeferred.resolve(toolSourceReferences)
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
          accountTraceEvent(ledger, spanOperations, event)
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
        if (runtime?.memory !== undefined && memoryState !== undefined && memoryState.status !== 'disabled') {
          await commitRuntimeMemory(
            runtime.memory, this.currentConversationId, this.currentMemory.snapshot(),
            memoryState, signal, ledger,
          )
        }
      } catch (error: unknown) {
        failure = error
        toolSourcesDeferred.resolve(toolSourceReferences)
      }

      let report: RunReport
      try {
        const status: OperationStatus = signal.aborted || outcome?.reason.kind === 'aborted'
          ? 'aborted'
          : failure !== undefined || outcome?.reason.kind === 'error'
            ? 'error'
            : 'success'
        const ledgerReport = await ledger.finalize(status, outcome?.completed ?? false, failure)
        report = withTerminalDelivery(createRunTerminalRecord(ledgerReport), ledgerReport.delivery)
        reportDeferred.resolve(report)
      } catch (finalizeError: unknown) {
        reportDeferred.reject(finalizeError)
        resultDeferred.reject(finalizeError)
        buffer.fail(finalizeError)
        terminal = true
        this.releaseRun()
        return
      }
      if (terminal) return

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
      terminal = true
      this.releaseRun()
    })()
    void task.catch(error => {
      if (terminal) return
      reportDeferred.reject(error)
      resultDeferred.reject(error)
      buffer.fail(error)
      terminal = true
      this.releaseRun()
    })
    void resultDeferred.promise.catch(() => undefined)
    void reportDeferred.promise.catch(() => undefined)
    let iterated = false
    return Object.freeze({
      runId: ledger.runId,
      traceId: ledger.traceId,
      toolSourceSnapshots: toolSourcesDeferred.promise,
      eventsSettled: task.then(() => undefined, () => undefined),
      result: resultDeferred.promise,
      report: reportDeferred.promise,
      seal: () => sealRuntimeRun({ ledger, buffer, report: reportDeferred, result: resultDeferred,
        toolSources: toolSourcesDeferred, currentToolSources: () => toolSourceReferences, isTerminal: () => terminal,
        markTerminal: () => { terminal = true }, abort: () => owned.abort(new Error('Agent run was sealed')),
        release: () => this.releaseRun() }),
      abort(_reason?: unknown): void {
        if (!terminal && !owned.signal.aborted) owned.abort(new Error('Agent run was aborted'))
      },
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
    this.activeAdditionalInstructions = undefined
    this.activeRuntimeCatalog = undefined
    if (this.skillCatalog !== undefined) bindSkillProviderLogger(this.skillCatalog, undefined)
    if (this.compactor !== undefined) bindCompactionAccounting(this.compactor, undefined)
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  private createLedger() {
    const runtime = runtimeSessionConfiguration(this)
    return createSessionLedger({
      definition: this.definition,
      options: this.options,
      runtimeLimits: this.runtimeLimits,
      conversationId: this.currentConversationId,
      ...(runtime === undefined ? {} : { runtime }),
    })
  }

  private runDefinition(
    invocation: AgentInvocationOptions,
    accounting?: RunAccountingPort,
  ): AsyncIterable<AgentRunEvent> {
    const definition = this.definition
    const hooks = this.combinedHooks(accounting)
    const catalog = this.effectiveCatalog()
    const common = {
      registry: this.options.registry,
      config: this.callConfig(),
      history: this.history,
      ...catalog === undefined ? {} : { tools: catalog },
      ...definition.nativeTools.length === 0 ? {} : { nativeTools: definition.nativeTools },
      ...definition.toolChoice === undefined ? {} : { toolChoice: definition.toolChoice },
      ...definition.outputFormat === undefined ? {} : { outputFormat: definition.outputFormat },
      system: this.systemInstructions(this.activeAdditionalInstructions),
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
        ...this.runtimeLimits.onExhausted === undefined
          ? {}
          : { onExhausted: this.runtimeLimits.onExhausted },
        ...this.runtimeLimits.maxToolResultTokens === undefined
          ? {}
          : { maxToolResultTokens: this.runtimeLimits.maxToolResultTokens },
        ...this.runtimeLimits.toolResultOverflow === undefined
          ? {}
          : { toolResultOverflow: this.runtimeLimits.toolResultOverflow },
        ...this.runtimeLimits.maxToolCycleLength === undefined
          ? {}
          : { maxToolCycleLength: this.runtimeLimits.maxToolCycleLength },
        ...this.runtimeLimits.finalReportReserveTokens === undefined ? {} : {
          finalReportReserveTokens: this.runtimeLimits.finalReportReserveTokens,
        },
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
      ...this.options.spillStore === undefined ? {} : { spillStore: this.options.spillStore },
      ...this.options.interceptors === undefined ? {} : { interceptors: this.options.interceptors },
      ...hooks === undefined ? {} : { hooks },
      ...invocation.signal === undefined ? {} : { signal: invocation.signal },
      ...accounting === undefined ? {} : { accounting },
      ...accounting?.modelInvocation.logger === undefined ? {} : { logger: accounting.modelInvocation.logger },
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

  private createCompactor(): ContextCompactor | undefined {
    const configured = this.options.compaction === false
      ? false
      : this.options.compaction === undefined
        ? this.definition.compaction
        : resolveCompactionConfig(this.options.compaction)
    if (configured === false) return undefined
    return new ContextCompactor({
      registry: this.options.registry,
      config: this.callConfig(),
      history: () => this.currentHistory,
      system: () => this.systemInstructions(this.activeAdditionalInstructions),
      pinnedMessages: () => renderRuntimeMemory(
        this.currentMemory, this.definition.memory.maxInjectedChars,
      ),
      tools: () => [
        ...this.effectiveCatalog()?.schemas() ?? [],
        ...this.definition.nativeTools,
      ],
      policy: configured,
    })
  }

  private effectiveCatalog(): ToolCatalog | undefined {
    return this.activeRuntimeCatalog ?? this.catalog
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
        if (this.compactor !== undefined) bindCompactionAccounting(this.compactor, accounting)
        await this.compactor?.beforeStep(context)
        if (accounting?.usageStop !== undefined) return { kind: 'proceed' as const }
        const refreshed = this.currentHistory.generation() === generation
          ? context
          : {
            ...context,
            messages: normalizeToolPairing(this.currentHistory.messages()),
            snapshot: this.currentHistory.snapshot(),
          }
        const memory = renderRuntimeMemory(
          this.currentMemory, this.definition.memory.maxInjectedChars, accounting,
        )
        const current = memory.length === 0
          ? refreshed
          : { ...refreshed, messages: Object.freeze([...memory, ...refreshed.messages]) }
        const decision = await user?.beforeStep?.(current) ?? { kind: 'proceed' as const }
        if (decision.kind === 'reject') return decision
        const prepend = [...memory, ...decision.prepend ?? []]
        return prepend.length === 0 ? decision : { kind: 'proceed' as const, prepend }
      },
      onRequestError: async context => {
        if (this.compactor !== undefined) bindCompactionAccounting(this.compactor, accounting)
        const recovery = await this.compactor?.onRequestError(context)
        if (accounting?.usageStop !== undefined) return 'fail'
        if (recovery === 'retry') return 'retry'
        return await user?.onRequestError?.(context) ?? 'fail'
      },
    }
  }

  private callConfig() { return sessionCallConfig(this.definition, runtimeSessionConfiguration(this)) }

  private systemInstructions(additionalInstructions?: string): string {
    const base = this.skillCatalog === undefined
      ? this.definition.instructions
      : renderSkillCatalog(
          this.definition.instructions,
          this.skillCatalog.summaries(),
          this.definition.skillOptions,
        )
    const team = this.options.team
    const composed = team === undefined
      ? base
      : `${base}\n\n${team.team.instructionsFor(team.name ?? this.definition.id)}`
    return appendRunInstructions(composed, additionalInstructions)
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
    for (const reference of this.skillCatalog?.activatedSkillReferences() ?? []) {
      activated.set(reference.id, reference)
    }
    for (const summary of this.skillCatalog?.activatedSummaries() ?? []) {
      if (activated.has(summary.id)) continue
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
    await prepareSkills(
      this.definition, this.skillCatalog, this.pendingSkillActivations,
      signal => this.skillLookup(signal),
      () => { this.pendingSkillActivations = Object.freeze([]) }, signal, accounting,
    )
  }
}

export { configureRuntimeSessionModel, streamRuntimeSession } from './session/runtime-binding.ts'
export type {
  AgentInput, AgentRuntimeLimits, AgentSessionOptions, AgentTeamMemberOptions,
  AgentSessionSnapshot, AgentSessionActivatedSkillSnapshot, AgentResumeSessionOptions,
  AgentInvocationOptions, AgentResponse, AgentRunHandle,
} from './session/types.ts'
