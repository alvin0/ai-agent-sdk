/** The live session owns its active operation, run lifecycle, and team port. */
import type {
  RuntimeAgentHost,
} from './session-host.ts'
import type {
  AgentInput,
} from '../../agent/define/session/types.ts'
import {
  isJsonValue, detachedFrozen, type JsonValue,
} from '../../primitives/index.ts'
import {
  freezeMessage,
} from '../../message/index.ts'
import {
  streamRuntimeSession, type AgentSession,
} from '../../agent/define/session.ts'
import {
  compactRuntimeSession, streamPendingRuntimeSession, type RuntimeSessionRunHandle,
} from '../../agent/define/session/runtime-binding.ts'
import type {
  AgentRunEvent,
} from '../../agent/mode/run-agent.ts'
import {
  AgentSdkError,
} from '../../errors/agent-sdk-error.ts'
import {
  atDeadline,
} from '../lifecycle/bounded.ts'
import type {
  RuntimeOperations,
} from '../lifecycle/operations.ts'
import {
  createRunTerminalRecord,
} from '../delivery/terminal.ts'
import {
  finalizeRuntimeRunReport, type RuntimeRunReport,
} from '../observation/final-report.ts'
import type {
  BoundRuntimeAgentDefinition,
} from './definition.ts'
import {
  captureInvocationOptions, type CapturedInvocationOptions,
} from './options.ts'
import {
  createConfiguredSession, type RuntimeSessionContext,
} from './session-config.ts'
import {
  codeOf, runtimeFailure, runtimeReport, runtimeResult,
} from './session-results.ts'
import {
  runtimeHandle,
} from './session-events.ts'
import type {
  RuntimeAgentInvocationOptions, RuntimeAgentResponse, RuntimeAgentRunEvent,
  RuntimeAgentRunHandle, RuntimeAgentSession,
  RuntimeAgentSessionOptions, RuntimeAgentSessionSnapshot,
} from './types.ts'
import type {
  CompactionResult,
} from '../../agent/memory/compaction.ts'

import type {
  TeamSessionPort,
} from '../../agent/team/contracts.ts'

interface RuntimeSessionValueInput {
  readonly host: RuntimeAgentHost
  readonly session: AgentSession
  readonly nativeProvider: string
  readonly definitionId: string
  readonly observerTimeoutMs: number | undefined
  readonly ownerSignal: AbortSignal | undefined
}

class RuntimeAgentSessionValue implements RuntimeAgentSession {
  private active: SessionOperation | undefined
  private readonly observerTimeoutMs: number
  readonly teamPort: TeamSessionPort

  private readonly host: RuntimeAgentHost
  private readonly session: AgentSession
  private readonly nativeProvider: string
  private readonly ownerSignal: AbortSignal | undefined

  constructor(input: RuntimeSessionValueInput) {
    const { host, session, nativeProvider, definitionId, observerTimeoutMs = 30_000, ownerSignal } = input
    this.host = host
    this.session = session
    this.nativeProvider = nativeProvider
    this.ownerSignal = ownerSignal
    this.observerTimeoutMs = observerTimeoutMs
    const owner = this
    this.teamPort = Object.freeze({
      definition: Object.freeze({ id: definitionId }),
      get conversationId() { return owner.conversationId },
      get isRunning() { return owner.isRunning },
      inject(input: Parameters<TeamSessionPort['inject']>[0]) { return owner.injectForTeam(input) },
      whenIdle(signal?: AbortSignal) { return owner.whenIdle(signal) },
      hasUnansweredInput() { return owner.session.hasUnansweredInput() },
      lastOutcome() { return owner.session.lastOutcome() },
      runPending(invocation = {}) { return owner.runPendingForTeam(invocation) },
    })
  }

  get conversationId(): string { return this.session.conversationId }
  get isRunning(): boolean { return this.active !== undefined }

  stream(input: AgentInput, rawOptions?: RuntimeAgentInvocationOptions): RuntimeAgentRunHandle {
    if (typeof input !== 'string') {
      if (input === null || typeof input !== 'object'
        || input.role !== 'user') throw new TypeError('Runtime input must be text or a user message')
      input = freezeMessage(input)
    }
    const options = captureInvocationOptions(rawOptions, this.host.selection)
    const started = this.start(input, options)
    return runtimeHandle(started.legacy, started.report, started.result, { nativeProvider: this.nativeProvider,
      includeTraceEvents: options.includeTraceEvents === true })
  }

