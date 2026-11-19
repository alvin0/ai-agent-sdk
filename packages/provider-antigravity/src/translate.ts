import { ModelError, ToolCallId, type ContentBlock, type UsageCounters } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolSseEvent, ProtocolStreamChunk } from '@alvin0/ai-agent-sdk-provider-http'
import { object, requiredString } from './http.ts'
import { inlineImage } from './image.ts'

interface OpenText { index: number; kind: 'text' | 'reasoning'; text: string; signature?: string }
type ChunkGenerator = Generator<ProtocolStreamChunk>

function parse(data: string): Record<string, unknown> {
  try { return object(JSON.parse(data) as unknown) }
  catch { throw new ModelError('Antigravity sent an invalid stream event', 'MALFORMED_RESPONSE') }
}

function combine(left: unknown, right: unknown, sign: number): unknown {
  if (typeof left !== 'number') return left
  if (right === undefined) return left
  return typeof right === 'number' ? left + sign * right : right
}

function mapUsage(value: unknown): UsageCounters {
  const usage = object(value)
  const mapped: Record<string, unknown> = {
    inputTokens: combine(usage.promptTokenCount, usage.cachedContentTokenCount, -1),
    outputTokens: combine(usage.candidatesTokenCount, usage.thoughtsTokenCount, 1),
    cacheReadTokens: usage.cachedContentTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
    totalTokens: usage.totalTokenCount,
  }
  return Object.fromEntries(Object.entries(mapped).filter(([, count]) => count !== undefined)) as UsageCounters
}

function partsOf(candidate: Record<string, unknown>): unknown[] {
  if (candidate.content === undefined) return []
  const parts = object(candidate.content).parts
  if (!Array.isArray(parts)) throw new ModelError('Antigravity returned invalid parts', 'MALFORMED_RESPONSE')
  return parts
}

class AntigravityStream {
  private open: OpenText | undefined
  private nextIndex = 0
  private finish: string | undefined
  private sawTool = false
  private usage: UsageCounters | undefined
  private readonly blocks: Record<string, unknown>[] = [];

  *event(envelope: Record<string, unknown>): ChunkGenerator {
    const data = envelope.response === undefined ? envelope : object(envelope.response)
    if (envelope.error !== undefined || data.error !== undefined) {
      throw new ModelError('Antigravity reported a streaming error', 'SERVER')
    }
    if (data.usageMetadata !== undefined) {
      this.usage = { ...this.usage, ...mapUsage(data.usageMetadata) }
      yield { type: 'usage-progress', usage: this.usage }
    }
    this.promptFeedback(data.promptFeedback)
    if (data.candidates !== undefined) yield* this.candidates(data.candidates)
  }

  private promptFeedback(value: unknown): void {
    if (value !== undefined && object(value).blockReason !== undefined) {
      throw new ModelError('Antigravity blocked this prompt', 'INVALID_REQUEST')
    }
  }

  private *candidates(value: unknown): ChunkGenerator {
    if (!Array.isArray(value) || value.length > 1) {
      throw new ModelError('Antigravity returned an invalid candidate list', 'MALFORMED_RESPONSE')
    }
    if (!value.length) return
    const candidate = object(value[0])
    for (const part of partsOf(candidate)) {
      if (this.finish !== undefined) {
        throw new ModelError('Antigravity sent content after completion', 'MALFORMED_RESPONSE')
      }
      yield* this.part(object(part))
    }
    if (candidate.finishReason !== undefined) this.finish = requiredString(candidate.finishReason, 'finish reason')
  }

  private *part(part: Record<string, unknown>): ChunkGenerator {
    if (part.inlineData !== undefined || part.inline_data !== undefined) yield* this.image(part)
    else if (part.functionCall !== undefined) yield* this.call(part)
    else if (typeof part.text === 'string') yield* this.text(part, part.text)
    else if (typeof part.thoughtSignature === 'string') yield* this.signature(part.thoughtSignature)
    else throw new ModelError('Antigravity returned an unsupported part', 'MALFORMED_RESPONSE')
  }

