import type { Message } from '@ai-agent-sdk/core'
import type { TokenUsage } from '@ai-agent-sdk/core'
import type { ToolCallId } from '@ai-agent-sdk/core'
import { deepFreeze } from '@ai-agent-sdk/core'
import type { ToolExecutionResult } from '../tool/definition.ts'
import { projectHistorySurface, projectMessages } from './project.ts'

export type SurfaceOp = 'append' | {
  readonly op: 'replace'
  /** Backward-compatible inclusive log range for simple replacements. */
  readonly from: number
  readonly to: number
  /** Exact current-surface nodes, required when prior replacements made seqs non-contiguous. */
  readonly targets?: readonly number[]
}

/** Shared persisted/runtime compaction backoff vocabulary. */
export type CompactionBackoffReason = 'low-savings' | 'unreachable-threshold'

export type HistoryEvent =
  | { readonly kind: 'user'; readonly message: Message }
  | {
    readonly kind: 'assistant'
    readonly message: Message
    readonly interrupted?: true
    readonly usage?: TokenUsage
  }
  | {
    readonly kind: 'tool-call'
    readonly callId: ToolCallId
    readonly name: string
    readonly rawArguments: string
  }
  | {
    readonly kind: 'tool-result'
    readonly callId: ToolCallId
    readonly message: Message
    readonly result: ToolExecutionResult
  }
  | {
    readonly kind: 'compaction-start'
    readonly compactionId: string
    readonly trigger: 'pressure' | 'context-overflow' | 'manual'
    readonly at: string
  }
  | {
    readonly kind: 'compaction-prune'
    readonly callId: ToolCallId
    readonly originalSeq: number
    readonly charsBefore: number
    readonly charsAfter: number
  }
  | {
    readonly kind: 'compaction-summary'
    readonly compactionId: string
    readonly summary: string
    readonly shadowedSeqs: readonly number[]
    readonly estimatedTokensBefore: number
    readonly estimatedTokensAfter: number
    readonly provider: string
    readonly model: string
    readonly usage?: TokenUsage
  }
  | {
    readonly kind: 'compaction-end'
    readonly compactionId: string
    readonly status: 'completed' | 'failed'
    readonly at: string
    readonly thresholdTokens?: number
    readonly estimatedNonCompactableTokens?: number
    readonly backoffReason?: CompactionBackoffReason
    readonly cooldownSteps?: number
    readonly error?: string
  }

export interface HistoryEntry {
  readonly seq: number
  readonly event: HistoryEvent
  readonly surfaceOp: SurfaceOp
}

export interface HistorySnapshot {
  readonly version: 1
  readonly entries: readonly HistoryEntry[]
}

export interface HistoryLimits {
  /** Maximum append-only entries retained by one in-memory history. Defaults to 100,000. */
  readonly maxEntries?: number
  /** Maximum serialized bytes for one entry. Defaults to 16 MiB. */
  readonly maxEntryBytes?: number
  /** Maximum cumulative serialized entry bytes. Defaults to 128 MiB. */
  readonly maxBytes?: number
}

interface ResolvedHistoryLimits {
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly maxBytes: number
}

const MAX_CONTENT_DEPTH = 64

/** Append-only conversation history with a replaceable model-facing projection. */
export class History {
  private readonly log: HistoryEntry[]
  private replacementGeneration: number
  private validationState: SnapshotValidationState
  private readonly limits: ResolvedHistoryLimits
  private storedBytes = 0

  constructor(limits: HistoryLimits = {}) {
    this.log = []
    this.replacementGeneration = 0
    this.validationState = emptyValidationState()
    this.limits = resolveHistoryLimits(limits)
  }

  private static hydrate(
    entries: HistoryEntry[],
    validationState: SnapshotValidationState,
    limits: ResolvedHistoryLimits,
    storedBytes: number,
  ): History {
    const history = new History(limits)
    history.log.push(...entries)
    history.replacementGeneration = entries.filter(entry => entry.surfaceOp !== 'append').length
    history.validationState = validationState
    history.storedBytes = storedBytes
    return history
  }

