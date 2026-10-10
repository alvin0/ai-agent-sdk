import { createMessage } from '../../../message/index.ts'
import type { History } from '../../history/history.ts'
import type { HistoryEvent } from '../../history/types.ts'
import type { ToolCatalog } from '../../tool/registry.ts'
import type { TurnEndReason, TurnHooks } from '../types.ts'
import type { TurnState } from './state.ts'
import { UNCHANGED_ANSWER_MARKER } from '../control-text.ts'
import { emitAssistantContent, textOf } from './content.ts'
import { deliverQueuedInput, hasQueuedInput } from './model-request-boundary.ts'

const MAX_RECOVERY_CHARS = 24_000
const RECOVERY_FOOTER = 'The remaining work is unverified. Completed tool results remain in the conversation'
  + ' history for continuation; they must not be repeated just because this run ended.'

function publicText(value: string): string {
  const text = value.replaceAll(UNCHANGED_ANSWER_MARKER, '')
  const markerStart = text.lastIndexOf('<<')
  return markerStart >= 0 && UNCHANGED_ANSWER_MARKER.startsWith(text.slice(markerStart).trim())
    ? text.slice(0, markerStart) : text
}

function stopLabel(reason: TurnEndReason): string {
  if (reason?.kind === 'budget-exhausted') return `${reason.budget} budget exhausted`
  if (reason?.kind === 'max-tokens') return 'model output limit reached'
  if (reason?.kind === 'usage-unavailable') return 'usage accounting unavailable'
  return 'execution could not finish'
}

type RecordedResult = { toolName: string; text: string }

function isPublicWorkTool(name: string | undefined, tools?: ToolCatalog): name is string {
  return name !== undefined && tools?.get(name)?.budgetExempt !== true
}

function resultEvidence(
  event: HistoryEvent, names: ReadonlyMap<string, string>, tools?: ToolCatalog,
): RecordedResult | undefined {
  if (event.kind !== 'tool-result' || event.result.isError || event.result.meta?.declined) return undefined
  const name = names.get(String(event.callId))
  if (!isPublicWorkTool(name, tools)) return undefined
  const text = publicText(event.result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
  if (!text.trim()) return undefined
  return { toolName: name, text: text.slice(0, 2_000)
    + (text.length > 2_000 ? '\n[Excerpt; full output remains in history.]' : '') }
}

function recordedResults(history: History, tools?: ToolCatalog): RecordedResult[] {
  const entries = history.entries()
  const boundary = entries.findLast(entry => entry.event.kind === 'user'
    && entry.event.message.source.kind === 'user')?.seq ?? 0
  const names = new Map<string, string>()
  const results: RecordedResult[] = []
  for (const entry of entries) {
    if (entry.seq <= boundary) continue
    const event = entry.event
    if (event.kind === 'tool-call') names.set(String(event.callId), event.name)
    const evidence = resultEvidence(event, names, tools)
    if (evidence) results.push(evidence)
  }
  return results.slice(-8)
}

/** Provider-free last resort for an accepted user-facing run. The caller owns
 * appending/persisting this message; creating it does not mark work complete. */
export function createTerminalRecoveryMessage(input: {
  readonly history: History; readonly reason: TurnEndReason; readonly text?: string
  readonly tools?: ToolCatalog; readonly format?: NonNullable<TurnHooks['onTerminalRecovery']>
}) {
  const previous = publicText(input.text ?? '')
  const results = recordedResults(input.history, input.tools)
  const defaultText = [
    `The request is not fully completed: ${stopLabel(input.reason)}.`,
    ...(previous.trim() ? ['Saved answer so far:', previous.slice(0, 12_000)] : []),
    ...(results.length ? ['Recorded tool results:',
      ...results.map(result => `- ${result.toolName}: ${result.text}`)] : []),
  ].join('\n\n').slice(0, MAX_RECOVERY_CHARS - RECOVERY_FOOTER.length - 2) + `\n\n${RECOVERY_FOOTER}`
  let text = defaultText
  try {
    const formatted = input.format?.({ reason: input.reason, text: previous, defaultText, evidence: results })
    if (typeof formatted === 'string' && publicText(formatted).trim()) {
      text = publicText(formatted).slice(0, MAX_RECOVERY_CHARS)
    }
  } catch { /* A formatter cannot remove the terminal answer. */ }
  return createMessage({ role: 'assistant', source: { kind: 'app', producer: 'terminal-recovery' },
    content: [{ type: 'text', text, phase: 'final-answer' }] })
}

function alreadyAnswered(state: TurnState): boolean {
  if (!state.text.trim()) return false
  const reason = state.reason
  if (reason?.kind === 'budget-exhausted') return reason.forcedFinalAnswer
  return reason?.kind === 'completed' || reason?.kind === 'concluded-by-tool'
}

/** Input accepted after the last model answer still belongs to this run. */
export function hasUnansweredUserInput(history: History): boolean {
  if (hasQueuedInput(history)) return true
  const entries = history.entries()
  const user = entries.findLast(entry => entry.event.kind === 'user'
    && entry.event.message.source.kind === 'user')?.seq ?? 0
  const assistant = entries.findLast(entry => entry.event.kind === 'assistant')?.seq ?? 0
  return user > assistant
}

function unansweredReason(state: TurnState): TurnEndReason {
  return state.admissionStop() ?? (state.workSteps() >= state.maxSteps
    ? { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: false }
    : { kind: 'error', failure: { code: 'UNANSWERED_INPUT', message: 'Accepted input remains unanswered.' } })
}

function needsTerminalRecovery(state: TurnState): boolean {
  if (!alreadyAnswered(state)) return true
  if (!hasUnansweredUserInput(state.options.history)) return false
  return state.reason?.kind !== 'completed' || state.workSteps() >= state.maxSteps
    || state.admissionStop() !== undefined
}

function canRecover(state: TurnState): boolean {
  return state.options.hooks?.onTerminalRecovery !== undefined
    && !state.signal.aborted && state.reason?.kind !== 'aborted'
    && needsTerminalRecovery(state)
}

/** The token/usage wall forbids another request, not delivery of already paid
 * work. This report uses committed public text/results, never private reasoning
 * or raw provider errors, and keeps the original unsuccessful outcome. */
export async function ensureTerminalAnswer(state: TurnState): Promise<void> {
  if (!canRecover(state)) return
  // Accepted steering must precede its recovery answer, even when admission
  // forbids another paid model round.
  deliverQueuedInput(state.options.history)
  if (alreadyAnswered(state)) state.reason = unansweredReason(state)
  if (state.reason?.kind === 'completed') state.reason = {
    kind: 'error', failure: { code: 'EMPTY_FINAL_ANSWER', message: 'The model ended without an answer.' },
  }
  const message = createTerminalRecoveryMessage({ history: state.options.history,
    reason: state.reason!, text: state.text,
    ...(state.options.tools ? { tools: state.options.tools } : {}),
    format: state.options.hooks?.onTerminalRecovery! })
  state.options.history.append({ kind: 'assistant', message })
  state.text = textOf(message.content)
  await state.emit({ type: 'assistant-message', message, trace: state.root })
  await emitAssistantContent({ message, trace: state.root, finish: { kind: 'stop' }, calls: [],
    afterToolCallIds: [], timing: 'standalone' }, state.emit)
}
