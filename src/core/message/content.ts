/**
 * Content blocks: the provider-neutral pieces a message is made of.
 *
 * The union is merge-extensible — derived from {@link ContentBlockMap}, so a
 * third-party adapter can widen it by declaration merging without forking the
 * core. The consequence for consumers is a rule, not a suggestion: switch on
 * `type` and FALL THROUGH unknown values, because a block you have never seen is
 * a valid thing to receive.
 *
 * @module ai-agent-sdk/core/message/content
 */

import type { ToolCallId } from '../primitives/brand.ts'
import type { JsonValue } from '../primitives/json.ts'

/** Whether assistant text is interim narration or the terminal answer. */
export type AssistantTextPhase = 'commentary' | 'final-answer'

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
  /** Provider-supplied or loop-inferred phase for assistant text. */
  phase?: AssistantTextPhase
  /** Provider-returned citations and other public annotations. */
  annotations?: readonly TextAnnotation[]
}

export interface UrlCitationAnnotation {
  type: 'url-citation'
  url: string
  title?: string
  startIndex?: number
  endIndex?: number
  /** Adapter-private citation payload needed for byte-faithful replay. */
  providerState?: unknown
}

export interface TextAnnotationMap {
  'url-citation': UrlCitationAnnotation
}

export type TextAnnotation = TextAnnotationMap[keyof TextAnnotationMap]

/**
 * Reasoning / thinking content, kept distinct from visible text.
 *
 * `providerState` exists for a concrete reason: Anthropic requires a response's
 * thinking block to be echoed back byte-identically, with its signature, on the
 * next request of a tool-use loop. Dropping it degrades quality and can be
 * rejected outright, so the block carries whatever the adapter needs to
 * reconstruct itself. The value is adapter-private and opaque above that layer.
 */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
  /** Adapter-private lossless state needed to replay this block on a later request. */
  providerState?: unknown
}

/** Raster image media types both supported providers accept. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

/**
 * Where an image's bytes come from.
 *
 * Inline rather than a handle into a durable attachment store, because an SDK
 * cannot assume its host has one. A consumer that does have durable storage
 * resolves its own reference into one of these before building the request.
 */
export type ImageSource =
  | { kind: 'base64'; mediaType: ImageMediaType; data: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileId: string }

export type ImageDetail = 'auto' | 'low' | 'high' | 'original'

/** An image, valid in user content and echoed in assistant content. */
export interface ImageBlock {
  type: 'image'
  source: ImageSource
  detail?: ImageDetail
}

/** A tool the provider ran internally, such as web search or image generation. */
export interface NativeToolCallBlock {
  type: 'native-tool-call'
  /** Provider item id, used for replay and GUI correlation. */
  id: string
  /** Neutral tool name (`web-search`, `image-generation`, or an extension). */
  name: string
  status?: string
  arguments?: JsonValue
  /** Public result content, including generated images. */
  content: ContentBlock[]
  /** Adapter-private item needed for stateless replay. */
  providerState?: unknown
}

/** A tool invocation requested by the model. */
export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: ToolCallId
  name: string
  /**
   * Arguments as the RAW JSON string the model produced.
   *
   * Deliberately not parsed here. Models emit invalid JSON often enough that
   * parsing at the transport boundary would turn a recoverable "tell the model it
   * sent bad arguments" into an unrecoverable stream failure. The tool layer
   * parses, and reports any error back into the conversation.
   */
  arguments: string
}

/** The result of a tool invocation, sent back to the model. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: ToolCallId
  content: ContentBlock[]
  isError?: boolean
}

/**
 * Merge-extensible content blocks keyed by `type`. Widen by declaration merging
 * this interface; a new CORE block must land with support in every adapter.
 */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'native-tool-call': NativeToolCallBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

/** The block `type` tag vocabulary; widens with {@link ContentBlockMap}. */
export type ContentBlockType = keyof ContentBlockMap

/** Any known content block. Switch on `type` and fall through unknowns. */
export type ContentBlock = ContentBlockMap[ContentBlockType]
