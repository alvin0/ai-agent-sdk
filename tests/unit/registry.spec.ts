import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import { ModelError } from '@alvin0/ai-agent-sdk-core'
import { createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { ModelRegistry, type StreamMiddleware } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'

/** An adapter whose behaviour each test dictates. */
class FakeAdapter extends ModelAdapter {
  constructor(
    private readonly script: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
    private readonly info?: Partial<ResolvedModelInfo>,
  ) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Fake' }
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, ...this.info })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.script(options)
  }
}

async function* textStream(): AsyncGenerator<StreamChunk> {
  yield { type: 'text-delta', index: 0, text: 'ok' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'fake',
    model: 'm',
    messages: [createTextMessage('hi')],
    ...overrides,
  }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('ModelRegistry registration', () => {
  it('bounds catalogs from arbitrary custom adapters at the registry boundary', async () => {
    class CatalogAdapter extends FakeAdapter {
      override listModels(provider: string) {
        return Promise.resolve([
          { provider, id: 'one', name: 'one' },
          { provider, id: 'two', name: 'two' },
        ])
      }
    }
    const registry = new ModelRegistry({ maxCatalogModels: 1 })
    registry.registerAdapter(['fake'], new CatalogAdapter(textStream))

    await expect(registry.listModels('fake')).rejects.toMatchObject({ code: 'INVALID_CATALOG' })
  })

  it('refuses an empty route set', () => {
    expect(() => new ModelRegistry().registerAdapter([], new FakeAdapter(textStream)))
      .toThrow(/at least one provider route/)
  })

  it('refuses a route another adapter already owns', () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['a'], new FakeAdapter(textStream))
    expect(() => registry.registerAdapter(['a'], new FakeAdapter(textStream)))
      .toThrow(/already registered/)
  })

  it('registers all-or-nothing, leaving no partial state behind', () => {
    // A partial registration would let a caller believe a route exists when the
    // registry rejected the batch it belonged to.
    const registry = new ModelRegistry()
    registry.registerAdapter(['taken'], new FakeAdapter(textStream))
    expect(() => registry.registerAdapter(['fresh', 'taken'], new FakeAdapter(textStream)))
      .toThrow(/already registered/)
    expect(registry.listProviders().map(p => p.id)).toEqual(['taken'])
  })

  it('frees the route on disposal and allows re-registration', () => {
    const registry = new ModelRegistry()
    const dispose = registry.registerAdapter(['a'], new FakeAdapter(textStream))
    dispose()
    expect(registry.listProviders()).toEqual([])
    expect(() => registry.registerAdapter(['a'], new FakeAdapter(textStream))).not.toThrow()
  })

  it('replaces routes atomically and rejects replace after disposal', () => {
    const registry = new ModelRegistry()
    const handle = registry.registerAdapter(['a'], new FakeAdapter(textStream))
    handle.replace(['b', 'c'])
    expect(registry.listProviders().map(p => p.id)).toEqual(['b', 'c'])
    handle()
    expect(() => handle.replace(['d'])).toThrow(/disposed/)
  })

  it('notifies topology observers without letting one broken listener veto a commit', () => {
    const registry = new ModelRegistry()
    const good = vi.fn()
    registry.onAdaptersUpdated(() => {
      throw new Error('observer bug')
    })
    registry.onAdaptersUpdated(good)
    expect(() => registry.registerAdapter(['a'], new FakeAdapter(textStream))).not.toThrow()
    expect(good).toHaveBeenCalled()
    expect(registry.listProviders()).toHaveLength(1)
  })
})

describe('ModelRegistry failure funnel', () => {
  it('turns an adapter throw into a terminal error finish', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(() => {
      throw new ModelError('boom', 'SERVER', { status: 503 })
    }))

    const chunks = await drain(registry.stream(request()))
    expect(chunks).toHaveLength(1)
    const finish = chunks[0]
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    expect(finish.reason.failure.code).toBe('SERVER')
    expect(finish.reason.failure.status).toBe(503)
  })

  it('turns a mid-iteration throw into a terminal error finish', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(async function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      throw new ModelError('cut off', 'TRANSPORT')
    }))

    const chunks = await drain(registry.stream(request()))
    expect(chunks.map(c => c.type)).toEqual(['text-delta', 'finish'])
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    expect(finish.reason.failure.code).toBe('TRANSPORT')
  })

  it('reports an unknown route as NO_ADAPTER without throwing', async () => {
    const chunks = await drain(new ModelRegistry().stream(request()))
    const finish = chunks[0]
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') {
      throw new Error('expected a terminal error finish')
    }
    expect(finish.reason.failure.code).toBe('NO_ADAPTER')
  })

  it('classifies a caller abort as aborted rather than error', async () => {
    const controller = new AbortController()
    controller.abort()
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(() => {
      throw new ModelError('stopped', 'ABORTED')
    }))

    const chunks = await drain(registry.stream(request({ signal: controller.signal })))
    const finish = chunks[0]
    if (finish?.type !== 'finish') throw new Error('expected a finish chunk')
    expect(finish.reason.kind).toBe('aborted')
  })

  it('lets a middleware failure stay thrown, because that is a bug in caller code', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    const broken: StreamMiddleware = () => {
      throw new Error('middleware bug')
    }
    registry.use(broken)
    await expect(drain(registry.stream(request()))).rejects.toThrow('middleware bug')
  })
})

