/** High-level agent modes built on the provider-neutral bounded tool loop. */

import { type Message } from '../../message/index.ts'
import type { CallConfig } from '../../contract/index.ts'
import { detachedFrozen } from '../../primitives/index.ts'
import { runTurn, type RunTurnOptions } from '../loop/run-turn.ts'
import { AwaitedEventQueue } from '../loop/queue.ts'
import { UNCHANGED_ANSWER_MARKER } from '../loop/control-text.ts'
import type { AgentEvent, TurnBounds, TurnHooks, TurnOutcome } from '../loop/types.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { readSpillTool } from '../tool/output-budget.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import { waitForSettlement } from '../../async/index.ts'
import type {
  UserInputBroker, UserInputRequest, UserInputResponse,
} from './user-input.ts'
import {
  combineTools, completionTool, invalidateDraftAfterSteering, isMarkerPrefix,
  keptAnswerMessage, keptAnswerOutcome, positiveFinite, restoreKeptAnswer,
  taskChangedSince,
} from './run-agent-support.ts'

export { AGENT_CONTROL_TOOLS } from './control-tools.ts'

/**
 * What the model replies with, after an accepted self-check, when the answer
 * it already gave the user earlier in the run still stands.
 *
 * Deep modes gate on an accepted `submit_result`, so a model that answered
 * before checking is asked to check, then told to "deliver the answer"
 * again — even when the check found nothing to add. Without this marker that
 * second pass either pads an already-adequate answer or, worse, quietly
 * changes it while claiming to only be confirming it. `driveAgent` treats a
 * reply that is exactly this marker as "no change": the run's `text` (and,
 * where the earlier answer is still the history's current surface, the
 * transcript) keep the answer already given instead of this marker.
 */
export { UNCHANGED_ANSWER_MARKER }

/** Default high-level runtime requested by this SDK; `runTurn` remains provider-neutral. */
export type AgentMode = 'basic' | 'deep' | 'deep-human-in-loop'

interface AgentRunCommon extends Omit<RunTurnOptions,
  'bounds' | 'commentary' | 'config' | 'hooks' | 'system' | 'tools'> {
  /** Explicit low-level model binding; composition users can select a configured provider default instead. */
  readonly config: CallConfig
  readonly tools?: ToolCatalog
  readonly system?: string
  /** Maximum normal model iterations. A forced final answer may use one extra request. */
  /** Model steps per prompt; 'auto' keeps completion and resource guards only. */
  readonly maxTurns?: number | 'auto'
  readonly bounds?: Omit<Partial<TurnBounds>, 'maxSteps'>
  readonly commentary?: RunTurnOptions['commentary']
  readonly hooks?: TurnHooks
}

export interface BasicAgentOptions extends AgentRunCommon {
  readonly mode?: 'basic'
}

export interface DeepAgentOptions extends AgentRunCommon {
  readonly mode: 'deep'
  /** Optional in deep mode: expose a blocking clarification tool when configured. */
  readonly userInput?: UserInputBroker
  /** How long a question waits for its answer; see {@link HumanInLoopAgentOptions.userInputTimeoutMs}. */
  readonly userInputTimeoutMs?: number
}

export interface HumanInLoopAgentOptions extends AgentRunCommon {
  readonly mode: 'deep-human-in-loop'
  /** Required in HIL mode: the tool call remains parked until this broker answers. */
  readonly userInput: UserInputBroker
  /**
   * How long a question waits for its answer, independent of
   * `bounds.maxToolDurationMs` (which defaults it). When it passes, the model
   * is told the person did not answer and continues without the answer; it is
   * not treated as the person dismissing the question.
   */
  readonly userInputTimeoutMs?: number
}

export type RunAgentOptions = BasicAgentOptions | DeepAgentOptions | HumanInLoopAgentOptions

export interface CompletionSubmission {
  readonly summary: string
  readonly evidence: readonly string[]
}

export interface AgentRunOutcome extends TurnOutcome {
  readonly mode: AgentMode
  /** Deep modes are complete only after the model explicitly submits its self-check. */
  readonly completed: boolean
  readonly completion?: CompletionSubmission
}

interface AgentModeStartEvent {
  readonly type: 'agent-start'
  readonly mode: AgentMode
  readonly maxTurns: number | 'auto'
}
interface UserInputRequestEvent {
  readonly type: 'user-input-request'
  readonly request: UserInputRequest
}
interface UserInputResponseEvent {
  readonly type: 'user-input-response'
  readonly request: UserInputRequest
  readonly response: UserInputResponse | 'abort'
}
interface AgentModeEndEvent {
  readonly type: 'agent-end'
  readonly outcome: AgentRunOutcome
}

