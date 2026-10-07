/** Programs: the scheduler-granted port through which one tool calls others. Internal to the loop. */
import type { ToolAdmission } from './admission.ts'
import {
  emitEvent, errorCode, immutableResult, messageOf, now, raceWithSignal, withApprovalEvents,
  type ToolCallHost,
} from './tool-call-support.ts'
import { waitForSettlement } from '../../async/index.ts'
import { ToolCallId, type JsonValue } from '../../primitives/index.ts'
import { snapshotJsonValue } from '../../primitives/json-snapshot.ts'
import type { ToolDefinition, ToolExecutionResult } from '../tool/definition.ts'
import { TOOL_ERROR_CODES, ToolError } from '../tool/errors.ts'
import {
  NESTED_TOOL_ERROR_CODES,
  type NestedCallOptions, type NestedLoadResult, type NestedToolPort,
  type NestedToolResult, type ProgramGrant,
} from '../tool/nested.ts'
import { checkOutputSchema } from '../tool/output-schema.ts'
import {
  authorizeToolCall, dispatchAuthorizedToolCall, finalizeToolCall, prepareToolCall, toolFailure,
  type ToolCallRequest,
} from '../tool/pipeline.ts'
import type { ProgramResultStore } from '../tool/program-results.ts'
import { createSpanId, type TraceRef } from '../trace/trace.ts'
import { assertStageSettled, checkpointFailure, describe, programSpanStatus,
  refuse, settleWithin } from './program-support.ts'
export { validPrograms, describe, refuse, settleWithin } from './program-support.ts'


/** What every slot of one step shares. */
export interface StepRuntime {
  readonly admission: ToolAdmission
  readonly maxDurationMs: number
  readonly teardownTimeoutMs: number
  readonly maxResultBytes: number
  readonly programs: ReadonlyMap<string, ProgramGrant>
  readonly programResults: ProgramResultStore | undefined
}

/** Largest serialized argument object a program may send to one child. */
export const MAX_NESTED_ARGUMENT_BYTES = 64 * 1024
const ARGUMENT_LIMITS = Object.freeze({
  maxBytes: MAX_NESTED_ARGUMENT_BYTES, maxDepth: 64, maxNodes: 32_768,
  maxArrayItems: 16_384, maxObjectFields: 16_384, maxKeyBytes: MAX_NESTED_ARGUMENT_BYTES,
})

/**
 * One running program: the port its body calls, and the latch that outlives
 * whatever the program does with a refusal.
 *
 * A child goes through the same reservation, policy, approval, checkpoint,
 * execution, post-policy and byte bound as a model-issued call. What it does
 * NOT do is enter history or spill: the program's own result is what the model
 * reads, and that result is bounded like any other.
 */
export class ProgramRun {
  readonly port: NestedToolPort
  /** A fatal child failure, rethrown as the outer call's own. */
  fatal: unknown
  private closedCode: string | undefined
  private closedMessage = ''
  private readonly shutdown = new AbortController()
  private inFlight: Promise<NestedToolResult> | undefined
  private requests = 0
  private sequence = 0
  private unbindExecutionSignal: (() => void) | undefined
  /** Definition identity per granted name, captured when the program started. */
  private readonly captured: ReadonlyMap<string, ToolDefinition | undefined>

  constructor(
    private readonly options: ToolCallHost,
    private readonly step: StepRuntime,
    private readonly grant: ProgramGrant,
    private readonly outer: { readonly call: ToolCallRequest; readonly trace: TraceRef; readonly signal: AbortSignal },
  ) {
    this.captured = new Map(grant.allow.map(name => [name, options.catalog.get(name)]))
    const descriptors = Object.freeze(grant.allow.flatMap(name => {
      const definition = this.captured.get(name)
      return definition === undefined ? [] : [describe(definition)]
    }))
    this.port = Object.freeze({
      call: (toolName: string, args: JsonValue, callOptions?: NestedCallOptions) => this.request(toolName, args,
        callOptions?.retain === true),
      catalog: () => descriptors,
      load: (handle: string) => this.load(handle),
      release: (handle: string) => this.step.programResults?.release(handle, this.outer.call.toolName) === true,
    })
  }