describe('ModelRegistry middleware and modality handling', () => {
  it('wraps calls with earlier middleware furthest out', async () => {
    const order: string[] = []
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    registry.use(async function* (_options, next) {
      order.push('outer-in')
      yield* next()
      order.push('outer-out')
    })
    registry.use(async function* (_options, next) {
      order.push('inner-in')
      yield* next()
      order.push('inner-out')
    })

    await drain(registry.stream(request()))
    expect(order).toEqual(['outer-in', 'inner-in', 'inner-out', 'outer-out'])
  })

  it('lets middleware short-circuit the adapter entirely', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(() => {
      throw new Error('must not be reached')
    }))
    registry.use(async function* () {
      yield { type: 'text-delta', index: 0, text: 'cached' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })

    const chunks = await drain(registry.stream(request()))
    expect(chunks[0]).toEqual({ type: 'text-delta', index: 0, text: 'cached' })
  })

  it('projects images to text for a model that declares no image support', async () => {
    let seen: GenerateOptions | undefined
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(
      (options) => {
        seen = options
        return textStream()
      },
      { inputModalities: ['text'] },
    ))

    await drain(registry.stream(request({
      messages: [{
        ...createTextMessage('look'),
        content: [{ type: 'image', source: { kind: 'url', url: 'https://x.invalid/a.png' } }],
      }],
    })))

    const block = seen?.messages[0]?.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') return
    expect(block.text).toContain('image omitted')
  })

  it('projects documents to text for a model that declares no document support', async () => {
    let seen: GenerateOptions | undefined
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(
      (options) => {
        seen = options
        return textStream()
      },
      { inputModalities: ['text', 'image'] },
    ))

    await drain(registry.stream(request({
      messages: [{
        ...createTextMessage('summarize'),
        content: [{
          type: 'document',
          source: { kind: 'base64', mediaType: 'application/pdf', data: 'JVBER' },
          filename: 'report.pdf',
        }],
      }],
    })))

    const block = seen?.messages[0]?.content[0]
    expect(block?.type).toBe('text')
    if (block?.type !== 'text') return
    expect(block.text).toContain('document omitted')
    expect(block.text).toContain('report.pdf')
  })

  it('keeps documents intact for a model that declares document support', async () => {
    let seen: GenerateOptions | undefined
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(
      (options) => {
        seen = options
        return textStream()
      },
      { inputModalities: ['text', 'document'] },
    ))

    await drain(registry.stream(request({
      messages: [{
        ...createTextMessage('summarize'),
        content: [{ type: 'document', source: { kind: 'file', fileId: 'file_1' } }],
      }],
    })))

    expect(seen?.messages[0]?.content[0]?.type).toBe('document')
  })

  it('rejects a document under a strict policy instead of projecting it', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(
      () => textStream(),
      { inputModalities: ['text'] },
    ))

    const chunks = await drain(registry.stream(request({
      documentPolicy: 'strict',
      messages: [{
        ...createTextMessage('summarize'),
        content: [{ type: 'document', source: { kind: 'file', fileId: 'file_1' } }],
      }],
    })))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'UNSUPPORTED_DOCUMENT_INPUT' } },
    })
  })

  it('rejects a prepared call dispatched twice', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm' })
    await drain(prepared.stream(request()))
    expect(() => prepared.stream(request())).toThrow(/only be dispatched once/)
  })

  it('rejects a prepared call whose config changed before dispatch', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm' })
    expect(() => prepared.stream(request({ model: 'different' })))
      .toThrow(/config changed/)
  })

  it('passes an effort through untouched, even when the model declares no ladder', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    const prepared = await registry.prepareCall({
      provider: 'fake',
      model: 'm',
      reasoningEffort: 'nonexistent' as never,
    })
    expect(prepared.config.reasoningEffort).toBe('nonexistent')
  })

  it('binds a complete capability snapshot and enforces the hard output ceiling', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream, {
      context: { contextWindow: 128 },
      defaultMaxTokens: 8,
      maxOutputTokens: 16,
      inputModalities: ['text', 'image'],
      nativeTools: ['web-search'],
    }))

    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm' })
    expect(prepared.config.maxTokens).toBe(8)
    expect(prepared.model).toMatchObject({
      context: { contextWindow: 128 }, maxOutputTokens: 16,
      inputModalities: ['text', 'image'], nativeTools: ['web-search'],
    })
    await expect(registry.prepareCall({ provider: 'fake', model: 'm', maxTokens: 17 }))
      .rejects.toMatchObject({ code: 'OUTPUT_TOKEN_LIMIT_EXCEEDED' })
  })

  it('detaches nested model metadata from a mutable adapter result', async () => {
    const context = { contextWindow: 128 }
    const modalities: ('text' | 'image')[] = ['text', 'image']
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream, {
      context, inputModalities: modalities,
    }))

    const info = await registry.resolveModelInfo('fake', 'm')
    context.contextWindow = 256
    modalities.pop()
    expect(info.context?.contextWindow).toBe(128)
    expect(info.inputModalities).toEqual(['text', 'image'])
    expect(Object.isFrozen(info.context)).toBe(true)
  })

  it('rejects a native tool excluded by an explicit model capability list', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream, {
      nativeTools: ['web-search'],
    }))

    const chunks = await drain(registry.stream(request({
      tools: [{ type: 'native', name: 'image-generation' }],
    })))
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_NATIVE_TOOL' } },
    })
  })
})

