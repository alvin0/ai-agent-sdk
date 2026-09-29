/** High-level agent modes built on the provider-neutral bounded tool loop. */

import { createMessage, createUserMessage, type Message } from '../../message/index.ts'
import type { CallConfig } from '../../contract/index.ts'
import type { JsonObject } from '../../primitives/index.ts'
import { detachedFrozen } from '../../primitives/index.ts'
import { runTurn, type RunTurnOptions } from '../loop/run-turn.ts'
import { AwaitedEventQueue } from '../loop/queue.ts'
import type { AgentEvent, TurnBounds, TurnHooks, TurnOutcome } from '../loop/types.ts'
import { defineTool, type ToolDefinition, type ToolExecutionMode } from '../tool/definition.ts'
import { readSpillTool } from '../tool/output-budget.ts'
import type { ToolInterceptor } from '../tool/pipeline.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import { waitForSettlement } from '../../async/index.ts'
import type {
  UserInputBroker, UserInputQuestion, UserInputRequest, UserInputResponse,
} from './user-input.ts'

export const AGENT_CONTROL_TOOLS = Object.freeze({
  complete: 'submit_result',
  requestUserInput: 'request_user_input',
} as const)

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
export const UNCHANGED_ANSWER_MARKER = '<<deep-mode:answer-unchanged>>'

/** Default high-level runtime requested by this SDK; `runTurn` remains provider-neutral. */
export type AgentMode = 'basic' | 'deep' | 'deep-human-in-loop'

interface AgentRunCommon extends Omit<RunTurnOptions, 'bounds' | 'commentary' | 'config' | 'hooks' | 'system' | 'tools'> {
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
}

