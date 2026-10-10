import type { ContentBlock } from '../../../message/index.ts'

/**
 * Deterministic token estimate for text.
 *
 * Four characters per token, the same heuristic compaction uses, and the same
 * order of magnitude as Codex's `approx_token_count`. It is an estimate: a real
 * tokenizer differs, and dense scripts differ more. It is used to decide when
 * to shorten output, never to bill anything.
 * @param text - The text to measure.
 * @returns The estimated token count.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Estimated tokens for the text a tool result puts in front of the model.
 *
 * Only text is counted. An image block is left alone — shortening it produces a
 * corrupt image rather than a smaller one.
 * @param content - The result's content blocks.
 * @returns The estimated token count of the text blocks.
 */
export function estimateTextBlockTokens(content: readonly ContentBlock[]): number {
  return content.reduce(
    (total, block) => block.type === 'text' ? total + estimateTextTokens(block.text) : total,
    0,
  )
}

/** The result of shortening one oversized text. */
export interface TruncatedText {
  readonly text: string
  /** Estimated tokens the original held. */
  readonly originalTokens: number
}

/**
 * Cut the middle out of a text to fit a token budget.
 *
 * The middle goes because the two ends carry the most: a command's invocation
 * and its verdict, a file's header and its tail. Codex splits its budget the
 * same way. The marker states how much left, so the model can see that it is
 * reading a fragment rather than a short result.
 * @param text - The full text.
 * @param maxTokens - Estimated tokens the model may read.
 * @returns The shortened text and what the original held.
 */
export function truncateMiddleToTokens(text: string, maxTokens: number): TruncatedText {
  const originalTokens = estimateTextTokens(text)
  if (originalTokens <= maxTokens) return { text, originalTokens }
  const budget = Math.max(1, maxTokens * 4)
  // Two thirds to the head: a command's own output usually leads with what it
  // did, and the tail is mostly the verdict.
  const head = Math.max(1, Math.floor(budget * 0.66))
  const tail = Math.max(0, budget - head)
  const points = [...text]
  const removed = originalTokens - maxTokens
  const marker = `\n\n[... ${String(removed)} estimated tokens omitted from the middle ...]\n\n`
  return {
    text: points.slice(0, head).join('')
      + marker
      + (tail === 0 ? '' : points.slice(points.length - tail).join('')),
    originalTokens,
  }
}

/**
 * The head/tail preview shown in place of a spilled result.
 * @param text - The full text.
 * @param maxTokens - Estimated tokens the preview may hold.
 * @returns The preview.
 */
export function previewForSpill(text: string, maxTokens: number): string {
  return truncateMiddleToTokens(text, maxTokens).text
}
