import { publicMessage } from './public-message.ts'
import type { AgentInput } from '../../agent/define/session/types.ts'
import { isJsonValue, detachedFrozen, type JsonValue } from '../../primitives/index.ts'
import { freezeMessage } from '../../message/index.ts'
import { AgentRunError } from '../../agent/accounting/error.ts'
import type { RunReport } from '../exporter/delivery-types.ts'
import { configureRuntimeSessionModel, streamRuntimeSession, type AgentSession } from '../../agent/define/session.ts'
import {
  compactRuntimeSession, streamPendingRuntimeSession, type RuntimeSessionRunHandle,
} from '../../agent/define/session/runtime-binding.ts'
import type { AgentRunHandle as LegacyRunHandle } from '../../agent/define/session/types.ts'
import type { AgentRunEvent } from '../../agent/mode/run-agent.ts'
import type { ToolExecutionResult } from '../../agent/tool/definition.ts'
import { TOOL_ERROR_CODES } from '../../agent/tool/errors.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import type { ModelRegistry } from '../../runtime/registry.ts'
import { atDeadline } from '../lifecycle/bounded.ts'
import type { RuntimeOperations } from '../lifecycle/operations.ts'
import type { RuntimeObservationPort } from '../observation/port.ts'
import { createRunTerminalRecord } from '../delivery/terminal.ts'
import { finalizeRuntimeRunReport, type RuntimeRunReport } from '../observation/final-report.ts'
import type { RuntimeObservationResource } from '../delivery/resource.ts'
import type { RuntimeResources } from '../../platform/resources.ts'
import { snapshotToolSources } from '../tool-source/snapshot.ts'
import { capabilityIdentityError, inheritCapabilityIdentityConflict } from '../identity/error.ts'
import type { CapturedToolSource } from '../tool-source/types.ts'
import type { ToolSourceRunReference } from '../tool-source/types.ts'
import { createRuntimeMemoryPersistence } from '../memory/run.ts'
import { validateMemoryResumeBinding } from '../memory/resume.ts'
import type { BoundRuntimeAgentDefinition } from './definition.ts'
import { captureInvocationOptions, captureRuntimeSessionOptions } from './options.ts'
import { projectNativeToolEvent } from './native-event.ts'
import type {
  RuntimeAgent, RuntimeAgentInvocationOptions, RuntimeAgentResponse, RuntimeAgentRunEvent,
  RuntimeAgentRunHandle, RuntimeAgentSession, RuntimeAgentSessionOptions, RuntimeAgentSessionSnapshot,
} from './types.ts'
import type { CompactionResult } from '../../agent/memory/compaction.ts'
import type { AgentTeamMemberOptions } from '../../agent/define/session/types.ts'
import type { TeamSessionPort } from '../../agent/team/contracts.ts'
import { assertAgentIdentitySnapshot } from '../identity/agent.ts'

export interface RuntimeAgentHost {
  readonly registry: ModelRegistry
  readonly operations: RuntimeOperations
  readonly observation: RuntimeObservationPort
  readonly resource: RuntimeObservationResource
  readonly resources: RuntimeResources
}

interface RuntimeAgentBinding {
  readonly host: RuntimeAgentHost
  readonly definition: BoundRuntimeAgentDefinition
}

const runtimeAgentBindings = new WeakMap<RuntimeAgent, RuntimeAgentBinding>()

export function createRuntimeAgent(host: RuntimeAgentHost, definition: BoundRuntimeAgentDefinition): RuntimeAgent {
  const agent = Object.freeze({
    model: definition.model,
    generate(input: AgentInput, options?: RuntimeAgentInvocationOptions) { return createRuntimeSession(host, definition).run(input, options) },
    stream(input: AgentInput, options?: RuntimeAgentInvocationOptions) { return createRuntimeSession(host, definition).stream(input, options) },
    createSession(options?: RuntimeAgentSessionOptions) { return createRuntimeSession(host, definition, options) },
    resumeSession(snapshot: RuntimeAgentSessionSnapshot, options?: RuntimeAgentSessionOptions) {
      return createRuntimeSession(host, definition, options, snapshot)
    },
  })
  runtimeAgentBindings.set(agent, Object.freeze({ host, definition }))
  return agent
}

