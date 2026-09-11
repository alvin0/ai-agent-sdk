/** Provider-neutral deterministic context estimator used by compaction policy. */

import type { ModelToolSchema } from '../../contract/index.ts'
import type { ContentBlock, ImageDetail } from '../../message/index.ts'
import type { Message } from '../../message/index.ts'

export function estimateContextTokens(input: {
  readonly system?: string
  readonly messages: readonly Message[]
  readonly tools?: readonly ModelToolSchema[]
}): number {
  const system = input.system === undefined ? 0 : estimateTextTokens(input.system)
  const messages = input.messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
  const tools = input.tools?.reduce((total, tool) => total + estimateTextTokens(safeJson(tool)) + 8, 0) ?? 0
  return system + messages + tools + 8
}

export function estimateMessageTokens(message: Message | undefined): number {
  if (message === undefined) return 0
  return 4 + message.content.reduce((total, block) => total + estimateBlockTokens(block), 0)
}

function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text': return estimateTextTokens(block.text) + 2
    case 'reasoning': return estimateTextTokens(block.text) + estimateTextTokens(safeJson(block.providerState)) + 2
    case 'image': return estimateImageTokens(block.detail)
    case 'document': return estimateDocumentTokens(block.pages)
    case 'tool-call': return estimateTextTokens(block.name) + estimateTextTokens(block.arguments) + 8
    case 'tool-result': return block.content.reduce((total, child) => total + estimateBlockTokens(child), 8)
    case 'native-tool-call': return estimateTextTokens(safeJson(block)) + 8
    default: return estimateTextTokens(safeJson(block)) + 4
  }
}

/*
 * How providers actually price attached content, and why none of it involves
 * payload size.
 *
 * An image costs by PIXEL AREA and a PDF costs by PAGE COUNT:
 *   - OpenAI covers an image with 32x32 patches and bills
 *     `ceil(w/32) * ceil(h/32)` patches times a model multiplier (1.2 on current
 *     models), after first resizing the image into the selected detail level's
 *     patch budget.
 *   - Anthropic bills an image at roughly `(w * h) / 750`, and a PDF at 1,500 to
 *     3,000 tokens per page — extracted text plus a rendered image of the page.
 *   - Gemini tiles an image at 258 tokens per 768x768 tile, and averages about 258
 *     tokens per PDF page.
 *
 * Base64 length is not a usable proxy for either, and not merely an imprecise one:
 * a 5 KB PDF can hold fifty pages of text while a 5 MB PDF can hold two scanned
 * ones, so bytes bound the true cost in NEITHER direction. The same holds for
 * images, where a small JPEG can carry far more pixels than a large PNG.
 *
 * So the estimate is built from the sizing facts a block actually carries, and the
 * residual unknown is resolved to the provider-documented UPPER bound. That bias
 * is deliberate and follows from the only consumer being compaction policy:
 * over-estimating compacts earlier than strictly necessary and costs some
 * history, while under-estimating overflows the real context window and fails the
 * request outright.
 */

/**
 * Patch budget each detail level resizes into, from OpenAI's published sizing
 * table. A block carries `detail` but never pixel dimensions, so the budget — the
 * most an image at that level can cost — stands in for the unknown area.
 */
const IMAGE_PATCH_BUDGET: Record<ImageDetail, number> = {
  // `low` fits the image inside a 512x512 box, which is 16x16 patches.
  low: 256,
  high: 2_500,
  // `auto` resolves to high-detail sizing on current models.
  auto: 2_500,
  original: 10_000,
}

/** Per-patch multiplier applied by current vision models. */
const IMAGE_TOKEN_MULTIPLIER = 1.2

/**
 * Upper end of Anthropic's documented per-page PDF cost.
 *
 * The highest of the three providers, so it bounds all of them. Measured against
 * a real 72-page PDF: OpenAI billed 214,019 input tokens (~2,970 per page, within
 * 1% of this constant) and Gemini billed 38,350 (~533 per page).
 */
const TOKENS_PER_DOCUMENT_PAGE = 3_000

/**
 * Pages assumed for a document that did not declare a count.
 *
 * A deliberate assumption, not a measurement: nothing on the block can reveal the
 * page count, and parsing the file to find it does not belong in an estimator.
 *
 * Be aware of the consequence, which is measured rather than theoretical: the
 * 72-page sample above really costs ~214k tokens, so this default under-states it
 * by roughly 9x. Any caller that can know the count should set
 * {@link DocumentBlock.pages}; with it, the estimate above came within 1% of the
 * figure the provider actually billed.
 */
const ASSUMED_DOCUMENT_PAGES = 8

function estimateImageTokens(detail: ImageDetail | undefined): number {
  return Math.ceil(IMAGE_PATCH_BUDGET[detail ?? 'auto'] * IMAGE_TOKEN_MULTIPLIER)
}

function estimateDocumentTokens(pages: number | undefined): number {
  const count = pages !== undefined && Number.isSafeInteger(pages) && pages > 0
    ? pages
    : ASSUMED_DOCUMENT_PAGES
  return count * TOKENS_PER_DOCUMENT_PAGE
}

function estimateTextTokens(text: string): number { return Math.ceil(text.length / 4) }
function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}