export interface HumanInLoopAgentOptions extends AgentRunCommon {
  readonly mode: 'deep-human-in-loop'
  /** Required in HIL mode: the tool call remains parked until this broker answers. */
  readonly userInput: UserInputBroker
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

export type AgentRunEvent = AgentEvent
  | AgentModeStartEvent
  | UserInputRequestEvent
  | UserInputResponseEvent
  | AgentModeEndEvent

interface DeepState {
  completion: CompletionSubmission | undefined
  userAborted: boolean
  /** Answers without intervening substantive tool work or an accepted check. */
  unverifiedAnswers: number
  completionInvalidated: boolean
  /**
   * The text of the last answer the self-check gate held back, so an accept
   * that finds nothing to change can point back to it instead of asking the
   * model to retype it. Tool work between that answer and the accept does not
   * clear it: nothing has been shown to the user since, so it is still the
   * right thing to compare against.
   */
  draftAnswer: string | undefined
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
}

const DEFAULT_MAX_TURNS = 16

/** Changing the wording of an unsubmitted conclusion is not execution progress. */
const UNVERIFIED_ANSWER_LIMIT = 3

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

async function driveAgent(
  options: RunAgentOptions,
  signal: AbortSignal,
  emit: (event: AgentRunEvent) => Promise<void>,
): Promise<void> {
  const mode: AgentMode = options.mode ?? 'basic'
  if (!['basic', 'deep', 'deep-human-in-loop'].includes(mode)) {
    throw new RangeError(`unsupported agent mode "${String(mode)}"`)
  }
  const configuredUserInput = 'userInput' in options ? options.userInput : undefined
  if (mode === 'deep-human-in-loop'
    && (configuredUserInput === undefined || typeof configuredUserInput.request !== 'function')) {
    throw new TypeError('deep-human-in-loop mode requires a UserInputBroker')
  }
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  if (maxTurns !== 'auto' && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    throw new RangeError("maxTurns must be a positive safe integer or 'auto'")
  }
  await emit({ type: 'agent-start', mode, maxTurns })

  const state: DeepState = {
    completion: undefined, userAborted: false, unverifiedAnswers: 0, completionInvalidated: false,
    draftAnswer: undefined, orphanMarkerNudged: false, markerCut: false, markerReply: false,
  }
  const deep = mode !== 'basic'
  const broker = options.mode === 'deep' || options.mode === 'deep-human-in-loop'
    ? configuredUserInput
    : undefined
  const internalTools: ToolDefinition[] = []
  // Spilling without a way to read the spill back would be worse than cutting
  // the output: the model would be told the rest exists and given no way in.
  if (options.spillStore !== undefined) {
    internalTools.push(readSpillTool(options.spillStore) as ToolDefinition)
  }
  if (deep) internalTools.push(completionTool(state))
  if (broker !== undefined && mode !== 'basic') {
    internalTools.push(userInputTool(mode, broker, state, emit, options.accounting))
  }
  const tools = internalTools.length === 0 ? options.tools : combineTools(options.tools, internalTools)
  const hooks = deep ? deepHooks(options.hooks, options.history, state, maxTurns) : options.hooks
  const turnOptions: RunTurnOptions = {
    registry: options.registry,
    config: options.config,
    history: options.history,
    ...tools === undefined ? {} : { tools },
    ...options.nativeTools === undefined ? {} : { nativeTools: options.nativeTools },
    ...options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice },
    ...options.imagePolicy === undefined ? {} : { imagePolicy: options.imagePolicy },
    ...options.documentPolicy === undefined ? {} : { documentPolicy: options.documentPolicy },
    ...(options.validateOutput === undefined ? {} : { validateOutput: options.validateOutput }),
    ...options.outputFormat === undefined ? {} : { outputFormat: options.outputFormat },
    system: joinSystem(options.system, modeSystem(mode, broker !== undefined)),
    ...options.interceptors === undefined ? {} : { interceptors: shieldControlTools(options.interceptors) },
    ...options.approvals === undefined ? {} : { approvals: options.approvals },
    bounds: { ...options.bounds, maxSteps: maxTurns },
    ...hooks === undefined ? {} : { hooks },
    signal,
    ...options.logger === undefined ? {} : { logger: options.logger },
    commentary: options.commentary ?? 'auto',
    teardownTimeoutMs: options.teardownTimeoutMs ?? 30_000,
    ...options.modelTimeoutMs === undefined ? {} : { modelTimeoutMs: options.modelTimeoutMs },
    ...options.maxModelRequestBytes === undefined ? {} : { maxModelRequestBytes: options.maxModelRequestBytes },
    ...options.maxModelResponseBytes === undefined ? {} : { maxModelResponseBytes: options.maxModelResponseBytes },
    ...options.maxModelStreamEvents === undefined ? {} : { maxModelStreamEvents: options.maxModelStreamEvents },
    ...options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs },
    ...options.hookTeardownTimeoutMs === undefined ? {} : { hookTeardownTimeoutMs: options.hookTeardownTimeoutMs },
    ...options.trace === undefined ? {} : { trace: options.trace },
    ...options.accounting === undefined ? {} : { accounting: options.accounting },
    ...options.spillStore === undefined ? {} : { spillStore: options.spillStore },
    ...options.experimentalPrograms === undefined ? {} : { experimentalPrograms: options.experimentalPrograms },
    ...options.contextSections === undefined ? {} : { contextSections: options.contextSections },
  }

  let terminal: TurnOutcome | undefined
  let stepCalls: string[] = []
  let completionCandidate: CompletionSubmission | undefined
  let markerCandidate = false
  let candidateText = ''
  let heldEvents: AgentRunEvent[] = []
  // The one message that stands in for a kept marker reply: live events, the
  // terminal outcome and the history surface all carry this same identity.
  let kept: { readonly from: Message['id']; readonly message: Message } | undefined
  // A bare marker with nothing to keep: its text is not shown at all.
  let orphan: Message['id'] | undefined
  // The history surface already carries the stand-in for this round.
  let keptRestored = false
  const flushHeld = async (): Promise<void> => {
    const pending = heldEvents
    heldEvents = []
    for (const event of pending) await emit(event)
  }
  /** Release everything held except the text itself. */
  const dropHeldText = async (): Promise<void> => {
    const pending = heldEvents
    heldEvents = []
    for (const held of pending) if (held.type !== 'text-delta' && held.type !== 'text-end') await emit(held)
  }
  const emitAnswerEvent = async (event: AgentRunEvent): Promise<void> => {
    // The loop describes each block of the message it just built. For a kept
    // reply that message is the marker: describe the stand-in instead.
    if (orphan !== undefined && event.type === 'assistant-text' && event.messageId === orphan) return
    if (kept !== undefined && event.type === 'assistant-reasoning' && event.messageId === kept.from) {
      await emit({ ...event, messageId: kept.message.id })
      return
    }
    if (kept !== undefined && event.type === 'assistant-text' && event.messageId === kept.from) {
      const block = kept.message.content.find(block => block.type === 'text')
      await emit({ ...event, messageId: kept.message.id, text: block?.type === 'text' ? block.text : event.text })
      return
    }
    if (event.type === 'step-start') {
      kept = undefined
      orphan = undefined
      keptRestored = false
      state.markerCut = false
      state.markerReply = false
      await flushHeld()
      // Held after any accepted check, with or without a draft: a later run can
      // imitate an earlier accept, and the marker must not stream either way.
      markerCandidate = state.completion !== undefined
      candidateText = ''
    }
    if (markerCandidate && (event.type === 'text-delta' || event.type === 'text-end')) {
      candidateText = event.type === 'text-end' ? event.text : candidateText + event.text
      heldEvents.push(event)
      // Ordinary answers resume streaming as soon as their prefix differs.
      // Hold the control reply until its complete assistant message confirms
      // it contains no additional text or tool calls.
      if (!isMarkerPrefix(candidateText)) {
        markerCandidate = false
        await flushHeld()
      } else if (event.type === 'text-end' && event.incomplete) {
        // Cut off mid-marker: stay a candidate so the message that follows is
        // resolved as the marker it was becoming, not shown as an answer.
        state.markerCut = true
      }
      return
    }
    if (markerCandidate && event.type === 'assistant-message') {
      const content = event.message.content
      const draft = state.draftAnswer
      const only = soleText(content)
      const bare = only !== undefined
        && (only.trim() === UNCHANGED_ANSWER_MARKER || (state.markerCut && isMarkerPrefix(only)))
      markerCandidate = false
      if (bare) {
        state.markerReply = true
        kept = { from: event.message.id, message: keptAnswerMessage(draft ?? '', content) }
        // Correct the persisted surface before exposing the replacement, even
        // when there is no draft: a reload must not present the control marker.
        restoreKeptAnswer(options.history, kept.message, state.markerCut)
        keptRestored = true
        if (draft === undefined) orphan = event.message.id
        await dropHeldText()
        await emit({ ...event, message: kept.message })
        return
      }
      // Text alone cannot identify a control reply if other content accompanies it.
      state.markerCut = false
      await flushHeld()
    } else if (heldEvents.length > 0) {
      if (event.type === 'turn-end' && markerCandidate && isMarkerPrefix(candidateText)) {
        // The round ended (abort, error) before a message could confirm it.
        markerCandidate = false
        state.markerCut = true
        await dropHeldText()
      } else if (event.type === 'turn-end' || event.type === 'tool-call') {
        markerCandidate = false
        await flushHeld()
      } else {
        heldEvents.push(event)
        return
      }
    }
    await emit(event)
  }
  for await (const event of runTurn(turnOptions)) {
    if (event.type === 'step-start') {
      stepCalls = []
      completionCandidate = undefined
    } else if (event.type === 'tool-call') {
      stepCalls.push(event.call.toolName)
      // Work performed after an accepted submission invalidates that submission;
      // the new result has not yet passed the completion gate.
      if (event.call.toolName !== AGENT_CONTROL_TOOLS.complete
        && tools?.get(event.call.toolName)?.completionExempt !== true) {
        if (state.completion !== undefined) state.completionInvalidated = true
        state.completion = undefined
        state.unverifiedAnswers = 0
      }
    } else if (event.type === 'tool-result'
      && event.call.toolName === AGENT_CONTROL_TOOLS.complete
      && !event.result.isError) {
      completionCandidate = completionFromResult(event.result.value)
    } else if (event.type === 'step-end'
      && completionCandidate !== undefined
      && stepCalls.filter(name => name === AGENT_CONTROL_TOOLS.complete).length === 1
      && stepCalls.every(name => name === AGENT_CONTROL_TOOLS.complete || tools?.get(name)?.completionExempt === true)) {
      // A completion submission cannot share a batch with work whose results the
      // model had not seen when it claimed success.
      state.completion = completionCandidate
      state.completionInvalidated = false
    }
    if (event.type === 'turn-end') {
      // A round that ends while its held text is only the start of the marker was
      // cut off mid-marker; resolve that before the outcome is decided.
      if (markerCandidate && heldEvents.length > 0 && isMarkerPrefix(candidateText)) state.markerCut = true
      terminal = keptAnswerOutcome(event.outcome, state)
      // Resolve the control reply before exposing the terminal turn outcome,
      // so consumers of turn-end and agent-end receive the same answer.
      if (terminal !== event.outcome && state.draftAnswer !== undefined && !keptRestored) {
        restoreKeptAnswer(options.history, kept?.message ?? keptAnswerMessage(terminal.text), state.markerCut)
      }
      await emitAnswerEvent({ ...event, outcome: terminal })
      continue
    }
    await emitAnswerEvent(event)
  }
  if (terminal === undefined) throw new Error('runTurn ended without a turn-end event')
  const completed = mode === 'basic'
    ? terminal.reason.kind === 'completed' || terminal.reason.kind === 'concluded-by-tool'
    : state.completion !== undefined && !state.userAborted
      && (terminal.reason.kind === 'completed'
        || terminal.reason.kind === 'concluded-by-tool'
        || (terminal.reason.kind === 'budget-exhausted' && terminal.reason.forcedFinalAnswer))
      && terminal.text.trim() !== ''
  const outcome: AgentRunOutcome = {
    ...terminal,
    mode,
    completed,
    ...state.completion === undefined ? {} : { completion: state.completion },
  }
  await emit({ type: 'agent-end', outcome })
}