  /** Stop admitting children and wait for the one in flight, if any. */
  async close(teardownTimeoutMs: number): Promise<boolean> {
    this.unbindExecutionSignal?.()
    this.latch(NESTED_TOOL_ERROR_CODES.CLOSED, 'the program has ended')
    this.shutdown.abort(new Error('program closed'))
    const inFlight = this.inFlight
    return inFlight === undefined || await waitForSettlement(inFlight, teardownTimeoutMs)
  }

  /** Stop without waiting; the outer call is already failing. */
  abort(reason: unknown): void {
    this.unbindExecutionSignal?.()
    this.latch(NESTED_TOOL_ERROR_CODES.CLOSED, 'the program was cancelled')
    this.shutdown.abort(reason)
  }

  /** The body signal also carries the program tool's own timeout. */
  bindExecutionSignal(signal: AbortSignal): void {
    this.unbindExecutionSignal?.()
    const abort = () => this.abort(signal.reason)
    this.unbindExecutionSignal = () => {
      signal.removeEventListener('abort', abort)
      this.unbindExecutionSignal = undefined
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  }

  private load(handle: string): NestedLoadResult {
    const store = this.step.programResults
    if (typeof handle !== 'string' || store === undefined || this.fatal !== undefined
      || this.closedCode !== undefined) {
      return refuse(NESTED_TOOL_ERROR_CODES.RESULT_UNAVAILABLE, 'no retained result is available')
    }
    // The owner is the program tool, never anything the program says it is.
    let loaded: ReturnType<ProgramResultStore['load']>
    try { loaded = store.load(handle, this.outer.call.toolName,
      name => this.options.catalog.get(name)) } catch (error) {
      this.fatal ??= ToolError.fatal(messageOf(error), errorCode(error), { cause: error })
      this.latch(NESTED_TOOL_ERROR_CODES.CLOSED, 'retained-result authority could not be checked')
      throw this.fatal
    }
    if (loaded.kind === 'unavailable') {
      return refuse(NESTED_TOOL_ERROR_CODES.RESULT_UNAVAILABLE,
        `the retained result is ${loaded.reason === 'unknown' ? 'not available to this program' : loaded.reason}`)
    }
    return Object.freeze({ ok: true, value: loaded.value, schema: loaded.schema, provenance: loaded.provenance })
  }

  private async request(toolName: string, args: JsonValue, retain = false): Promise<NestedToolResult> {
    if (this.fatal !== undefined || this.closedCode !== undefined) return this.refusal()
    if (this.inFlight !== undefined) {
      return refuse(NESTED_TOOL_ERROR_CODES.CALL_IN_FLIGHT, 'a program may run one tool call at a time')
    }
    this.requests++
    if (this.requests > this.grant.maxCalls) {
      this.latch(NESTED_TOOL_ERROR_CODES.CALL_CAP, `the program reached its limit of ${this.grant.maxCalls} tool calls`)
      return this.refusal()
    }
    let resolve!: (result: NestedToolResult) => void
    let reject!: (error: unknown) => void
    const pending = new Promise<NestedToolResult>((done, fail) => { resolve = done; reject = fail })
    // Hold the port before run() can synchronously call catalog/observation code.
    // Start run synchronously too: arguments are still captured at call time.
    this.inFlight = pending
    void this.run(toolName, args, retain).then(resolve, error => {
      this.fatal ??= ToolError.fatal(messageOf(error), errorCode(error), { cause: error })
      this.latch(NESTED_TOOL_ERROR_CODES.CLOSED, 'an earlier tool call failed fatally')
      reject(error)
    })
    try { return await pending } finally { this.inFlight = undefined }
  }

  private captureRequest(toolName: string, args: JsonValue) {
    if (!this.captured.has(toolName)) {
      return refuse(NESTED_TOOL_ERROR_CODES.NOT_ALLOWED, `the program may not call "${toolName}"`)
    }
    if (!this.current(toolName)) return this.stale(toolName)
    const definition = this.captured.get(toolName)
    if (definition === undefined) {
      return refuse(TOOL_ERROR_CODES.UNKNOWN_TOOL, `no tool named "${toolName}" is available`)
    }
    let rawArguments: string | undefined
    try { rawArguments = JSON.stringify(snapshotJsonValue(args, ARGUMENT_LIMITS)) } catch { rawArguments = undefined }
    if (rawArguments === undefined || new TextEncoder().encode(rawArguments).byteLength > MAX_NESTED_ARGUMENT_BYTES) {
      return refuse(NESTED_TOOL_ERROR_CODES.INVALID_ARGUMENTS, 'tool arguments must be JSON within the size limit')
    }
    return { definition, rawArguments }
  }

  private async run(toolName: string, args: JsonValue, retain: boolean): Promise<NestedToolResult> {
    const prepared = this.captureRequest(toolName, args)
    if (!('definition' in prepared)) return prepared
    const { definition, rawArguments } = prepared
    const call: ToolCallRequest = Object.freeze({
      callId: ToolCallId(`${this.outer.call.callId}:${String(++this.sequence)}`), toolName, rawArguments,
    })
    const trace: TraceRef = { traceId: this.outer.trace.traceId, spanId: createSpanId(),
      parentSpanId: this.outer.trace.spanId }
    const signal = AbortSignal.any([this.outer.signal, this.shutdown.signal])
    await emitEvent(this.options, {
      type: 'span-start', trace, at: now(), name: `execute_tool ${toolName}`, kind: 'execute_tool',
      attributes: {
        'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': toolName, 'gen_ai.tool.call.id': call.callId,
        'sdk.tool.parent_call_id': this.outer.call.callId,
      },
      input: rawArguments,
    })
    let result: ToolExecutionResult
    try {
      result = immutableResult(await this.execute(call, definition, trace, signal), this.step.maxResultBytes)
    } catch (error: unknown) {
      // Tool bodies already become results inside the pipeline. What escapes
      // here — a throwing interceptor, a teardown timeout, a fatal ToolError —
      // fails a model-issued call's whole turn, so it fails the program too.
      this.fatal ??= ToolError.fatal(messageOf(error), errorCode(error), { cause: error })
      this.latch(NESTED_TOOL_ERROR_CODES.CLOSED, 'an earlier tool call failed fatally')
      result = toolFailure(messageOf(error), errorCode(error))
    }
    // Authority is checked again at publication: a result produced under a
    // grant that changed while it ran is not handed to the program.
    const publishable = this.current(toolName) && !signal.aborted
    if (!this.current(toolName)) this.latch(NESTED_TOOL_ERROR_CODES.STALE_CATALOG,
      `"${toolName}" changed while the program was running`)
    await emitEvent(this.options, {
      type: 'span-end', trace, at: now(),
      status: programSpanStatus(signal, result),
      ...result.isError ? { error: { type: 'ToolError', message: result.error.message, code: result.error.code } } : {},
    })
    if (!publishable) return this.refusal()
    return this.publishResult({ toolName, definition, call }, result, retain)
  }

  private publishResult(
    child: { readonly toolName: string; readonly definition: ToolDefinition; readonly call: ToolCallRequest },
    result: ToolExecutionResult, retain: boolean,
  ): NestedToolResult {
    const { toolName, definition, call } = child
    if (result.isError) return refuse(result.error.code, result.error.message)
    // Policy may have removed the value. Rendered text is for the model and is
    // never parsed back into data the policy chose not to release.
    if (result.value === undefined) {
      return refuse(NESTED_TOOL_ERROR_CODES.STRUCTURED_OUTPUT_UNAVAILABLE,
        `"${toolName}" returned no structured value the program may read`)
    }
    const schema = definition.experimentalOutputSchema
    const verdict = schema === undefined ? 'unsupported' : checkOutputSchema(schema, result.value)
    if (verdict === 'invalid') {
      return refuse(NESTED_TOOL_ERROR_CODES.OUTPUT_SCHEMA_MISMATCH,
        `"${toolName}" returned a value outside its declared output schema`)
    }
    const checked = verdict === 'valid' ? 'validated' as const : 'unchecked' as const
    if (!retain) return Object.freeze({ ok: true, value: result.value, schema: checked })
    const saved = this.step.programResults?.save({
      owner: this.outer.call.toolName, value: result.value, definition, schema: checked,
      provenance: { toolName, callId: String(call.callId), parentCallId: String(this.outer.call.callId) },
    }) ?? { refused: 'closed' as const }
    return Object.freeze({
      ok: true, value: result.value, schema: checked,
      ...'handle' in saved ? { handle: saved.handle } : { retainRefused: saved.refused },
    })
  }

  private async execute(
    call: ToolCallRequest,
    definition: ToolDefinition,
    trace: TraceRef,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const { teardownTimeoutMs } = this.step
    const prepared = this.prepareChildCall(call, signal, teardownTimeoutMs)
    const ticket = this.step.admission.reserve(definition.budgetExempt === true)
    if (ticket === undefined) {
      return this.budgetRefusal()
    }
    try {
      const authorizing = authorizeToolCall(withApprovalEvents(this.options, prepared, trace))
      let authorization: Awaited<typeof authorizing>
      try {
        authorization = await raceWithSignal(authorizing, signal)
      } catch (error: unknown) {
        if (!signal.aborted) throw error
        assertStageSettled(await waitForSettlement(authorizing, teardownTimeoutMs), {
          toolName: call.toolName, stage: 'authorization', teardownTimeoutMs, error,
        })
        return toolFailure('the call was cancelled', TOOL_ERROR_CODES.ABORTED)
      }
      if (authorization.kind === 'final') return authorization.result
      try {
        const checkpointing = this.checkpointChildCall(call, signal)
        try { await raceWithSignal(checkpointing, signal) }
        catch (error: unknown) {
          if (!signal.aborted) throw error
          assertStageSettled(await waitForSettlement(checkpointing, teardownTimeoutMs), {
            toolName: call.toolName, stage: 'checkpoint', teardownTimeoutMs, error,
          })
        }
      } catch (error: unknown) {
        return checkpointFailure(error)
      }
      // Approval and checkpoint both await. Whatever changed meanwhile decides.
      const refused = this.dispatchRefusal(call, signal)
      if (refused !== undefined) return refused
      ticket.confirm()
      const executing = dispatchAuthorizedToolCall(authorization.call)
      void executing.catch(() => undefined)
      const executed = await settleWithin(executing, signal, teardownTimeoutMs,
        { toolName: call.toolName, stage: 'execution' })
      const finalized = await settleWithin(
        finalizeToolCall(authorization.call, executed), signal, teardownTimeoutMs,
        { toolName: call.toolName, stage: 'finalization' },
      )
      return finalized
    } finally {
      ticket.release()
    }
  }

  private budgetRefusal(): ToolExecutionResult {
    const message = 'the turn has spent its tool-call budget'
    this.latch(NESTED_TOOL_ERROR_CODES.BUDGET_EXHAUSTED, message)
    return toolFailure(message, NESTED_TOOL_ERROR_CODES.BUDGET_EXHAUSTED)
  }

  private prepareChildCall(call: ToolCallRequest, signal: AbortSignal, teardownTimeoutMs: number) {
    return prepareToolCall({
      catalog: this.options.catalog, call, position: this.options.position, signal,
      teardownTimeoutMs,
      parentCallId: this.outer.call.callId,
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
      ...this.options.interceptors === undefined ? {} : { interceptors: this.options.interceptors },
      ...this.options.approvals === undefined ? {} : { approvals: this.options.approvals },
    })
  }

  private checkpointChildCall(call: ToolCallRequest, signal: AbortSignal): Promise<void> {
    return Promise.resolve(this.options.checkpoint?.({
      kind: 'before-tool-dispatch', call, parentCallId: this.outer.call.callId,
      snapshot: this.options.history.snapshot(), signal,
      ...(this.options.logger === undefined ? {} : { logger: this.options.logger }),
    }))
  }

  private dispatchRefusal(call: ToolCallRequest, signal: AbortSignal): ToolExecutionResult | undefined {
    if (!this.current(call.toolName)) {
      const message = `"${call.toolName}" changed while the program was running`
      this.latch(NESTED_TOOL_ERROR_CODES.STALE_CATALOG, message)
      return toolFailure(message, NESTED_TOOL_ERROR_CODES.STALE_CATALOG)
    }
    if (this.fatal !== undefined || signal.aborted) return toolFailure('the program was cancelled',
      TOOL_ERROR_CODES.ABORTED)
    return undefined
  }

  private current(toolName: string): boolean {
    return this.options.catalog.get(toolName) === this.captured.get(toolName)
  }

  private stale(toolName: string): NestedToolResult {
    this.latch(NESTED_TOOL_ERROR_CODES.STALE_CATALOG, `"${toolName}" changed after the program started`)
    return this.refusal()
  }

  private latch(code: string, message: string): void {
    if (this.closedCode !== undefined) return
    this.closedCode = code
    this.closedMessage = message
  }

  private refusal(): NestedToolResult {
    return refuse(this.closedCode ?? NESTED_TOOL_ERROR_CODES.CLOSED, this.closedMessage || 'the program is closed')
  }
}
