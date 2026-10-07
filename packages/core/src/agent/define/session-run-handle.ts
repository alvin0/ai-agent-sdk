import { contentHasDocument, contentHasImage } from '../../message/projection.ts'
import { ModelError } from '../../errors/model-error.ts'
import { isManagedTeamNotice } from '../history/input-work.ts'
import { bindModelRequestBoundary, bindQueuedInput } from '../loop/turn/model-request-boundary.ts'
import { bindCompactionAccounting } from '../memory/accounting-binding.ts'
import { toolCatalog } from './session/common.ts'
import type { AgentRunEvent, AgentRunOutcome } from '../mode/run-agent.ts'
import { waitForSettlement } from '../../async/index.ts'
import { RunEventBuffer } from '../accounting/event-buffer.ts'
import { AgentRunError, AGENT_ACCOUNTING_ERROR_CODES } from '../accounting/error.ts'
import type { RunReport } from '../accounting/delivery-types.ts'
import { createRunTerminalRecord, withTerminalDelivery } from '../accounting/delivery/terminal.ts'
import type { AgentInput, AgentInvocationOptions, AgentResponse, AgentRunHandle } from './session/types.ts'
import { userMessage, deferred, messageOf, errorCodeOf } from './session/common.ts'
import type { ToolSourceRunReference } from '../tool/source-types.ts'
import { accountTraceEvent } from './session/trace-accounting.ts'
import { commitRuntimeMemory, loadRuntimeMemory } from './session/runtime-memory.ts'
import { runtimeSessionConfiguration } from './session/runtime-binding.ts'
import { bindSkillProviderLogger } from '../skill/provider/context.ts'
import type { OperationStatus } from '../../observation/index.ts'
import { sealRuntimeRun } from './session/run-seal.ts'

function sessionOperationStatus(
  signal: AbortSignal, outcome: AgentRunOutcome | undefined, failure: unknown,
): OperationStatus {
  if (signal.aborted || outcome?.reason.kind === 'aborted') return 'aborted'
  if (failure !== undefined || outcome?.reason.kind === 'error') return 'error'
  return 'success'
}

type SessionTaskState = {
  host: any
  input: AgentInput | undefined
  invocation: AgentInvocationOptions
  signal: AbortSignal
  ledger: any
  buffer: RunEventBuffer<AgentRunEvent>
  reportDeferred: ReturnType<typeof deferred<RunReport>>
  resultDeferred: ReturnType<typeof deferred<AgentResponse>>
  toolSourcesDeferred: ReturnType<typeof deferred<readonly ToolSourceRunReference[]>>
  toolSourceReferences: readonly ToolSourceRunReference[]
  spanOperations: Map<string, string>
  firstTurnSeq: number
  owned: AbortController
  terminal: boolean
}

type SessionWorkResult = {
  failure: unknown
  outcome: AgentRunOutcome | undefined
  memoryState: Awaited<ReturnType<typeof loadRuntimeMemory>>['state'] | undefined
  toolSourceReferences: readonly ToolSourceRunReference[]
}

async function loadSessionMemory(host: any, runtime: any, signal: AbortSignal, ledger: any): Promise<any> {
  if (runtime?.memory === undefined) return undefined
  const prepared = await loadRuntimeMemory(
    runtime.memory, host.currentConversationId, host.definition.memory, { signal, ledger },
  )
  if (prepared.memory !== undefined) host.currentMemory = prepared.memory
  return prepared.state
}

async function prepareSessionTools(options: {
  host: any; runtime: any; signal: AbortSignal; ledger: any;
  references: readonly ToolSourceRunReference[]
}): Promise<readonly ToolSourceRunReference[]> {
  const { host, runtime, signal, ledger, references } = options
  if (runtime?.prepareTools === undefined) return references
  const logger = ledger.modelInvocation.logger
  if (logger === undefined) throw new Error('runtime tool source logger is unavailable')
  const generation = runtime.prepareTools(signal, logger, [...host.catalog?.names() ?? [],
    ...host.definition.nativeTools.map((tool: any) => tool.name)])
  host.activeRuntimeCatalog = toolCatalog([], host.catalog, generation.tools)
  return generation.references
}

function appendSessionInput(host: any, input: AgentInput | undefined, ledger: any): void {
  if (input === undefined) return
  const message = userMessage(input)
  if (host.definition.memory.autoCaptureObjective) {
    const operation = ledger.startOperation('memory', { data: { action: 'capture-objective' } })
    try { host.currentMemory.captureOriginalObjective(message); ledger.endOperation(operation, 'success') }
    catch (error) { ledger.endOperation(operation, 'error', { error }); throw error }
  }
  host.currentHistory.append({ kind: 'user', message })
}

