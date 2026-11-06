/**
 * Append-only text built from streamed deltas.
 *
 * `text += delta` makes V8 keep one rope node per delta for as long as the
 * result lives, so a long stream retained several times its own text size.
 * Deltas are collected instead and joined into a flat string every
 * {@link TEXT_ACCUMULATOR_CHUNK} parts, leaving one node per chunk.
 *
 * @module ai-agent-sdk/core/stream/text-accumulator
 */

/** Deltas buffered before they are joined into one flat string. */
const TEXT_ACCUMULATOR_CHUNK = 256

/** Collects streamed text deltas; read the whole text with {@link TextAccumulator.text}. */
export class TextAccumulator {
  private head: string
  private parts: string[] = []
  private size: number

  /** @param initial - text the block already carries before any delta. */
  constructor(initial = '') {
    this.head = initial
    this.size = initial.length
  }

  /** Append one delta. */
  append(delta: string): void {
    if (delta.length === 0) return
    this.parts.push(delta)
    this.size += delta.length
    if (this.parts.length >= TEXT_ACCUMULATOR_CHUNK) this.compact()
  }

  /** Length of the accumulated text, in UTF-16 code units. */
  get length(): number {
    return this.size
  }

  /** The accumulated text. */
  get text(): string {
    this.compact()
    return this.head
  }

  private compact(): void {
    if (this.parts.length === 0) return
    this.head += this.parts.join('')
    this.parts = []
  }
}