  static fromSnapshot(snapshot: HistorySnapshot, limits: HistoryLimits = {}): History {
    const resolved = resolveHistoryLimits(limits)
    const sourceEntries = snapshotEntries(snapshot)
    if (sourceEntries.length > resolved.maxEntries) {
      throw new RangeError(`history snapshot exceeds the ${resolved.maxEntries}-entry limit`)
    }
    // Reject oversized input before duplicating it with structuredClone. The
    // detached clone is measured again because accessors/toJSON on hostile
    // objects must not be able to make the preflight size authoritative.
    assertEntriesWithinLimits(sourceEntries, resolved)
    const clone = structuredClone(sourceEntries) as HistoryEntry[]
    const storedBytes = assertEntriesWithinLimits(clone, resolved)
    const validationState = validateEntries(clone)
    return History.hydrate(clone.map(entry => deepFreeze(entry)), validationState, resolved, storedBytes)
  }

  private static assertCandidateWithinLimits(entry: HistoryEntry, limits: ResolvedHistoryLimits): number {
    const bytes = serializedBytes(entry)
    if (bytes > limits.maxEntryBytes) {
      throw new RangeError(`history entry exceeds the ${limits.maxEntryBytes}-byte limit`)
    }
    return bytes
  }

  private static cloneCandidate(
    seq: number,
    event: HistoryEvent,
    surfaceOp: SurfaceOp,
    limits: ResolvedHistoryLimits,
  ): { readonly entry: HistoryEntry; readonly bytes: number } {
    const source = { seq, event, surfaceOp }
    // Preflight before cloning so a single oversized caller value cannot force
    // an equally large detached copy merely to discover that it exceeds policy.
    History.assertCandidateWithinLimits(source, limits)
    const entry = structuredClone(source) as HistoryEntry
    return { entry, bytes: History.assertCandidateWithinLimits(entry, limits) }
  }

  append(event: HistoryEvent, surfaceOp: SurfaceOp = 'append'): HistoryEntry {
    return this.appendOne(event, surfaceOp)
  }

  /** Validate and commit related history writes atomically. */
  appendBatch(
    writes: readonly { readonly event: HistoryEvent; readonly surfaceOp?: SurfaceOp }[],
  ): readonly HistoryEntry[] {
    if (writes.length === 0) return Object.freeze([])
    if (writes.length === 1) {
      const write = writes[0]!
      return Object.freeze([this.appendOne(write.event, write.surfaceOp ?? 'append')])
    }
    if (this.log.length + writes.length > this.limits.maxEntries) {
      throw new RangeError(`history reached its ${this.limits.maxEntries}-entry limit`)
    }
    const state = cloneValidationState(this.validationState)
    const candidates: HistoryEntry[] = []
    let totalBytes = this.storedBytes
    let replacements = 0
    for (let index = 0; index < writes.length; index++) {
      const write = writes[index]!
      const surfaceOp = write.surfaceOp ?? 'append'
      const { entry: candidate, bytes: entryBytes } = History.cloneCandidate(
        this.log.length + index + 1, write.event, surfaceOp, this.limits,
      )
      validateHistoryEvent(candidate.event, candidate.seq, state)
      validateSurfaceOp(
        candidate.surfaceOp,
        candidate.seq,
        state.visibleMessageSeqs,
        messageOfHistoryEvent(candidate.event),
      )
      updateVisibleMessages(candidate, state.visibleMessageSeqs)
      totalBytes += entryBytes
      if (totalBytes > this.limits.maxBytes) {
        throw new RangeError(`history reached its ${this.limits.maxBytes}-byte limit`)
      }
      candidates.push(deepFreeze(candidate))
      if (surfaceOp !== 'append') replacements++
    }
    this.log.push(...candidates)
    this.validationState = state
    this.storedBytes = totalBytes
    this.replacementGeneration += replacements
    return Object.freeze([...candidates])
  }