async function validateSessionModality(
  host: any, invocation: AgentInvocationOptions, signal: AbortSignal, kind: 'image' | 'document',
): Promise<void> {
  const policy = invocation[`${kind}Policy`]
  if (policy !== 'strict' || !host.history.messages().some((message: any) =>
    (kind === 'image' ? contentHasImage(message.content) : contentHasDocument(message.content)))) return
  const config = host.callConfig(invocation)
  const model = await host.options.registry.resolveModelInfo(config.provider, config.model, signal)
  if (model.inputModalities !== undefined && !model.inputModalities.includes(kind)) {
    throw new ModelError(
      `model ${model.id} does not support required ${kind} input`,
      `UNSUPPORTED_${kind.toUpperCase()}_INPUT`,
    )
  }
}

async function consumeSessionEvents(options: {
  host: any; invocation: AgentInvocationOptions; signal: AbortSignal; ledger: any;
  buffer: RunEventBuffer<AgentRunEvent>; spanOperations: Map<string, string>
}): Promise<AgentRunOutcome> {
  const { host, invocation, signal, ledger, buffer, spanOperations } = options
  let outcome: AgentRunOutcome | undefined
  for await (const event of host.runDefinition({ ...invocation, signal }, ledger)) {
    host.observeRoundBoundary(event); accountTraceEvent(ledger, spanOperations, event)
    if (event.type === 'agent-end') outcome = event.outcome
    buffer.push(event)
  }
  if (outcome === undefined) throw new Error(`agent session '${host.definition.id}' ended without agent-end`)
  if (signal.aborted) throw signal.reason ?? new Error('agent run was aborted')
  if (outcome.reason.kind === 'error' && outcome.reason.failure.code === 'USAGE_REQUIRED') {
    const error = new Error(outcome.reason.failure.message) as Error & { code: string }
    error.code = 'USAGE_REQUIRED'; throw error
  }
  return outcome
}

async function executeSessionWork(ctx: SessionTaskState): Promise<SessionWorkResult> {
  const { host, input, invocation, signal, ledger, buffer, toolSourcesDeferred, spanOperations } = ctx
  let toolSourceReferences = ctx.toolSourceReferences
  let failure: unknown
  let outcome: AgentRunOutcome | undefined
  let memoryState: Awaited<ReturnType<typeof loadRuntimeMemory>>['state'] | undefined
  try {
    const runtime = runtimeSessionConfiguration(host)
    memoryState = await loadSessionMemory(host, runtime, signal, ledger)
    toolSourceReferences = await prepareSessionTools({
      host, runtime, signal, ledger, references: toolSourceReferences,
    })
    toolSourcesDeferred.resolve(toolSourceReferences)
    await host.prepareSkills(signal, ledger)
    appendSessionInput(host, input, ledger)
    await validateSessionModality(host, invocation, signal, 'image')
    await validateSessionModality(host, invocation, signal, 'document')
    outcome = await consumeSessionEvents({ host, invocation, signal, ledger, buffer, spanOperations })
    if (runtime?.memory !== undefined && memoryState !== undefined && memoryState.status !== 'disabled') {
      await commitRuntimeMemory(runtime.memory, host.currentConversationId,
        { snapshot: host.currentMemory.snapshot(), state: memoryState }, { signal, ledger })
    }
  } catch (error: unknown) {
    failure = error; toolSourcesDeferred.resolve(toolSourceReferences)
  }
  return { failure, outcome, memoryState, toolSourceReferences }
}

function publishSessionResult(
  ctx: SessionTaskState, failure: unknown, outcome: AgentRunOutcome | undefined, report: RunReport,
): void {
  const { host, ledger, buffer, resultDeferred, firstTurnSeq } = ctx
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
  const historyEvent = [...host.currentHistory.entries()].reverse()
    .find((entry: any) => entry.seq >= firstTurnSeq && entry.event.kind === 'assistant')
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

}

async function finishSessionTask(
  ctx: SessionTaskState, failure: unknown, outcome: AgentRunOutcome | undefined,
): Promise<boolean> {
  const { host, signal, ledger, buffer, reportDeferred, resultDeferred } = ctx
try { host.drainInjections() } catch (error) { failure ??= error }

let report: RunReport
try {
  const status = sessionOperationStatus(signal, outcome, failure)
  const ledgerReport = await ledger.finalize(status, outcome?.completed ?? false, failure)
  report = withTerminalDelivery(createRunTerminalRecord(ledgerReport), ledgerReport.delivery)
  reportDeferred.resolve(report)
} catch (finalizeError: unknown) {
  reportDeferred.reject(finalizeError)
  resultDeferred.reject(finalizeError)
  buffer.fail(finalizeError)
  ctx.terminal = true
  host.releaseRun()
  return ctx.terminal
}
if (ctx.terminal) return ctx.terminal

publishSessionResult(ctx, failure, outcome, report)
ctx.terminal = true
host.releaseRun()
  return ctx.terminal
}

async function runSessionTask(ctx: SessionTaskState): Promise<void> {
  const work = await executeSessionWork({ ...ctx, toolSourceReferences: ctx.toolSourceReferences })
  const terminal = await finishSessionTask(ctx, work.failure, work.outcome)
  ctx.terminal = terminal
  ctx.toolSourceReferences = work.toolSourceReferences
}