/**
 * The message's one text block, when text is all it says. Reasoning is not
 * something it says to the user: reasoning models attach it to a reply that is
 * otherwise only the marker, and that reply must still count as the marker.
 */
function soleText(content: readonly Message['content'][number][]): string | undefined {
  const said = content.filter(block => block.type !== 'reasoning')
  return said.length === 1 && said[0]?.type === 'text' ? said[0].text : undefined
}

/** Text that is, so far, only the beginning (or the whole) of the marker. */
function isMarkerPrefix(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length === 0 ? true : UNCHANGED_ANSWER_MARKER.startsWith(trimmed)
}

function keptAnswerOutcome(outcome: TurnOutcome, state: DeepState): TurnOutcome {
  if (state.completion === undefined || (!state.markerReply && !state.markerCut)) return outcome
  const cut = state.markerCut && outcome.text.trim() !== '' && isMarkerPrefix(outcome.text)
  if (!cut && outcome.text.trim() !== UNCHANGED_ANSWER_MARKER) return outcome
  // With no draft there is nothing the marker could mean: an empty answer, so
  // the run reports incomplete instead of presenting the marker as its answer.
  return { ...outcome, text: state.draftAnswer ?? '' }
}

/** Replace the control text while preserving the confirming round's reasoning. */
function keptAnswerMessage(draftAnswer: string, content?: Message['content']): Message {
  return createMessage({
    role: 'assistant',
    content: content === undefined
      ? [{ type: 'text', text: draftAnswer, phase: 'final-answer' }]
      : content.flatMap<Message['content'][number]>(block => block.type === 'reasoning' ? [block]
        : draftAnswer === '' ? [] : [{ type: 'text' as const, text: draftAnswer, phase: 'final-answer' as const }]),
    source: { kind: 'app', producer: 'deep-mode-kept-answer' },
  })
}

