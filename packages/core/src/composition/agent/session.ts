import { AgentRunError } from '../../agent/accounting/error.ts'
import type { RunReport } from '../exporter/delivery-types.ts'
import { configureRuntimeSessionModel, streamRuntimeSession, type AgentSession } from '../../agent/define/session.ts'
import { compactRuntimeSession, type RuntimeSessionRunHandle } from '../../agent/define/session/runtime-binding.ts'
import type { AgentRunHandle as LegacyRunHandle } from '../../agent/define/session/types.ts'
import type { AgentRunEvent } from '../../agent/mode/run-agent.ts'
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
    generate(input: string, options?: RuntimeAgentInvocationOptions) { return createRuntimeSession(host, definition).run(input, options) },
    stream(input: string, options?: RuntimeAgentInvocationOptions) { return createRuntimeSession(host, definition).stream(input, options) },
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
): RuntimeAgentSession {
  const binding = runtimeAgentBindings.get(agent)
  if (binding?.host !== host) throw new AgentSdkError(
    'Runtime team members must be agents from the same runtime', 'TEAM_AGENT_OWNERSHIP_INVALID',
  )
  return createRuntimeSession(host, binding.definition, options, undefined, team)
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
  private active: Promise<void> | undefined
  private readonly observerTimeoutMs: number

  constructor(
    private readonly host: RuntimeAgentHost,
    private readonly session: AgentSession,
    private readonly nativeProvider: string,
    observerTimeoutMs = 30_000,
  ) { this.observerTimeoutMs = observerTimeoutMs }

  get conversationId(): string { return this.session.conversationId }
  get isRunning(): boolean { return this.active !== undefined }

  stream(input: string, rawOptions?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle {
    if (typeof input !== 'string') throw new TypeError('Runtime agent input must be a string')
    const options = captureInvocationOptions(rawOptions)
    const lease = this.host.operations.acquire('agent-run', {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    let legacy: RuntimeSessionRunHandle
    try {
      legacy = streamRuntimeSession(this.session, input, { signal: lease.signal }, options.additionalInstructions)
    } catch (error) { lease.settle(); throw error }
    const abort = (): void => legacy.abort()
    lease.signal.addEventListener('abort', abort, { once: true })
    if (lease.signal.aborted) abort()
    void lease.whenSealed.then(() => legacy.seal()).catch(() => undefined)
    const report = this.runtimeReport(legacy.report, legacy.toolSourceSnapshots)
    const result = this.runtimeResult(legacy.result, report)
    let resolveActive!: () => void
    this.active = new Promise(done => { resolveActive = done })
    const eventsSettled = Promise.race([legacy.eventsSettled, lease.whenSealed])
    void Promise.allSettled([eventsSettled, result, report]).then(() => {
      lease.signal.removeEventListener('abort', abort)
      lease.settle()
      this.active = undefined
      resolveActive()
    })
    void result.catch(() => undefined)
    void report.catch(() => undefined)
    return runtimeHandle(legacy, report, result, this.nativeProvider)
  }

  async run(input: string, rawOptions?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse> {
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

  inject(input: string): number {
    this.host.operations.assertActive()
    if (this.active !== undefined) throw new Error('Cannot inject while a runtime session is active')
    return this.session.inject(input)
  }

  snapshot(): RuntimeAgentSessionSnapshot { return this.session.snapshot() }

  compact(rawOptions?: RuntimeAgentInvocationOptions): Promise<CompactionResult | null> {
    const options = captureInvocationOptions(rawOptions)
    return this.host.operations.execute('manual-compaction', {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, async lease => {
      const outcome = await compactRuntimeSession(this.session, { signal: lease.signal })
      const record = createRunTerminalRecord(outcome.report)
      const terminal = await this.host.observation.checkpointTerminal(record)
      const report = finalizeRuntimeRunReport(record, outcome.report.delivery, terminal,
        this.host.observation.mode, this.host.observation.requiredBoundary)
      if (outcome.failure !== undefined) throw runtimeFailure(
        outcome.failure,
        report,
        report.errors.at(-1)?.code ?? codeOf(outcome.failure),
      )
      return outcome.result === null ? null : Object.freeze({ ...outcome.result, status: 'completed' as const, report })
    })
  }

  reset(): void {
    this.host.operations.assertActive()
    if (this.active !== undefined) throw new Error('Cannot reset while a runtime session is active')
    this.session.reset()
  }

  whenIdle(signal?: AbortSignal): Promise<void> {
    const pending = this.active
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

  private async runtimeReport(
    legacy: Promise<RunReport>,
    sourceSnapshots: Promise<readonly ToolSourceRunReference[]>,
  ): Promise<RuntimeRunReport> {
    const [previous, sources] = await Promise.all([legacy, sourceSnapshots])
    const record = createRunTerminalRecord(previous, sources)
    const terminal = await this.host.observation.checkpointTerminal(record)
    return finalizeRuntimeRunReport(record, previous.delivery, terminal,
      this.host.observation.mode, this.host.observation.requiredBoundary)
  }

  private async runtimeResult(
    legacy: Promise<Awaited<LegacyRunHandle['result']>>,
    report: Promise<RuntimeRunReport>,
  ): Promise<RuntimeAgentResponse> {
    try {
      const response = await legacy
      const final = await report
      if (final.status !== 'success') {
        throw runtimeFailure(undefined, final, final.errors.at(-1)?.code ?? 'AGENT_RUN_FAILED')
      }
      return Object.freeze({ runId: final.runId, traceId: final.traceId,
        text: response.text, usage: final.usage, report: final })
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
): RuntimeAgentSession {
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
    ...(options.interceptors === undefined ? {} : { interceptors: options.interceptors }),
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
      memory: createRuntimeMemoryPersistence(memory, definition.legacy.id),
    }),
  })
  return new RuntimeAgentSessionValue(host, session, definition.model.provider, limits?.observerTimeoutMs)
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
): RuntimeAgentRunHandle {
  let iterated = false
  return Object.freeze({ runId: source.runId, report, result, abort: () => source.abort(),
    [Symbol.asyncIterator](): AsyncIterator<RuntimeAgentRunEvent> {
      if (iterated) return (async function* () { throw new Error('A runtime run handle can only be iterated once') })()
      iterated = true
      return projectEvents(source, report, nativeProvider)
    } })
}

async function* projectEvents(
  source: LegacyRunHandle & { readonly traceId: string; abort(reason?: unknown): void },
  report: Promise<RuntimeRunReport>,
  nativeProvider: string,
): AsyncGenerator<RuntimeAgentRunEvent> {
  let sequence = 0, completed = false
  const context = () => ({ runId: source.runId, traceId: source.traceId, sequence: ++sequence })
  try {
    for await (const event of source) {
      const projected = projectEvent(event, nativeProvider)
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

type WithoutEventContext<T> = T extends unknown ? Omit<T, 'runId' | 'traceId' | 'sequence'> : never
type ProjectedEvent = WithoutEventContext<RuntimeAgentRunEvent>

function projectEvent(event: AgentRunEvent, nativeProvider: string): ProjectedEvent | undefined {
  if (event.type === 'text-delta') return event.phase === 'commentary'
    ? { type: 'commentary-delta', text: event.text } : { type: 'assistant-delta', text: event.text }
  if (event.type === 'tool-call') return { type: 'tool-call', callId: event.call.callId,
    name: event.call.toolName, input: parseInput(event.call.rawArguments) }
  if (event.type === 'tool-result') return { type: 'tool-result', callId: event.call.callId,
    name: event.call.toolName, status: event.result.isError ? 'failed' : 'completed', output: event.result }
  if (event.type === 'assistant-native-tool') return projectNativeToolEvent(event.call, nativeProvider)
  if (event.type === 'approval-request') return { type: 'approval-request', request: event.request }
  if (event.type === 'user-input-request') return { type: 'user-input-request', request: event.request }
  if (event.type === 'user-input-response') return { type: 'user-input-response', requestId: event.request.requestId,
    response: event.response }
  return undefined
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
