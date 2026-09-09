/**
 * The single canonical chunk-to-message assembly algorithm.
 *
 * Every consumer that needs a finished message from a stream uses this, so that
 * "what the user saw streaming" and "what got stored in history" cannot drift
 * apart. Feed it every chunk, then read {@link BlockAssembler.blocks},
 * {@link BlockAssembler.message}, `usage`, and `finish` once the stream ends  Eor
 * {@link BlockAssembler.interruptedBlocks} when cancellation cut it short.
 *
 * @module ai-agent-sdk/core/stream/assembler
 */

import type { AssistantTextPhase, ContentBlock } from '../message/content.ts'
import { createMessage, type Message, type MessageSource } from '../message/message.ts'
import { ToolCallId } from '../primitives/brand.ts'
import { assertNever } from '../primitives/never.ts'
import type { FinishReason, ReplayEnvelope, StreamChunk, TokenUsage } from './chunk.ts'

interface PartialBlock {
  blockType: string
  text: string
  textPhase?: AssistantTextPhase
  toolCallId?: ToolCallId
  toolCallName?: string
  toolCallArguments: string
  /** Set by `block-end`  Eauthoritative, and freezes this partial against further deltas. */
  block?: ContentBlock
}

/**
 * Incrementally assembles {@link StreamChunk}s into {@link ContentBlock}s and a
 * final assistant {@link Message}.
 *
 * Tolerant by design: it accepts delta-only protocols that never send
 * `block-start`, and it IGNORES deltas that arrive for an index already closed by
 * `block-end`. That last rule is a containment boundary  Ea misbehaving adapter
 * cannot grow memory without bound or corrupt a block a consumer has already
 * been told is final.
 */
export class BlockAssembler {
  private partials = new Map<number, PartialBlock>()
  /** Block indexes in FIRST-SEEN order; the stream's own ordering, not sorted. */
  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined
  private _replayState: ReplayEnvelope | undefined

