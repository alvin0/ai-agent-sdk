import { systemRandomId } from '../../platform/adapter.ts'
import { createUserMessage, type Message } from '../../message/index.ts'
import type { History } from '../history/history.ts'
import type { CompactionBackoffReason, CompactionTrigger } from '../loop/events.ts'
import type { ResolvedBudget } from './compaction-budget.ts'
import type { CompactionSummarizer } from './compaction-summary.ts'
import type { selectCompactablePrefix } from './surface-compaction.ts'
import { estimateMessageTokens } from './token-estimator.ts'

const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint of earlier conversation context. '
    + 'Treat it as established background, preserve the original objective and constraints, '
    + 'and continue directly from the messages that follow.'

const MIN_PRESSURE_SAVINGS_TOKENS = 256
const MIN_PRESSURE_SAVINGS_RATIO = 0.01
export const PRESSURE_BACKOFF_STEPS = 4

export function newCompactionId(): string {
  return systemRandomId()
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

export function pressureBackoffReason(input: {
  readonly trigger: CompactionTrigger
  readonly thresholdTokens: number | undefined
  readonly estimatedTokensBefore: number
  readonly estimatedTokensAfter: number
  readonly estimatedNonCompactableTokens: number
}): CompactionBackoffReason | undefined {
  if (input.trigger !== 'pressure' || input.thresholdTokens === undefined
    || input.estimatedTokensAfter < input.thresholdTokens) return undefined
  if (input.estimatedNonCompactableTokens >= input.thresholdTokens) {
    return 'unreachable-threshold'
  }
  const savings = input.estimatedTokensBefore - input.estimatedTokensAfter
  const minimum = Math.max(
    MIN_PRESSURE_SAVINGS_TOKENS,
    Math.ceil(input.estimatedTokensBefore * MIN_PRESSURE_SAVINGS_RATIO),
  )
  return savings < minimum ? 'low-savings' : undefined
}

export function createCheckpoint(
  compactionId: string,
  summary: string,
  selected: ReturnType<typeof selectCompactablePrefix>,
) {
  const checkpoint = createUserMessage({
    source: { kind: 'app', producer: `agent-compaction:${compactionId}` },
    content: [{
      type: 'text',
      text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${summary}\n</compacted-summary>`,
    }],
  })
  const shadowedTokens = selected.reduce((total, node) => total + estimateMessageTokens(node.message), 0)
  const checkpointTokens = estimateMessageTokens(checkpoint)
  if (checkpointTokens >= shadowedTokens) {
    throw new Error(
      'compaction summary did not shrink selected context '
      + `(${checkpointTokens} >= ${shadowedTokens} estimated tokens)`,
    )
  }
  return { checkpoint, shadowedTokens, checkpointTokens }
}

export function appendCheckpoint(history: History, checkpoint: Message, input: {
  compactionId: string
  summarized: Awaited<ReturnType<CompactionSummarizer['summarize']>>
  shadowedSeqs: readonly number[]
  totalBefore: number
  estimatedTokensAfter: number
  thresholdTokens: number | undefined
  estimatedNonCompactableTokens: number
  pressureBackoff: CompactionBackoffReason | undefined
}): void {
  const { compactionId, summarized, shadowedSeqs, totalBefore, estimatedTokensAfter,
    thresholdTokens, estimatedNonCompactableTokens, pressureBackoff } = input
  history.appendBatch([
    { event: {
      kind: 'compaction-summary', compactionId, summary: summarized.summary, shadowedSeqs,
      estimatedTokensBefore: totalBefore, estimatedTokensAfter,
      provider: summarized.provider, model: summarized.model,
      ...(summarized.usage === undefined ? {} : { usage: summarized.usage }),
    } },
    { event: { kind: 'user', message: checkpoint }, surfaceOp: {
      op: 'replace',
      from: Math.min(...shadowedSeqs),
      to: Math.max(...shadowedSeqs),
      targets: shadowedSeqs,
    } },
    { event: {
      kind: 'compaction-end', compactionId, status: 'completed', at: new Date().toISOString(),
      ...(thresholdTokens === undefined ? {} : { thresholdTokens }),
      estimatedNonCompactableTokens,
      ...(pressureBackoff === undefined ? {} : {
        backoffReason: pressureBackoff,
        cooldownSteps: PRESSURE_BACKOFF_STEPS,
      }),
    } },
  ])
}

export function belowPressure(
  trigger: CompactionTrigger, budget: ResolvedBudget | null, total: number, allowMissing: boolean,
): boolean {
  if (trigger !== 'pressure') return false
  if (budget === null) return allowMissing
  return total < budget.thresholdTokens
}

export function compactionRetainTokens(input: {
  trigger: CompactionTrigger
  surface: ReturnType<History['surface']>
  budget: ResolvedBudget | null
  totalBefore: number
}): number {
  const { trigger, surface, budget, totalBefore } = input
  return trigger === 'context-overflow'
    ? Math.max(1, estimateMessageTokens(surface.at(-1)?.message))
    : budget?.retainTokens ?? Math.max(1, Math.floor(totalBefore * 0.25))
}
