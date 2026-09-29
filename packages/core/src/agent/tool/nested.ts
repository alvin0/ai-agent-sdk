/**
 * Experimental seam for programmatic tool calling (SP-01). Public entry points
 * expose it only under explicitly experimental names.
 *
 * A program tool receives a port from the scheduler, never from the model. The
 * port runs each child call through the same admission, policy, approval,
 * checkpoint, execution and post-policy stages as a model-issued call.
 */
import type { JsonObject, JsonValue } from '../../primitives/index.ts'
import type { ToolRunContext } from './definition.ts'

/** What the host grants one program tool. */
export interface ProgramGrant {
  /** Tools the program may call, by name. Resolved once when the program starts. */
  readonly allow: readonly string[]
  /** Hard cap on child requests, counted whether or not they spend budget. */
  readonly maxCalls: number
}

/**
 * Experimental: grant one program tool the right to call other tools.
 *
 * Off unless a host passes one. The program tool must be exclusive (the
 * default) and must not be `budgetExempt`; its children spend the turn's tool
 * budget and never enter the model-visible history.
 */
export interface ExperimentalProgramGrant extends ProgramGrant {
  /** The program tool this grant belongs to. */
  readonly tool: string
}

const MAX_PROGRAM_GRANTS = 16
const MAX_GRANTED_TOOLS = 64
const MAX_PROGRAM_CALLS = 1_000

/**
 * Validate and detach host grants.
 * @param value - What the host passed.
 * @returns Grants keyed by program tool, frozen.
 */
export function captureProgramGrants(value: unknown): ReadonlyMap<string, ProgramGrant> {
  if (!Array.isArray(value) || value.length > MAX_PROGRAM_GRANTS) {
    throw new TypeError(`experimentalPrograms must be an array of at most ${MAX_PROGRAM_GRANTS} grants`)
  }
  const grants = new Map<string, ProgramGrant>()
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) throw new TypeError('program grant must be an object')
    const tool: unknown = Reflect.get(entry, 'tool')
    const allow: unknown = Reflect.get(entry, 'allow')
    const maxCalls: unknown = Reflect.get(entry, 'maxCalls')
    if (typeof tool !== 'string' || tool.length === 0) throw new TypeError('program grant tool must be a non-empty string')
    if (grants.has(tool)) throw new TypeError(`program "${tool}" is granted twice`)
    // Copy once, then validate the copy: the host's array is read exactly one time.
    const names: unknown[] = Array.isArray(allow) && allow.length <= MAX_GRANTED_TOOLS ? Array.from(allow as unknown[]) : []
    if (!Array.isArray(allow) || names.length !== allow.length
      || !names.every(name => typeof name === 'string' && name.length > 0)) {
      throw new TypeError(`program "${tool}" allow must list at most ${MAX_GRANTED_TOOLS} tool names`)
    }
    if (typeof maxCalls !== 'number' || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_PROGRAM_CALLS) {
      throw new RangeError(`program "${tool}" maxCalls must be an integer from 1 to ${MAX_PROGRAM_CALLS}`)
    }
    grants.set(tool, Object.freeze({ allow: Object.freeze([...new Set(names as string[])]), maxCalls }))
  }
  // One level only: a program may not call a program, itself included. Refused
  // when the session is created rather than on the first turn.
  for (const [tool, grant] of grants) {
    const nested = grant.allow.find(name => grants.has(name))
    if (nested !== undefined) throw new RangeError(`program "${tool}" may not call program "${nested}"`)
  }
  return grants
}

/** A child result as the program sees it: only the finalized, post-policy value. */
export type NestedToolResult =
  | {
    readonly ok: true
    readonly value: JsonValue
    /**
     * `validated` when the tool declared a supported output schema and the
     * value satisfies it; `unchecked` when there is no schema or it is outside
     * the supported subset. An unchecked value is data, not a typed contract.
     */
    readonly schema: 'validated' | 'unchecked'
    /** Present when the call asked to retain and the store accepted. */
    readonly handle?: string
    /** Present when the call asked to retain and the store refused. */
    readonly retainRefused?: 'closed' | 'entry-too-large' | 'store-full'
  }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** One granted tool as a program may discover it. Captured when the program starts. */
