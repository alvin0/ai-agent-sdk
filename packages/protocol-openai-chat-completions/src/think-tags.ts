/**
 * Split a leading `<think>…</think>` block out of streamed `content`.
 *
 * Local servers (llama.cpp without a reasoning parser, LM Studio, Ollama, some
 * vLLM deployments) often hand a reasoning model's thoughts back INSIDE
 * `content`, wrapped in `<think>` tags, instead of on a separate
 * `reasoning_content` / `reasoning` field. Left alone, those thoughts reach the
 * caller as answer text and are replayed to the model as something it said
 * out loud.
 *
 * Only a block that OPENS the content is treated as reasoning. A tag appearing
 * later is ordinary text — a model explaining the tag, for instance — and
 * guessing otherwise would silently eat part of an answer. Tags can be split
 * across stream fragments, so a fragment that could still be the start of a tag
 * is held back until the next one resolves it.
 *
 * Not handled: a template that puts the opening `<think>` in the PROMPT, so the
 * output starts mid-thought and only carries `</think>`. Recognising that would
 * mean holding back the whole answer until the close tag or the end of the
 * stream; such output stays text. Run the server with a reasoning parser.
 *
 * @module ai-agent-sdk/protocols/openai-chat-completions/think-tags
 */

const OPEN = '<think>'
const CLOSE = '</think>'

/** One piece of classified content, in stream order. */
export interface ThinkSegment {
  readonly kind: 'reasoning' | 'text'
  readonly text: string
}

type Mode = 'detect' | 'think' | 'after-think' | 'text'

/** Streaming splitter; one instance per response. */
export class LeadingThinkSplitter {
  private mode: Mode = 'detect'
  private buffer = ''
  /** Whether any non-whitespace reasoning has been released yet. */
  private thinking = false

  push(chunk: string): ThinkSegment[] {
    switch (this.mode) {
      case 'text': return chunk.length === 0 ? [] : [{ kind: 'text', text: chunk }]
      case 'detect': return this.detect(chunk)
      case 'think': return this.think(chunk)
      case 'after-think': return this.afterThink(chunk)
    }
  }

  /** Release whatever is still held back once the stream has ended. */
  flush(): ThinkSegment[] {
    const held = this.buffer
    this.buffer = ''
    // Whitespace alone carries nothing; emitting it would open an empty block,
    // after any tool call that arrived in the meantime.
    if (held.trim().length === 0) return []
    // Inside a think block only a possible `</think>` prefix is ever held (the
    // rest of an unterminated thought was already released as reasoning), so a
    // cut-off close tag is dropped. An undecided prefix such as `<thi` is text.
    if (this.mode === 'think') return []
    return [{ kind: 'text', text: held }]
  }

  private detect(chunk: string): ThinkSegment[] {
    this.buffer += chunk
    const trimmed = this.buffer.trimStart()
    if (trimmed.length === 0) return []
    if (trimmed.startsWith(OPEN)) {
      this.mode = 'think'
      this.buffer = ''
      return this.think(trimmed.slice(OPEN.length))
    }
    if (OPEN.startsWith(trimmed)) return [] // still possibly a tag; wait
    this.mode = 'text'
    const text = this.buffer
    this.buffer = ''
    return [{ kind: 'text', text }]
  }

  private think(chunk: string): ThinkSegment[] {
    // Leading whitespace is template padding (`<think>\n`); dropping it keeps an
    // empty think block — thinking disabled — from producing a blank thought.
    this.buffer += chunk
    if (!this.thinking) this.buffer = this.buffer.trimStart()
    const close = this.buffer.indexOf(CLOSE)
    if (close >= 0) {
      const reasoning = this.buffer.slice(0, close)
      const rest = this.buffer.slice(close + CLOSE.length)
      this.buffer = ''
      this.mode = 'after-think'
      return [
        ...reasoning.trim().length === 0 ? [] : [{ kind: 'reasoning' as const, text: reasoning }],
        ...this.afterThink(rest),
      ]
    }
    const hold = partialSuffix(this.buffer, CLOSE)
    const ready = this.buffer.slice(0, this.buffer.length - hold)
    this.buffer = this.buffer.slice(this.buffer.length - hold)
    if (ready.length === 0) return []
    this.thinking = true
    return [{ kind: 'reasoning', text: ready }]
  }

  /**
   * Drop the line breaks a template puts between `</think>` and the answer.
   * Only line breaks: leading spaces may be the answer's own indentation.
   */
  private afterThink(chunk: string): ThinkSegment[] {
    const text = chunk.replace(/^(?:\r?\n)+/, '')
    if (text.length === 0) return []
    this.mode = 'text'
    return [{ kind: 'text', text }]
  }
}

/** Length of the longest suffix of `value` that is a proper prefix of `tag`. */
function partialSuffix(value: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, value.length); length > 0; length--) {
    if (value.endsWith(tag.slice(0, length))) return length
  }
  return 0
}
