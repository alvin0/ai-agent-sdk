import { AGENT_CONTROL_TOOLS } from './control-tools.ts'
import { UNCHANGED_ANSWER_MARKER } from '../loop/control-text.ts'
import { createMessage, type Message } from '../../message/index.ts'
import type { TurnOutcome } from '../loop/types.ts'
import type { ToolInterceptor } from '../tool/pipeline.ts'
import { defineTool, type ToolDefinition, type ToolExecutionMode } from '../tool/definition.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import { userInputResponseProblem, type UserInputQuestion, type UserInputResponse } from './user-input.ts'
import { type AgentMode, type RunAgentOptions, type CompletionSubmission, type DeepState } from './run-agent.ts'


/**
 * The message's combined text, when text is all it says. Reasoning is not
 * something it says to the user: reasoning models attach it to a reply that is
 * otherwise only the marker, and that reply must still count as the marker.
 */
export function soleText(content: readonly Message['content'][number][]): string | undefined {
  const said = content.filter(block => block.type !== 'reasoning')
  return said.length > 0 && said.every(block => block.type === 'text')
    ? said.map(block => block.type === 'text' ? block.text : '').join('') : undefined
}

/** Text that is, so far, only the beginning (or the whole) of the marker. */
export function isMarkerPrefix(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length === 0 ? true : UNCHANGED_ANSWER_MARKER.startsWith(trimmed)
}

export function markerFallbackText(state: DeepState): string {
  return state.completion !== undefined && (state.markerReply || state.markerCut)
    ? state.draftAnswer ?? '' : ''
}

export function exactMarkerOutcome(outcome: TurnOutcome, state: DeepState): TurnOutcome {
  return { ...outcome, text: state.resolvedMarkerAnswer ?? markerFallbackText(state) }
}

export function keptAnswerOutcome(outcome: TurnOutcome, state: DeepState): TurnOutcome {
  const trimmed = outcome.text.trim()
  if (trimmed === UNCHANGED_ANSWER_MARKER) return exactMarkerOutcome(outcome, state)
  if (outcome.text.includes(UNCHANGED_ANSWER_MARKER)) {
    return { ...outcome, text: outcome.text.replaceAll(UNCHANGED_ANSWER_MARKER, '').trim() }
  }
  if (!state.markerReply && !state.markerCut) return outcome
  const cut = state.markerCut && trimmed !== '' && isMarkerPrefix(outcome.text)
  if (!cut && trimmed !== UNCHANGED_ANSWER_MARKER) return outcome
  return { ...outcome, text: state.draftAnswer ?? '' }
}

/** Replace the control text while preserving the confirming round's reasoning. */
export function keptAnswerMessage(draftAnswer: string, content?: Message['content']): Message {
  return createMessage({
    role: 'assistant',
    content: content === undefined
      ? [{ type: 'text', text: draftAnswer, phase: 'final-answer' }]
      : [...content.filter(block => block.type === 'reasoning'),
        { type: 'text' as const, text: draftAnswer, phase: 'final-answer' as const }],
    source: { kind: 'app', producer: draftAnswer === '' ? 'deep-mode-invalid-marker' : 'deep-mode-kept-answer' },
  })
}

/** Supersede a bare marker on the history surface without changing the raw log. */
export function latestAssistantEntry(
  history: RunAgentOptions['history'],
): ReturnType<RunAgentOptions['history']['entries']>[number] | undefined {
  return [...history.entries()].reverse().find(entry => entry.event.kind === 'assistant')
}

export function restoreKeptAnswer(history: RunAgentOptions['history'], replacement: Message, cut = false): void {
  const target = latestAssistantEntry(history)
  if (target?.event.kind !== 'assistant') return
  const only = target.event.message.content
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  if (!only.includes(UNCHANGED_ANSWER_MARKER)
    && !(cut && only.trim() !== '' && isMarkerPrefix(only))) return
  history.append(
    { kind: 'assistant', message: replacement },
    { op: 'replace', from: target.seq, to: target.seq },
  )
}

