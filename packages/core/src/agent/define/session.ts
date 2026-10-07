import { type ToolCatalog } from '../tool/registry.ts'
import { History } from '../history/history.ts'
import { isManagedTeamNotice } from '../history/input-work.ts'
import { bindModelRequestBoundary, bindQueuedInput } from '../loop/turn/model-request-boundary.ts'
import type { TurnHooks } from '../loop/types.ts'
import { ContextCompactor, type CompactionResult } from '../memory/compaction.ts'
import { bindCompactionAccounting } from '../memory/accounting-binding.ts'
import { resolveCompactionConfig } from '../memory/compaction-config.ts'
import { AgentMemory } from '../memory/memory.ts'
import type { ContextSection } from '../context/types.ts'
import { type AgentRunEvent, type AgentRunOutcome } from '../mode/run-agent.ts'
import { runSessionDefinition } from './session-run-definition.ts'
import { createSessionRunHandle } from './session-run-handle.ts'
import { combinedSessionHooks, sessionSkillLookup, sessionActivationSnapshot } from './session-hooks.ts'
import { sessionContextSections, sessionSkills, sessionCatalog, teamAttachmentOptions } from './session-init.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { LegacyRunReport } from '../accounting/report.ts'
import { SkillCatalog, renderSkillCatalog, type SkillLookupOptions } from '../skill/index.ts'
import type { AgentDefinition } from './definition.ts'
import {
  type AgentInput, type AgentRuntimeLimits, type AgentSessionOptions, type AgentSessionSnapshot,
  type AgentSessionActivatedSkillSnapshot, type AgentResumeSessionOptions,
  type AgentInvocationOptions, type AgentResponse, type AgentRunHandle,
} from './session/types.ts'
import { validateSessionSnapshot } from './session/validation.ts'
import { normalizeSessionOptions, resolveRuntimeLimits } from './session/config.ts'
import {
  conversationId, newConversationId, userMessage,
} from './session/common.ts'
import { captureResumedSkillActivations, prepareSkills } from './session/skills.ts'
import { appendRunInstructions } from './instructions.ts'
import { captureResumedObjective, renderRuntimeMemory } from './session/runtime-memory.ts'
import { attachRuntimeSession, runtimeSessionConfiguration } from './session/runtime-binding.ts'
import { bindSkillProviderLogger } from '../skill/provider/context.ts'
import { createSessionLedger } from './session/accounting.ts'
import { runRuntimeCompaction } from './session/runtime-compaction.ts'
import { sessionCallConfig } from './session/model-config.ts'
import { consumeSessionEvents } from './session/observer.ts'
function createSessionMemory(memory: AgentSessionOptions['memory'], definition: AgentDefinition): AgentMemory {
  if (memory instanceof AgentMemory) return memory
  return memory === undefined
    ? new AgentMemory(definition.memory.seed, definition.memory)
    : AgentMemory.fromSnapshot(memory, definition.memory)
}
function resolveSessionCompaction(
  option: AgentSessionOptions['compaction'], definition: AgentDefinition['compaction'],
): any {
  if (option === false) return false
  if (option === undefined) return definition
  return resolveCompactionConfig(option)
}
function isChatSpanStart(event: AgentRunEvent): boolean {
  return event.type === 'span-start' && event.kind === 'chat'
}
function eventCalledTool(event: AgentRunEvent): boolean {
  return event.type === 'tool-call'
    || (event.type === 'assistant-message'
      && event.message?.content.some(block => block.type === 'tool-call') === true)
}
function eventEndsRound(event: AgentRunEvent, calledTools: boolean): boolean {
  return (event.type === 'step-end' && calledTools)
    || event.type === 'turn-end' || event.type === 'agent-end'
}

