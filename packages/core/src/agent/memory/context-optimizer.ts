import { createMessage, type Message } from '../../message/index.ts'
import { projectHistorySurface } from '../history/project.ts'
import type { HistorySnapshot } from '../history/types.ts'
import type { BeforeStepContext, TurnHooks } from '../loop/events.ts'
import type { SpillRecord, SpillStore } from '../tool/output-budget.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { readSpillTool } from '../tool/output-budget.ts'
import { diagnosticLineNumbers, reduceEvidence, type EvidenceReducer } from '../tool/evidence-reducer.ts'
import { estimateMessageTokens } from './token-estimator.ts'

export interface ContextMilestone {
  readonly id: string
  /** Inclusive append-only sequence boundary, captured after the completed step. */
  readonly throughSeq: number
  /** Host-verified state, including decisions and unresolved constraints needed later. */
  readonly summary: string
  readonly remainingTurns: number
  /** Same cost units as historyTokenCost; include input/output and summary-model price. */
  readonly compactionCost: number
  readonly historyTokenCost?: number
}
export interface ContextOptimizerOptions {
  /** Mount the returned retrievalTool in the same session. Use a store scoped to that session. */
  readonly store: SpillStore
  readonly observationThresholdBytes?: number
  readonly summaryBytes?: number
  readonly fullRequests?: number
  readonly maxObservations?: number
  readonly maxMilestones?: number
  /** Persist raw snapshots locally/durably before a milestone projection is accepted. */
  readonly archive?: (snapshot: HistorySnapshot, milestone: ContextMilestone, signal: AbortSignal) => Promise<void>
  readonly reducer?: EvidenceReducer
  /** Explicitly identify logs and their authoritative outcome; core does not guess exit status. */
  readonly log?: (toolName: string, text: string) => {
    readonly status: 'pass' | 'fail' | 'unknown'; readonly requiredLines?: readonly number[]
  } | undefined
  readonly reductionThresholdBytes?: number
}
export interface ContextOptimizationMetrics {
  readonly packedObservations: number
  readonly verifiedReductions: number
  readonly rejectedReductions: number
  readonly compactedMilestones: number
  readonly skippedMilestones: number
  /** Estimate of payload tokens avoided across prepared requests; never billing usage. */
  readonly estimatedTokensSaved: number
}
interface Observation {
  readonly text: string
  readonly record: SpillRecord
  exposures: number
  reduced?: string
  reductionAttempted: boolean
  readonly log?: { readonly status: 'pass' | 'fail' | 'unknown'; readonly requiredLines?: readonly number[] }
  packed?: string
}
interface Completed { readonly targets: ReadonlySet<string>; readonly inputs: ReadonlyMap<string, string>; readonly message: Message }

/**
 * One controller per session. Projection affects requests only; snapshots retain raw history.
 * Compose its hooks with application hooks using wrapHooks(), and register retrievalTool.
 * Disposal drops projection state, never tool receipts or host-owned storage.
 */
