import type { Message } from '../../message/index.ts'
import {
  type SurfaceOp, type HistoryEvent, type HistoryEntry, type HistorySnapshot,
  type ResolvedHistoryLimits,
} from './types.ts'
import { MAX_CONTENT_DEPTH, serializedBytes } from './config.ts'

export function snapshotEntries(value: unknown): readonly HistoryEntry[] {
  if (typeof value !== 'object' || value === null) throw new TypeError('history snapshot must be an object')
  const snapshot = value as Partial<HistorySnapshot>
  if (snapshot.version !== 1) throw new TypeError('unsupported history snapshot version')
  if (!Array.isArray(snapshot.entries)) throw new TypeError('history snapshot entries must be an array')
  return snapshot.entries as readonly HistoryEntry[]
}

export function assertEntriesWithinLimits(entries: readonly HistoryEntry[], limits: ResolvedHistoryLimits): number {
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

export function emptyValidationState(): SnapshotValidationState {
  return {
    messageIds: new Set(),
    toolCallIds: new Set(),
    nativeToolIds: new Set(),
    toolCallEventIds: new Set(),
    compactions: new Map(),
    visibleMessageSeqs: new Set(),
  }
}

export function cloneValidationState(state: SnapshotValidationState): SnapshotValidationState {
  return {
    messageIds: new Set(state.messageIds),
    toolCallIds: new Set(state.toolCallIds),
    nativeToolIds: new Set(state.nativeToolIds),
    toolCallEventIds: new Set(state.toolCallEventIds),
    compactions: new Map([...state.compactions].map(([id, lifecycle]) => [id, { ...lifecycle }])),
    visibleMessageSeqs: new Set(state.visibleMessageSeqs),
  }
}

export function validateEntries(entries: readonly HistoryEntry[]): SnapshotValidationState {
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

export interface SnapshotValidationState {
  readonly messageIds: Set<string>
  readonly toolCallIds: Set<string>
  readonly nativeToolIds: Set<string>
  readonly toolCallEventIds: Set<string>
  readonly compactions: Map<string, { summary: boolean; end: boolean }>
  readonly visibleMessageSeqs: Set<number>
}

export function validateHistoryEvent(
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

export function validateMessage(value: unknown, path: string, state: SnapshotValidationState): asserts value is Message {
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

export function validateMessageSource(value: unknown, path: string): void {
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

export function validateContentBlock(
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
    case 'document':
      validateDocumentSource(value.source, `${path}.source`)
      for (const field of ['filename', 'title', 'context'] as const) {
        if (value[field] !== undefined && typeof value[field] !== 'string') {
          throw new TypeError(`${path}.${field} must be a string`)
        }
      }
      if (value.citations !== undefined && typeof value.citations !== 'boolean') {
        throw new TypeError(`${path}.citations must be a boolean`)
      }
      if (value.pages !== undefined) {
        if (!Number.isSafeInteger(value.pages) || (value.pages as number) <= 0) {
          throw new TypeError(`${path}.pages must be a positive integer`)
        }
      }
      return
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

export function validateContentArray(
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

export function validateTextAnnotation(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const type = nonEmptyString(value.type, `${path}.type`)
  if (type !== 'url-citation') return
  nonEmptyString(value.url, `${path}.url`)
  if (value.title !== undefined && typeof value.title !== 'string') throw new TypeError(`${path}.title must be a string`)
  for (const field of ['startIndex', 'endIndex'] as const) {
    if (value[field] !== undefined) nonNegativeInteger(value[field], `${path}.${field}`)
  }
}

export function validateImageSource(value: unknown, path: string): void {
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

export function validateDocumentSource(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const kind = nonEmptyString(value.kind, `${path}.kind`)
  if (kind === 'base64') {
    if (String(value.mediaType) !== 'application/pdf') throw new TypeError(`${path}.mediaType is invalid`)
    if (typeof value.data !== 'string') throw new TypeError(`${path}.data must be a string`)
  } else if (kind === 'url') {
    nonEmptyString(value.url, `${path}.url`)
  } else if (kind === 'file') {
    nonEmptyString(value.fileId, `${path}.fileId`)
  } else {
    throw new TypeError(`${path}.kind is invalid`)
  }
}

export function validateToolResultMessage(message: Message, callId: string, path: string): void {
  if (message.source.kind !== 'tool' || message.source.callId !== callId) {
    throw new TypeError(`${path}.source.callId must match its tool-result event`)
  }
  if (message.role !== 'user' || message.content.length !== 1
    || message.content[0]?.type !== 'tool-result'
    || message.content[0].toolCallId !== callId) {
    throw new TypeError(`${path} must carry exactly one matching tool-result block`)
  }
}

export function validateToolExecutionResult(value: unknown, path: string): void {
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

export function validateDetachedContent(value: unknown, path: string): void {
  const state: SnapshotValidationState = {
    messageIds: new Set(), toolCallIds: new Set(), nativeToolIds: new Set(), toolCallEventIds: new Set(),
    compactions: new Map(), visibleMessageSeqs: new Set(),
  }
  validateContentArray(value, path, state, new Set(), 0)
}

export function validateUsage(value: unknown, path: string): void {
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

export function validateSeqTargets(value: unknown, nextSeq: number, path: string): asserts value is readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    throw new TypeError(`${path} must contain unique earlier sequence numbers`)
  }
  if (value.some(seq => !Number.isInteger(seq) || seq < 1 || seq >= nextSeq)) {
    throw new TypeError(`${path} must contain unique earlier sequence numbers`)
  }
}

export function updateVisibleMessages(entry: HistoryEntry, visible: Set<number>): void {
  if (entry.surfaceOp !== 'append') {
    const operation = entry.surfaceOp
    const targets = operation.targets === undefined
      ? [...visible].filter(seq => seq >= operation.from && seq <= operation.to)
      : [...operation.targets]
    for (const target of targets) visible.delete(target)
  }
  if (messageOfHistoryEvent(entry.event)) visible.add(entry.seq)
}

export function messageOfHistoryEvent(event: HistoryEvent): boolean {
  return event.kind === 'user' || event.kind === 'assistant' || event.kind === 'tool-result'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${path} must be a non-empty string`)
  return value
}

export function positiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError(`${path} must be a positive integer`)
}

export function nonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${path} must be a non-negative integer`)
}

export function validateIsoTimestamp(value: unknown, path: string): void {
  const timestamp = nonEmptyString(value, path)
  const date = new Date(timestamp)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== timestamp) {
    throw new TypeError(`${path} must be an ISO timestamp`)
  }
}

export function validateSurfaceOp(
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