/** Whether a new user or delegated task arrived after the given history position. */
export function taskChangedSince(history: RunAgentOptions['history'], seq: number | undefined): boolean {
  return history.entries().slice(seq ?? 0)
    .some(entry => entry.event.kind === 'user' && ['user', 'agent-message', 'a2a-message']
      .includes(entry.event.message.source.kind))
}

export function invalidateDraftAfterSteering(state: DeepState, history: RunAgentOptions['history']): void {
  if (state.completion !== undefined && taskChangedSince(history, state.completionSeq)) {
    state.completion = undefined
    state.completionInvalidated = 'input'
  }
  if (state.draftAnswer === undefined || !taskChangedSince(history, state.draftSeq)) return
  state.draftAnswer = undefined
  state.draftSeq = undefined
}

function acceptedCompletionInstruction(state: DeepState): string {
  return state.draftAnswer === undefined
    ? 'This self-check is accepted for the current run. Now deliver the answer or artifact '
      + 'requested by the current user or assigned task, preserving its requested content and '
      + 'format. For exact text, only JSON, only a number, or another constrained format, '
      + 'return only the requested output. The summary and evidence in this tool result are '
      + 'verification metadata; keep them out of the final answer unless the task requests '
      + 'them. If the task requests a report, provide the substantive findings or changes, '
      + 'supporting evidence or sources, and relevant limitations. Do not merely say the '
      + 'self-check passed or refer to an earlier message. Do not call submit_result again in '
      + 'this run unless you perform new substantive tool work that invalidates this '
      + 'submission. A later user request or worker follow-up starts a new run and needs its '
      + 'own self-check.'
    : `This self-check is accepted for the current run. You already gave the user a `
      + `complete answer earlier in this run, before this check. If no user message or `
      + `delegated task arrived after that answer and it still satisfies every current `
      + `requirement, reply with exactly ${UNCHANGED_ANSWER_MARKER} and nothing else. If a `
      + `user message or delegated task arrived after that answer, give the complete answer `
      + `to the latest request in full, even if the earlier answer seems correct. If this `
      + `check found something to correct or add, also give the complete corrected answer in `
      + `full, as if the earlier one did not exist: never summarize it, point back to it, or `
      + `say the self-check passed. Do not call submit_result again in this run unless you `
      + `perform new substantive tool work that invalidates this submission. A later user `
      + `request or worker follow-up starts a new run and needs its own self-check.`
}

export function completionTool(state: DeepState, history: RunAgentOptions['history'],
  tools?: ToolCatalog): ToolDefinition<CompletionSubmission> {
  return defineTool({
    name: AGENT_CONTROL_TOOLS.complete,
    description: 'Submit the self-check only when the user objective and constraints are fully satisfied. '
      + 'After acceptance, give the user the final answer.',
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
    execute: submission => {
      // A newer user or delegated task changes what the draft answered, so
      // "the earlier answer still stands" is no longer a truthful reply: the
      // model is asked for the answer in full, and a marker it sends anyway is
      // treated as having nothing to keep.
      invalidateDraftAfterSteering(state, history)
      const calls = history.messages().findLast(message => message.role === 'assistant')?.content
        .filter(block => block.type === 'tool-call') ?? []
      if (calls.filter(call => call.name === AGENT_CONTROL_TOOLS.complete).length !== 1
        || calls.some(call => call.name !== AGENT_CONTROL_TOOLS.complete
          && tools?.get(call.name)?.completionExempt !== true)) {
        return { accepted: false,
          instruction: 'Review the tool results, then call submit_result exactly once without substantive '
            + 'sibling tools. '
            + 'This batch has no accepted self-check.' }
      }
      return {
        accepted: true,
        summary: submission.summary,
        evidence: [...submission.evidence],
        // A draft recorded means the model already gave the user a complete
        // answer before this check, so confirming it is a legitimate outcome,
        // not just a shorter way to restate it.
        instruction: acceptedCompletionInstruction(state)
      }
    },
  })
}