  private *image(part: Record<string, unknown>): ChunkGenerator {
    // Intermediate thinking sketches are not final images for the user.
    if (part.thought === true) return
    const block = inlineImage(part.inlineData ?? part.inline_data)
    yield* this.close()
    const index = this.nextIndex++
    const source = block.source as Extract<typeof block.source, { kind: 'base64' }>
    yield { type: 'block-start', index, blockType: 'image' }
    yield { type: 'image-delta', index, itemId: `antigravity-image-${index}`,
      data: source.data, mediaType: source.mediaType }
    yield { type: 'block-end', index, block }
    this.blocks.push({ blockType: 'image',
      ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}) })
  }

  private *signature(value: string): ChunkGenerator {
    if (this.open !== undefined) this.open.signature = value
    else if (this.blocks.length) this.blocks.at(-1)!.thoughtSignature = value
    else yield* this.text({ thought: true, thoughtSignature: value }, '')
  }

  private *text(part: Record<string, unknown>, text: string): ChunkGenerator {
    const kind = part.thought === true ? 'reasoning' : 'text'
    if (this.open?.kind !== kind || this.open.signature !== undefined
      || (text === '' && part.thoughtSignature !== undefined)) {
      yield* this.close()
      this.open = { index: this.nextIndex++, kind, text: '' }
      yield { type: 'block-start', index: this.open.index, blockType: kind }
    }
    const open = this.open!
    open.text += text
    if (typeof part.thoughtSignature === 'string') open.signature = part.thoughtSignature
    yield kind === 'reasoning' ? { type: 'reasoning-delta', index: open.index, text, kind: 'content' }
      : { type: 'text-delta', index: open.index, text }
  }

  private *call(part: Record<string, unknown>): ChunkGenerator {
    yield* this.close()
    const call = object(part.functionCall)
    const id = ToolCallId(typeof call.id === 'string' && call.id ? call.id : crypto.randomUUID())
    const name = requiredString(call.name, 'function name')
    const args = JSON.stringify(object(call.args ?? {}))
    const index = this.nextIndex++
    this.sawTool = true
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } }
    this.blocks.push(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {})
  }

  private *close(): ChunkGenerator {
    if (this.open === undefined) return
    const open = this.open
    const metadata = open.signature === undefined ? {} : { thoughtSignature: open.signature }
    const block: ContentBlock = open.kind === 'text' ? { type: 'text', text: open.text }
      : { type: 'reasoning', text: open.text, kind: 'content', providerState: metadata }
    yield { type: 'block-end', index: open.index, block }
    this.blocks.push(metadata)
    this.open = undefined
  }

  *end(): ChunkGenerator {
    if (this.finish === undefined) throw new ModelError('Antigravity stream ended before completion', 'STREAM_CLOSED')
    if (this.finish !== 'STOP' && this.finish !== 'MAX_TOKENS') {
      throw new ModelError('Antigravity generation was blocked or failed', 'INVALID_REQUEST')
    }
    yield* this.close()
    if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
    let kind: 'stop' | 'tool-calls' | 'max-tokens' = this.sawTool ? 'tool-calls' : 'stop'
    if (this.finish === 'MAX_TOKENS') kind = 'max-tokens'
    yield { type: 'finish', reason: { kind },
      replayState: { response: { protocol: 'antigravity' }, blocks: this.blocks } }
  }
}

/** Cloud Code GenerateContent SSE, with lossless signatures for the next tool turn. */
export async function* translateAntigravityStream(
  events: AsyncIterable<ProtocolSseEvent>,
): AsyncGenerator<ProtocolStreamChunk> {
  const state = new AntigravityStream()
  for await (const event of events) {
    if (event.data !== '[DONE]') yield* state.event(parse(event.data))
  }
  yield* state.end()
}
