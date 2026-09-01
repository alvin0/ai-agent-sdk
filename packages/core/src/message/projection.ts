/**
 * Content inspection and the text-only-model projection.
 *
 * Why the projection exists: conversation history outlives any single model
 * choice. A user attaches an image, the conversation continues, and later the
 * caller switches to a cheaper text-only model  Eor a summarizer runs on the same
 * history. Sending the image would be rejected by the provider, and silently
 * deleting it would leave the model reading a conversation that references
 * something invisible. Replacing it with a deterministic textual stand-in keeps
 * the history coherent and the request valid.
 *
 * @module ai-agent-sdk/core/message/projection
 */

import type { ContentBlock, ImageBlock } from './content.ts'
import { freezeMessage, type Message } from './message.ts'

/**
 * Whether any block in this content is (or contains) an image.
 *
 * Recurses into tool results, because a tool that returns a screenshot puts the
 * image one level down where a shallow scan would miss it.
 * @param content - the blocks to inspect.
 * @returns true when at least one image block is present at any depth.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || ((block.type === 'tool-result' || block.type === 'native-tool-call')
      && contentHasImage(block.content)))
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

/** Replace image blocks with their textual stand-in, recursing into tool results. */
function projectContent(content: readonly ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type === 'image') {
      return { type: 'text', text: textOnlyImageText(block) } satisfies ContentBlock
    }
    if ((block.type === 'tool-result' || block.type === 'native-tool-call')
      && contentHasImage(block.content)) {
      return { ...block, content: projectContent(block.content) } satisfies ContentBlock
    }
    return block
  })
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
  let changed = false
  const projected = messages.map((message) => {
    if (!contentHasImage(message.content)) return message
    changed = true
    return freezeMessage({ ...message, content: projectContent(message.content) })
  })
  return changed ? projected : messages
}