  private appendOne(event: HistoryEvent, surfaceOp: SurfaceOp): HistoryEntry {
    if (this.log.length >= this.limits.maxEntries) {
      throw new RangeError(`history reached its ${this.limits.maxEntries}-entry limit`)
    }
    const { entry: candidate, bytes: entryBytes } = History.cloneCandidate(
      this.log.length + 1, event, surfaceOp, this.limits,
    )
    try {
      validateHistoryEvent(candidate.event, candidate.seq, this.validationState)
      validateSurfaceOp(
        candidate.surfaceOp,
        candidate.seq,
        this.validationState.visibleMessageSeqs,
        messageOfHistoryEvent(candidate.event),
      )
      updateVisibleMessages(candidate, this.validationState.visibleMessageSeqs)
      if (this.storedBytes + entryBytes > this.limits.maxBytes) {
        throw new RangeError(`history reached its ${this.limits.maxBytes}-byte limit`)
      }
      const entry = deepFreeze(candidate)
      this.log.push(entry)
      this.storedBytes += entryBytes
      if (surfaceOp !== 'append') this.replacementGeneration++
      return entry
    } catch (error: unknown) {
      // Incremental validators mutate correlation sets. Rebuild only on the
      // exceptional path so normal append stays O(1) rather than O(history).
      this.validationState = validateEntries(this.log)
      throw error
    }
  }

  entries(): readonly HistoryEntry[] {
    return Object.freeze([...this.log])
  }

  messages(): readonly Message[] {
    return projectMessages(this.log)
  }

  /** Current model-visible nodes with durable seq identity, in surface order. */
  surface(): readonly import('./project.ts').HistorySurfaceNode[] {
    return projectHistorySurface(this.log)
  }

  generation(): number {
    return this.replacementGeneration
  }

  snapshot(): HistorySnapshot {
    return deepFreeze(structuredClone({ version: 1 as const, entries: this.log }))
  }
}

function snapshotEntries(value: unknown): readonly HistoryEntry[] {
  if (typeof value !== 'object' || value === null) throw new TypeError('history snapshot must be an object')
  const snapshot = value as Partial<HistorySnapshot>
  if (snapshot.version !== 1) throw new TypeError('unsupported history snapshot version')
  if (!Array.isArray(snapshot.entries)) throw new TypeError('history snapshot entries must be an array')
  return snapshot.entries as readonly HistoryEntry[]
}

function assertEntriesWithinLimits(entries: readonly HistoryEntry[], limits: ResolvedHistoryLimits): number {
  let totalBytes = 0
  for (const entry of entries) {
    const bytes = serializedBytes(entry)
    if (bytes > limits.maxEntryBytes) {
      throw new RangeError(`history snapshot entry exceeds the ${limits.maxEntryBytes}-byte limit`)
    }
    totalBytes += bytes
    if (totalBytes > limits.maxBytes) {
      throw new RangeError(`history snapshot exceeds the ${limits.maxBytes}-byte limit`)
    }
  }
  return totalBytes
}

function emptyValidationState(): SnapshotValidationState {
  return {
    messageIds: new Set(),
    toolCallIds: new Set(),
    nativeToolIds: new Set(),
    toolCallEventIds: new Set(),
    compactions: new Map(),
    visibleMessageSeqs: new Set(),
  }
}

function cloneValidationState(state: SnapshotValidationState): SnapshotValidationState {
  return {
    messageIds: new Set(state.messageIds),
    toolCallIds: new Set(state.toolCallIds),
    nativeToolIds: new Set(state.nativeToolIds),
    toolCallEventIds: new Set(state.toolCallEventIds),
    compactions: new Map([...state.compactions].map(([id, lifecycle]) => [id, { ...lifecycle }])),
    visibleMessageSeqs: new Set(state.visibleMessageSeqs),
  }
}

function validateEntries(entries: readonly HistoryEntry[]): SnapshotValidationState {
  const state = emptyValidationState()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as Partial<HistoryEntry> | undefined
    if (entry === undefined || entry.seq !== index + 1 || typeof entry.event !== 'object'
      || entry.event === null || !('kind' in entry.event)) {
      throw new TypeError(`invalid history entry at index ${index}`)
    }
    if (![
      'user', 'assistant', 'tool-call', 'tool-result',
      'compaction-start', 'compaction-prune', 'compaction-summary', 'compaction-end',
    ].includes(String(entry.event.kind))) {
      throw new TypeError(`unknown history event kind at index ${index}`)
    }
    validateHistoryEvent(entry.event, entry.seq, state)
    validateSurfaceOp(
      entry.surfaceOp as SurfaceOp,
      entry.seq,
      state.visibleMessageSeqs,
      messageOfHistoryEvent(entry.event),
    )
    updateVisibleMessages(entry as HistoryEntry, state.visibleMessageSeqs)
  }
  return state
}