export function createRuntimeTeamMemberSession(
  host: RuntimeAgentHost,
  agent: RuntimeAgent,
  options: RuntimeAgentSessionOptions,
  team: AgentTeamMemberOptions,
  ownerSignal: AbortSignal,
): { readonly view: RuntimeAgentSession; readonly port: TeamSessionPort } {
  const binding = runtimeAgentBindings.get(agent)
  if (binding?.host !== host) throw new AgentSdkError(
    'Runtime team members must be agents from the same runtime', 'TEAM_AGENT_OWNERSHIP_INVALID',
  )
  const view = createRuntimeSession(host, binding.definition, options, undefined, team, ownerSignal)
  return Object.freeze({ view, port: view.teamPort })
}

export function preflightRuntimeTeamMember(
  host: RuntimeAgentHost,
  agent: RuntimeAgent,
  options: RuntimeAgentSessionOptions,
  additionalToolNames: readonly string[],
): void {
  const binding = runtimeAgentBindings.get(agent)
  if (binding?.host !== host) throw new AgentSdkError(
    'Runtime team members must be agents from the same runtime', 'TEAM_AGENT_OWNERSHIP_INVALID',
  )
  assertAgentIdentitySnapshot({
    tools: [...binding.definition.legacy.tools, ...options.tools ?? []],
    nativeTools: binding.definition.legacy.nativeTools,
    skills: [...binding.definition.legacy.skills, ...options.skills ?? []] as never,
    ...(binding.definition.legacy.skillIds === undefined ? {} : {
      allowedSkillIds: binding.definition.legacy.skillIds,
    }),
    additionalToolNames,
  })
}

export function runtimeOwnsAgent(host: RuntimeAgentHost, agent: unknown): agent is RuntimeAgent {
  return typeof agent === 'object' && agent !== null && runtimeAgentBindings.get(agent as RuntimeAgent)?.host === host
}

class RuntimeAgentSessionValue implements RuntimeAgentSession {
  private active: SessionOperation | undefined
  private readonly observerTimeoutMs: number
  readonly teamPort: TeamSessionPort

  constructor(
    private readonly host: RuntimeAgentHost,
    private readonly session: AgentSession,
    private readonly nativeProvider: string,
    definitionId: string,
    observerTimeoutMs = 30_000,
    private readonly ownerSignal?: AbortSignal,
  ) {
    this.observerTimeoutMs = observerTimeoutMs
    const owner = this
    this.teamPort = Object.freeze({
      definition: Object.freeze({ id: definitionId }),
      get conversationId() { return owner.conversationId },
      get isRunning() { return owner.isRunning },
      inject(input: Parameters<TeamSessionPort['inject']>[0]) { return owner.injectForTeam(input) },
      whenIdle(signal?: AbortSignal) { return owner.whenIdle(signal) },
      runPending(invocation = {}) { return owner.runPendingForTeam(invocation) },
    })
  }

  get conversationId(): string { return this.session.conversationId }
  get isRunning(): boolean { return this.active !== undefined }

