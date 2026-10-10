import type { SessionRunHost } from './session/run-host.ts'
import { createSessionCompactor } from './session/compactor.ts'
import { sessionSystemInstructions } from './session/system-instructions.ts'
import { SessionIdleState } from './session/idle-state.ts'
import { SessionInputState } from './session/input-state.ts'
import { type ToolCatalog } from '../tool/registry.ts'
import { History } from '../history/history.ts'
import { bindModelRequestBoundary, bindQueuedInput } from '../loop/turn/model-request-boundary.ts'
import type { TurnHooks } from '../loop/types.ts'
import { ContextCompactor, type CompactionResult } from '../memory/compaction.ts'
import { bindCompactionAccounting } from '../memory/accounting-binding.ts'
import { AgentMemory } from '../memory/memory.ts'
import type { ContextSection } from '../context/types.ts'
import { type AgentRunEvent, type AgentRunOutcome } from '../mode/run-agent.ts'
import { runSessionDefinition } from './session-run-definition.ts'
import { createSessionRunHandle } from './session-run-handle.ts'
import { combinedSessionHooks, sessionSkillLookup, sessionActivationSnapshot } from './session-hooks.ts'
import { sessionContextSections, sessionSkills, sessionCatalog, teamAttachmentOptions } from './session-init.ts'
import type { RunAccountingPort } from '../accounting/contracts.ts'
import type { LegacyRunReport } from '../accounting/report.ts'
import { SkillCatalog, type SkillLookupOptions } from '../skill/index.ts'
import type { AgentDefinition } from './definition.ts'
import {
  type AgentInput, type AgentRuntimeLimits, type AgentSessionOptions, type AgentSessionSnapshot,
  type AgentSessionActivatedSkillSnapshot, type AgentResumeSessionOptions,
  type AgentInvocationOptions, type AgentResponse, type AgentRunHandle,
} from './session/types.ts'
import { validateSessionSnapshot } from './session/validation.ts'
import { normalizeSessionOptions, resolveRuntimeLimits } from './session/config.ts'
import {
  conversationId, newConversationId,
} from './session/common.ts'
import { captureResumedSkillActivations, prepareSkills } from './session/skills.ts'
import { captureResumedObjective } from './session/runtime-memory.ts'
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
  private readonly inputState = new SessionInputState({
    history: () => this.currentHistory,
    historyLimits: () => this.options.historyLimits,
    isRunning: () => this.active,
  })
  private readonly idleState = new SessionIdleState(() => this.active)

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
    const persistedHistory = this.inputState.snapshotHistory()
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
    this.inputState.reset()
    this.pendingSkillActivations = Object.freeze([])
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
  inject(input: AgentInput): number { return this.inputState.inject(input) }
  observeRoundBoundary(event: AgentRunEvent): void { return this.inputState.observeRoundBoundary(event) }
  private drainInjections(): void { this.inputState.drainInjections() }
  hasUnansweredInput(): boolean { return this.inputState.hasUnansweredInput() }
  lastOutcome(): AgentRunOutcome | undefined { return this.inputState.lastOutcome() }
  whenIdle(signal?: AbortSignal): Promise<void> { return this.idleState.whenIdle(signal) }
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
    return createSessionRunHandle(this.runHost(), input, invocation, additionalInstructions)
  }
  private runHost(): SessionRunHost {
    const owner = this
    return {
      definition: this.definition, options: this.options,
      get currentHistory() { return owner.currentHistory },
      get currentConversationId() { return owner.currentConversationId },
      get history() { return owner.history },
      get catalog() { return owner.catalog },
      get skillCatalog() { return owner.skillCatalog },
      get compactor() { return owner.compactor },
      inputState: this.inputState,
      get currentMemory() { return owner.currentMemory },
      set currentMemory(value) { owner.currentMemory = value },
      get activeRuntimeCatalog() { return owner.activeRuntimeCatalog },
      set activeRuntimeCatalog(value) { owner.activeRuntimeCatalog = value },
      get active() { return owner.active },
      set active(value) { owner.active = value },
      get activeInvocation() { return owner.activeInvocation },
      set activeInvocation(value) { owner.activeInvocation = value },
      get activeAdditionalInstructions() { return owner.activeAdditionalInstructions },
      set activeAdditionalInstructions(value) { owner.activeAdditionalInstructions = value },
      callConfig: invocation => owner.callConfig(invocation),
      observeRoundBoundary: event => owner.observeRoundBoundary(event),
      runDefinition: (invocation, accounting) => owner.runDefinition(invocation, accounting),
      runtime: () => runtimeSessionConfiguration(owner),
      createLedger: () => owner.createLedger(),
      prepareSkills: (signal, accounting) => owner.prepareSkills(signal, accounting),
      drainInjections: () => owner.drainInjections(),
      releaseRun: () => owner.releaseRun(),
    }
  }
  private releaseRun(): void {
    try { this.drainInjections() } finally {
      bindModelRequestBoundary(this.currentHistory)
      bindQueuedInput(this.currentHistory)
      this.inputState.releaseRound()
      this.active = false
      this.activeAdditionalInstructions = undefined
      this.activeInvocation = undefined
      this.activeRuntimeCatalog = undefined
      if (this.skillCatalog !== undefined) bindSkillProviderLogger(this.skillCatalog, undefined)
      if (this.compactor !== undefined) bindCompactionAccounting(this.compactor, undefined)
      this.idleState.release()
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
    return createSessionCompactor({
      options: this.options, definition: this.definition,
      config: () => this.callConfig(this.activeInvocation),
      history: () => this.currentHistory,
      system: () => this.systemInstructions(this.activeAdditionalInstructions),
      memory: () => this.currentMemory,
      tools: () => [...this.effectiveCatalog()?.schemas() ?? [], ...this.definition.nativeTools],
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
    return sessionSystemInstructions({
      definition: this.definition, skills: this.skillCatalog, team: this.options.team,
    }, additionalInstructions)
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
