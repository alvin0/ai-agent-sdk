import { ModelError } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk, UsageCounters } from '@alvin0/ai-agent-sdk-core/provider'
import { abortable, throwIfAborted } from './async.ts'
import { decisionError, snapshotJson } from './validation.ts'
import { OUTPUT_NAME } from './llm-schema.ts'

interface StreamOptions { readonly mode: 'json-schema' | 'tool'; readonly maxBytes: number }

export async function readDecisionStream(
  iterator: AsyncIterator<StreamChunk>, signal: AbortSignal, options: StreamOptions,
) {
  const output = new DecisionStreamOutput(options)
  while (true) {
    const next = await abortable(iterator.next(), signal)
    throwIfAborted(signal)
    if (next.done) return output
    output.accept(next.value)
  }
}

class DecisionStreamOutput {
  readonly closed = true
  readonly texts: string[] = []
  readonly tools: string[] = []
  finished = false
  usage: UsageCounters | undefined
  private readonly indices = new Set<number>()
  private readonly encoder = new TextEncoder()
  private deltaBytes = 0
  private blockBytes = 0
  private chunks = 0

  constructor(private readonly options: StreamOptions) {}

  accept(chunk: StreamChunk): void {
    if (this.finished || ++this.chunks > 100_000) decisionError('Invalid LLM decision stream sequence', true)
    this.countDelta(chunk)
    this.assertContent(chunk)
    if (chunk.type === 'block-end') this.acceptBlock(chunk)
    if (chunk.type === 'usage') this.acceptUsage(chunk)
    if (chunk.type === 'finish') this.acceptFinish(chunk)
  }

  private count(text: string, authoritative = false): void {
    const bytes = this.encoder.encode(text).byteLength
    if (authoritative) this.blockBytes += bytes
    else this.deltaBytes += bytes
    if (Math.max(this.deltaBytes, this.blockBytes) > this.options.maxBytes) decisionError(
      'LLM decision response exceeds byte limit', true)
  }

  private countDelta(chunk: StreamChunk): void {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') this.count(chunk.text)
    if (chunk.type === 'tool-call-delta') this.count(chunk.argumentsDelta)
  }

  private assertContent(chunk: StreamChunk): void {
    if (chunk.type === 'image-delta' || (chunk.type === 'block-start' && !['text', 'reasoning',
      'tool-call'].includes(chunk.blockType))) decisionError('Unexpected LLM decision content', true)
  }

  private acceptBlock(chunk: Extract<StreamChunk, { type: 'block-end' }>): void {
    if (this.indices.has(chunk.index)) decisionError('Duplicate LLM decision block', true)
    this.indices.add(chunk.index)
    const block = chunk.block
    if (block.type === 'text') {
      this.count(block.text, true)
      this.texts.push(block.text)
    } else if (block.type === 'tool-call') {
      this.count(block.arguments, true)
      if (block.name !== OUTPUT_NAME) decisionError('Unexpected LLM decision tool', true)
      this.tools.push(block.arguments)
    } else if (block.type === 'reasoning') this.count(block.text, true)
    else decisionError('Unexpected LLM decision content', true)
  }

  private acceptUsage(chunk: Extract<StreamChunk, { type: 'usage' }>): void {
    if (this.usage !== undefined) decisionError('Duplicate LLM decision usage', true)
    try { this.usage = snapshotJson(chunk.usage) }
    catch { decisionError('Invalid LLM decision usage', true) }
  }

  private acceptFinish(chunk: Extract<StreamChunk, { type: 'finish' }>): void {
    if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
      const failure = chunk.reason.failure
      throw new ModelError('LLM decision generation failed', failure.code, { ...failure })
    }
    if (chunk.reason.kind !== (this.options.mode === 'tool' ? 'tool-calls' : 'stop')) decisionError(
      'LLM decision generation did not complete successfully', true)
    this.finished = true
  }
}
