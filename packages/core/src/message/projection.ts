/**
 * Content inspection and the text-only-model projection.
 *
 * Why the projection exists: conversation history outlives any single model
 * choice. A user attaches an image or a PDF, the conversation continues, and
 * later the caller switches to a cheaper text-only model  Eor a summarizer runs on
 * the same history. Sending the attachment would be rejected by the provider, and
 * silently deleting it would leave the model reading a conversation that
 * references something invisible. Replacing it with a deterministic textual
 * stand-in keeps the history coherent and the request valid.
 *
 * @module ai-agent-sdk/core/message/projection
 */

import type { ContentBlock, ContentBlockType, DocumentBlock, ImageBlock } from './content.ts'
import { freezeMessage, type Message } from './message.ts'

/**
 * Whether any block in this content is (or contains) a block of one type.
 *
 * Recurses into tool results, because a tool that returns a screenshot or a
 * generated PDF puts it one level down where a shallow scan would miss it.
 */
function contentHasType(content: readonly ContentBlock[], type: ContentBlockType): boolean {
  return content.some(block => block.type === type
    || ((block.type === 'tool-result' || block.type === 'native-tool-call')
      && contentHasType(block.content, type)))
}

/**
 * Whether any block in this content is (or contains) an image.
 *
 * Recurses into tool results, because a tool that returns a screenshot puts the
 * image one level down where a shallow scan would miss it.
 * @param content - the blocks to inspect.
 * @returns true when at least one image block is present at any depth.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return contentHasType(content, 'image')
}

/**
 * Whether any block in this content is (or contains) a document.
 *
 * @param content - the blocks to inspect.
 * @returns true when at least one document block is present at any depth.
 */
export function contentHasDocument(content: readonly ContentBlock[]): boolean {
  return contentHasType(content, 'document')
}

/**
 * The deterministic text that stands in for one omitted image.
 *
 * Deterministic on purpose: a stable string keeps the request prefix
 * byte-identical across turns, which is what lets provider prompt caching keep
 * working on the unchanged part of a long history.
 * @param block - the image being replaced.
 * @returns model-visible replacement text.
 */
export function textOnlyImageText(block: ImageBlock): string {
  const detail = block.source.kind === 'url'
    ? block.source.url
    : block.source.kind === 'file' ? block.source.fileId : block.source.mediaType
  return `[image omitted: the selected model does not accept image input (${detail})]`
}

/**
 * The deterministic text that stands in for one omitted document.
 *
 * Deterministic for the same prompt-caching reason as {@link textOnlyImageText}.
 * Prefers the file name when one was supplied, because "report-q3.pdf" tells the
 * model far more about what it is missing than a media type does.
 * @param block - the document being replaced.
 * @returns model-visible replacement text.
 */
export function textOnlyDocumentText(block: DocumentBlock): string {
  const detail = block.filename ?? (block.source.kind === 'url'
    ? block.source.url
    : block.source.kind === 'file' ? block.source.fileId : block.source.mediaType)
  return `[document omitted: the selected model does not accept document input (${detail})]`
}

/** Replace blocks of one type with their textual stand-in, recursing into tool results. */
function projectContent(
  content: readonly ContentBlock[],
  type: ContentBlockType,
  replacement: (block: ContentBlock) => string,
): ContentBlock[] {
  return content.map((block) => {
    if (block.type === type) {
      return { type: 'text', text: replacement(block) } satisfies ContentBlock
    }
    if ((block.type === 'tool-result' || block.type === 'native-tool-call')
      && contentHasType(block.content, type)) {
      return { ...block, content: projectContent(block.content, type, replacement) } satisfies ContentBlock
    }
    return block
  })
}

/** Project every block of one type in a message list into text. */
function projectForTextModel(
  messages: readonly Message[],
  type: ContentBlockType,
  replacement: (block: ContentBlock) => string,
): readonly Message[] {
  let changed = false
  const projected = messages.map((message) => {
    if (!contentHasType(message.content, type)) return message
    changed = true
    return freezeMessage({ ...message, content: projectContent(message.content, type, replacement) })
  })
  return changed ? projected : messages
}

/**
 * Project every image in a message list into text.
 *
 * Returns the SAME array identity when nothing changed, so callers can use a
 * reference check to skip re-freezing and re-cloning an untouched history.
 * @param messages - the conversation as assembled.
 * @returns an equivalent list whose images have become text.
 */
export function projectImagesForTextModel(
  messages: readonly Message[],
): readonly Message[] {
  return projectForTextModel(messages, 'image', block => textOnlyImageText(block as ImageBlock))
}

/**
 * Project every document in a message list into text.
 *
 * Returns the SAME array identity when nothing changed, on the same terms as
 * {@link projectImagesForTextModel}.
 * @param messages - the conversation as assembled.
 * @returns an equivalent list whose documents have become text.
 */
export function projectDocumentsForTextModel(
  messages: readonly Message[],
): readonly Message[] {
  return projectForTextModel(messages, 'document', block => textOnlyDocumentText(block as DocumentBlock))
}