  stream(input: AgentInput, rawOptions?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle {
    if (typeof input !== 'string') {
      if (input === null || typeof input !== 'object' || input.role !== 'user') throw new TypeError('Runtime input must be text or a user message')
      input = freezeMessage(input)
    }
    const options = captureInvocationOptions(rawOptions)
    const started = this.start(input, options)
    return runtimeHandle(started.legacy, started.report, started.result, this.nativeProvider, options.includeTraceEvents === true)
  }

  private start(input: AgentInput | undefined, options: RuntimeAgentInvocationOptions): StartedRuntimeRun {
    const operation = this.beginOperation()
    let lease: ReturnType<RuntimeOperations['acquire']>
    try {
      const signal = this.ownerSignal === undefined
        ? options.signal
        : options.signal === undefined ? this.ownerSignal : AbortSignal.any([options.signal, this.ownerSignal])
      lease = this.host.operations.acquire('agent-run', {
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) { this.finishOperation(operation); throw error }
    let output: JsonValue | undefined
    const structured = options.structuredOutput
    let legacy: RuntimeSessionRunHandle
    try {
      legacy = input === undefined
        ? streamPendingRuntimeSession(this.session, { signal: lease.signal })
        : streamRuntimeSession(this.session, input, { signal: lease.signal, ...(structured === undefined ? {} : {
          outputFormat: { type: 'json_schema' as const, name: structured.name, schema: structured.schema.jsonSchema },
          validateOutput: (value: unknown) => {
            const parsed = structured.schema.parse(value)
            if (!isJsonValue(parsed)) throw new TypeError('structured output parser must return lossless JSON synchronously')
            output = detachedFrozen(parsed)
          },
        }), ...(options.imagePolicy === undefined ? {} : { imagePolicy: options.imagePolicy }),
        ...(options.documentPolicy === undefined ? {} : { documentPolicy: options.documentPolicy }) }, options.additionalInstructions)
    } catch (error) { lease.settle(); this.finishOperation(operation); throw error }
    const abort = (): void => legacy.abort()
    lease.signal.addEventListener('abort', abort, { once: true })
    if (lease.signal.aborted) abort()
    void lease.whenSealed.then(() => legacy.seal()).catch(() => undefined)
    const report = this.runtimeReport(legacy.report, legacy.toolSourceSnapshots, lease.signal)
    const internalResult = this.runtimeResult(legacy.result, report, () => output)
    const eventsSettled = Promise.race([legacy.eventsSettled, lease.whenSealed])
    const released = Promise.allSettled([eventsSettled, internalResult, report]).then(() => {
      lease.signal.removeEventListener('abort', abort)
      lease.settle()
      this.finishOperation(operation)
    })
    const result = released.then(() => internalResult)
    void result.catch(() => undefined)
    void report.catch(() => undefined)
    return Object.freeze({ legacy, report, result })
  }

  async run(input: AgentInput, rawOptions?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse> {
    const options = captureInvocationOptions(rawOptions)
    const handle = this.stream(input, options)
    try {
      for await (const event of handle) {
        if (options.onEvent !== undefined) {
          try { await this.observe(options.onEvent, event, handle) }
          catch (error) {
            handle.abort()
            const report = await handle.report
            throw runtimeFailure(error, report, 'RUN_EVENT_OBSERVER_FAILED')
          }
        }
      }
    } catch (error) { if (codeOf(error) === 'RUN_EVENT_OBSERVER_FAILED') throw error; return await handle.result }
    return await handle.result
  }

  inject(input: AgentInput): number {
    this.host.operations.assertActive()
    this.assertOwnerActive()
    if (this.active !== undefined) throw new Error('Cannot inject while a runtime session is active')
    return this.session.inject(input)
  }

  private injectForTeam(input: Parameters<TeamSessionPort['inject']>[0]): number {
    this.host.operations.assertActive()
    this.assertOwnerActive()
    return this.session.inject(input)
  }

  snapshot(): RuntimeAgentSessionSnapshot { return this.session.snapshot() }

  compact(rawOptions?: RuntimeAgentInvocationOptions): Promise<CompactionResult | null> {
    const options = captureInvocationOptions(rawOptions)
    const operation = this.beginOperation()
    let pending: Promise<CompactionResult | null>
    try {
      pending = this.host.operations.execute('manual-compaction', {
        ...(this.ownerSignal === undefined
          ? options.signal === undefined ? {} : { signal: options.signal }
          : { signal: options.signal === undefined ? this.ownerSignal : AbortSignal.any([options.signal, this.ownerSignal]) }),
      }, async lease => {
        const outcome = await compactRuntimeSession(this.session, { signal: lease.signal })
        const record = createRunTerminalRecord(outcome.report)
        const terminal = await this.host.observation.checkpointTerminal(record, lease.signal)
        const report = finalizeRuntimeRunReport(record, outcome.report.delivery, terminal,
          this.host.observation.mode, this.host.observation.requiredBoundary)
        if (outcome.failure !== undefined) throw runtimeFailure(
          outcome.failure,
          report,
          report.errors.at(-1)?.code ?? codeOf(outcome.failure),
        )
        return outcome.result === null ? null : Object.freeze({ ...outcome.result, status: 'completed' as const, report })
      })
    } catch (error) { this.finishOperation(operation); throw error }
    return pending.finally(() => this.finishOperation(operation))
  }

  reset(): void {
    this.host.operations.assertActive()
    this.assertOwnerActive()
    if (this.active !== undefined) throw new Error('Cannot reset while a runtime session is active')
    this.session.reset()
  }

  whenIdle(signal?: AbortSignal): Promise<void> {
    const pending = this.active?.done
    if (pending === undefined) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(new AgentSdkError('Runtime idle wait was aborted', 'RUNTIME_OPERATION_ABORTED'))
    return new Promise((resolve, reject) => {
      let release = (): void => undefined
      const finish = (error?: Error): void => { release(); error === undefined ? resolve() : reject(error) }
      if (signal !== undefined) release = this.host.resources.onAbort(signal,
        () => finish(new AgentSdkError('Runtime idle wait was aborted', 'RUNTIME_OPERATION_ABORTED')))
      void pending.then(() => finish())
    })
  }

  private async runPendingForTeam(invocation: {
    readonly signal?: AbortSignal
    readonly onEvent?: (event: AgentRunEvent) => void | Promise<void>
  }): Promise<unknown> {
    const started = this.start(undefined, {
      ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
    })
    try {
      for await (const event of started.legacy) await invocation.onEvent?.(event)
    } catch (error) {
      started.legacy.abort()
      await started.result.catch(() => undefined)
      throw error
    }
    return await started.result
  }

  private beginOperation(): SessionOperation {
    this.assertOwnerActive()
    if (this.active !== undefined) throw new Error('Cannot start while a runtime session is active')
    let resolve!: () => void
    const operation: SessionOperation = { done: new Promise(done => { resolve = done }), resolve }
    this.active = operation
    return operation
  }

  private finishOperation(operation: SessionOperation): void {
    if (this.active !== operation) return
    this.active = undefined
    operation.resolve()
  }

  private assertOwnerActive(): void {
    if (this.ownerSignal?.aborted === true) {
      throw new AgentSdkError('Runtime team session is closed', 'TEAM_CLOSED')
    }
  }

  private async runtimeReport(
    legacy: Promise<RunReport>,
    sourceSnapshots: Promise<readonly ToolSourceRunReference[]>,
    signal: AbortSignal,
  ): Promise<RuntimeRunReport> {
    const [previous, sources] = await Promise.all([legacy, sourceSnapshots])
    const record = createRunTerminalRecord(previous, sources)
    const terminal = await this.host.observation.checkpointTerminal(record, signal)
    return finalizeRuntimeRunReport(record, previous.delivery, terminal,
      this.host.observation.mode, this.host.observation.requiredBoundary)
  }

  private async runtimeResult(
    legacy: Promise<Awaited<LegacyRunHandle['result']>>,
    report: Promise<RuntimeRunReport>,
    output: () => JsonValue | undefined,
  ): Promise<RuntimeAgentResponse> {
    try {
      const response = await legacy
      const final = await report
      if (final.status !== 'success') {
        throw runtimeFailure(undefined, final, final.errors.at(-1)?.code ?? 'AGENT_RUN_FAILED')
      }
      const parsedOutput = output()
      return Object.freeze({ runId: final.runId, traceId: final.traceId,
        completed: response.outcome.completed, stopReason: response.outcome.reason.kind,
        text: response.text, ...(parsedOutput === undefined ? {} : { output: parsedOutput }),
        ...(response.message === undefined ? {} : { message: publicMessage(response.message) }),
        usage: final.usage, report: final })
    } catch (error) {
      const final = await report
      throw runtimeFailure(error, final, codeOf(error))
    }
  }

  private async observe(
    observer: NonNullable<RuntimeAgentInvocationOptions['onEvent']>,
    event: RuntimeAgentRunEvent,
    handle: RuntimeAgentRunHandle,
  ): Promise<void> {
    const deadlineAt = this.host.resources.platform.monotonicNow() + this.observerTimeoutMs
    try { await atDeadline(this.host.resources, deadlineAt, () => observer(event), undefined) }
    catch { handle.abort(); throw new AgentSdkError('Runtime event observer did not complete', 'RUN_EVENT_OBSERVER_FAILED') }
  }
}

function createRuntimeSession(
  host: RuntimeAgentHost,
  definition: BoundRuntimeAgentDefinition,
  options: RuntimeAgentSessionOptions = {},
  snapshot?: RuntimeAgentSessionSnapshot,
  team?: AgentTeamMemberOptions,
  ownerSignal?: AbortSignal,
): RuntimeAgentSessionValue {
  host.operations.assertActive()
  options = captureRuntimeSessionOptions(options)
  assertAgentIdentitySnapshot({
    tools: [...definition.legacy.tools, ...options.tools ?? []],
    nativeTools: definition.legacy.nativeTools,
    skills: [...definition.legacy.skills, ...options.skills ?? []] as never,
    ...(definition.legacy.skillIds === undefined ? {} : { allowedSkillIds: definition.legacy.skillIds }),
  })
  const memory = options.memory === false ? undefined : options.memory ?? definition.memory
  if (snapshot !== undefined) validateMemoryResumeBinding(snapshot, memory)
  const toolSources = combineToolSources(definition.toolSources, options.toolSources ?? [])
  const limits = options.runtimeLimits
  const { maxSteps: _maxSteps, maxToolCalls: _maxToolCalls, ...agentRuntimeLimits } = limits ?? {}
  const selected = limits?.maxSteps === undefined && limits?.maxToolCalls === undefined
    ? definition.legacy : definition.legacy.with({
      ...(limits.maxSteps === undefined ? {} : { maxTurns: limits.maxSteps }),
      ...(limits.maxToolCalls === undefined ? {} : { maxToolCalls: limits.maxToolCalls }),
    })
  const shared = { registry: host.registry, observation: host.observation, observationResource: host.resource,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.skills === undefined ? {} : { skills: options.skills as never }),
    ...(options.skillCwd === undefined ? {} : { skillCwd: options.skillCwd }),
    ...(options.userInput === undefined ? {} : { userInput: options.userInput }),
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    ...(options.spillStore === undefined ? {} : { spillStore: options.spillStore }),
    ...(options.interceptors === undefined ? {} : { interceptors: options.interceptors }),
    ...(options.contextSections === undefined ? {} : { contextSections: options.contextSections }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.usagePolicy === undefined ? {} : { usagePolicy: options.usagePolicy }),
    ...(options.historyLimits === undefined ? {} : { historyLimits: options.historyLimits }),
    ...(options.ledgerLimits === undefined ? {} : { ledgerLimits: options.ledgerLimits }),
    ...(options.eventBufferLimits === undefined ? {} : { eventBufferLimits: options.eventBufferLimits }),
    ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
    ...(team === undefined ? {} : { team }),
    ...(Object.keys(agentRuntimeLimits).length === 0 ? {} : { runtimeLimits: agentRuntimeLimits }),
  }
  const session = snapshot === undefined
    ? selected.createSession({ ...shared, ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }) })
    : selected.resumeSession({ ...shared, snapshot })
  configureRuntimeSessionModel(session, { provider: definition.model.provider, model: definition.model.id,
    ...(definition.effort === undefined ? {} : { reasoningEffort: definition.effort }),
    ...(definition.maxTokens === undefined ? {} : { maxTokens: definition.maxTokens }),
    logger: correlation => host.observation.correlatedLogger(correlation, { scope: 'sdk.agent.run' }),
    ...(toolSources.length === 0 ? {} : {
      prepareTools: (signal, logger, occupiedNames) => snapshotToolSources(
        toolSources, signal, logger, occupiedNames,
      ),
    }),
    ...(memory === undefined ? {} : {
      memory: createRuntimeMemoryPersistence(
        memory,
        definition.legacy.id,
        agentRuntimeLimits.memoryOperationTimeoutMs,
      ),
    }),
  })
  return new RuntimeAgentSessionValue(
    host, session, definition.model.provider, definition.legacy.id, limits?.observerTimeoutMs, ownerSignal,
  )
}

interface SessionOperation {
  readonly done: Promise<void>
  readonly resolve: () => void
}

interface StartedRuntimeRun {
  readonly legacy: RuntimeSessionRunHandle
  readonly report: Promise<RuntimeRunReport>
  readonly result: Promise<RuntimeAgentResponse>
}

function combineToolSources(
  defined: readonly CapturedToolSource[],
  additional: readonly CapturedToolSource[],
): readonly CapturedToolSource[] {
  const all = [...defined, ...additional]
  const seen = new Map<string, number>()
  for (const [index, source] of all.entries()) {
    const first = seen.get(source.id)
    if (first !== undefined) throw capabilityIdentityError(
      'TOOL_SOURCE_ID_CONFLICT', 'tool-source-id', first, index,
    )
    seen.set(source.id, index)
  }
  return Object.freeze(all)
}

function runtimeHandle(
  source: LegacyRunHandle & { readonly traceId: string; abort(reason?: unknown): void },
  report: Promise<RuntimeRunReport>, result: Promise<RuntimeAgentResponse>, nativeProvider: string,
  includeTraceEvents: boolean,
): RuntimeAgentRunHandle {
  let iterated = false
  return Object.freeze({ runId: source.runId, report, result, abort: () => source.abort(),
    [Symbol.asyncIterator](): AsyncIterator<RuntimeAgentRunEvent> {
      if (iterated) return (async function* () { throw new Error('A runtime run handle can only be iterated once') })()
      iterated = true
      return projectEvents(source, report, nativeProvider, includeTraceEvents)
    } })
}

async function* projectEvents(
  source: LegacyRunHandle & { readonly traceId: string; abort(reason?: unknown): void },
  report: Promise<RuntimeRunReport>,
  nativeProvider: string,
  includeTraceEvents: boolean,
): AsyncGenerator<RuntimeAgentRunEvent> {
  let sequence = 0, completed = false
  const context = () => ({ runId: source.runId, traceId: source.traceId, sequence: ++sequence, schemaVersion: 1 as const })
  try {
    for await (const event of source) {
      const projected = projectEvent(event, nativeProvider, includeTraceEvents)
      if (projected !== undefined) yield Object.freeze({ ...context(), ...projected }) as RuntimeAgentRunEvent
    }
    const terminal = await report
    if (terminal.status === 'success') {
      yield Object.freeze({ ...context(), type: 'usage', usage: terminal.usage, report: terminal })
    } else {
      const error = terminal.errors.at(-1) ?? fallbackError(terminal)
      yield Object.freeze({ ...context(), type: 'error', error, report: terminal })
    }
    completed = true
  } catch {
    const terminal = await report
    const error = terminal.errors.at(-1) ?? fallbackError(terminal)
    yield Object.freeze({ ...context(), type: 'error', error, report: terminal })
    completed = true
  } finally { if (!completed) source.abort() }
}

type WithoutEventContext<T> = T extends unknown ? Omit<T, 'runId' | 'traceId' | 'sequence' | 'schemaVersion'> : never
type ProjectedEvent = WithoutEventContext<RuntimeAgentRunEvent>

function projectEvent(event: AgentRunEvent, nativeProvider: string, includeTraceEvents: boolean): ProjectedEvent | undefined {
  // Runtime consumers such as Edge hosts may persist an execution trace. Keep
  // the SDK's span lifecycle intact; unlike transcript events, spans carry the
  // identity and nesting needed to reconstruct the call tree.
  if (includeTraceEvents && (event.type === 'span-start' || event.type === 'span-end')) return event
  if (event.type === 'text-delta') return {
    type: event.phase === 'commentary' ? 'commentary-delta' : 'assistant-delta',
    text: event.text, index: event.index, phase: event.phase, blockId: `${event.trace.spanId}:${event.index}`,
  }
  if (event.type === 'assistant-message') return { type: 'assistant-message', message: publicMessage(event.message) }
  if (event.type === 'text-end' || event.type === 'reasoning-delta') {
    const { trace, ...content } = event
    return { ...content, blockId: `${trace.spanId}:${event.index}` }
  }
  if (event.type === 'image-delta') {
    const { trace, ...content } = event
    return { ...content, blockId: `${trace.spanId}:${event.itemId}` }
  }
  if (event.type === 'compaction-start' || event.type === 'compaction-end'
    || event.type === 'turn-start' || event.type === 'step-start' || event.type === 'step-end'
    || event.type === 'assistant-text' || event.type === 'assistant-reasoning') {
    const { trace: _trace, ...content } = event
    return content
  }
  if (event.type === 'tool-call') return { type: 'tool-call', callId: event.call.callId,
    name: event.call.toolName, input: parseInput(event.call.rawArguments) }
  if (event.type === 'tool-result') return { type: 'tool-result', callId: event.call.callId,
    name: event.call.toolName, status: toolResultStatus(event.result), output: event.result }
  if (event.type === 'assistant-native-tool') return projectNativeToolEvent(event.call, nativeProvider)
  if (event.type === 'approval-request') return { type: 'approval-request', request: event.request }
  if (event.type === 'user-input-request') return { type: 'user-input-request', request: event.request }
  if (event.type === 'user-input-response') return { type: 'user-input-response', requestId: event.request.requestId,
    response: event.response }
  return undefined
}

function toolResultStatus(
  result: ToolExecutionResult,
): 'completed' | 'failed' | 'aborted' | 'rejected' | 'declined' {
  // A call the loop refused to run is neither success nor failure: nothing
  // broke, and nothing was done. Reporting it as either misleads a UI — and a
  // red row for a budget decision is what makes a finished run look crashed.
  if (!result.isError) return result.meta?.['declined'] === true ? 'declined' : 'completed'
  if (result.error.code === TOOL_ERROR_CODES.ABORTED
    || result.error.code === TOOL_ERROR_CODES.ABORTED_BEFORE_DISPATCH) return 'aborted'
  if (result.error.code === TOOL_ERROR_CODES.UNKNOWN_TOOL
    || result.error.code === TOOL_ERROR_CODES.INVALID_ARGUMENTS
    || result.error.code === TOOL_ERROR_CODES.MALFORMED_ARGUMENTS
    || result.error.code === TOOL_ERROR_CODES.DENIED
    || result.error.code === TOOL_ERROR_CODES.BUDGET_EXHAUSTED
    || result.error.code === TOOL_ERROR_CODES.CHECKPOINT_FAILED) return 'rejected'
  return 'failed'
}

function parseInput(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return value } }
function codeOf(value: unknown): string {
  return value instanceof AgentSdkError ? value.code : 'AGENT_RUN_FAILED'
}
function runtimeFailure(value: unknown, report: RuntimeRunReport, code: string): AgentRunError {
  return inheritCapabilityIdentityConflict(
    new AgentRunError('Agent run did not complete', code, report as never), value,
  )
}
function fallbackError(report: RuntimeRunReport): RuntimeRunReport['errors'][number] {
  return Object.freeze({ code: 'AGENT_RUN_FAILED', stage: 'agent-run', message: 'Agent operation failed',
    usageCoverage: report.usage.coverage,
    possiblyBilledAttemptsWithoutUsage: report.usage.coverage.possiblyBilledAttemptsWithoutUsage })
}