  /**
   * Feed one chunk into the assembly state.
   * @param chunk - the next chunk, in stream order.
   */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block !== undefined) return // closed by block-end; ignore stragglers
        partial.text += chunk.text
        if (chunk.type === 'text-delta' && chunk.phase !== undefined) partial.textPhase = chunk.phase
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block !== undefined) return // closed by block-end; ignore stragglers
        partial.toolCallId = chunk.id
        if (chunk.name !== undefined && chunk.name.length > 0) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'image-delta':
        // Progressive images are presentation-only. The authoritative final
        // image arrives inside the native-tool-call `block-end`.
        return
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        // First close wins. Ignoring re-close stragglers keeps the streamed
        // output and the final assembled block in agreement.
        if (partial.block !== undefined) return
        partial.block = chunk.block
        return
      }
      case 'usage': {
        this._usage = chunk.usage
        return
      }
      case 'finish': {
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        return
      }
      default:
        return assertNever(chunk, 'BlockAssembler.push')
    }
  }

  private ensure(index: number, blockType: string): PartialBlock {
    let partial = this.partials.get(index)
    if (partial === undefined) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block !== undefined) return partial.block
    switch (partial.blockType) {
      case 'text': return {
        type: 'text',
        text: partial.text,
        ...partial.textPhase === undefined ? {} : { phase: partial.textPhase },
      }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        // A synthesized id keeps the result correlatable even from a provider
        // that only sent the id on a chunk we never received.
        id: partial.toolCallId ?? ToolCallId(`call-${index}`),
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments,
      }
      default:
        // An extension block type that never received its authoritative
        // `block-end`: only the adapter that invented it knows how to build one.
        throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  /** Invariant accessor: every index in `order` has a partial. */
  private mustGet(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (partial === undefined) {
      throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    }
    return partial
  }

  /**
   * The ONE keep/drop decision over all seen blocks, so emitted blocks and
   * replay metadata cannot disagree about what survived.
   *
   * Max-token truncation drops tool calls: a call cut off mid-arguments has
   * incomplete JSON, and executing it would act on arguments the model never
   * finished choosing.
   */
  private assembled(): { blocks: ContentBlock[]; replay: ReplayEnvelope | undefined } {
    const all = this.order.map(index => this.assemble(this.mustGet(index), index))
    const kept = this.finish.kind === 'max-tokens'
      ? all.map(block => block.type !== 'tool-call')
      : undefined
    const blocks = kept === undefined ? all : all.filter((_, position) => kept[position] === true)
    const envelope = this._replayState
    if (envelope?.blocks === undefined) return { blocks, replay: envelope }
    // A per-block envelope that does not line up with the blocks it describes is
    // discarded whole: a misaligned mapping is worse than no mapping.
    if (envelope.blocks.length !== all.length) return { blocks, replay: undefined }
    return {
      blocks,
      replay: kept === undefined || blocks.length === all.length
        ? envelope
        : {
          response: envelope.response,
          blocks: envelope.blocks.filter((_, position) => kept[position] === true),
        },
    }
  }

  /**
   * Assemble every block seen so far, in stream order.
   * @returns one block per seen index, minus tool calls dropped by max-token
   *   truncation. An open block assembles from its accumulated deltas.
   */
  blocks(): ContentBlock[] {
    return this.assembled().blocks
  }

  /** Whether the canonical stream contains host tool calls, including calls
   * dropped from blocks() on truncation. No incomplete arguments are parsed. */
  get hasToolCalls(): boolean {
    return this.order.some(index => {
      const partial = this.mustGet(index)
      return (partial.block?.type ?? partial.blockType) === 'tool-call'
    })
  }

  /** Canonical text blocks with their original stream indexes, in first-seen
   * order. Shares first-close-wins semantics with blocks(), including ignored
   * straggler deltas and authoritative block-end replacements. */
  textBlocks(): { index: number; block: Extract<ContentBlock, { type: 'text' }>; beforeNativeCall: boolean }[] {
    const lastNative = this.order.findLastIndex(index => {
      const partial = this.mustGet(index)
      return (partial.block?.type ?? partial.blockType) === 'native-tool-call'
    })
    return this.order.flatMap((index, position) => {
      const partial = this.mustGet(index)
      if ((partial.block?.type ?? partial.blockType) !== 'text') return []
      const block = this.assemble(partial, index)
      return block.type === 'text' ? [{ index, block, beforeNativeCall: position < lastNative }] : []
    })
  }

  /**
   * Assemble the prefix an INTERRUPTED stream can safely finalize: closed and
   * open text/reasoning blocks carrying non-whitespace content.
   *
   * Tool calls are omitted because interruption precedes dispatch, so keeping one
   * would oblige the caller to fabricate a result for a call that never ran.
   * @returns the kept blocks; empty when nothing usable streamed first.
   */
  interruptedBlocks(): ContentBlock[] {
    return this.order
      .map((index) => {
        const partial = this.mustGet(index)
        const type = partial.block?.type ?? partial.blockType
        if (type !== 'text' && type !== 'reasoning') return undefined
        return this.assemble(partial, index)
      })
      .filter((block): block is ContentBlock =>
        (block?.type === 'text' || block?.type === 'reasoning') && block.text.trim() !== '')
  }

  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /** Finish reason; `{ kind: 'stop' }` when the stream ended without one. */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  /**
   * Replay metadata, with per-block entries pruned in step with {@link blocks}.
   * Undefined when the envelope did not align with the emitted blocks.
   */
  get replayState(): ReplayEnvelope | undefined {
    return this.assembled().replay
  }

  /**
   * The assembled assistant message.
   * @param source - producer attribution for the message.
   * @returns a frozen assistant-role message over {@link blocks}.
   */
  message(source: MessageSource): Message {
    return createMessage({ role: 'assistant', content: this.blocks(), source })
  }
}