interface AssistantReplacementEvent {
  readonly type: 'assistant-replacement'
  readonly fromMessageId: Message['id']
  readonly message: Message
}

export type AgentRunEvent = AgentEvent | AssistantReplacementEvent
  | AgentModeStartEvent
  | UserInputRequestEvent
  | UserInputResponseEvent
  | AgentModeEndEvent

export interface DeepState {
  completion: CompletionSubmission | undefined
  completionSeq?: number
  userAborted: boolean
  /** Answers without intervening substantive tool work or an accepted check. */
  unverifiedAnswers: number
  completionInvalidated: 'tool' | 'input' | undefined
  /**
   * The text of the last answer the self-check gate held back, so an accept
   * that finds nothing to change can point back to it instead of asking the
   * model to retype it. Tool work between that answer and the accept does not
   * clear it: nothing has been shown to the user since, so it is still the
   * right thing to compare against.
   */
  draftAnswer: string | undefined
  /**
   * History length when {@link draftAnswer} was recorded. A message from the
   * user or another agent after that point changes the request the draft
   * answered, so the draft can no longer stand on its own.
   */
  draftSeq: number | undefined
  /**
   * A bare marker with no draft to keep has been answered with a request for
   * the answer itself. Once is enough: a model that repeats it gets an empty,
   * incomplete result rather than another paid round.
   */
  orphanMarkerNudged: boolean
  /**
   * The confirming round was cut off (aborted, errored, out of tokens) while
   * its text was still only the start of the marker. That text can only be
   * the marker arriving; it is dropped rather than shown in place of the draft.
   */
  markerCut: boolean
  /** The current reply was confirmed to contain only the control marker. */
  markerReply: boolean
  /** Canonical answer of a control reply, retained if a later round has no message. */
  resolvedMarkerAnswer?: string
}

const DEFAULT_MAX_TURNS = 16

/** Changing the wording of an unsubmitted conclusion is not execution progress. */
export const UNVERIFIED_ANSWER_LIMIT = 3

/**
 * Run an agent in basic, self-checking deep, or deep human-in-loop mode.
 *
 * The low-level `turn-*`, trace, commentary, reasoning-summary, and tool events are
 * forwarded unchanged. High-level `agent-*` and `user-input-*` events make GUI
 * orchestration possible without parsing assistant prose.
 */
export function runAgent(options: RunAgentOptions): AsyncIterable<AgentRunEvent> {
  return {
    async * [Symbol.asyncIterator]() {
      const queue = new AwaitedEventQueue<AgentRunEvent>()
      const consumer = new AbortController()
      const teardownTimeoutMs = positiveFinite(options.teardownTimeoutMs ?? 30_000, 'teardownTimeoutMs')
      const signal = options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal])
      let tail = Promise.resolve()
      const emit = (event: AgentRunEvent): Promise<void> => {
        const next = tail.then(() => queue.push(detachedFrozen(event)))
        tail = next.catch(() => undefined)
        return next
      }
      const task = driveAgent(options, signal, emit)
        .then(async () => { await tail; queue.close() }, async error => { await tail; queue.fail(error) })

      try {
        while (true) {
          const item = await queue.take()
          if (item.done) break
          yield item.value
        }
        await task
      } finally {
        consumer.abort(new Error('agent event consumer stopped'))
        queue.close()
        if (!await waitForSettlement(task, teardownTimeoutMs)) {
          const error = new Error(
            `agent producer ignored cancellation for more than ${teardownTimeoutMs}ms`,
            { cause: consumer.signal.reason },
          ) as Error & { code: string }
          error.code = 'AGENT_TEARDOWN_TIMEOUT'
          throw error
        }
      }
    },
  }
}

async function emitAgentTextDelta(
  event: Extract<AgentRunEvent, { type: 'text-delta' }>, tails: Map<number, string>,
  emitRaw: (event: AgentRunEvent) => Promise<void>,
): Promise<void> {
  const text = ((tails.get(event.index) ?? '') + event.text).replaceAll(UNCHANGED_ANSWER_MARKER, '')
  let suffix = Math.min(text.length, UNCHANGED_ANSWER_MARKER.length - 1)
  while (suffix > 0 && !UNCHANGED_ANSWER_MARKER.startsWith(text.slice(-suffix))) suffix--
  tails.set(event.index, suffix === 0 ? '' : text.slice(-suffix))
  const safe = suffix === 0 ? text : text.slice(0, -suffix)
  if (safe !== '') await emitRaw({ ...event, text: safe })
}

