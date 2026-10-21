import type { ContentBlock, ImageBlock, ImageMediaType, Message, TextBlock } from '../../message/index.ts'
import type { HistoryEvent } from './types.ts'
import { serializedByteLength } from './image-retention-size.ts'

export const MAX_IMAGE_RETENTION_KEEP_LATEST = 100_000
export const MAX_IMAGE_RETENTION_PLACEHOLDER_CHARS = 512
export const DEFAULT_IMAGE_RETENTION_PLACEHOLDER = '[Image omitted by retention policy.]'

export interface ImageRetentionInfo {
  readonly sourceKind: ImageBlock['source']['kind']
  readonly mediaType?: ImageMediaType
  readonly detail?: ImageBlock['detail']
  /** Serialized UTF-8 size of the image block, without exposing its source data. */
  readonly serializedBytes: number
}

export type ImageRetentionPlaceholder = string | Pick<TextBlock, 'type' | 'text'>
export type ImageRetentionPlaceholderFactory = (info: ImageRetentionInfo) => ImageRetentionPlaceholder

/** Per-session, provider-neutral retention for inline image blocks. */
export interface ImageRetentionOptions {
  /** Maximum image blocks retained in any model request. Zero removes all image blocks. */
  readonly keepLatest: number
  /** Replace old images in snapshots and in-memory history as they age out. Defaults to 'keep'. */
  readonly persist?: 'keep' | 'drop-pruned'
  /** Stable model-facing text. The default is identical for every pruned image. */
  readonly placeholder?: ImageRetentionPlaceholderFactory
}

export interface ResolvedImageRetentionOptions {
  readonly keepLatest: number
  readonly persist: 'keep' | 'drop-pruned'
  readonly placeholder: ImageRetentionPlaceholderFactory
}

interface CachedImageProjection {
  readonly serializedBytes: number
  readonly placeholder: TextBlock
  readonly placeholderBytes: number
}

const resolvedPolicies = new WeakMap<ImageRetentionOptions, ResolvedImageRetentionOptions>()
const imageProjectionCaches = new WeakMap<
  ResolvedImageRetentionOptions, WeakMap<ImageBlock, CachedImageProjection>
>()
const runPolicies = new WeakMap<object, ResolvedImageRetentionOptions | undefined>()

export interface ImageRetentionMetrics {
  readonly imagesPruned: number
  /** Serialized UTF-8 bytes removed, floored at zero when a custom placeholder is longer. */
  readonly bytesSaved: number
}

export interface ImageRetentionSnapshot extends ImageRetentionMetrics {
  readonly keepLatest: number
  readonly persist: 'keep' | 'drop-pruned'
  readonly imagesRetained: number
  /** Cumulative images replaced in model requests (one count per request projection). */
  readonly requestImagesPruned: number
  readonly requestBytesSaved: number
  /** Cumulative image blocks removed from persisted history and snapshots. */
  readonly persistedImagesPruned: number
  readonly persistedBytesSaved: number
}

export function resolveImageRetention(
  input: ImageRetentionOptions | undefined,
): ResolvedImageRetentionOptions | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'object' || input === null) throw new TypeError('imageRetention must be an object')
  const cached = resolvedPolicies.get(input)
  // The cache is keyed by object identity, so a caller that mutates its options
  // object after first use must get a freshly validated policy, not the stale one.
  if (cached !== undefined && resolvesTo(input, cached)) return cached
  validateImageRetention(input)
  const resolved = Object.freeze({
    keepLatest: input.keepLatest,
    persist: input.persist ?? 'keep',
    placeholder: input.placeholder ?? defaultPlaceholder,
  })
  resolvedPolicies.set(input, resolved)
  resolvedPolicies.set(resolved, resolved)
  return resolved
}

/** Bind one captured retention policy to a model run so rounds reuse its resolution. */
export function captureRunImageRetention(
  runOptions: object,
  input: ImageRetentionOptions | undefined,
): void {
  runPolicies.set(runOptions, resolveImageRetention(input))
}

/** Resolve only for unsnapshotted internal callers; normal runs use the captured entry. */
export function imageRetentionForRun(
  runOptions: object,
  fallback: ImageRetentionOptions | undefined,
): ResolvedImageRetentionOptions | undefined {
  return runPolicies.has(runOptions) ? runPolicies.get(runOptions) : resolveImageRetention(fallback)
}

function resolvesTo(input: ImageRetentionOptions, resolved: ResolvedImageRetentionOptions): boolean {
  return input === resolved || (input.keepLatest === resolved.keepLatest
    && (input.persist ?? 'keep') === resolved.persist
    && (input.placeholder ?? defaultPlaceholder) === resolved.placeholder)
}