interface SnapshotValidationState {
  readonly messageIds: Set<string>
  readonly toolCallIds: Set<string>
  readonly nativeToolIds: Set<string>
  readonly toolCallEventIds: Set<string>
  readonly compactions: Map<string, { summary: boolean; end: boolean }>
  readonly visibleMessageSeqs: Set<number>
}

function validateHistoryEvent(
  event: HistoryEvent,
  seq: number,
  state: SnapshotValidationState,
): void {
  const path = `history entry ${seq} ${event.kind}`
  switch (event.kind) {
    case 'user':
      validateMessage(event.message, `${path}.message`, state)
      return
    case 'assistant':
      validateMessage(event.message, `${path}.message`, state)
      if (event.interrupted !== undefined && event.interrupted !== true) {
        throw new TypeError(`${path}.interrupted must be true when present`)
      }
      if (event.usage !== undefined) validateUsage(event.usage, `${path}.usage`)
      return
    case 'tool-call': {
      const callId = nonEmptyString(event.callId, `${path}.callId`)
      if (state.toolCallEventIds.has(callId)) throw new TypeError(`duplicate tool-call event id '${callId}'`)
      state.toolCallEventIds.add(callId)
      nonEmptyString(event.name, `${path}.name`)
      if (typeof event.rawArguments !== 'string') throw new TypeError(`${path}.rawArguments must be a string`)
      return
    }
    case 'tool-result': {
      const callId = nonEmptyString(event.callId, `${path}.callId`)
      validateMessage(event.message, `${path}.message`, state)
      validateToolResultMessage(event.message, callId, `${path}.message`)
      validateToolExecutionResult(event.result, `${path}.result`)
      return
    }
    case 'compaction-start': {
      const id = nonEmptyString(event.compactionId, `${path}.compactionId`)
      if (state.compactions.has(id)) throw new TypeError(`duplicate compaction id '${id}'`)
      if (!['pressure', 'context-overflow', 'manual'].includes(event.trigger)) {
        throw new TypeError(`${path}.trigger is invalid`)
      }
      validateIsoTimestamp(event.at, `${path}.at`)
      state.compactions.set(id, { summary: false, end: false })
      return
    }
    case 'compaction-prune':
      nonEmptyString(event.callId, `${path}.callId`)
      positiveInteger(event.originalSeq, `${path}.originalSeq`)
      if (event.originalSeq >= seq) throw new TypeError(`${path}.originalSeq must reference an earlier entry`)
      nonNegativeInteger(event.charsBefore, `${path}.charsBefore`)
      nonNegativeInteger(event.charsAfter, `${path}.charsAfter`)
      if (event.charsAfter > event.charsBefore) throw new TypeError(`${path}.charsAfter cannot exceed charsBefore`)
      return
    case 'compaction-summary': {
      const id = nonEmptyString(event.compactionId, `${path}.compactionId`)
      const lifecycle = state.compactions.get(id)
      if (lifecycle === undefined) throw new TypeError(`${path} has no matching compaction-start`)
      if (lifecycle.summary) throw new TypeError(`duplicate compaction summary for '${id}'`)
      if (lifecycle.end) throw new TypeError(`${path} appears after compaction-end`)
      nonEmptyString(event.summary, `${path}.summary`)
      validateSeqTargets(event.shadowedSeqs, seq, `${path}.shadowedSeqs`)
      for (const target of event.shadowedSeqs) {
        if (!state.visibleMessageSeqs.has(target)) {
          throw new TypeError(`${path}.shadowedSeqs references non-visible message ${target}`)
        }
      }
      nonNegativeInteger(event.estimatedTokensBefore, `${path}.estimatedTokensBefore`)
      nonNegativeInteger(event.estimatedTokensAfter, `${path}.estimatedTokensAfter`)
      if (event.estimatedTokensAfter > event.estimatedTokensBefore) {
        throw new TypeError(`${path}.estimatedTokensAfter cannot exceed estimatedTokensBefore`)
      }
      nonEmptyString(event.provider, `${path}.provider`)
      nonEmptyString(event.model, `${path}.model`)
      if (event.usage !== undefined) validateUsage(event.usage, `${path}.usage`)
      lifecycle.summary = true
      return
    }
    case 'compaction-end': {
      const id = nonEmptyString(event.compactionId, `${path}.compactionId`)
      const lifecycle = state.compactions.get(id)
      if (lifecycle === undefined) throw new TypeError(`${path} has no matching compaction-start`)
      if (lifecycle.end) throw new TypeError(`duplicate compaction end for '${id}'`)
      if (!['completed', 'failed'].includes(event.status)) throw new TypeError(`${path}.status is invalid`)
      validateIsoTimestamp(event.at, `${path}.at`)
      if (event.thresholdTokens !== undefined) positiveInteger(event.thresholdTokens, `${path}.thresholdTokens`)
      if (event.estimatedNonCompactableTokens !== undefined) {
        nonNegativeInteger(event.estimatedNonCompactableTokens, `${path}.estimatedNonCompactableTokens`)
      }
      if (event.backoffReason !== undefined
        && !['low-savings', 'unreachable-threshold'].includes(event.backoffReason)) {
        throw new TypeError(`${path}.backoffReason is invalid`)
      }
      if (event.cooldownSteps !== undefined) positiveInteger(event.cooldownSteps, `${path}.cooldownSteps`)
      if ((event.backoffReason === undefined) !== (event.cooldownSteps === undefined)) {
        throw new TypeError(`${path}.backoffReason and cooldownSteps must be set together`)
      }
      if (event.backoffReason !== undefined && event.thresholdTokens === undefined) {
        throw new TypeError(`${path}.backoffReason requires thresholdTokens`)
      }
      if (event.status === 'completed') {
        if (!lifecycle.summary) throw new TypeError(`${path} completed without a compaction-summary`)
        if (event.error !== undefined) throw new TypeError(`${path}.error is only valid for failed compaction`)
      } else {
        nonEmptyString(event.error, `${path}.error`)
        if (event.backoffReason !== undefined || event.thresholdTokens !== undefined
          || event.estimatedNonCompactableTokens !== undefined) {
          throw new TypeError(`${path} failed compaction cannot carry completed metrics`)
        }
      }
      lifecycle.end = true
      return
    }
  }
}

