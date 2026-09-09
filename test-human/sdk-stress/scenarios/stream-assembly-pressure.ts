import { BlockAssembler, ToolCallId, type StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { SdkStressContext, SdkStressScenarioResult } from '../types.ts'
import { StressChecks } from './shared.ts'

export async function streamAssemblyPressure(context: SdkStressContext): Promise<SdkStressScenarioResult> {
  const checks = new StressChecks()
  let textBytes = 0
  let chunks = 0
  let maxTokenCases = 0
  for (let iteration = 0; iteration < context.iterations; iteration++) {
    context.signal.throwIfAborted()
    const expected = deterministicText(iteration, 256 + Math.floor(context.random() * 1_792))
    const authoritative = iteration % 5 === 0 ? `${expected}:authoritative` : expected
    const stream = textChunks(expected, context.random)
    const assembler = new BlockAssembler()
    for (const chunk of stream) { assembler.push(chunk); chunks++ }
    if (iteration % 5 === 0) {
      assembler.push({ type: 'block-end', index: 7, block: { type: 'text', text: authoritative } })
      assembler.push({ type: 'text-delta', index: 7, text: ':ignored-straggler' })
      chunks += 2
    }
    assembler.push({
      type: 'tool-call-delta', index: 3,
      id: ToolCallId(`stream-${iteration}`), name: 'lookup', argumentsDelta: '{"id":',
    })
    assembler.push({
      type: 'tool-call-delta', index: 3,
      id: ToolCallId(`stream-${iteration}`), argumentsDelta: `${iteration}}`,
    })
    const capped = iteration % 3 === 0
    if (capped) maxTokenCases++
    assembler.push({
      type: 'finish', reason: { kind: capped ? 'max-tokens' : 'tool-calls' },
      replayState: { response: { iteration }, blocks: ['text', 'tool'] },
    })
    const blocks = assembler.blocks()
    const text = blocks.find(block => block.type === 'text')
    if (text?.type !== 'text' || text.text !== authoritative) {
      checks.check(`iteration ${iteration} preserves authoritative streamed text`, false,
        `received length=${text?.type === 'text' ? text.text.length : -1}`)
      break
    }
    const tools = blocks.filter(block => block.type === 'tool-call')
    if (tools.length !== (capped ? 0 : 1)) {
      checks.check(`iteration ${iteration} applies max-token tool safety`, false,
        `tool blocks=${tools.length} capped=${capped}`)
      break
    }
    if (assembler.replayState?.blocks?.length !== blocks.length) {
      checks.check(`iteration ${iteration} keeps replay metadata aligned`, false,
        `replay=${assembler.replayState?.blocks?.length ?? -1} blocks=${blocks.length}`)
      break
    }
    const message = assembler.message({ kind: 'model', provider: 'stress', model: 'assembler' })
    if (!Object.isFrozen(message) || !Object.isFrozen(message.content)) {
      checks.check(`iteration ${iteration} returns immutable messages`, false)
      break
    }
    textBytes += Buffer.byteLength(expected)
    if (iteration < 4 || iteration === context.iterations - 1) {
      context.artifact.record('assembly-sample', {
        iteration, inputChars: expected.length, chunks: stream.length,
        blocks: blocks.map(block => block.type), finish: assembler.finish.kind,
      })
    }
  }
  if (checks.items().length === 0) {
    checks.check('all chunk partitions assemble without drift', true)
    checks.check('max-token responses never retain partial tool calls', maxTokenCases > 0)
    checks.check('assembled messages remain deeply immutable', true)
  }
  return Object.freeze({
    invariants: checks.items(),
    metrics: Object.freeze({ iterations: context.iterations, textBytes, chunks, maxTokenCases }),
  })
}

function deterministicText(iteration: number, length: number): string {
  const prefix = `iteration-${iteration}:`
  return `${prefix}${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(Math.ceil(length / 36)).slice(0, length)}`
}

function textChunks(text: string, random: () => number): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let cursor = 0
  while (cursor < text.length) {
    const size = Math.max(1, Math.floor(random() * 31))
    chunks.push({ type: 'text-delta', index: 7, text: text.slice(cursor, cursor + size) })
    cursor += size
  }
  return chunks
}