function validateImageRetention(input: ImageRetentionOptions): void {
  if (!Number.isSafeInteger(input.keepLatest) || input.keepLatest < 0
    || input.keepLatest > MAX_IMAGE_RETENTION_KEEP_LATEST) {
    throw new RangeError(`imageRetention.keepLatest must be an integer from 0 to ${MAX_IMAGE_RETENTION_KEEP_LATEST}`)
  }
  if (input.persist !== undefined && input.persist !== 'keep' && input.persist !== 'drop-pruned') {
    throw new TypeError("imageRetention.persist must be 'keep' or 'drop-pruned'")
  }
  if (input.placeholder !== undefined && typeof input.placeholder !== 'function') {
    throw new TypeError('imageRetention.placeholder must be a function')
  }
}

export function countImages(value: unknown): number {
  let count = 0
  visitImages(value, () => { count++ })
  return count
}

export function retainLatestImagesInMessages(
  messages: readonly Message[],
  policy: ResolvedImageRetentionOptions,
): {
  readonly messages: readonly Message[]
  readonly metrics: ImageRetentionMetrics
  readonly serializedBytesDelta: number
} {
  const count = countImages(messages)
  const pruneCount = Math.max(0, count - policy.keepLatest)
  if (pruneCount === 0) return { messages, metrics: EMPTY_METRICS, serializedBytesDelta: 0 }
  const state = createMutation(pruneCount)
  const projected = messages.map(message => {
    const content = mapBlocks(message.content, policy, state)
    return content === message.content ? message : Object.freeze({ ...message, content })
  })
  return {
    messages: Object.freeze(projected),
    metrics: metricsOf(state),
    serializedBytesDelta: state.serializedBytesDelta,
  }
}

export function retainLatestImagesInEvent(
  event: HistoryEvent,
  pruneCount: number,
  policy: ResolvedImageRetentionOptions,
): {
  readonly event: HistoryEvent
  readonly metrics: ImageRetentionMetrics
  readonly serializedBytesDelta: number
} {
  if (pruneCount < 1) return { event, metrics: EMPTY_METRICS, serializedBytesDelta: 0 }
  const state = createMutation(Math.min(pruneCount, countImages(event)))
  const next = mapEventMessage(event, policy, state)
  return { event: next, metrics: metricsOf(state), serializedBytesDelta: state.serializedBytesDelta }
}

interface ImageMutation {
  remaining: number
  imagesPruned: number
  bytesSaved: number
  serializedBytesDelta: number
}

function createMutation(remaining: number): ImageMutation {
  return { remaining, imagesPruned: 0, bytesSaved: 0, serializedBytesDelta: 0 }
}

function metricsOf(state: ImageMutation): ImageRetentionMetrics {
  return Object.freeze({ imagesPruned: state.imagesPruned, bytesSaved: state.bytesSaved })
}

function mapEventMessage(
  event: HistoryEvent,
  policy: ResolvedImageRetentionOptions,
  state: ImageMutation,
): HistoryEvent {
  if (event.kind !== 'user' && event.kind !== 'assistant' && event.kind !== 'tool-result') return event
  const message = mapMessage(event.message, policy, state)
  if (event.kind !== 'tool-result') {
    return message === event.message ? event : Object.freeze({ ...event, message })
  }
  return mapResultContext(event, message, policy, state)
}

function mapResultContext(
  event: Extract<HistoryEvent, { kind: 'tool-result' }>, message: Message,
  policy: ResolvedImageRetentionOptions, state: ImageMutation,
): HistoryEvent {
  const duplicateState = createMutation(state.imagesPruned)
  const content = mapBlocks(event.result.content, policy, duplicateState)
  state.bytesSaved += duplicateState.bytesSaved
  state.serializedBytesDelta += duplicateState.serializedBytesDelta
  const additionalContext = event.result.additionalContext === undefined ? undefined
    : mapBlocks(event.result.additionalContext, policy, state)
  const result = content === event.result.content && additionalContext === event.result.additionalContext
    ? event.result : Object.freeze({ ...event.result, content,
      ...additionalContext === undefined ? {} : { additionalContext } })
  return message === event.message && result === event.result
    ? event : Object.freeze({ ...event, message, result })
}

function mapMessage(
  message: Message,
  policy: ResolvedImageRetentionOptions,
  state: ImageMutation,
): Message {
  const content = mapBlocks(message.content, policy, state)
  return content === message.content ? message : Object.freeze({ ...message, content })
}

