import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { ToolCallId } from '../../../packages/core/src/primitives/brand.ts'

export class BlockingAdapter extends ModelAdapter {
  readonly entered: Promise<void>
  private enter!: () => void
  aborts = 0

  constructor() {
    super()
    this.entered = new Promise(resolve => { this.enter = resolve })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.enter()
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return }
      options.signal?.addEventListener('abort', () => { this.aborts++; reject(options.signal?.reason) }, { once: true })
    })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export class UncooperativeAdapter extends ModelAdapter {
  readonly entered: Promise<void>
  private enter!: () => void
  private readonly blocked: Promise<void>
  private resume!: () => void
  continued = false

  constructor() {
    super()
    this.entered = new Promise(resolve => { this.enter = resolve })
    this.blocked = new Promise(resolve => { this.resume = resolve })
  }

  release(): void { this.resume() }

  async * stream(): AsyncIterable<StreamChunk> {
    this.enter()
    await this.blocked
    this.continued = true
    yield { type: 'text-delta', index: 0, text: 'PRIVATE_LATE/RESULT~SENTINEL%' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PRIVATE_LATE/RESULT~SENTINEL%' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export class EarlyReturnAdapter extends ModelAdapter {
  readonly blocked: Promise<void>
  private block!: () => void
  aborts = 0

  constructor() {
    super()
    this.blocked = new Promise(resolve => { this.block = resolve })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'first' }
    this.block()
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { this.aborts++; reject(options.signal.reason); return }
      options.signal?.addEventListener('abort', () => { this.aborts++; reject(options.signal?.reason) }, { once: true })
    })
  }
}

export class CompleteAdapter extends ModelAdapter {
  lateAborts = 0
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.addEventListener('abort', () => { this.lateAborts++ })
    yield { type: 'text-delta', index: 0, text: 'complete' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export class FailingAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: {
      code: 'PROVIDER_SCRIPT_FAILED', message: 'scripted safe failure',
    } } }
  }
}

export class OversizedEventAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'x'.repeat(16 * 1024 * 1024 + 1) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export class ToolCallAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: ToolCallId('parked-tool-call'), name: 'park', arguments: '{}',
    } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