describe('ModelRegistry runtime defaults', () => {
  it('falls back to the SDK constant when neither the model nor the runtime names a context window', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    const info = await registry.resolveModelInfo('fake', 'm')
    expect(info.context?.contextWindow).toBe(200_000)
  })

  it('falls back to the SDK constant set: text, image, and document, when nothing restricts input', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    const info = await registry.resolveModelInfo('fake', 'm')
    expect(info.inputModalities).toEqual(['text', 'image', 'document'])
  })

  it('does not send maxTokens at all when nobody — caller, model, or runtime — names one', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm' })
    expect(prepared.config.maxTokens).toBeUndefined()
  })

  it('lets a runtime default fill a context window, output cap, and modality list the model leaves silent', async () => {
    const registry = new ModelRegistry({
      defaults: { contextWindow: 272_000, maxTokens: 32_000, inputModalities: ['text'] },
    })
    registry.registerAdapter(['fake'], new FakeAdapter(textStream))
    const info = await registry.resolveModelInfo('fake', 'm')
    expect(info.context?.contextWindow).toBe(272_000)
    expect(info.inputModalities).toEqual(['text'])
    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm' })
    expect(prepared.config.maxTokens).toBe(32_000)
  })

  it('lets a model or route override still win over the runtime default', async () => {
    const registry = new ModelRegistry({ defaults: { contextWindow: 272_000, maxTokens: 32_000 } })
    registry.registerAdapter(['fake'], new FakeAdapter(textStream, {
      context: { contextWindow: 8_000 }, defaultMaxTokens: 1_000, inputModalities: ['text', 'image'],
    }))
    const info = await registry.resolveModelInfo('fake', 'm')
    expect(info.context?.contextWindow).toBe(8_000)
    expect(info.inputModalities).toEqual(['text', 'image'])
    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm' })
    expect(prepared.config.maxTokens).toBe(1_000)
  })

  it('lets an explicit per-call maxTokens win over every other tier', async () => {
    const registry = new ModelRegistry({ defaults: { maxTokens: 32_000 } })
    registry.registerAdapter(['fake'], new FakeAdapter(textStream, { defaultMaxTokens: 1_000 }))
    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm', maxTokens: 500 })
    expect(prepared.config.maxTokens).toBe(500)
  })

  it('rejects a malformed runtime default at construction, before any call', () => {
    expect(() => new ModelRegistry({ defaults: { contextWindow: -1 } })).toThrow(RangeError)
    expect(() => new ModelRegistry({ defaults: { inputModalities: [] } })).toThrow(RangeError)
  })

  it('lets an agent-tier contextWindow win over the model, route, and runtime default', async () => {
    const registry = new ModelRegistry({ defaults: { contextWindow: 272_000 } })
    registry.registerAdapter(['fake'], new FakeAdapter(textStream, { context: { contextWindow: 8_000 } }))
    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm', contextWindow: 64_000 })
    expect(prepared.model.context?.contextWindow).toBe(8_000)
    expect(prepared.config.contextWindow).toBe(64_000)
  })

  it('lets an agent-tier inputModalities list win over the model, route, and runtime default', async () => {
    const registry = new ModelRegistry({ defaults: { inputModalities: ['text', 'image'] } })
    registry.registerAdapter(['fake'], new FakeAdapter(textStream, { inputModalities: ['text', 'image', 'document'] }))
    const prepared = await registry.prepareCall({ provider: 'fake', model: 'm', inputModalities: ['text'] })
    expect(prepared.model.inputModalities).toEqual(['text', 'image', 'document'])
    expect(prepared.inputModalities).toEqual(['text'])
  })

  it('rejects an agent-tier contextWindow above the model\'s technical ceiling', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['fake'], new FakeAdapter(textStream, {
      context: { contextWindow: 8_000, maxContextWindow: 8_000 },
    }))
    await expect(registry.prepareCall({ provider: 'fake', model: 'm', contextWindow: 16_000 }))
      .rejects.toMatchObject({ code: 'INVALID_MODEL_INFO' })
  })
})