export interface NestedToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  /** `declared`: supported schema; `unsupported`: schema outside the subset; `unknown`: none. */
  readonly output: 'declared' | 'unsupported' | 'unknown'
  readonly outputSchema?: JsonObject
}

/** What a program may ask for with a call. */
export interface NestedCallOptions {
  /** Keep the validated value for later programs in this turn; the result carries its handle. */
  readonly retain?: boolean
}

/** A retained value read back through its handle. */
export type NestedLoadResult =
  | {
    readonly ok: true
    readonly value: JsonValue
    readonly schema: 'validated' | 'unchecked'
    readonly provenance: { readonly toolName: string; readonly callId: string; readonly parentCallId: string; readonly storedAt: number }
  }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** The capability a program tool uses to call other tools. */
export interface NestedToolPort {
  /**
   * With `retain`, a successful result also carries `handle`, or
   * `retainRefused` with the reason the store refused it.
   */
  call(toolName: string, args: JsonValue, options?: NestedCallOptions): Promise<NestedToolResult>
  /** Read a value this program tool retained earlier in the same turn. */
  load(handle: string): NestedLoadResult
  /** Drop a retained value before it expires. */
  release(handle: string): boolean
  /** The granted tools, in grant order, as they were when the program started. */
  catalog(): readonly NestedToolDescriptor[]
}

export const NESTED_TOOL_ERROR_CODES = Object.freeze({
  /** The tool is not in this program's grant. */
  NOT_ALLOWED: 'PROGRAM_TOOL_NOT_ALLOWED',
  /** The program spent its hard call cap; the port stays closed. */
  CALL_CAP: 'PROGRAM_CALL_CAP',
  /** The turn's tool budget declined a child; the port stays closed. */
  BUDGET_EXHAUSTED: 'PROGRAM_BUDGET_EXHAUSTED',
  /** A granted tool changed after the program started; the port stays closed. */
  STALE_CATALOG: 'PROGRAM_STALE_CATALOG',
  /** The value does not satisfy the tool's declared output schema. */
  OUTPUT_SCHEMA_MISMATCH: 'PROGRAM_OUTPUT_SCHEMA_MISMATCH',
  /** Policy removed the structured value; rendered text is never parsed instead. */
  STRUCTURED_OUTPUT_UNAVAILABLE: 'STRUCTURED_OUTPUT_UNAVAILABLE',
  /** A second child was requested while one is still running. */
  CALL_IN_FLIGHT: 'PROGRAM_CALL_IN_FLIGHT',
  /** The handle is unknown to this program, expired, stale, or its store closed. */
  RESULT_UNAVAILABLE: 'PROGRAM_RESULT_UNAVAILABLE',
  /** The program ended, was cancelled, or latched an earlier failure. */
  CLOSED: 'PROGRAM_CLOSED',
  /** Child arguments are not lossless JSON or exceed the size bound. */
  INVALID_ARGUMENTS: 'PROGRAM_INVALID_ARGUMENTS',
  /** The host configured the program tool in a way the scheduler refuses. */
  CONFIGURATION: 'PROGRAM_CONFIGURATION',
})

const portsByCall = new WeakMap<object, { readonly port: NestedToolPort; readonly bindSignal?: (signal: AbortSignal) => void }>()
const portsByContext = new WeakMap<object, NestedToolPort>()

/** Scheduler side: the authorized outer call that owns this port. */
export function attachNestedToolPort(call: object, port: NestedToolPort, bindSignal?: (signal: AbortSignal) => void): void {
  portsByCall.set(call, { port, ...bindSignal === undefined ? {} : { bindSignal } })
}

/** Pipeline side: expose the owning call's port on the context its body receives. */
export function bindNestedToolPort(call: object, context: ToolRunContext): void {
  const binding = portsByCall.get(call)
  if (binding !== undefined) {
    binding.bindSignal?.(context.signal)
    portsByContext.set(context, binding.port)
  }
}

/**
 * Tool side: the port the scheduler granted this call, if any.
 * @param context - The context the tool body received.
 * @returns The port, or `undefined` for every tool the host did not grant one.
 */
export function nestedToolPort(context: ToolRunContext): NestedToolPort | undefined {
  return portsByContext.get(context)
}