/** Supersede a bare marker on the history surface without changing the raw log. */
function restoreKeptAnswer(history: RunAgentOptions['history'], replacement: Message, cut = false): void {
  const entries = history.entries()
  let target: (typeof entries)[number] | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry?.event.kind !== 'assistant') continue
    target = entry
    break
  }
  const only = target?.event.kind === 'assistant' ? soleText(target.event.message.content) : undefined
  if (target === undefined || only === undefined) return
  if (only.trim() !== UNCHANGED_ANSWER_MARKER && !(cut && only.trim() !== '' && isMarkerPrefix(only))) return
  // Persist before emitting the replacement. Capacity and validation failures
  // must fail the run; claiming success would leave its result and replay in
  // disagreement and expose the raw marker through the session response.
  history.append(
    { kind: 'assistant', message: replacement },
    { op: 'replace', from: target.seq, to: target.seq },
  )
}

function completionTool(state: DeepState): ToolDefinition<CompletionSubmission> {
  return defineTool({
    name: AGENT_CONTROL_TOOLS.complete,
    description: 'Submit the self-check only when the user objective and constraints are fully satisfied. After acceptance, give the user the final answer.',
    // The one call that ENDS a deep run. A budget that can block it can leave
    // the run with no way to complete at all.
    budgetExempt: true,
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise statement of what was completed.' },
        evidence: {
          type: 'array', items: { type: 'string' },
          description: 'Concrete checks or tool results showing the objective is satisfied.',
        },
      },
      required: ['summary', 'evidence'],
      additionalProperties: false,
    },
    parse: parseCompletion,
    execute: submission => ({
      accepted: true,
      summary: submission.summary,
      evidence: [...submission.evidence],
      // A draft recorded means the model already gave the user a complete
      // answer before this check, so confirming it is a legitimate outcome,
      // not just a shorter way to restate it.
      instruction: state.draftAnswer === undefined
        ? 'This self-check is accepted for the current run. Now deliver the answer or artifact requested by the current user or assigned task, preserving its requested content and format. For exact text, only JSON, only a number, or another constrained format, return only the requested output. The summary and evidence in this tool result are verification metadata; keep them out of the final answer unless the task requests them. If the task requests a report, provide the substantive findings or changes, supporting evidence or sources, and relevant limitations. Do not merely say the self-check passed or refer to an earlier message. Do not call submit_result again in this run unless you perform new substantive tool work that invalidates this submission. A later user request or worker follow-up starts a new run and needs its own self-check.'
        : `This self-check is accepted for the current run. You already gave the user a complete answer earlier in this run, before this check. If that answer is still correct and complete, reply with exactly ${UNCHANGED_ANSWER_MARKER} and nothing else — no summary, no reference to it, no repeating it; the earlier answer is kept as the final answer. Only if this check found something to correct or add, give the complete corrected answer in full, as if the earlier one did not exist: never summarize it, point back to it, or say the self-check passed. Do not call submit_result again in this run unless you perform new substantive tool work that invalidates this submission. A later user request or worker follow-up starts a new run and needs its own self-check.`,
    }),
  })
}