export function createContextOptimizer(options: ContextOptimizerOptions) {
  const threshold = positive(options.observationThresholdBytes ?? 10 * 1024, 'observationThresholdBytes')
  const summaryBytes = positive(options.summaryBytes ?? 1024, 'summaryBytes')
  if (summaryBytes < 256) throw new RangeError('summaryBytes must be at least 256')
  const fullRequests = positive(options.fullRequests ?? 2, 'fullRequests')
  const maxObservations = positive(options.maxObservations ?? 64, 'maxObservations')
  const maxMilestones = positive(options.maxMilestones ?? 128, 'maxMilestones')
  const reductionThreshold = positive(options.reductionThresholdBytes ?? 4 * 1024, 'reductionThresholdBytes')
  const store = options.store
  const archive = options.archive
  const reducer = options.reducer
  const log = options.log
  const observations = new Map<string, Observation>()
  const pending: ContextMilestone[] = []
  const completed: Completed[] = []
  const milestoneIds = new Set<string>()
  const metrics = { packedObservations: 0, verifiedReductions: 0, rejectedReductions: 0,
    compactedMilestones: 0, skippedMilestones: 0, estimatedTokensSaved: 0 }
  let disposed = false
  let active = false
  let scope: string | undefined
  const lifetime = new AbortController()
  let completedThroughSeq = 0
  const retrievalTool: ToolDefinition = readSpillTool(store)

  const projectMilestones = async (context: BeforeStepContext, sourceMessages: readonly Message[]): Promise<readonly Message[]> => {
    const fingerprints = new Map((completed.length || pending.length ? sourceMessages : []).map(message => [String(message.id), JSON.stringify({ content: message.content, source: message.source, role: message.role })]))
    for (const milestone of pending.splice(0)) {
      if (milestone.throughSeq > (context.snapshot.entries.at(-1)?.seq ?? 0)) {
        metrics.skippedMilestones++; continue
      }
      const surface = projectHistorySurface(context.snapshot.entries)
      const visible = new Set(context.messages.map(message => message.id))
      // Preserve the initial request and injected state. Only completed, balanced ranges.
      const nodes = surface.slice(1).filter(node => node.seq > completedThroughSeq
        && node.seq <= milestone.throughSeq && node.message.source.kind !== 'app' && visible.has(node.message.id))
      const byId = new Map(context.messages.map(message => [message.id, message]))
      const messages = nodes.map(node => byId.get(node.message.id)!)
      const covered = new Set(completed.flatMap(group => [...group.targets]))
      if (nodes.length === 0 || nodes.some(node => covered.has(node.message.id)) || !balanced(messages)) {
        metrics.skippedMilestones++; continue
      }
      const summary = createMessage({ role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: `[Completed ${milestone.id}: ${milestone.summary}]` }] })
      const saved = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) - estimateMessageTokens(summary)
      if (saved <= 0 || milestone.compactionCost >= saved * milestone.remainingTurns * (milestone.historyTokenCost ?? 1)) {
        metrics.skippedMilestones++; continue
      }
      if (archive === undefined) { metrics.skippedMilestones++; continue }
      try {
        await archive(context.snapshot, milestone, context.signal)
        if (disposed) break
        context.signal.throwIfAborted()
      } catch {
        if (disposed) break
        context.signal.throwIfAborted()
        metrics.skippedMilestones++; continue
      }
      completed.push({ targets: new Set(messages.map(message => message.id)),
        inputs: new Map(messages.map(message => [String(message.id), fingerprints.get(message.id)!])), message: summary })
      completedThroughSeq = milestone.throughSeq
      metrics.compactedMilestones++
    }
    let messages = [...context.messages]
    // If regular pressure compaction has shadowed a target, its summary now owns that range.
    for (let i = completed.length - 1; i >= 0; i--) {
      const group = completed[i]!
      const visible = new Set(messages.map(message => String(message.id)))
      if (![...group.targets].every(id => visible.has(id) && fingerprints.get(id) === group.inputs.get(id))) {
        completed.splice(i, 1); continue
      }
      const first = messages.findIndex(message => group.targets.has(message.id))
      const retained = messages.filter(message => !group.targets.has(message.id))
      retained.splice(first, 0, group.message)
      messages = retained
    }
    return messages
  }

  const prepare: NonNullable<TurnHooks['beforeStep']> = async context => {
    let messages = context.messages
    const toolNames = new Map(context.snapshot.entries.flatMap(entry => entry.event.kind === 'tool-call'
      ? [[String(entry.event.callId), entry.event.name] as const] : []))
    messages = await mapSequential(messages, async message => {
      const content = await mapSequential(message.content, async block => {
        if (block.type !== 'tool-result') return block
        const toolName = toolNames.get(String(block.toolCallId)) ?? ''
        if (toolName === retrievalTool.name) return block
        const children = await mapSequential(block.content, async (child, index) => {
          if (disposed) return child
          context.signal.throwIfAborted()
          if (child.type !== 'text') return child
          const key = `${message.id}:${block.toolCallId}:${index}`
          let observation = observations.get(key)
          if (observation !== undefined && observation.text !== child.text) return child
          const bytes = observation?.record.bytes ?? byteLength(child.text)
          const identifiedLog = observation === undefined
            ? bytes > reductionThreshold ? log?.(toolName, child.text) : undefined
            : observation.log
          // Save may await a host backend. Capture its authority before that await.
          const logInfo = identifiedLog === undefined ? undefined : Object.freeze({ status: identifiedLog.status,
            ...identifiedLog.requiredLines === undefined ? {} : { requiredLines: Object.freeze([...identifiedLog.requiredLines]) } })
          const large = bytes > threshold
          const reducible = reducer !== undefined && logInfo !== undefined && bytes > reductionThreshold
          if (!large && !reducible) return child
          if (observation === undefined) {
            if (observations.size >= maxObservations) return child
            try {
              const record = await store.save(child.text, { toolName, callId: String(block.toolCallId) })
              if (disposed) return child
              context.signal.throwIfAborted()
              const captured = Object.freeze({ locator: record.locator, retrieval: record.retrieval, bytes: record.bytes })
              if (typeof captured.locator !== 'string' || !captured.locator || typeof captured.retrieval !== 'string'
                || !captured.retrieval || captured.bytes !== bytes) return child
              observation = { text: child.text, record: captured, exposures: 0, reductionAttempted: false,
                ...logInfo === undefined ? {} : { log: { ...logInfo,
                  ...logInfo.requiredLines === undefined ? {} : { requiredLines: Object.freeze([...logInfo.requiredLines]) } } } }
              observations.set(key, observation)
            } catch { return child }
          }
          if (large && observation.exposures < fullRequests) return child
          // Retention is owned by the store. Do not emit a pointer known to be expired.
          try {
            if (await store.read(observation.record.locator, { offset: 0, limit: 1 }) === undefined) return child
          } catch { return child }
          if (disposed) return child
          context.signal.throwIfAborted()
          if (observation.packed !== undefined) {
            metrics.packedObservations++
            return { ...child, text: observation.packed }
          }
          if (reducible && !observation.reductionAttempted) {
            observation.reductionAttempted = true
            const result = await reduceEvidence({ text: child.text, status: logInfo.status, signal: context.signal }, reducer, logInfo.requiredLines)
            if (disposed) return child
            context.signal.throwIfAborted()
            if (result.accepted) { observation.reduced = result.text; metrics.verifiedReductions++ }
            else { metrics.rejectedReductions++; return child }
          }
          // Invalid reductions always preserve the original, including on later requests.
          if (reducible && observation.reduced === undefined) return child
          const header = `[Observation stored. ID: ${observation.record.locator}; bytes: ${bytes}]\n${observation.record.retrieval}\n`
          let body = observation.reduced
          if (body === undefined) {
            const lines = child.text.split('\n')
            const evidence = diagnosticLineNumbers(child.text).map(line => `${line}: ${lines[line - 1]}`).join('\n')
            const room = summaryBytes - byteLength(header) - byteLength(evidence) - 40
            if (room <= 0) return child
            body = `${utf8Prefix(child.text, room)}\n[Preview; omitted text is retrievable]\n${evidence}`
          }
          const text = header + body
          if (byteLength(text) >= bytes) return child
          observation.packed = text
          metrics.packedObservations++
          return { ...child, text }
        })
        return { ...block, content: children }
      })
      return { ...message, content }
    })
    if (disposed) return { kind: 'proceed', messages: context.messages }
    context.signal.throwIfAborted()
    messages = await projectMilestones({ ...context, messages }, context.messages)
    if (disposed) return { kind: 'proceed', messages: context.messages }
    context.signal.throwIfAborted()
    const before = context.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    const after = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    metrics.estimatedTokensSaved += Math.max(0, before - after)
    return { kind: 'proceed', messages: Object.freeze(messages) }
  }
  const beforeStep: NonNullable<TurnHooks['beforeStep']> = async context => {
    if (disposed) return { kind: 'proceed', messages: context.messages }
    if (active) return { kind: 'reject', reason: 'Context optimizer already has a prepare in flight; use one controller per session.' }
    const first = context.snapshot.entries.find(entry => 'message' in entry.event)
    const identity = first !== undefined && 'message' in first.event ? String(first.event.message.id) : undefined
    if (scope !== undefined && identity !== scope) return { kind: 'reject', reason: 'Context optimizer belongs to a different history; create a fresh controller after reset/resume.' }
    scope ??= identity
    active = true
    try { return await prepare({ ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) }) }
    finally { active = false }
  }
  const checkpoint: NonNullable<TurnHooks['checkpoint']> = context => {
    if (disposed || context.kind !== 'before-model-request') return
    for (const message of context.request.messages ?? []) {
      for (const block of message.content) {
        if (block.type !== 'tool-result') continue
        block.content.forEach((_child, index) => {
          const observation = observations.get(`${message.id}:${block.toolCallId}:${index}`)
          if (observation !== undefined) observation.exposures++
        })
      }
    }
  }
  const hooks: TurnHooks = Object.freeze({ beforeStep, checkpoint })
  return Object.freeze({
    hooks, retrievalTool,
    completeMilestone(milestone: ContextMilestone): void {
      if (disposed) throw new Error('context optimizer is disposed')
      if (milestoneIds.size >= maxMilestones) throw new RangeError('context optimizer milestone capacity reached')
      if (!milestone.id.trim() || !milestone.summary.trim() || milestoneIds.has(milestone.id)) throw new TypeError('milestone requires a unique id and non-empty summary')
      if (byteLength(milestone.id) > 128 || byteLength(milestone.summary) > 8192) throw new RangeError('milestone id/summary exceeds 128/8192 bytes')
      positive(milestone.throughSeq, 'throughSeq')
      positive(milestone.remainingTurns, 'remainingTurns')
      if (!Number.isFinite(milestone.compactionCost) || milestone.compactionCost < 0
        || !Number.isFinite(milestone.historyTokenCost ?? 1) || (milestone.historyTokenCost ?? 1) <= 0) throw new RangeError('milestone costs must be finite and non-negative; token cost must be positive')
      milestoneIds.add(milestone.id)
      pending.push(Object.freeze({ ...milestone }))
    },
    /** Application hook runs first; checkpoints count only after host persistence succeeds. */
    wrapHooks(application: TurnHooks = {}): TurnHooks {
      return {
        ...application,
        async beforeStep(context) {
          const decision = await application.beforeStep?.(context)
          if (decision?.kind === 'reject') return decision
          const optimized = await beforeStep({ ...context, messages: decision?.messages ?? context.messages })
          return { ...optimized, ...decision?.prepend === undefined ? {} : { prepend: decision.prepend } }
        },
        async checkpoint(context) { await application.checkpoint?.(context); await checkpoint(context) },
      }
    },
    metrics(): ContextOptimizationMetrics { return Object.freeze({ ...metrics }) },
    dispose(): void { disposed = true; lifetime.abort(new Error('Context optimizer disposed')); observations.clear(); pending.length = 0; completed.length = 0; milestoneIds.clear() },
  })
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}
function byteLength(text: string): number { return new TextEncoder().encode(text).byteLength }
async function mapSequential<T, U>(items: readonly T[], map: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const result: U[] = []
  for (let index = 0; index < items.length; index++) result.push(await map(items[index]!, index))
  return result
}
function utf8Prefix(text: string, bytes: number): string {
  let result = '', used = 0
  for (const point of text) { used += byteLength(point); if (used > bytes) break; result += point }
  return result
}
function balanced(messages: readonly Message[]): boolean {
  const calls = new Set<string>(), results = new Set<string>()
  for (const message of messages) for (const block of message.content) {
    if (block.type === 'tool-call') calls.add(String(block.id))
    if (block.type === 'tool-result') results.add(String(block.toolCallId))
  }
  return calls.size === results.size && [...calls].every(id => results.has(id))
}
