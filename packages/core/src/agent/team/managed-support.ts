import type { JsonValue } from '../../primitives/index.ts'
import { timeoutValue } from '../../platform/config.ts'
import type { AgentResponse } from '../define/session.ts'
import type { HistoryEntry, HistorySnapshot } from '../history/index.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { ToolRegistry, type ToolCatalog } from '../tool/registry.ts'
import { AgentTeam } from './team.ts'
import type { ManagedAgentSpawnContext, ManagedAgentSpawnRequest, ManagedAgentTeamOptions,
  ManagedAgentRole, ManagedAgentWorkerStatus, WorkerRuntime } from './managed-types.ts'
import {
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS, DEFAULT_HOLD_WAIT_MS, DEFAULT_SPAWN_SETUP_TIMEOUT_MS,
} from './managed-config.ts'

export function mergeTools(
  supplied: ToolCatalog | readonly ToolDefinition<any>[] | undefined,
  generated: readonly ToolDefinition<any>[],
): ToolRegistry {
  const registry = new ToolRegistry()
  if (supplied !== undefined) {
    const tools = 'names' in supplied
      ? supplied.names().map(name => supplied.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
      : supplied
    for (const tool of tools) registry.register(tool)
  }
  for (const tool of generated) registry.register(tool)
  return registry
}

export function parseCloseTool(value: unknown): { name: string; cancelRunning: boolean } {
  const input = object(value, 'close_agent arguments')
  if (Object.keys(input).some(key => key !== 'name' && key !== 'cancelRunning')) {
    throw new TypeError('close_agent arguments contain unknown fields')
  }
  if (input.cancelRunning !== undefined && typeof input.cancelRunning !== 'boolean') {
    throw new TypeError('close_agent cancelRunning must be a boolean')
  }
  return { name: memberName(input.name), cancelRunning: input.cancelRunning === true }
}

export function parseSpawnTool(value: unknown): ManagedAgentSpawnRequest {
  const input = object(value, 'spawn_agent arguments')
  const known = new Set([
    'name', 'task', 'specialty', 'context', 'role', 'dependsOn', 'writes',
  ])
  if (Object.keys(input).some(key => !known.has(key))) {
    throw new TypeError('spawn_agent arguments contain unknown fields')
  }
  return {
    task: nonEmpty(input.task, 'worker task'),
    ...(input.name === undefined ? {} : { name: memberName(input.name) }),
    ...(input.specialty === undefined
      ? {}
      : { specialty: nonEmpty(input.specialty, 'worker specialty') }),
    ...(input.context === undefined ? {} : { context: spawnContext(input.context) }),
    ...(input.role === undefined ? {} : { role: nonEmpty(input.role, 'worker role') }),
    ...(input.dependsOn === undefined
      ? {}
      : { dependsOn: stringArray(input.dependsOn, 'dependsOn') }),
    ...(input.writes === undefined ? {} : { writes: stringArray(input.writes, 'writes') }),
  }
}

export function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of strings`)
  return value.map(entry => nonEmpty(entry, `${label} entry`))
}

export function spawnContext(value: unknown): ManagedAgentSpawnContext {
  if (value !== 'fresh' && value !== 'fork') {
    throw new TypeError("worker context must be 'fresh' or 'fork'")
  }
  return value
}

/**
 * Copy the lead's conversation up to the last point it was complete.
 *
 * The lead is INSIDE a turn when it calls `spawn_agent`: the assistant message
 * carrying that very call is already in history, and its result cannot be,
 * because producing it is what this code is doing. Handing that tail to a
 * worker gives it a conversation ending in an unanswered tool call — which
 * providers reject, and which would turn a context optimisation into a spawn
 * that fails outright.
 *
 * So the fork is cut at the last position where no tool call was outstanding.
 * That is also the honest boundary in meaning: work still in flight is not yet
 * something the lead knows. The DeepSeek harness names the same rule a
 * "completed-turn prefix".
 *
 * A prefix is safe to hydrate as a history in its own right: `replace` surface
 * ops and compaction records only ever reference earlier entries, so cutting
 * from the end cannot orphan a reference.
 * @param snapshot - The lead's history, taken mid-turn.
 * @returns Entries up to that boundary; empty when nothing has completed.
 */
export function completedHistoryPrefix(
  snapshot: HistorySnapshot,
): readonly HistoryEntry[] {
  const pending = new Set<string>()
  let cut = 0
  snapshot.entries.forEach((entry, index) => {
    const event = entry.event
    if (event.kind === 'tool-call') pending.add(event.callId)
    else if (event.kind === 'tool-result') pending.delete(event.callId)
    else if (event.kind === 'assistant') {
      // The assistant MESSAGE carries its own tool-call blocks, separately from
      // the `tool-call` events beside it. Counting only the events left the
      // spawn call in the fork, complete with the synthetic "interrupted before
      // a result was recorded" error the request builder pairs it with — the
      // worker's first sight of its lead being that it had just failed.
      for (const block of event.message.content) {
        if (block.type === 'tool-call') pending.add(block.id)
      }
    }
    // An interrupted assistant message is a turn that never finished; treating
    // it as settled context would hand a worker a half-formed intention.
    const settled = pending.size === 0
      && !(event.kind === 'assistant' && event.interrupted === true)
    if (settled) cut = index + 1
  })
  return snapshot.entries.slice(0, cut)
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function memberName(value: unknown): string {
  const name = nonEmpty(value, 'managed agent name')
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new TypeError('managed agent name must start with a letter and contain only letters, digits, _ or -')
  }
  if (name.length > 128) throw new TypeError('managed agent name must not exceed 128 characters')
  return name
}

export function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

export function boundedString(value: unknown, label: string, maxBytes: number): string {
  const text = nonEmpty(value, label)
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new TypeError(`${label} exceeds the ${maxBytes}-byte limit`)
  }
  return text
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    // Calling a host callback can synchronously abort and return a rejected
    // promise; retain its rejection observer even though cancellation won.
    void promise.catch(() => undefined)
    throw signal.reason ?? new Error('managed worker aborted')
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('managed worker aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

export function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const active = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined)
  return active.length === 1 ? active[0]! : AbortSignal.any(active)
}

export function asJson(value: unknown): JsonValue { return value as JsonValue }

/** Worker states that will never change again on their own. */
export const SETTLED_WORKER_STATUS: ReadonlySet<ManagedAgentWorkerStatus> =
  new Set<ManagedAgentWorkerStatus>(['completed', 'failed', 'closed'])

/**
 * Reduce one declared write scope to a comparable path.
 *
 * Comparison is by path component, so the shapes that mean the same directory
 * have to arrive spelled the same way: `./app/`, `app`, and `app\` all name
 * `app`, and a worker writing `app/page.tsx` conflicts with one writing `app`.
 */
/**
 * Why a worker's run did not produce an answer, if it did not.
 *
 * A rejected run is obvious; a run that ends on an error reason is not, because
 * it resolves like any other. Both leave the lead with nothing to read, so both
 * are failures as far as the report is concerned.
 * @param response - What the worker's run returned.
 * @returns The failure to report, or undefined when the worker actually answered.
 */
export function failureOf(response: AgentResponse, requireText: boolean): string | undefined {
  const reason = response.outcome.reason
  if (reason.kind === 'error') return reason.failure.message
  if (reason.kind === 'max-tokens') return 'the model stopped at its output limit'
  if (reason.kind === 'usage-unavailable') return 'the provider reported no usage for a billed call'
  if (reason.kind === 'aborted') return 'the run was aborted'
  if (reason.kind === 'budget-exhausted' && !response.outcome.completed) {
    return `the run stopped at its ${reason.budget} limit before completing the task`
  }
  // Tool-only agents may intentionally complete without a textual answer.
  if (requireText && response.text.trim() === '') return 'it produced no answer'
  return undefined
}

export function normalizeWriteScope(value: unknown): string {
  const text = nonEmpty(value, 'worker write scope').trim().split('\\').join('/')
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) {
    throw new TypeError('a worker write scope must be workspace-relative')
  }
  const parts: string[] = []
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new TypeError('a worker write scope must not escape the workspace')
      parts.pop()
    } else parts.push(part)
  }
  if (parts.length === 0) {
    throw new TypeError('a worker write scope must name a file or directory, not the whole workspace')
  }
  return parts.join('/')
}

/** Whether two normalized scopes cover any of the same files. */
export function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** Cut text to a byte budget without splitting a UTF-16 surrogate pair. */
export function prefixWithinBytes(text: string, maxBytes: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(new TextEncoder().encode(text).subarray(0, maxBytes),
    { stream: true })
}

/** Keep both the initial findings and final verdict; the marker is inside the byte cap. */
export function truncate(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return text
  const marker = '\n… (truncated; read full result) …\n'
  const markerBytes = new TextEncoder().encode(marker).byteLength
  if (maxBytes <= markerBytes) return prefixWithinBytes('(truncated)', maxBytes)
  const remaining = maxBytes - markerBytes
  const head = prefixWithinBytes(text, Math.ceil(remaining / 2))
  let tailStart = encoded.length - Math.floor(remaining / 2)
  while (tailStart < encoded.length && (encoded[tailStart]! & 0xc0) === 0x80) tailStart++
  const tail = new TextDecoder().decode(encoded.subarray(tailStart))
  return head + marker + tail
}

/** Detached evidence keeps full reports available without retaining producer sessions or ancestor chains. */
export function recordEvidence(runtime: WorkerRuntime): void {
  runtime.evidence.status = runtime.status
  runtime.evidence.result = runtime.result
  runtime.evidence.error = runtime.error
}

export function managedTimeouts(options: ManagedAgentTeamOptions) {
  return {
    workerTimeoutMs: timeoutValue(options.workerTimeoutMs ?? 10 * 60_000),
    observerTimeoutMs: timeoutValue(options.observerTimeoutMs ?? 1_000),
    closeTimeoutMs: timeoutValue(options.closeTimeoutMs ?? DEFAULT_WORKER_CLOSE_TIMEOUT_MS),
    holdWaitMs: timeoutValue(options.holdWaitMs ?? DEFAULT_HOLD_WAIT_MS),
    spawnTimeoutMs: timeoutValue(options.spawnTimeoutMs ?? DEFAULT_SPAWN_SETUP_TIMEOUT_MS),
  }
}

export function managedRoles(options: ManagedAgentTeamOptions): Map<string, ManagedAgentRole> {
  const roles = new Map((options.roles ?? []).map(role => [role.name, role]))
  if (roles.size !== (options.roles ?? []).length) {
    throw new Error('managed agent roles contain a duplicate name')
  }
  return roles
}

export function managedControlPlane(options: ManagedAgentTeamOptions, maxWorkers: number): AgentTeam {
  return options.team instanceof AgentTeam
    ? options.team
    : new AgentTeam({
        ...options.team,
        maxMembers: options.team?.maxMembers ?? maxWorkers + 1,
      })
}

export function assertDependencyOffset(text: string, offset: number): void {
  if (offset > text.length || (offset > 0
    && /[\uDC00-\uDFFF]/.test(text[offset]!))) throw new RangeError('offset must be a valid character boundary')
}
