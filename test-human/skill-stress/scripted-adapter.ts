import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { ResolvedModelInfo } from '@ai-agent-sdk/core'
import { ReasoningEffortId, ToolCallId } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'
import type { StressRequestKind } from './observer.ts'

export interface ScriptedToolCall {
  readonly name: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface ScriptedRound {
  readonly reasoning?: string
  readonly commentary?: string
  readonly toolCalls?: readonly ScriptedToolCall[]
  readonly finalText?: string
}

export interface ScriptedStressAdapterOptions {
  readonly rounds: readonly ScriptedRound[]
  readonly compactionSummary?: string
  readonly onRequest?: (options: GenerateOptions, kind: StressRequestKind) => void
}

/** Deterministic provider that still traverses the real registry, loop, and tool pipeline. */
export class ScriptedStressAdapter extends ModelAdapter {
  private readonly options: ScriptedStressAdapterOptions
  private normalRound = 0
  readonly requests: GenerateOptions[] = []
  readonly requestKinds: StressRequestKind[] = []

  constructor(options: ScriptedStressAdapterOptions) {
    super()
    this.options = options
  }

  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    request.signal?.throwIfAborted()
    const kind: StressRequestKind = request.toolChoice === 'none' ? 'compaction' : 'model'
    this.requests.push(request)
    this.requestKinds.push(kind)
    this.options.onRequest?.(request, kind)
    const round = kind === 'compaction'
      ? { finalText: this.options.compactionSummary ?? defaultCheckpoint() }
      : this.options.rounds[this.normalRound++] ?? { finalText: 'Scripted plan exhausted.' }
    yield* chunksFor(round, this.normalRound)
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      context: { contextWindow: 32_000 },
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

async function* chunksFor(round: ScriptedRound, roundNumber: number): AsyncIterable<StreamChunk> {
  let index = 0
  if (round.reasoning !== undefined) {
    yield { type: 'reasoning-delta', index, text: round.reasoning }
    yield { type: 'block-end', index, block: { type: 'reasoning', text: round.reasoning } }
    index++
  }
  if (round.commentary !== undefined) {
    yield { type: 'text-delta', index, text: round.commentary, phase: 'commentary' }
    yield { type: 'block-end', index, block: { type: 'text', text: round.commentary, phase: 'commentary' } }
    index++
  }
  for (const [callIndex, call] of (round.toolCalls ?? []).entries()) {
    const id = ToolCallId(`stress-${roundNumber}-${callIndex + 1}-${call.name}`)
    yield {
      type: 'block-end', index: index++,
      block: { type: 'tool-call', id, name: call.name, arguments: JSON.stringify(call.arguments) },
    }
  }
  if (round.finalText !== undefined) {
    yield { type: 'text-delta', index, text: round.finalText, phase: 'final-answer' }
    yield { type: 'block-end', index, block: { type: 'text', text: round.finalText, phase: 'final-answer' } }
  }
  yield {
    type: 'usage',
    usage: { inputTokens: 100 + roundNumber, outputTokens: 20, totalTokens: 120 + roundNumber },
  }
  yield { type: 'finish', reason: { kind: (round.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop' } }
}

function defaultCheckpoint(): string {
  return [
    '## Primary Request and Intent', '- Continue the deterministic skill stress case.',
    '## Progress and Completed Work', '- Preserved verified tool evidence.',
    '## Next Step', '- Finish the requested verification.',
  ].join('\n')
}