async function emitAgentTextEnd(
  event: Extract<AgentRunEvent, { type: 'text-end' }>, tails: Map<number, string>,
  emitRaw: (event: AgentRunEvent) => Promise<void>,
): Promise<void> {
  const tail = tails.get(event.index) ?? ''
  tails.delete(event.index)
  if (tail !== '' && !event.incomplete) await emitRaw({ ...event, type: 'text-delta', text: tail })
  await emitRaw({ ...event, text: event.text.replaceAll(UNCHANGED_ANSWER_MARKER, '') })
}

function createAgentEmitter(emitRaw: (event: AgentRunEvent) => Promise<void>): (event: AgentRunEvent) => Promise<void> {
  const textTails = new Map<number, string>()
  return async (event: AgentRunEvent): Promise<void> => {
    if (event.type === 'step-start') textTails.clear()
    if (event.type === 'text-delta') return emitAgentTextDelta(event, textTails, emitRaw)
    if (event.type === 'text-end') return emitAgentTextEnd(event, textTails, emitRaw)
    await emitRaw(event)
  }
}

import { buildAgentTurnOptions } from './run-agent-setup.ts'
import { userInputTool } from './run-agent-input.ts'
import { deepHooks } from './run-agent-hooks.ts'
type PreparedAgentRun = {
  mode: AgentMode; maxTurns: number | 'auto'; deep: boolean; tools: ToolCatalog | undefined
  state: DeepState; broker: UserInputBroker | undefined; turnOptions: RunTurnOptions
}

import { validateAgentMaxTurns, validateAgentModeValue } from './run-agent-support.ts'
function validateAgentMode(options: RunAgentOptions): {
  mode: AgentMode; maxTurns: number | 'auto'; broker: UserInputBroker | undefined
} {
  const mode: AgentMode = options.mode ?? 'basic'
  validateAgentModeValue(mode)
  const configuredUserInput = 'userInput' in options ? options.userInput : undefined
  if (mode === 'deep-human-in-loop'
    && (configuredUserInput === undefined || typeof configuredUserInput.request !== 'function')) {
    throw new TypeError('deep-human-in-loop mode requires a UserInputBroker')
  }
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  validateAgentMaxTurns(maxTurns)
  const broker = mode === 'deep' || mode === 'deep-human-in-loop' ? configuredUserInput : undefined
  return { mode, maxTurns, broker }
}

function createAgentInternalTools(setup: {
  options: RunAgentOptions; mode: AgentMode; state: DeepState; broker: UserInputBroker | undefined
  emit: (event: AgentRunEvent) => Promise<void>
}): ToolDefinition[] {
  const { options, mode, state, broker, emit } = setup
  const internalTools: ToolDefinition[] = []
  if (options.spillStore !== undefined) internalTools.push(readSpillTool(options.spillStore) as ToolDefinition)
  if (mode !== 'basic') internalTools.push(completionTool(state, options.history, options.tools))
  if (broker !== undefined) {
    const waitMs = positiveFinite(
      ('userInputTimeoutMs' in options ? options.userInputTimeoutMs : undefined)
        ?? options.bounds?.maxToolDurationMs ?? 10 * 60_000,
      'userInputTimeoutMs',
    )
    internalTools.push(userInputTool({
      mode: mode as Exclude<AgentMode, 'basic'>, broker, state, emit, waitMs,
      accounting: options.accounting,
    }))
  }
  return internalTools
}

async function prepareAgentRun(
  options: RunAgentOptions, signal: AbortSignal, emit: (event: AgentRunEvent) => Promise<void>,
): Promise<PreparedAgentRun> {
  const { mode, maxTurns, broker } = validateAgentMode(options)
  await emit({ type: 'agent-start', mode, maxTurns })
  const state: DeepState = {
    completion: undefined, userAborted: false, unverifiedAnswers: 0, completionInvalidated: undefined,
    draftAnswer: undefined, draftSeq: undefined, orphanMarkerNudged: false, markerCut: false, markerReply: false,
  }
  const deep = mode !== 'basic'
  const internalTools = createAgentInternalTools({ options, mode, state, broker, emit })
  const tools = internalTools.length === 0 ? options.tools : combineTools(options.tools, internalTools)
  const hooks = deep ? deepHooks(options.hooks, options.history, state) : options.hooks
  const turnOptions = buildAgentTurnOptions({ options, signal, mode, deep, broker, tools, hooks, state, maxTurns })
  return { mode, maxTurns, deep, tools, state, broker, turnOptions }
}

