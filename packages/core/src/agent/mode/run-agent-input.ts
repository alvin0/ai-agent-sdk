import { AGENT_CONTROL_TOOLS } from './control-tools.ts'
import type { JsonObject } from '../../primitives/index.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import type { RunTurnOptions } from '../loop/run-turn.ts'
import { type AgentRunEvent, type AgentMode, type DeepState } from './run-agent.ts'
import type { UserInputBroker, UserInputDecision, UserInputQuestion, UserInputRequest } from './user-input.ts'
import { parseUserInput, requestUserInputSchema, validateUserResponse } from './run-agent-support.ts'

type UserInputToolOptions = {
  mode: Exclude<AgentMode, 'basic'>
  broker: UserInputBroker
  state: DeepState
  emit: (event: AgentRunEvent) => Promise<void>
  waitMs: number
  accounting?: RunTurnOptions['accounting']
}

type UserInputContext = {
  callId: UserInputRequest["callId"]; turn: number; step: number; signal: AbortSignal; concludeTurn: () => void
}

async function waitForInput(
  pending: Promise<UserInputDecision>, unanswered: AbortSignal, signal: AbortSignal,
): Promise<UserInputDecision> {
  return new Promise<UserInputDecision>((resolve, reject) => {
    const cleanup = (): void => {
      unanswered.removeEventListener('abort', onEnd)
      signal.removeEventListener('abort', onEnd)
    }
    const onEnd = (): void => { cleanup(); resolve('abort') }
    if (unanswered.aborted || signal.aborted) { onEnd(); return }
    unanswered.addEventListener('abort', onEnd, { once: true })
    signal.addEventListener('abort', onEnd, { once: true })
    void pending.then(
      response => { cleanup(); resolve(response) },
      error => { cleanup(); reject(error) },
    )
  })
}

type FinishInputOptions = {
  response: UserInputDecision; questions: readonly UserInputQuestion[]; waitMs: number
  unanswered: AbortSignal; ctx: UserInputContext; state: DeepState
  operation: string | undefined; accounting: RunTurnOptions['accounting']
}

function timedOutInputResponse(
  waitMs: number, operation: string | undefined, accounting: RunTurnOptions['accounting'],
): JsonObject {
  if (operation !== undefined) accounting?.endOperation(operation, 'aborted')
  return { answered: false, reason: 'The user did not answer within ' + Math.round(waitMs / 1000)
    + ' seconds. Continue without their answer: state the assumption you make for each open question, '
    + 'and do not ask the same questions again in this run.' }
}

function abortedInputResponse(
  ctx: UserInputContext, state: DeepState, operation: string | undefined,
  accounting: RunTurnOptions['accounting'],
): JsonObject {
  state.userAborted = true
  ctx.concludeTurn()
  if (operation !== undefined) accounting?.endOperation(operation, 'aborted')
  return { aborted: true }
}

function finishInputResponse(options: FinishInputOptions): JsonObject {
  const { response, questions, waitMs, unanswered, ctx, state, operation, accounting } = options
  if (response === 'abort' && unanswered.aborted && !ctx.signal.aborted) {
    return timedOutInputResponse(waitMs, operation, accounting)
  }
  if (response === 'abort') return abortedInputResponse(ctx, state, operation, accounting)
  state.draftAnswer = undefined
  state.draftSeq = undefined
  state.completion = undefined
  if (operation !== undefined) accounting?.endOperation(operation, 'success')
  return validateUserResponse(response, questions) as unknown as JsonObject
}

export function userInputTool(
  options: UserInputToolOptions,
): ToolDefinition<{ readonly questions: readonly UserInputQuestion[] }> {
  const { mode, broker, state, emit, waitMs, accounting } = options
  return defineTool({
    name: AGENT_CONTROL_TOOLS.requestUserInput,
    // Asking the user is how a blocked run gets unblocked; a spent budget must
    // not be the reason the question is never asked.
    budgetExempt: true,
    // The wait is bounded below by `waitMs`, not by the turn's tool limit.
    awaitsPerson: true,
    description: mode === 'deep-human-in-loop'
      ? 'Ask the user one to three short questions when a material choice or missing fact requires human input, '
        + 'then wait for the response. Provide 2-3 mutually exclusive suggestions; '
        + 'free-form input is added by the client.'
      : 'Ask the user one to three short clarification questions only when blocked, then wait for the response. '
        + 'Provide suggested choices; free-form input is added by the client.',
    parameters: requestUserInputSchema(),
    parse: parseUserInput,
    execute: async ({ questions }, ctx: UserInputContext) => {
      const operation = accounting?.startOperation('user-input', {
        toolCallId: ctx.callId,
        data: { questionCount: questions.length },
      })
      const request: UserInputRequest = {
        requestId: ctx.callId, callId: ctx.callId, turn: ctx.turn, step: ctx.step,
        questions, isBlocking: true,
      }
      // Start the broker first: an event consumer may resolve synchronously, and
      // the waiter must already exist when the request event becomes visible.
      const unanswered = AbortSignal.timeout(waitMs)
      try {
        const pending = broker.request(request, AbortSignal.any([ctx.signal, unanswered]))
        // Observe the broker immediately, including rejection while publication
        // is backpressured or after the question's timeout has already won.
        void pending.catch(() => undefined)
        await emit({ type: 'user-input-request', request })
        // The wait limit holds even for a broker that ignores the signal: an
        // answer arriving after it, or never, cannot keep the run waiting,
        // since `awaitsPerson` leaves no scheduler deadline above it.
        const response = await waitForInput(pending, unanswered, ctx.signal)
        await emit({ type: 'user-input-response', request, response })
        const result = finishInputResponse({
          response, questions, waitMs, unanswered, ctx, state, operation, accounting,
        })
        return result
      } catch (error) {
        if (ctx.signal.aborted) await emit({ type: 'user-input-response', request, response: 'abort' })
        if (operation !== undefined) accounting?.endOperation(
          operation,
          ctx.signal.aborted ? 'aborted' : 'error',
          { error },
        )
        throw error
      }
    },
  })
}