function validateMessage(value: unknown, path: string, state: SnapshotValidationState): asserts value is Message {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const id = nonEmptyString(value.id, `${path}.id`)
  if (state.messageIds.has(id)) throw new TypeError(`duplicate message id '${id}'`)
  state.messageIds.add(id)
  if (!['system', 'user', 'assistant'].includes(String(value.role))) {
    throw new TypeError(`${path}.role is invalid`)
  }
  if (!Array.isArray(value.content)) throw new TypeError(`${path}.content must be an array`)
  for (let index = 0; index < value.content.length; index++) {
    validateContentBlock(value.content[index], `${path}.content[${index}]`, state, new Set(), 0)
  }
  validateMessageSource(value.source, `${path}.source`)
}

function validateMessageSource(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const kind = nonEmptyString(value.kind, `${path}.kind`)
  switch (kind) {
    case 'user': return
    case 'app': nonEmptyString(value.producer, `${path}.producer`); return
    case 'model':
      nonEmptyString(value.provider, `${path}.provider`)
      nonEmptyString(value.model, `${path}.model`)
      return
    case 'tool': nonEmptyString(value.callId, `${path}.callId`); return
    default:
      // Message sources and content blocks are declaration-merge extensible.
      // Preserve third-party kinds while still requiring their discriminator.
      return
  }
}