import { type AnswerEventState, createAnswerEventHandler } from './run-agent-answer.ts'
import { type AgentTurnProgress, processAgentTurnProgress } from './run-agent-progress.ts'
type AgentTurnLoopContext = {
  options: RunAgentOptions; state: DeepState; tools: ToolCatalog | undefined
  turnOptions: RunTurnOptions; answerState: AnswerEventState
  emitAnswerEvent: (event: AgentRunEvent) => Promise<void>
}

async function processAgentTurnEnd(
  event: Extract<AgentRunEvent, { type: 'turn-end' }>, ctx: AgentTurnLoopContext,
): Promise<TurnOutcome> {
  const { options, state, answerState, emitAnswerEvent } = ctx
  if (answerState.markerCandidate && answerState.heldEvents.length > 0
    && isMarkerPrefix(answerState.candidateText)) state.markerCut = true
  const terminal = keptAnswerOutcome(event.outcome, state)
  if (terminal !== event.outcome && state.draftAnswer !== undefined && !answerState.keptRestored) {
    restoreKeptAnswer(options.history, answerState.kept?.message ?? keptAnswerMessage(terminal.text), state.markerCut)
  }
  await emitAnswerEvent({ ...event, outcome: terminal })
  return terminal
}

async function runAgentTurnLoop(ctx: AgentTurnLoopContext): Promise<{ terminal: TurnOutcome; lastRequestSeq: number }> {
  const { options, state, tools, turnOptions, answerState, emitAnswerEvent } = ctx
  let terminal: TurnOutcome | undefined
  const progress: AgentTurnProgress = { options, state, tools, stepCalls: [], completionCandidate: undefined }
  for await (const event of runTurn(turnOptions)) {
    processAgentTurnProgress(event, progress)
    if (event.type === 'turn-end') {
      terminal = await processAgentTurnEnd(event, ctx)
      continue
    }
  await emitAnswerEvent(event)
}
if (terminal === undefined) throw new Error('runTurn ended without a turn-end event')
  invalidateDraftAfterSteering(state, options.history)
  return { terminal, lastRequestSeq: answerState.lastRequestSeq }
}

import { isAgentCompletionEligible } from './run-agent-support.ts'
async function driveAgent(
  options: RunAgentOptions,
  signal: AbortSignal,
  emitRaw: (event: AgentRunEvent) => Promise<void>,
): Promise<void> {
  const emit = createAgentEmitter(emitRaw)
  const prepared = await prepareAgentRun(options, signal, emit)
  const { mode, deep, tools, state, turnOptions } = prepared
  const answerState: AnswerEventState = {
    options, deep, deepState: state, emit, heldEvents: [], kept: undefined, sanitized: undefined,
    orphan: undefined, keptRestored: false, lastRequestSeq: options.history.entries().length,
    draftMessageId: undefined, keptTextEmitted: false, markerCandidate: false, candidateText: '',
    candidateBlocks: new Map(), flushHeld: async () => undefined, dropHeldText: async () => undefined,
  }
  answerState.flushHeld = async () => {
    const pending = answerState.heldEvents; answerState.heldEvents = []
    for (const event of pending) await emit(event)
  }
  answerState.dropHeldText = async () => {
    const pending = answerState.heldEvents; answerState.heldEvents = []
    for (const held of pending) if (held.type !== 'text-delta' && held.type !== 'text-end') await emit(held)
  }
  const emitAnswerEvent = createAnswerEventHandler(answerState)
  const turnResult = await runAgentTurnLoop({ options, state, tools, turnOptions, answerState, emitAnswerEvent })
  const { terminal } = turnResult
  const completionEligible = isAgentCompletionEligible(mode, terminal, state)
  const completed = completionEligible && !taskChangedSince(options.history, answerState.lastRequestSeq)
  const outcome: AgentRunOutcome = {
    ...terminal,
    mode,
    completed,
    ...state.completion === undefined ? {} : { completion: state.completion },
  }
  await emit({ type: 'agent-end', outcome })
}