function userInputTool(
  mode: Exclude<AgentMode, 'basic'>,
  broker: UserInputBroker,
  state: DeepState,
  emit: (event: AgentRunEvent) => Promise<void>,
  accounting?: RunTurnOptions['accounting'],
): ToolDefinition<{ readonly questions: readonly UserInputQuestion[] }> {
  return defineTool({
    name: AGENT_CONTROL_TOOLS.requestUserInput,
    // Asking the user is how a blocked run gets unblocked; a spent budget must
    // not be the reason the question is never asked.
    budgetExempt: true,
    description: mode === 'deep-human-in-loop'
      ? 'Ask the user one to three short questions when a material choice or missing fact requires human input, then wait for the response. Provide 2-3 mutually exclusive suggestions; free-form input is added by the client.'
      : 'Ask the user one to three short clarification questions only when blocked, then wait for the response. Provide suggested choices; free-form input is added by the client.',
    parameters: requestUserInputSchema(),
    parse: parseUserInput,
    execute: async ({ questions }, ctx) => {
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
      try {
        const pending = broker.request(request, ctx.signal)
        await emit({ type: 'user-input-request', request })
        const response = await pending
        await emit({ type: 'user-input-response', request, response })
        if (response === 'abort') {
          state.userAborted = true
          ctx.concludeTurn()
          if (operation !== undefined) accounting?.endOperation(operation, 'aborted')
          return { aborted: true }
        }
        if (operation !== undefined) accounting?.endOperation(operation, 'success')
        return validateUserResponse(response, questions) as unknown as JsonObject
      } catch (error) {
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

function deepHooks(
  userHooks: TurnHooks | undefined,
  history: RunAgentOptions['history'],
  state: DeepState,
  maxTurns: number | 'auto',
): TurnHooks {
  return {
    ...userHooks,
    onTurnEnd: async context => {
      const outcome = keptAnswerOutcome(context.outcome, state)
      await userHooks?.onTurnEnd?.(outcome === context.outcome ? context : { ...context, outcome })
      if (context.outcome.reason.kind === 'completed' && context.canContinue
        && state.completion !== undefined && state.draftAnswer === undefined && !state.orphanMarkerNudged
        && state.markerReply
        && context.outcome.text.trim() === UNCHANGED_ANSWER_MARKER) {
        state.orphanMarkerNudged = true
        history.append({ kind: 'user', message: createUserMessage({
          source: { kind: 'app', producer: 'deep-mode-self-check' },
          content: [{ type: 'text', text: `There is no earlier answer in this run for ${UNCHANGED_ANSWER_MARKER} to keep: that reply applies only after an answer was given before the check in the same run. Reply with the answer itself now, in the requested format.` }],
        }) })
        return
      }
      if (context.outcome.reason.kind !== 'completed'
        || (maxTurns !== 'auto' && context.outcome.steps >= maxTurns)
        || state.completion !== undefined
        || state.userAborted) return
      // Auto must not pay indefinitely for paraphrases of "already checked".
      // Substantive tool work resets this allowance; progress-only updates do not.
      state.unverifiedAnswers++
      if (state.unverifiedAnswers >= UNVERIFIED_ANSWER_LIMIT) return
      // What the gate is about to ask the model to justify or repeat. Kept
      // even though tool work may follow: nothing new has been shown to the
      // user since, so this is still what an eventual accept is confirming.
      if (context.outcome.text.trim() !== '' && context.outcome.text.trim() !== UNCHANGED_ANSWER_MARKER) {
        state.draftAnswer = context.outcome.text
      }
      history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'deep-mode-self-check' },
        content: [{
          type: 'text',
          text: (state.completionInvalidated
            ? `Your previously accepted submission is no longer current because you called another substantive tool afterwards. Review the later tool results and call ${AGENT_CONTROL_TOOLS.complete} again when complete; the old instruction not to resubmit no longer applies. `
            : '')
            + `Self-check required: this run has no accepted current self-check. Acceptance recorded in an earlier run does not complete this request or follow-up; an earlier instruction not to resubmit applied only to that earlier run. Compare the current result against the user's objective and every constraint. If anything is missing, continue with tools. If blocked and request_user_input is available, ask the user. Only when the work is actually complete, call ${AGENT_CONTROL_TOOLS.complete}. Keep verification in that tool call and then deliver the current user or assigned task's requested output in its original format. This reminder does not change the task or request a process report. Rephrasing a completion claim without submitting does not satisfy this gate.`,
        }],
      }) })
    },
  }
}

