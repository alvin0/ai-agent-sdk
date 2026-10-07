import type { ContentBlock } from '../../message/index.ts'
import type { JsonObject } from '../../primitives/index.ts'
import type { ToolExecutionResult } from '../tool/definition.ts'
import type { ToolCallRequest } from '../tool/pipeline.ts'
import {
  estimateTextBlockTokens, previewForSpill, truncateMiddleToTokens,
} from '../tool/output-budget.ts'
import type { RunToolCallsOptions } from './schedule.ts'

/**
 * Keep one tool result inside its share of the context window.
 *
 * This runs at the RESULT boundary rather than when the request is assembled,
 * which is the whole point: by the time an oversized result reaches the model
 * the window is already gone, and the turn's only remaining move is to lose
 * everything it has paid for. Both reference harnesses cut here.
 *
 * The budget is the stricter of the turn's and the tool's own declaration, so
 * a tool that knows it returns a lot can ask for room without any tool being
 * able to exceed what the host allows.
 * @param options - The scheduling options carrying budget and store.
 * @param slot - The call this result belongs to.
 * @param result - The finalized result.
 * @returns The result the model will read.
 */
export async function boundOutput(
  options: RunToolCallsOptions,
  call: ToolCallRequest,
  result: ToolExecutionResult,
): Promise<ToolExecutionResult> {
  const turnBudget = options.maxResultTokens
  const toolBudget = options.catalog.get(call.toolName)?.maxOutputTokens
  const budget = resultBudget(turnBudget, toolBudget)
  if (budget === undefined) return result
  const tokens = estimateTextBlockTokens(result.content)
  if (tokens <= budget) return result

  // Only text is shortened. Cutting an image block produces a corrupt image
  // rather than a smaller one, so those pass through and are counted by the
  // byte cap instead.
  const texts = result.content.filter(block => block.type === 'text')
  if (texts.length === 0) return result
  const full = texts.map(block => block.text).join('\n')
  const policy = options.resultOverflow ?? 'auto'
  const store = options.spillStore

  if (policy !== 'truncate' && store !== undefined) {
    try {
      // Reserve room for the notice inside the budget, so the replacement is
      // never bigger than what it replaced.
      const record = await store.save(full, {
        toolName: call.toolName, callId: String(call.callId),
      })
      const preview = previewForSpill(full, Math.max(1, Math.floor(budget * 0.75)))
      return replaceText(result, `${preview}\n\n[Output exceeded this call's budget of `
        + `${String(budget)} estimated tokens. The full ${String(record.bytes)} bytes are saved. `
        + `${record.retrieval}]`, {
        outputSpilled: { locator: record.locator, bytes: record.bytes, estimatedTokens: tokens },
      })
    } catch {
      // Best-effort, deliberately: a store that is full or unreachable must not
      // cost the model a result it can still read most of.
    }
  }

  const truncated = truncateMiddleToTokens(full, budget)
  return replaceText(result, truncated.text
    + `\n\n[Output was ${String(truncated.originalTokens)} estimated tokens, over this call's `
    + `budget of ${String(budget)}. Omitted output does not mean the operation failed. `
    + 'Check an existing receipt or current state; repeat the operation only when the host confirms it is safe.]', {
    outputTruncated: { estimatedTokens: truncated.originalTokens, budget },
  })
}

function resultBudget(turnBudget: number | undefined, toolBudget: number | undefined): number | undefined {
  if (turnBudget === undefined) return toolBudget
  if (toolBudget === undefined) return turnBudget
  return Math.min(turnBudget, toolBudget)
}

/**
 * Swap a result's text for one shortened block, keeping everything else.
 * @param result - The original result.
 * @param text - The replacement text.
 * @param meta - What a UI should know about the replacement.
 * @returns The rewritten result.
 */
function replaceText(
  result: ToolExecutionResult,
  text: string,
  meta: JsonObject,
): ToolExecutionResult {
  // The replacement takes the FIRST text block's position and the other text
  // blocks drop out. Appending it after the non-text blocks instead would
  // reorder a result whose image came after its caption.
  let placed = false
  const content: ContentBlock[] = []
  for (const block of result.content) {
    if (block.type !== 'text') { content.push(block); continue }
    if (placed) continue
    placed = true
    content.push({ type: 'text', text })
  }
  // `value` is deliberately untouched: it is what a host logs and replays, and
  // shortening it would make the record disagree with what the tool returned.
  return { ...result, content, meta: { ...result.meta, ...meta } }
}

