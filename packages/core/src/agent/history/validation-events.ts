import type { HistoryEvent } from './types.ts'
import { validateMessage, validateToolResultMessage, validateToolExecutionResult } from './validation-content.ts'
import { nonEmptyString, positiveInteger, nonNegativeInteger, validateIsoTimestamp,
  validateSeqTargets, validateUsage, type SnapshotValidationState } from './validation-primitives.ts'

export function validateHistoryEvent(
  event: HistoryEvent,
  seq: number,
  state: SnapshotValidationState,
): void {
  const path = `history entry ${seq} ${event.kind}`
  switch (event.kind) {
    case 'user': return validateUserEvent(event, path, state)
    case 'assistant': return validateAssistantEvent(event, path, state)
    case 'tool-call': return validateToolCallEvent(event, path, state)
    case 'tool-result': return validateToolResultEvent(event, path, state)
    case 'compaction-start': return validateCompactionStartEvent(event, path, state)
    case 'compaction-prune': return validateCompactionPruneEvent(event, path, seq)
    case 'compaction-summary': return validateCompactionSummaryEvent(event, path, seq, state)
    case 'compaction-end': return validateCompactionEndEvent(event, path, state)
  }
}

function validateUserEvent(
  event: Extract<HistoryEvent, { kind: 'user' }>, path: string, state: SnapshotValidationState,
): void {
  validateMessage(event.message, `${path}.message`, state)
}

function validateAssistantEvent(
  event: Extract<HistoryEvent, { kind: 'assistant' }>, path: string, state: SnapshotValidationState,
): void {
  validateMessage(event.message, `${path}.message`, state)
  if (event.interrupted !== undefined && event.interrupted !== true) {
    throw new TypeError(`${path}.interrupted must be true when present`)
  }
  if (event.usage !== undefined) validateUsage(event.usage, `${path}.usage`)
}

function validateToolCallEvent(
  event: Extract<HistoryEvent, { kind: 'tool-call' }>, path: string, state: SnapshotValidationState,
): void {
  const callId = nonEmptyString(event.callId, `${path}.callId`)
  if (state.toolCallEventIds.has(callId)) throw new TypeError(`duplicate tool-call event id '${callId}'`)
  state.toolCallEventIds.add(callId)
  nonEmptyString(event.name, `${path}.name`)
  if (typeof event.rawArguments !== 'string') throw new TypeError(`${path}.rawArguments must be a string`)
}

function validateToolResultEvent(
  event: Extract<HistoryEvent, { kind: 'tool-result' }>, path: string, state: SnapshotValidationState,
): void {
  const callId = nonEmptyString(event.callId, `${path}.callId`)
  validateMessage(event.message, `${path}.message`, state)
  validateToolResultMessage(event.message, callId, `${path}.message`)
  validateToolExecutionResult(event.result, `${path}.result`)
}

function validateCompactionStartEvent(
  event: Extract<HistoryEvent, { kind: 'compaction-start' }>, path: string, state: SnapshotValidationState,
): void {
  const id = nonEmptyString(event.compactionId, `${path}.compactionId`)
  if (state.compactions.has(id)) throw new TypeError(`duplicate compaction id '${id}'`)
  if (!['pressure', 'context-overflow', 'manual'].includes(event.trigger)) {
    throw new TypeError(`${path}.trigger is invalid`)
  }
  validateIsoTimestamp(event.at, `${path}.at`)
  state.compactions.set(id, { summary: false, end: false })
}

function validateCompactionPruneEvent(
  event: Extract<HistoryEvent, { kind: 'compaction-prune' }>, path: string, seq: number,
): void {
  nonEmptyString(event.callId, `${path}.callId`)
  positiveInteger(event.originalSeq, `${path}.originalSeq`)
  if (event.originalSeq >= seq) throw new TypeError(`${path}.originalSeq must reference an earlier entry`)
  nonNegativeInteger(event.charsBefore, `${path}.charsBefore`)
  nonNegativeInteger(event.charsAfter, `${path}.charsAfter`)
  if (event.charsAfter > event.charsBefore) throw new TypeError(`${path}.charsAfter cannot exceed charsBefore`)
}

function validateCompactionSummaryEvent(
  event: Extract<HistoryEvent, { kind: 'compaction-summary' }>, path: string,
  seq: number, state: SnapshotValidationState,
): void {
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
}

function validateCompactionEndEvent(
  event: Extract<HistoryEvent, { kind: 'compaction-end' }>, path: string, state: SnapshotValidationState,
): void {
  const id = nonEmptyString(event.compactionId, `${path}.compactionId`)
  const lifecycle = state.compactions.get(id)
  if (lifecycle === undefined) throw new TypeError(`${path} has no matching compaction-start`)
  if (lifecycle.end) throw new TypeError(`duplicate compaction end for '${id}'`)
  if (!['completed', 'failed'].includes(event.status)) throw new TypeError(`${path}.status is invalid`)
  validateIsoTimestamp(event.at, `${path}.at`)
  validateCompactionEndMetrics(event, path)
  validateCompactionEndOutcome(event, path, lifecycle.summary)
  lifecycle.end = true
}

type CompactionEndEvent = Extract<HistoryEvent, { kind: 'compaction-end' }>

function validateCompactionEndMetrics(event: CompactionEndEvent, path: string): void {
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
}

function validateCompactionEndOutcome(event: CompactionEndEvent, path: string, hasSummary: boolean): void {
  if (event.status === 'completed') {
    if (!hasSummary) throw new TypeError(`${path} completed without a compaction-summary`)
    if (event.error !== undefined) throw new TypeError(`${path}.error is only valid for failed compaction`)
  } else {
    nonEmptyString(event.error, `${path}.error`)
    if (event.backoffReason !== undefined || event.thresholdTokens !== undefined
      || event.estimatedNonCompactableTokens !== undefined) {
      throw new TypeError(`${path} failed compaction cannot carry completed metrics`)
    }
  }
}
