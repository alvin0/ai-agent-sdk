/** High-level agent modes built on the provider-neutral bounded tool loop. */

import { createUserMessage } from '../../message/index.ts'
import type { CallConfig } from '../../contract/index.ts'
import type { JsonObject } from '../../primitives/index.ts'
import { detachedFrozen } from '../../primitives/index.ts'
import { runTurn, type RunTurnOptions } from '../loop/run-turn.ts'
import { AwaitedEventQueue } from '../loop/queue.ts'
import type { AgentEvent, TurnBounds, TurnHooks, TurnOutcome } from '../loop/types.ts'
import { defineTool, type ToolDefinition, type ToolExecutionMode } from '../tool/definition.ts'
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

/** Default high-level runtime requested by this SDK; `runTurn` remains provider-neutral. */
export type AgentMode = 'basic' | 'deep' | 'deep-human-in-loop'

interface AgentRunCommon extends Omit<RunTurnOptions, 'bounds' | 'commentary' | 'config' | 'hooks' | 'system' | 'tools'> {
  /** Explicit low-level model binding; composition users can select a configured provider default instead. */
  readonly config: CallConfig
  readonly tools?: ToolCatalog
  readonly system?: string
  /** Maximum normal model iterations. A forced final answer may use one extra request. */
  readonly maxTurns?: number
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
  readonly maxTurns: number
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
}

const DEFAULT_MAX_TURNS = 16

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
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new RangeError('maxTurns must be a positive integer')
  await emit({ type: 'agent-start', mode, maxTurns })

  const state: DeepState = { completion: undefined, userAborted: false }
  const deep = mode !== 'basic'
  const broker = options.mode === 'deep' || options.mode === 'deep-human-in-loop'
    ? configuredUserInput
    : undefined
  const internalTools: ToolDefinition[] = []
  if (deep) internalTools.push(completionTool())
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
    ...options.outputFormat === undefined ? {} : { outputFormat: options.outputFormat },
    system: joinSystem(options.system, modeSystem(mode, broker !== undefined)),
    ...options.interceptors === undefined ? {} : { interceptors: shieldControlTools(options.interceptors) },
    ...options.approvals === undefined ? {} : { approvals: options.approvals },
    bounds: { ...options.bounds, maxSteps: maxTurns },
    ...hooks === undefined ? {} : { hooks },
    signal,
    ...options.logger === undefined ? {} : { logger: options.logger },
    commentary: options.commentary ?? 'concise',
    teardownTimeoutMs: options.teardownTimeoutMs ?? 30_000,
    ...options.modelTimeoutMs === undefined ? {} : { modelTimeoutMs: options.modelTimeoutMs },
    ...options.maxModelRequestBytes === undefined ? {} : { maxModelRequestBytes: options.maxModelRequestBytes },
    ...options.maxModelResponseBytes === undefined ? {} : { maxModelResponseBytes: options.maxModelResponseBytes },
    ...options.maxModelStreamEvents === undefined ? {} : { maxModelStreamEvents: options.maxModelStreamEvents },
    ...options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs },
    ...options.hookTeardownTimeoutMs === undefined ? {} : { hookTeardownTimeoutMs: options.hookTeardownTimeoutMs },
    ...options.trace === undefined ? {} : { trace: options.trace },
    ...options.accounting === undefined ? {} : { accounting: options.accounting },
  }

  let terminal: TurnOutcome | undefined
  let stepCalls: string[] = []
  let completionCandidate: CompletionSubmission | undefined
  for await (const event of runTurn(turnOptions)) {
    if (event.type === 'step-start') {
      stepCalls = []
      completionCandidate = undefined
    } else if (event.type === 'tool-call') {
      stepCalls.push(event.call.toolName)
      // Work performed after an accepted submission invalidates that submission;
      // the new result has not yet passed the completion gate.
      if (event.call.toolName !== AGENT_CONTROL_TOOLS.complete) state.completion = undefined
    } else if (event.type === 'tool-result'
      && event.call.toolName === AGENT_CONTROL_TOOLS.complete
      && !event.result.isError) {
      completionCandidate = completionFromResult(event.result.value)
    } else if (event.type === 'step-end'
      && completionCandidate !== undefined
      && stepCalls.length === 1
      && stepCalls[0] === AGENT_CONTROL_TOOLS.complete) {
      // A completion submission cannot share a batch with work whose results the
      // model had not seen when it claimed success.
      state.completion = completionCandidate
    }
    if (event.type === 'turn-end') terminal = event.outcome
    await emit(event)
  }
  if (terminal === undefined) throw new Error('runTurn ended without a turn-end event')
  const completed = mode === 'basic'
    ? terminal.reason.kind === 'completed' || terminal.reason.kind === 'concluded-by-tool'
    : state.completion !== undefined && !state.userAborted
  const outcome: AgentRunOutcome = {
    ...terminal,
    mode,
    completed,
    ...state.completion === undefined ? {} : { completion: state.completion },
  }
  await emit({ type: 'agent-end', outcome })
}

function completionTool(): ToolDefinition<CompletionSubmission> {
  return defineTool({
    name: AGENT_CONTROL_TOOLS.complete,
    description: 'Submit the self-check only when the user objective and constraints are fully satisfied. After acceptance, give the user the final answer.',
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
      instruction: 'Now provide the final answer to the user without calling submit_result again.',
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
  maxTurns: number,
): TurnHooks {
  return {
    ...userHooks,
    onTurnEnd: async context => {
      await userHooks?.onTurnEnd?.(context)
      if (context.outcome.reason.kind !== 'completed'
        || context.outcome.steps >= maxTurns
        || state.completion !== undefined
        || state.userAborted) return
      history.append({ kind: 'user', message: createUserMessage({
        source: { kind: 'app', producer: 'deep-mode-self-check' },
        content: [{
          type: 'text',
          text: `Self-check required: compare the current result against the user's objective and every constraint. If anything is missing, continue with tools. If blocked and request_user_input is available, ask the user. Only when the work is actually complete, call ${AGENT_CONTROL_TOOLS.complete}.`,
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