export class CombinedToolCatalog implements ToolCatalog {
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

export function combineTools(base: ToolCatalog | undefined, additions: readonly ToolDefinition[]): ToolCatalog {
  return new CombinedToolCatalog(base, additions)
}

/** Control tools are host protocol, not application capabilities subject to tool policy. */
export function shieldControlTools(interceptors: readonly ToolInterceptor[]): readonly ToolInterceptor[] {
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

export function completionFromResult(value: unknown): CompletionSubmission {
  const result = record(value, 'submit_result result')
  return parseCompletion({ summary: result.summary, evidence: result.evidence })
}

export function validateUserResponse(
  response: UserInputResponse,
  questions: readonly UserInputQuestion[],
): UserInputResponse {
  const problem = userInputResponseProblem(questions, response)
  if (problem !== undefined) throw new Error(`the user-input broker returned ${problem}`)
  return response
}

export function parseCompletion(raw: unknown): CompletionSubmission {
  const value = record(raw, 'submit_result arguments')
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    throw new Error('summary must be a non-empty string')
  }
  if (!Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string'
    || item.trim().length === 0)) {
    throw new Error('evidence must be an array of non-empty strings')
  }
  return { summary: value.summary, evidence: value.evidence as string[] }
}

export function parseUserInput(raw: unknown): { readonly questions: readonly UserInputQuestion[] } {
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
    return Object.freeze({ id, header, question: prompt, options: Object.freeze(options),
      allowFreeForm: true as const })
  })
  return { questions: Object.freeze(questions) }
}

export function requestUserInputSchema(): Record<string, unknown> {
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
              description: 'Mutually exclusive choices. Put the recommended choice first and suffix its label '
                + 'with "(Recommended)". '
                + 'Do not add Other; the client supplies free-form input.',
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

export function modeSystem(mode: AgentMode, canAskUser: boolean): string {
  if (mode === 'basic') return [
    'Work as a bounded tool-using agent. Use available tools proactively when they materially improve correctness.',
    'Stay within the configured iteration budget, then give the best final answer supported by the gathered results.',
  ].join(' ')
  const ask = canAskUser
    ? `If a missing fact or material user choice blocks correct progress, call `
      + `${AGENT_CONTROL_TOOLS.requestUserInput} and continue after the answer.`
    : 'If blocked by missing user input, state that limitation plainly in the final response.'
  const hil = mode === 'deep-human-in-loop'
    ? 'For material choices, surface 2-3 concise options with the recommended option first; '
      + 'the UI also permits free-form feedback.'
    : ''
  return [
    'Work autonomously in deep mode. After every tool result, compare the evidence against the user objective '
      + 'and all constraints; continue until gaps are closed.',
    `Do not treat a plausible draft as completion. When the work is actually complete, call `
      + `${AGENT_CONTROL_TOOLS.complete} `
      + 'with a summary and concrete evidence, then provide the final answer.',
    'Put verification summaries and evidence in the self-check tool call. Deliver the current user or '
      + 'assigned task\'s requested answer or artifact in its requested format, including exact text or JSON. '
      + 'Add verification commentary only when that format permits it.',
    ask, hil,
    'Never reveal private chain-of-thought. Use concise user-visible commentary for intent, progress, '
      + 'observations, and decisions.',
  ].filter(Boolean).join(' ')
}

export function joinSystem(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join('\n\n')
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}
export function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}

export function isAgentCompletionEligible(mode: AgentMode, terminal: TurnOutcome, state: DeepState): boolean {
  if (mode === 'basic') {
    return (terminal.reason.kind === 'completed' && terminal.text.trim() !== '')
      || terminal.reason.kind === 'concluded-by-tool'
  }
  return state.completion !== undefined && !state.userAborted
    && (terminal.reason.kind === 'completed'
      || terminal.reason.kind === 'concluded-by-tool'
      || (terminal.reason.kind === 'budget-exhausted' && terminal.reason.forcedFinalAnswer))
    && terminal.text.trim() !== ''
}

export function validateAgentModeValue(mode: AgentMode): void {
  if (!['basic', 'deep', 'deep-human-in-loop'].includes(mode)) {
    throw new RangeError('unsupported agent mode "' + String(mode) + '"')
  }
}

export function validateAgentMaxTurns(maxTurns: number | 'auto'): void {
  if (maxTurns !== 'auto' && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    throw new RangeError("maxTurns must be a positive safe integer or 'auto'")
  }
}