export class AgentSession {
  readonly definition: AgentDefinition
  readonly options: AgentSessionOptions
  private readonly catalog: ToolCatalog | undefined
  private activeRuntimeCatalog: ToolCatalog | undefined
  private readonly skillCatalog: SkillCatalog | undefined
  readonly runtimeLimits: Readonly<AgentRuntimeLimits>
    readonly contextSections: readonly ContextSection[] | undefined
  currentHistory: History
  private currentMemory: AgentMemory
  currentConversationId: string
  private compactor: ContextCompactor | undefined
  private pendingSkillActivations: readonly AgentSessionActivatedSkillSnapshot[] = Object.freeze([])
  private active = false
  activeAdditionalInstructions: string | undefined
    private activeInvocation: AgentInvocationOptions | undefined
  private readonly idleWaiters = new Set<() => void>()
    private pendingInjections: History | undefined
  private lastRunOutcome: AgentRunOutcome | undefined
    private roundInFlight = false
    private roundCalledTools = false
  constructor(definition: AgentDefinition, options: AgentSessionOptions) {
    if (definition.mode === 'deep-human-in-loop' && options.userInput === undefined) {
      throw new TypeError(`agent '${definition.id}' requires a userInput broker in deep-human-in-loop mode`)
    }
    this.definition = definition
    options = normalizeSessionOptions(options)
    this.options = options
    this.runtimeLimits = resolveRuntimeLimits(options.runtimeLimits)
    this.contextSections = sessionContextSections(definition, options)
    this.currentConversationId = conversationId(options.conversationId)
    this.currentHistory = options.history ?? new History(options.historyLimits)
    this.skillCatalog = sessionSkills(definition, options)
    this.catalog = sessionCatalog(definition, options, this.skillCatalog, () => this.skillLookup())
    this.currentMemory = createSessionMemory(options.memory, definition)
    captureResumedObjective(this.currentMemory, this.currentHistory, this.definition.memory.autoCaptureObjective)
    this.compactor = this.createCompactor()
    attachRuntimeSession(this, (input, invocation, additionalInstructions) =>
      this.createRunHandle(input, invocation, additionalInstructions), invocation =>
      this.createRunHandle(undefined, invocation), {
        compact: invocation => this.compactForRuntime(invocation),
        onConfigure: () => { this.compactor = this.createCompactor() },
      })
    options.team?.team.attach(this, teamAttachmentOptions(options))
  }
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
    get conversationId(): string { return this.currentConversationId }
    get history(): History { return this.currentHistory }
    get memory(): AgentMemory { return this.currentMemory }
    get skills(): SkillCatalog | undefined { return this.skillCatalog }
    get isRunning(): boolean { return this.active }
    snapshot(): AgentSessionSnapshot {
    const activated = this.activationSnapshot()
    const history = this.currentHistory.snapshot()
    const pending = this.pendingInjections?.entries() ?? []
    const persistedHistory = pending.length === 0 ? history : Object.freeze({
      version: 1 as const,
      entries: Object.freeze([...history.entries, ...pending.map((entry, index) => Object.freeze({
        ...entry, seq: history.entries.length + index + 1,
      }))]),
    })
    return Object.freeze({
      version: 1 as const,
      conversationId: this.currentConversationId,
      agentId: this.definition.id,
      history: persistedHistory,
      memory: this.currentMemory.snapshot(),
      ...runtimeSessionConfiguration(this)?.memory === undefined ? {} : {
        memoryBindingId: runtimeSessionConfiguration(this)!.memory!.bindingId,
      },
      ...activated.length === 0 ? {} : {
        skills: Object.freeze({ activated }),
      },
    })
  }
    reset(): void {
    if (this.active) throw new Error('cannot reset an agent session while a run is active')
    this.currentConversationId = newConversationId()
    this.currentHistory = new History(this.options.historyLimits)
    this.currentMemory = new AgentMemory(this.definition.memory.seed, this.definition.memory)
    this.pendingInjections = undefined
    this.pendingSkillActivations = Object.freeze([])
    this.lastRunOutcome = undefined
    this.skillCatalog?.clearActivations()
    this.compactor = this.createCompactor()
  }
    async compact(invocation: AgentInvocationOptions = {}): Promise<CompactionResult | null> {
    if (this.active) throw new Error('cannot compact an agent session while a run is active')
    this.active = true
    this.activeInvocation = invocation
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
    this.activeInvocation = invocation
    if (this.compactor !== undefined) bindCompactionAccounting(this.compactor, ledger)
    if (this.skillCatalog !== undefined) bindSkillProviderLogger(this.skillCatalog, ledger.modelInvocation.logger)
    try { return await runRuntimeCompaction({
      ...(this.compactor === undefined ? {} : { compactor: this.compactor }),
      invocation,
      accounting: ledger,
      prepare: () => this.prepareSkills(invocation.signal, ledger),
    }) } finally { this.releaseRun() }
  }
    inject(input: AgentInput): number {
    const message = userMessage(input)
    if (this.active && this.roundInFlight) {
      const candidate = History.fromSnapshot(this.currentHistory.snapshot(), this.options.historyLimits)
      candidate.appendBatch([
        ...(this.pendingInjections?.entries() ?? []).map(entry => ({ event: entry.event })),
        { event: { kind: 'user' as const, message } },
      ])
      const pending = this.pendingInjections ??= new History(this.options.historyLimits)
      pending.append({ kind: 'user', message })
      return this.currentHistory.entries().length + pending.entries().length
    }
    this.drainInjections()
    this.currentHistory.append({ kind: 'user', message })
    return this.currentHistory.entries().length
  }
    observeRoundBoundary(event: AgentRunEvent): void {
    if (event.type === 'agent-end') this.lastRunOutcome = event.outcome
    if (isChatSpanStart(event)) {
      this.roundInFlight = true
      this.roundCalledTools = false
      return
    }
    if (!this.roundInFlight) return
    if (eventCalledTool(event)) this.roundCalledTools = true
    if (eventEndsRound(event, this.roundCalledTools)) {
      this.roundInFlight = false
      this.drainInjections()
    }
  }
    private drainInjections(): void {
    if (this.pendingInjections === undefined) return
    const pending = this.pendingInjections
    this.currentHistory.appendBatch(pending.entries().map(entry => ({ event: entry.event })))
    this.pendingInjections = undefined
  }
    hasUnansweredInput(): boolean {
    if ((this.pendingInjections?.entries().length ?? 0) > 0) return true
    for (const message of [...this.currentHistory.messages()].reverse()) {
      if (message.source.kind === 'app') {
        if (message.source.producer === 'turn-interrupted') return false
        if (message.role === 'user' && !isManagedTeamNotice(message)) continue
      }
      return message.role === 'user'
    }
    return false
  }
  lastOutcome(): AgentRunOutcome | undefined { return this.lastRunOutcome }
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
    stream(input: AgentInput, invocation: AgentInvocationOptions = {}): AgentRunHandle {
    return this.createRunHandle(input, invocation)
  }
    streamPending(invocation: AgentInvocationOptions = {}): AgentRunHandle {
    return this.createRunHandle(undefined, invocation)
  }
    async run(input: AgentInput, invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    const handle = this.stream(input, invocation)
    await consumeSessionEvents(handle, invocation.onEvent, this.runtimeLimits.observerTimeoutMs ?? 30_000)
    return await handle.result
  }
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
    return createSessionRunHandle(this, input, invocation, additionalInstructions)
  }
  private releaseRun(): void {
    try { this.drainInjections() } finally {
      bindModelRequestBoundary(this.currentHistory)
      bindQueuedInput(this.currentHistory)
      this.roundInFlight = false
      this.active = false
      this.activeAdditionalInstructions = undefined
      this.activeInvocation = undefined
      this.activeRuntimeCatalog = undefined
      if (this.skillCatalog !== undefined) bindSkillProviderLogger(this.skillCatalog, undefined)
      if (this.compactor !== undefined) bindCompactionAccounting(this.compactor, undefined)
      const waiters = [...this.idleWaiters]
      this.idleWaiters.clear()
      for (const resolve of waiters) resolve()
    }
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
  runDefinition(invocation: AgentInvocationOptions, accounting?: RunAccountingPort): AsyncIterable<AgentRunEvent> {
    return runSessionDefinition(this, invocation, accounting)
  }
  private createCompactor(): ContextCompactor | undefined {
    const configured = resolveSessionCompaction(this.options.compaction, this.definition.compaction)
    if (configured === false) return undefined
    return new ContextCompactor({
      registry: this.options.registry,
      config: () => this.callConfig(this.activeInvocation),
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
  effectiveCatalog(): ToolCatalog | undefined {
    return this.activeRuntimeCatalog ?? this.catalog
  }
  combinedHooks(accounting?: RunAccountingPort): TurnHooks | undefined {
    return combinedSessionHooks(this, accounting)
  }
  callConfig(invocation?: AgentInvocationOptions) {
    return sessionCallConfig(this.definition, runtimeSessionConfiguration(this), invocation)
  }
  systemInstructions(additionalInstructions?: string): string {
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
    return sessionSkillLookup(this, signal)
  }
  private activationSnapshot(): readonly AgentSessionActivatedSkillSnapshot[] {
    return sessionActivationSnapshot(this)
  }
  private async prepareSkills(signal?: AbortSignal, accounting?: RunAccountingPort): Promise<void> {
    await prepareSkills(
      this.definition, this.skillCatalog, this.pendingSkillActivations,
      { skillLookup: signal => this.skillLookup(signal),
        clearPending: () => { this.pendingSkillActivations = Object.freeze([]) }, signal, accounting },
    )
  }
}
export { configureRuntimeSessionModel, streamRuntimeSession } from './session/runtime-binding.ts'
export type {
  AgentInput, AgentRuntimeLimits, AgentSessionOptions, AgentTeamMemberOptions, AgentSessionSnapshot,
  AgentSessionActivatedSkillSnapshot, AgentResumeSessionOptions, AgentInvocationOptions, AgentResponse,
  AgentRunHandle,
} from './session/types.ts'