function validateContentBlock(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
  ancestors: Set<object>,
  depth: number,
): void {
  if (depth > MAX_CONTENT_DEPTH) throw new TypeError(`${path} exceeds the maximum content depth`)
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain a cycle`)
  const nextAncestors = new Set(ancestors).add(value)
  const type = nonEmptyString(value.type, `${path}.type`)
  switch (type) {
    case 'text':
      if (typeof value.text !== 'string') throw new TypeError(`${path}.text must be a string`)
      if (value.phase !== undefined && !['commentary', 'final-answer'].includes(String(value.phase))) {
        throw new TypeError(`${path}.phase is invalid`)
      }
      if (value.annotations !== undefined) {
        if (!Array.isArray(value.annotations)) throw new TypeError(`${path}.annotations must be an array`)
        for (let index = 0; index < value.annotations.length; index++) {
          validateTextAnnotation(value.annotations[index], `${path}.annotations[${index}]`)
        }
      }
      return
    case 'reasoning':
      if (typeof value.text !== 'string') throw new TypeError(`${path}.text must be a string`)
      return
    case 'image': validateImageSource(value.source, `${path}.source`); return
    case 'native-tool-call':
      {
        const id = nonEmptyString(value.id, `${path}.id`)
        if (state.nativeToolIds.has(id)) throw new TypeError(`duplicate native tool id '${id}'`)
        state.nativeToolIds.add(id)
      }
      nonEmptyString(value.name, `${path}.name`)
      if (value.status !== undefined && typeof value.status !== 'string') {
        throw new TypeError(`${path}.status must be a string`)
      }
      validateContentArray(value.content, `${path}.content`, state, nextAncestors, depth + 1)
      return
    case 'tool-call': {
      const id = nonEmptyString(value.id, `${path}.id`)
      if (state.toolCallIds.has(id)) throw new TypeError(`duplicate tool call id '${id}'`)
      state.toolCallIds.add(id)
      nonEmptyString(value.name, `${path}.name`)
      if (typeof value.arguments !== 'string') throw new TypeError(`${path}.arguments must be a string`)
      return
    }
    case 'tool-result':
      nonEmptyString(value.toolCallId, `${path}.toolCallId`)
      if (value.isError !== undefined && typeof value.isError !== 'boolean') {
        throw new TypeError(`${path}.isError must be a boolean`)
      }
      validateContentArray(value.content, `${path}.content`, state, nextAncestors, depth + 1)
      return
    default:
      return
  }
}

function validateContentArray(
  value: unknown,
  path: string,
  state: SnapshotValidationState,
  ancestors: Set<object>,
  depth: number,
): void {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  for (let index = 0; index < value.length; index++) {
    validateContentBlock(value[index], `${path}[${index}]`, state, ancestors, depth)
  }
}

function validateTextAnnotation(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const type = nonEmptyString(value.type, `${path}.type`)
  if (type !== 'url-citation') return
  nonEmptyString(value.url, `${path}.url`)
  if (value.title !== undefined && typeof value.title !== 'string') throw new TypeError(`${path}.title must be a string`)
  for (const field of ['startIndex', 'endIndex'] as const) {
    if (value[field] !== undefined) nonNegativeInteger(value[field], `${path}.${field}`)
  }
}

function validateImageSource(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const kind = nonEmptyString(value.kind, `${path}.kind`)
  if (kind === 'base64') {
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(value.mediaType))) {
      throw new TypeError(`${path}.mediaType is invalid`)
    }
    if (typeof value.data !== 'string') throw new TypeError(`${path}.data must be a string`)
  } else if (kind === 'url') {
    nonEmptyString(value.url, `${path}.url`)
  } else if (kind === 'file') {
    nonEmptyString(value.fileId, `${path}.fileId`)
  } else {
    throw new TypeError(`${path}.kind is invalid`)
  }
}

function validateToolResultMessage(message: Message, callId: string, path: string): void {
  if (message.source.kind !== 'tool' || message.source.callId !== callId) {
    throw new TypeError(`${path}.source.callId must match its tool-result event`)
  }
  if (message.role !== 'user' || message.content.length !== 1
    || message.content[0]?.type !== 'tool-result'
    || message.content[0].toolCallId !== callId) {
    throw new TypeError(`${path} must carry exactly one matching tool-result block`)
  }
}

function validateToolExecutionResult(value: unknown, path: string): void {
  if (!isRecord(value) || typeof value.isError !== 'boolean') {
    throw new TypeError(`${path}.isError must be a boolean`)
  }
  validateDetachedContent(value.content, `${path}.content`)
  if (value.additionalContext !== undefined) {
    validateDetachedContent(value.additionalContext, `${path}.additionalContext`)
  }
  if (value.meta !== undefined && (!isRecord(value.meta))) throw new TypeError(`${path}.meta must be an object`)
  if (value.isError) {
    if (!isRecord(value.error)) throw new TypeError(`${path}.error must be an object`)
    nonEmptyString(value.error.message, `${path}.error.message`)
    nonEmptyString(value.error.code, `${path}.error.code`)
    if (value.concludesTurn !== undefined) throw new TypeError(`${path}.concludesTurn is invalid for a failure`)
  } else if (value.concludesTurn !== undefined && value.concludesTurn !== true) {
    throw new TypeError(`${path}.concludesTurn must be true when present`)
  }
}

function validateDetachedContent(value: unknown, path: string): void {
  const state: SnapshotValidationState = {
    messageIds: new Set(), toolCallIds: new Set(), nativeToolIds: new Set(), toolCallEventIds: new Set(),
    compactions: new Map(), visibleMessageSeqs: new Set(),
  }
  validateContentArray(value, path, state, new Set(), 0)
}

function validateUsage(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  for (const field of [
    'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  ] as const) {
    const tokenCount = value[field]
    if ((field === 'inputTokens' || field === 'outputTokens') || tokenCount !== undefined) {
      nonNegativeInteger(tokenCount, `${path}.${field}`)
    }
  }
}

function validateSeqTargets(value: unknown, nextSeq: number, path: string): asserts value is readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    throw new TypeError(`${path} must contain unique earlier sequence numbers`)
  }
  if (value.some(seq => !Number.isInteger(seq) || seq < 1 || seq >= nextSeq)) {
    throw new TypeError(`${path} must contain unique earlier sequence numbers`)
  }
}

function updateVisibleMessages(entry: HistoryEntry, visible: Set<number>): void {
  if (entry.surfaceOp !== 'append') {
    const operation = entry.surfaceOp
    const targets = operation.targets === undefined
      ? [...visible].filter(seq => seq >= operation.from && seq <= operation.to)
      : [...operation.targets]
    for (const target of targets) visible.delete(target)
  }
  if (messageOfHistoryEvent(entry.event)) visible.add(entry.seq)
}

function messageOfHistoryEvent(event: HistoryEvent): boolean {
  return event.kind === 'user' || event.kind === 'assistant' || event.kind === 'tool-result'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${path} must be a positive integer`)
}

function nonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${path} must be a non-negative integer`)
}

function validateIsoTimestamp(value: unknown, path: string): void {
  const timestamp = nonEmptyString(value, path)
  const date = new Date(timestamp)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== timestamp) {
    throw new TypeError(`${path} must be an ISO timestamp`)
  }
}

function validateSurfaceOp(
  op: SurfaceOp,
  nextSeq: number,
  visible?: ReadonlySet<number>,
  replacementCarriesMessage = true,
): void {
  if (op === 'append') return
  if (typeof op !== 'object' || op.op !== 'replace'
    || !Number.isInteger(op.from) || !Number.isInteger(op.to)
    || op.from < 1 || op.to < op.from || op.to >= nextSeq) {
    throw new TypeError('history replace span must reference an earlier inclusive sequence range')
  }
  if (op.targets !== undefined) {
    if (op.targets.length === 0 || new Set(op.targets).size !== op.targets.length
      || op.targets.some(seq => !Number.isInteger(seq) || seq < 1 || seq >= nextSeq)) {
      throw new TypeError('history replace targets must be unique earlier sequence numbers')
    }
    if (op.targets.some(seq => seq < op.from || seq > op.to)) {
      throw new TypeError('history replace targets must stay within its inclusive sequence range')
    }
  }
  if (visible !== undefined) {
    if (!replacementCarriesMessage) throw new TypeError('history replacement entry must carry a message')
    const targets = op.targets ?? [...visible].filter(seq => seq >= op.from && seq <= op.to)
    if (targets.length === 0 || targets.some(seq => !visible.has(seq))) {
      throw new TypeError('history replace targets must reference current visible messages')
    }
  }
}

function resolveHistoryLimits(input: HistoryLimits): ResolvedHistoryLimits {
  const maxEntries = positiveLimit(input.maxEntries ?? 100_000, 'maxEntries')
  const maxEntryBytes = positiveLimit(input.maxEntryBytes ?? 16 * 1024 * 1024, 'maxEntryBytes')
  const maxBytes = positiveLimit(input.maxBytes ?? 128 * 1024 * 1024, 'maxBytes')
  if (maxEntryBytes > maxBytes) throw new RangeError('history maxEntryBytes must not exceed maxBytes')
  return Object.freeze({ maxEntries, maxEntryBytes, maxBytes })
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`history ${name} must be a positive safe integer`)
  return value
}

function serializedBytes(value: unknown): number {
  let json: string | undefined
  try { json = JSON.stringify(value) }
  catch (error: unknown) { throw new TypeError('history value must be JSON-serializable', { cause: error }) }
  if (json === undefined) throw new TypeError('history value must be JSON-serializable')
  return new TextEncoder().encode(json).byteLength
}