const EMPTY_METRICS: ImageRetentionMetrics = Object.freeze({ imagesPruned: 0, bytesSaved: 0 })

function defaultPlaceholder(): string { return DEFAULT_IMAGE_RETENTION_PLACEHOLDER }

function mapBlocks(
  blocks: readonly ContentBlock[],
  policy: ResolvedImageRetentionOptions,
  state: ImageMutation,
): readonly ContentBlock[] {
  let changed = false
  const projected = blocks.map(block => {
    if (block.type === 'image') {
      if (state.remaining === 0) return block
      const replacement = projectImagePlaceholder(block, policy)
      state.remaining--
      state.imagesPruned++
      recordByteDelta(state, replacement.serializedBytes - replacement.placeholderBytes)
      changed = true
      return replacement.placeholder
    }
    if (block.type === 'tool-result' || block.type === 'native-tool-call') {
      const content = mapBlocks(block.content, policy, state)
      if (content !== block.content) {
        changed = true
        return Object.freeze({ ...block, content: [...content] })
      }
    }
    return block
  })
  return changed ? Object.freeze(projected) : blocks
}

function recordByteDelta(state: ImageMutation, delta: number): void {
  state.serializedBytesDelta += delta
  state.bytesSaved += Math.max(0, delta)
}

function projectImagePlaceholder(image: ImageBlock, policy: ResolvedImageRetentionOptions): CachedImageProjection {
  const cache = imageProjectionCache(policy)
  const cached = cache.get(image)
  if (cached !== undefined) return cached

  const serializedBytes = serializedByteLength(image)
  const info = imageRetentionInfo(image, serializedBytes)
  const bounded = imagePlaceholderText(policy, info)
  const projection = Object.freeze({
    serializedBytes,
    placeholder: Object.freeze({ type: 'text' as const, text: bounded }),
    placeholderBytes: serializedByteLength({ type: 'text', text: bounded }),
  })
  cache.set(image, projection)
  return projection
}

function imageProjectionCache(
  policy: ResolvedImageRetentionOptions,
): WeakMap<ImageBlock, CachedImageProjection> {
  let cache = imageProjectionCaches.get(policy)
  if (cache === undefined) {
    cache = new WeakMap()
    imageProjectionCaches.set(policy, cache)
  }
  return cache
}

function imageRetentionInfo(image: ImageBlock, serializedBytes: number): ImageRetentionInfo {
  return Object.freeze({
    sourceKind: image.source.kind,
    ...(image.source.kind === 'base64' ? { mediaType: image.source.mediaType } : {}),
    ...(typeof image.detail === 'string' ? { detail: image.detail } : {}),
    serializedBytes,
  })
}

function imagePlaceholderText(
  policy: ResolvedImageRetentionOptions,
  info: ImageRetentionInfo,
): string {
  let rendered: ImageRetentionPlaceholder
  try { rendered = policy.placeholder(info) }
  catch { rendered = DEFAULT_IMAGE_RETENTION_PLACEHOLDER }
  let text = DEFAULT_IMAGE_RETENTION_PLACEHOLDER
  if (typeof rendered === 'string') text = rendered
  else if (rendered?.type === 'text' && typeof rendered.text === 'string') text = rendered.text
  return text.length > MAX_IMAGE_RETENTION_PLACEHOLDER_CHARS
    ? text.slice(0, MAX_IMAGE_RETENTION_PLACEHOLDER_CHARS)
    : text
}

function visitImages(value: unknown, onImage: (image: ImageBlock) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitImages(item, onImage)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const block = value as Partial<ContentBlock>
  if (block.type === 'image') { onImage(block as ImageBlock); return }
  const content = (block as { readonly content?: unknown }).content
  if (Array.isArray(content)) {
    if (replaceableContainer(block)) visitImages(content, onImage)
  } else if ('message' in block && block.message !== undefined) {
    visitImages(block.message, onImage)
    // A tool's context is also retained in its result receipt, in addition to
    // the separate app message. Account for both stored copies when pruning.
    visitResultContext(block, onImage)
  }
}

/**
 * Descend only where mapBlocks can replace (messages, tool results, native tool
 * calls). Counting an image inside an extension block would make pruning skip
 * an old image and replace a newer one instead.
 */
function replaceableContainer(block: Partial<ContentBlock>): boolean {
  return block.type === undefined || block.type === 'tool-result' || block.type === 'native-tool-call'
}

function visitResultContext(value: unknown, onImage: (image: ImageBlock) => void): void {
  const result = (value as { readonly result?: { readonly additionalContext?: unknown } }).result
  if (Array.isArray(result?.additionalContext)) visitImages(result.additionalContext, onImage)
}