  private start(input: AgentInput | undefined, options: CapturedInvocationOptions): StartedRuntimeRun {
    const operation = this.beginOperation()
    let lease: ReturnType<RuntimeOperations['acquire']>
    try {
      const signal = runSignal(options, this.ownerSignal)
      lease = this.host.operations.acquire('agent-run', {
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) { this.finishOperation(operation); throw error }
    let output: JsonValue | undefined
    const structured = options.structuredOutput
    let legacy: RuntimeSessionRunHandle
    try {
      legacy = input === undefined
        ? streamPendingRuntimeSession(this.session, { signal: lease.signal, ...modelOverlay(options) })
        : streamRuntimeSession(this.session, input, { signal: lease.signal, ...modelOverlay(options),
          ...(structured === undefined ? {} : {
          outputFormat: { type: 'json_schema' as const, name: structured.name, schema: structured.schema.jsonSchema },
          validateOutput: (value: unknown) => {
            const parsed = structured.schema.parse(value)
            if (!isJsonValue(parsed)) throw new TypeError(
              'structured output parser must return lossless JSON synchronously')
            output = detachedFrozen(parsed)
          },
        }), ...(options.imagePolicy === undefined ? {} : { imagePolicy: options.imagePolicy }),
        ...(options.documentPolicy === undefined ? {} : { documentPolicy: options.documentPolicy }) },
          options.additionalInstructions)
    } catch (error) { lease.settle(); this.finishOperation(operation); throw error }
    const abort = (): void => legacy.abort()
    lease.signal.addEventListener('abort', abort, { once: true })
    if (lease.signal.aborted) abort()
    void lease.whenSealed.then(() => legacy.seal()).catch(() => undefined)
    const report = runtimeReport(this.host, legacy.report, legacy.toolSourceSnapshots, lease.signal)
    const internalResult = runtimeResult(legacy.result, report, () => output)
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
    const options = captureInvocationOptions(rawOptions, this.host.selection)
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
    // A run in flight is the case steering exists for. The underlying session
    // holds the message until the round that could not see it has finished,
    // then delivers it in arrival order. Refusing here left the runtime
    // surface unable to steer at all, while the same call on a bare session
    // (and injectForTeam below) is accepted.
    return this.session.inject(input)
  }

  private injectForTeam(input: Parameters<TeamSessionPort['inject']>[0]): number {
    this.host.operations.assertActive()
    this.assertOwnerActive()
    return this.session.inject(input)
  }

  hasUnansweredInput(): boolean { return this.session.hasUnansweredInput() }

  async runPending(rawOptions?: RuntimeAgentInvocationOptions): Promise<RuntimeAgentResponse> {
    const options = captureInvocationOptions(rawOptions, this.host.selection)
    const started = this.start(undefined, options)
    const handle = runtimeHandle(started.legacy, started.report, started.result, { nativeProvider: this.nativeProvider,
      includeTraceEvents: options.includeTraceEvents === true })
    try {
      for await (const event of handle) {
        if (options.onEvent !== undefined) await this.observe(options.onEvent, event, handle)
      }
    } catch (error) {
      handle.abort()
      await handle.result.catch(() => undefined)
      throw error
    }
    return await handle.result
  }

  snapshot(): RuntimeAgentSessionSnapshot { return this.session.snapshot() }

  compact(rawOptions?: RuntimeAgentInvocationOptions): Promise<CompactionResult | null> {
    const options = captureInvocationOptions(rawOptions, this.host.selection)
    const operation = this.beginOperation()
    let pending: Promise<CompactionResult | null>
    try {
      pending = this.host.operations.execute('manual-compaction', {
        ...operationSignalOptions(options, this.ownerSignal),
      }, async lease => {
        const outcome = await compactRuntimeSession(this.session, { signal: lease.signal, ...modelOverlay(options) })
        const record = createRunTerminalRecord(outcome.report)
        const terminal = await this.host.observation.checkpointTerminal(record, lease.signal)
        const report = finalizeRuntimeRunReport(
          record,
          outcome.report.delivery,
          terminal,
          {
            mode: this.host.observation.mode,
            requiredBoundary: this.host.observation.requiredBoundary,
          },
        )
        if (outcome.failure !== undefined) throw runtimeFailure(
          outcome.failure,
          report,
          report.errors.at(-1)?.code ?? codeOf(outcome.failure),
        )
        return outcome.result === null ? null : Object.freeze({ ...outcome.result, status: 'completed' as const,
          report })
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
    if (signal?.aborted) return Promise.reject(new AgentSdkError('Runtime idle wait was aborted',
      'RUNTIME_OPERATION_ABORTED'))
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

  private async observe(
    observer: NonNullable<RuntimeAgentInvocationOptions['onEvent']>,
    event: RuntimeAgentRunEvent,
    handle: RuntimeAgentRunHandle,
  ): Promise<void> {
    const deadlineAt = this.host.resources.platform.monotonicNow() + this.observerTimeoutMs
    try { await atDeadline(this.host.resources, deadlineAt, () => observer(event), undefined) }
    catch { handle.abort(); throw new AgentSdkError('Runtime event observer did not complete',
      'RUN_EVENT_OBSERVER_FAILED') }
  }
}

export function createRuntimeSession(
  host: RuntimeAgentHost, definition: BoundRuntimeAgentDefinition, options: RuntimeAgentSessionOptions = {},
  context: RuntimeSessionContext = {},
): RuntimeAgentSessionValue {
  const { session, observerTimeoutMs } = createConfiguredSession(host, definition, options, context)
  return new RuntimeAgentSessionValue({
    host, session, nativeProvider: definition.model.provider, definitionId: definition.legacy.id,
    observerTimeoutMs, ownerSignal: context.ownerSignal,
  })
}

/** Project one captured invocation onto the low-level per-run model overlay. */
function modelOverlay(options: CapturedInvocationOptions): {
  readonly model?: { readonly provider: string; readonly model: string }
  readonly maxTokens?: number
} {
  return {
    ...(options.model === undefined ? {} : { model: { provider: options.model.provider, model: options.model.id } }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  }
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

function runSignal(options: CapturedInvocationOptions, ownerSignal: AbortSignal | undefined): AbortSignal | undefined {
  if (ownerSignal === undefined) return options.signal
  if (options.signal === undefined) return ownerSignal
  return AbortSignal.any([options.signal, ownerSignal])
}

function operationSignalOptions(options: CapturedInvocationOptions, ownerSignal: AbortSignal | undefined) {
  if (ownerSignal === undefined) return options.signal === undefined ? {} : { signal: options.signal }
  const signal = options.signal === undefined ? ownerSignal : AbortSignal.any([options.signal, ownerSignal])
  return { signal }
}