class CombinedToolCatalog implements ToolCatalog {
  private readonly definitions: ReadonlyMap<string, ToolDefinition>
  constructor(base: ToolCatalog | undefined, additions: readonly ToolDefinition[]) {
    const definitions = new Map<string, ToolDefinition>()
    for (const name of base?.names() ?? []) {
      const definition = base?.get(name)
      if (definition !== undefined) definitions.set(name, definition)
    }
    for (const definition of additions) {
      if (definitions.has(definition.name)) {
        throw new Error(`tool name "${definition.name}" is reserved by the selected agent mode`)
      }
      definitions.set(definition.name, definition)
    }
    this.definitions = definitions
  }
  get(name: string): ToolDefinition | undefined { return this.definitions.get(name) }
  has(name: string): boolean { return this.definitions.has(name) }
  names(): readonly string[] { return [...this.definitions.keys()] }
  schemas() {
    return [...this.definitions.values()].map(({ name, description, parameters }) => ({
      name, description, parameters: structuredClone(parameters),
    }))
  }
  executionMode(name: string, args: unknown): ToolExecutionMode {
    const definition = this.definitions.get(name)
    if (definition === undefined) return 'exclusive'
    try { return definition.isConcurrencySafe?.(args) === true ? 'parallel' : 'exclusive' }
    catch { return 'exclusive' }
  }
}

function combineTools(base: ToolCatalog | undefined, additions: readonly ToolDefinition[]): ToolCatalog {
  return new CombinedToolCatalog(base, additions)
}

/** Control tools are host protocol, not application capabilities subject to tool policy. */
function shieldControlTools(interceptors: readonly ToolInterceptor[]): readonly ToolInterceptor[] {
  const reserved = new Set<string>(Object.values(AGENT_CONTROL_TOOLS))
  return interceptors.map(interceptor => ({
    name: interceptor.name,
    ...interceptor.before === undefined ? {} : {
      before: (call, next) => reserved.has(call.toolName) ? next() : interceptor.before!(call, next),
    },
    ...interceptor.around === undefined ? {} : {
      around: (call, next) => reserved.has(call.toolName) ? next() : interceptor.around!(call, next),
    },
    ...interceptor.after === undefined ? {} : {
      after: (call, result, next) => reserved.has(call.toolName) ? next() : interceptor.after!(call, result, next),
    },
  }))
}

function completionFromResult(value: unknown): CompletionSubmission {
  const result = record(value, 'submit_result result')
  return parseCompletion({ summary: result.summary, evidence: result.evidence })
}