type SessionHandleState = {
  host: any; ledger: any; buffer: RunEventBuffer<AgentRunEvent>
  reportDeferred: ReturnType<typeof deferred<RunReport>>
  resultDeferred: ReturnType<typeof deferred<AgentResponse>>
  toolSourcesDeferred: ReturnType<typeof deferred<readonly ToolSourceRunReference[]>>
  task: Promise<void>; owned: AbortController
  isTerminal: () => boolean; markTerminal: () => void
  currentToolSources: () => readonly ToolSourceRunReference[]
}

function makeSessionRunHandle(state: SessionHandleState): AgentRunHandle {
  const { host, ledger, buffer, reportDeferred, resultDeferred, toolSourcesDeferred, task, owned } = state
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
    toolSources: toolSourcesDeferred, currentToolSources: state.currentToolSources, isTerminal: state.isTerminal,
    markTerminal: state.markTerminal, abort: () => owned.abort(new Error('Agent run was sealed')),
    release: () => host.releaseRun() }),
  abort(_reason?: unknown): void {
    if (!state.isTerminal() && !owned.signal.aborted) owned.abort(new Error('Agent run was aborted'))
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

function bindSessionBoundaries(host: any): void {
bindModelRequestBoundary(host.currentHistory, inFlight => {
    host.roundInFlight = inFlight
    if (!inFlight) host.drainInjections()
  })
  bindQueuedInput(host.currentHistory, () => {
    // By entries, not by the buffer: an input refused at admission leaves an
    // empty buffer behind, and that must not buy the run another round.
    const held = host.pendingInjections?.entries() ?? []
    if (held.length === 0) return false
    // Person input and managed-team coordination extend the run. Team deliveries keep
    // their contract: queued behind the answer, then processed exactly once
    // by the team's wake-up through runPending().
    const extendsRun = held.some((entry: any) => entry.event.kind === 'user'
      && (entry.event.message.source.kind === 'user' || isManagedTeamNotice(entry.event.message)))
    if (!extendsRun) return false
    host.roundInFlight = false
    host.drainInjections()
    return true
  }, () => (host.pendingInjections?.entries() ?? []).some((entry: any) => entry.event.kind === 'user'
    && (entry.event.message.source.kind === 'user' || isManagedTeamNotice(entry.event.message))))

}

export function createSessionRunHandle(
  host: any,
  input: AgentInput | undefined,
  invocation: AgentInvocationOptions,
  additionalInstructions?: string,
): AgentRunHandle {
  if (host.active) throw new Error(`agent session '${host.definition.id}' is already running`)
  host.drainInjections()
  const firstTurnSeq = host.currentHistory.entries().length + 1
  const owned = new AbortController()
  let terminal = false
  const signal = invocation.signal === undefined
    ? owned.signal
    : AbortSignal.any([invocation.signal, owned.signal])
  const buffer = new RunEventBuffer<AgentRunEvent>(
    host.options.eventBufferLimits?.maxEvents,
    host.options.eventBufferLimits?.maxBytes,
  )
  const reportDeferred = deferred<RunReport>()
  const resultDeferred = deferred<AgentResponse>()
  const toolSourcesDeferred = deferred<readonly ToolSourceRunReference[]>()
  const ledger = host.createLedger()
  let toolSourceReferences: readonly ToolSourceRunReference[] = Object.freeze([])
  if (host.compactor !== undefined) bindCompactionAccounting(host.compactor, ledger)
  if (host.skillCatalog !== undefined) {
    bindSkillProviderLogger(host.skillCatalog, ledger.modelInvocation.logger)
  }
  host.active = true
  bindSessionBoundaries(host)
  host.activeAdditionalInstructions = additionalInstructions
  host.activeInvocation = invocation
  const spanOperations = new Map<string, string>()
  const state: SessionTaskState = {
    host, input, invocation, signal, ledger, buffer, reportDeferred, resultDeferred,
    toolSourcesDeferred, toolSourceReferences, spanOperations, firstTurnSeq, owned,
    get terminal() { return terminal }, set terminal(value: boolean) { terminal = value },
  }
  const task = (async (): Promise<void> => {
    await runSessionTask(state)
    terminal = state.terminal
    toolSourceReferences = state.toolSourceReferences
  })()
  void task.catch(error => {
    if (terminal) return
    reportDeferred.reject(error)
    resultDeferred.reject(error)
    buffer.fail(error)
    terminal = true
    host.releaseRun()
  })
  void resultDeferred.promise.catch(() => undefined)
  void reportDeferred.promise.catch(() => undefined)
  return makeSessionRunHandle({
    host, ledger, buffer, reportDeferred, resultDeferred, toolSourcesDeferred, task, owned,
    isTerminal: () => terminal, markTerminal: () => { terminal = true },
    currentToolSources: () => toolSourceReferences,
  })
}


