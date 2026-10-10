import type { TurnState } from './state.ts'
import type { TurnOutcome } from '../types.ts'
import { runWorkSteps } from './work-step.ts'
import { openFinalizeWindow } from './finalize-window.ts'
import { preserveFinalizedAnswer } from './finalized-answer.ts'
import { buildTurnOutcome, continueAfterTurnHook, turnOutcomeStatus } from './outcome.ts'
import { emitTurnSpanStart, appendTurnInterruption } from './lifecycle-events.ts'
import { now, errorCodeOf, messageOf } from './common.ts'
import { ensureTerminalAnswer, hasUnansweredUserInput } from './terminal-answer.ts'

function beginFinalizeWindow(state: TurnState) {
  const window = openFinalizeWindow({ ...state,
    finalizeSteps: state.bounds.finalizeSteps, workStep: state.workSteps() })
  if (window === undefined) return false
  state.finalizePromptSeq = window.promptSeq
  state.finalizeOrigin = window.origin
  state.finalizeReason = window.budget
  state.forcedText = state.text
  state.forcedMessage = window.message
  state.finalizeUntil = window.until
  state.reason = undefined
  return true
}

async function finalizedOutcome(state: TurnState) {
  state.reason ??= state.signal.aborted
    ? { kind: 'aborted' }
    : { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: false }
  if (state.finalizeOrigin !== undefined) {
    const finalized = await preserveFinalizedAnswer({ ...state,
      reason: state.reason, finalizeOrigin: state.finalizeOrigin })
    state.text = finalized.text
    state.reason = finalized.reason
  }
  await ensureTerminalAnswer(state)
  return buildTurnOutcome({ ...state, reason: state.reason })
}

async function runLifecycle(state: TurnState): Promise<TurnOutcome> {
  while (true) {
    await runWorkSteps(state)
    if (beginFinalizeWindow(state)) continue
    const candidate = await finalizedOutcome(state)
    const canContinue = candidate.reason.kind === 'completed'
      && state.workSteps() < state.maxSteps && state.admissionStop() === undefined
    if (await continueAfterTurnHook(state.options, state.signal, candidate, canContinue)) {
      state.reason = undefined
      continue
    }
    // A hook may accept steering after the first terminal check. Refused
    // continuation must still seal that input with an honest terminal answer.
    if (!canContinue && hasUnansweredUserInput(state.options.history)) {
      await ensureTerminalAnswer(state)
      return buildTurnOutcome({ ...state, reason: state.reason! })
    }
    return candidate
  }
}

async function finishTurn(state: TurnState, outcome: TurnOutcome) {
  appendTurnInterruption(state.options, outcome)
  await state.emit({
    type: 'span-end', trace: state.root, at: now(), status: turnOutcomeStatus(outcome),
    output: { reason: outcome.reason, text: state.text },
    ...outcome.usage === undefined ? {} : { usage: outcome.usage },
    ...outcome.reason.kind === 'error' ? { error: { type: 'ModelError', message: outcome.reason.failure.message,
      code: outcome.reason.failure.code } } : {},
  })
  state.rootEnded = true
  if (state.turnOperationId !== undefined) {
    state.options.accounting?.endOperation(state.turnOperationId, turnOutcomeStatus(outcome), {
      data: { reason: outcome.reason.kind, steps: state.steps, toolCalls: state.toolCalls },
    })
    state.turnOperationEnded = true
  }
  await state.emit({ type: 'turn-end', outcome, trace: state.root })
}

export async function reportTurnFailure(state: TurnState, error: unknown) {
  const code = errorCodeOf(error)
  if (state.rootStarted && !state.rootEnded) {
    await state.emit({
      type: 'span-end', trace: state.root, at: now(), status: state.signal.aborted ? 'aborted' : 'error',
      error: { type: error instanceof Error ? error.name : 'RuntimeError', message: messageOf(error),
        ...code === undefined ? {} : { code } },
    }).catch(() => undefined)
  }
  if (state.turnOperationId !== undefined && !state.turnOperationEnded) {
    state.options.accounting?.endOperation(state.turnOperationId, state.signal.aborted ? 'aborted' : 'error', { error })
    state.turnOperationEnded = true
  }
}

export async function executeTurn(state: TurnState) {
  await emitTurnSpanStart(state.options, state.emit, state.root, state.startedAt)
  state.rootStarted = true
  await state.emit({ type: 'turn-start', turn: state.turn, trace: state.root })
  const outcome = await runLifecycle(state)
  await finishTurn(state, outcome)
}

export async function recoverTurnFailure(state: TurnState, error: unknown): Promise<void> {
  if (state.options.hooks?.onTerminalRecovery === undefined || state.signal.aborted || state.rootEnded
    || errorCodeOf(error) === 'TOOL_ABORTED') throw error
  state.reason = { kind: 'error', failure: { code: errorCodeOf(error) ?? 'TURN_RUNTIME_ERROR',
    message: messageOf(error) } }
  await ensureTerminalAnswer(state)
  await finishTurn(state, buildTurnOutcome({ ...state, reason: state.reason }))
}