function validateUserResponse(
  response: UserInputResponse,
  questions: readonly UserInputQuestion[],
): UserInputResponse {
  const expected = new Set(questions.map(question => question.id))
  for (const id of expected) {
    const answer = response.answers[id]
    if (answer === undefined || !Array.isArray(answer.answers) || answer.answers.length === 0
      || answer.answers.some(value => typeof value !== 'string' || value.trim().length === 0)) {
      throw new Error(`the user-input broker returned no valid answer for "${id}"`)
    }
  }
  for (const id of Object.keys(response.answers)) {
    if (!expected.has(id)) throw new Error(`the user-input broker returned an answer for unknown question "${id}"`)
  }
  return response
}

function parseCompletion(raw: unknown): CompletionSubmission {
  const value = record(raw, 'submit_result arguments')
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    throw new Error('summary must be a non-empty string')
  }
  if (!Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error('evidence must be an array of non-empty strings')
  }
  return { summary: value.summary, evidence: value.evidence as string[] }
}

function parseUserInput(raw: unknown): { readonly questions: readonly UserInputQuestion[] } {
  const value = record(raw, 'request_user_input arguments')
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) {
    throw new Error('questions must contain one to three items')
  }
  const ids = new Set<string>()
  const questions = value.questions.map((rawQuestion, index) => {
    const question = record(rawQuestion, `questions[${index}]`)
    const id = requiredString(question.id, `questions[${index}].id`)
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error(`questions[${index}].id must be snake_case`)
    if (ids.has(id)) throw new Error(`question id "${id}" is duplicated`)
    ids.add(id)
    const header = requiredString(question.header, `questions[${index}].header`)
    const prompt = requiredString(question.question, `questions[${index}].question`)
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) {
      throw new Error(`questions[${index}].options must contain two or three choices`)
    }
    const options = question.options.map((rawOption, optionIndex) => {
      const option = record(rawOption, `questions[${index}].options[${optionIndex}]`)
      return {
        label: requiredString(option.label, `questions[${index}].options[${optionIndex}].label`),
        description: requiredString(option.description, `questions[${index}].options[${optionIndex}].description`),
      }
    })
    return Object.freeze({ id, header, question: prompt, options: Object.freeze(options), allowFreeForm: true as const })
  })
  return { questions: Object.freeze(questions) }
}

function requestUserInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: 3,
        description: 'Questions to show the user. Prefer one and do not exceed three.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Stable snake_case answer key.' },
            header: { type: 'string', description: 'Short UI label, ideally 12 characters or fewer.' },
            question: { type: 'string', description: 'Single-sentence question.' },
            options: {
              type: 'array', minItems: 2, maxItems: 3,
              description: 'Mutually exclusive choices. Put the recommended choice first and suffix its label with "(Recommended)". Do not add Other; the client supplies free-form input.',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  label: { type: 'string', description: 'User-facing label, one to five words.' },
                  description: { type: 'string', description: 'One sentence explaining impact or trade-off.' },
                },
                required: ['label', 'description'],
              },
            },
          },
          required: ['id', 'header', 'question', 'options'],
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  }
}

function modeSystem(mode: AgentMode, canAskUser: boolean): string {
  if (mode === 'basic') return [
    'Work as a bounded tool-using agent. Use available tools proactively when they materially improve correctness.',
    'Stay within the configured iteration budget, then give the best final answer supported by the gathered results.',
  ].join(' ')
  const ask = canAskUser
    ? `If a missing fact or material user choice blocks correct progress, call ${AGENT_CONTROL_TOOLS.requestUserInput} and continue after the answer.`
    : 'If blocked by missing user input, state that limitation plainly in the final response.'
  const hil = mode === 'deep-human-in-loop'
    ? 'For material choices, surface 2-3 concise options with the recommended option first; the UI also permits free-form feedback.'
    : ''
  return [
    'Work autonomously in deep mode. After every tool result, compare the evidence against the user objective and all constraints; continue until gaps are closed.',
    `Do not treat a plausible draft as completion. When the work is actually complete, call ${AGENT_CONTROL_TOOLS.complete} with a summary and concrete evidence, then provide the final answer.`,
    'Put verification summaries and evidence in the self-check tool call. Deliver the current user or assigned task\'s requested answer or artifact in its requested format, including exact text or JSON. Add verification commentary only when that format permits it.',
    ask, hil,
    'Never reveal private chain-of-thought. Use concise user-visible commentary for intent, progress, observations, and decisions.',
  ].filter(Boolean).join(' ')
}

function joinSystem(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join('\n\n')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}
function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}
