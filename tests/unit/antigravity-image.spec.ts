import { describe, expect, it } from 'vitest'
import { createAgentRuntime, createAssistantMessage, type ImageBlock } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from '@alvin0/ai-agent-sdk-provider-http'
import {
  antigravityAdapter, antigravityPlugin, memoryAntigravityCredentialStore,
  serializeAntigravityRequest, translateAntigravityStream,
} from '../../packages/provider-antigravity/src/index.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
const MODEL = 'gemini-3.1-flash-image'
const credentials = () => memoryAntigravityCredentialStore({ version: 1, projectId: 'image-project', clientId: 'client',
  obtainedAt: new Date().toISOString(), tokens: { access_token: 'image-access', refresh_token: 'image-refresh',
    expires_at: Date.now() + 3_600_000 } })
const image = (data = PNG) => ({ inlineData: { mimeType: 'image/png', data }, thoughtSignature: 'signed-image' })
const frame = (parts: unknown[], finish = true) => ({ response: { candidates: [{ content: { parts },
  ...(finish ? { finishReason: 'STOP' } : {}) }],
usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } } })
const events = async function* (...values: unknown[]) {
  for (const value of values) yield { event: undefined, data: JSON.stringify(value) }
}
const collect = async <T>(source: AsyncIterable<T>) => {
  const result: T[] = []
  for await (const value of source) result.push(value)
  return result
}
const response = (parts: unknown[]) => new Response(`data: ${JSON.stringify(frame(parts))}\n\n`, {
  headers: { 'content-type': 'text/event-stream' },
})
const request = (messages: ProtocolRequest['options']['messages'] = [], model = MODEL): ProtocolRequest => ({
  options: { provider: 'antigravity', model, messages },
  model: { provider: 'antigravity', id: model, name: model }, connection: {} as ProtocolRequest['connection'],
})

describe('Antigravity image output', () => {
  it('keeps ordered text and image blocks, public image events and replay signatures', async () => {
    const chunks = await collect(translateAntigravityStream(events(frame([
      { text: 'before' }, image(), { text: 'after' },
    ]))))
    const blocks = chunks.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
    expect(blocks.map(block => block.type)).toEqual(['text', 'image', 'text'])
    expect(blocks[1]).toEqual({ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } })
    expect(chunks.find(chunk => chunk.type === 'image-delta')).toMatchObject({
      index: 1, data: PNG, mediaType: 'image/png',
    })
    const finish = chunks.find(chunk => chunk.type === 'finish')!
    expect(finish.replayState?.blocks).toEqual([{}, { blockType: 'image', thoughtSignature: 'signed-image' }, {}])
    expect(JSON.stringify(finish.replayState)).not.toContain(PNG)
    const assistant = createAssistantMessage({ content: blocks,
      source: { provider: 'antigravity', model: MODEL, replayState: finish.replayState } })
    expect(serializeAntigravityRequest(request([assistant]))).toMatchObject({ contents: [{ role: 'model', parts: [
      { text: 'before' }, image(), { text: 'after' },
    ] }] })
  })

  it('completes an image-only runtime reply without retrying and retains it in the session', async () => {
    let generations = 0
    const eventImages: string[] = []
    const runtime = await createAgentRuntime({ providers: [antigravityPlugin({ authStore: credentials(),
      fetch: async (input, init) => {
        if (String(input).includes('fetchAvailableModels')) return new Response(JSON.stringify({ models: {
          [MODEL]: { displayName: 'Image model', maxTokens: 65536, maxOutputTokens: 65536 },
        } }), { headers: { 'content-type': 'application/json' } })
        generations++
        expect(JSON.parse(String(init?.body))).toMatchObject({ request: { generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
        } } })
        return response([image()])
      },
    })] })
    try {
      const catalog = await runtime.modelCatalog('antigravity')
      expect(catalog.models[0]?.outputModalities).toEqual(['text', 'image'])
      const session = runtime.agent({ id: 'image-only', instructions: 'Draw.',
        model: { provider: 'antigravity', id: MODEL }, maxTokens: 4096, maxTurns: 1, compaction: false }).createSession()
      const result = await session.run('Draw an icon.', { onEvent(event) {
        if (event.type === 'image-delta') eventImages.push(event.data)
      } })
      expect(result.completed).toBe(true)
      expect(result.text).toBe('')
      expect(result.message?.content).toContainEqual({ type: 'image',
        source: { kind: 'base64', mediaType: 'image/png', data: PNG } })
      expect(generations).toBe(1)
      expect(eventImages).toEqual([PNG])
      expect(JSON.stringify(session.snapshot())).toContain(PNG)
      expect(result.usage.reported.totalTokens).toBe(12)
    } finally { await runtime.close() }
  })

  it('allows an image event above the text limit and still honors an explicit smaller bound', async () => {
    const data = 'A'.repeat(1_200_000)
    const options = { authStore: credentials(), models: [{ id: MODEL }], fetch: async () => response([image(data)]) }
    const chunks = await collect(antigravityAdapter(options).stream(request().options))
    const finalImage = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'image')
    expect((finalImage as { block: ImageBlock }).block.source).toMatchObject({ data })
    await expect(collect(antigravityAdapter({ ...options, maxSseEventChars: 1024 })
      .stream(request().options))).rejects.toMatchObject({ code: 'HTTP_SSE_LIMIT_EXCEEDED' })
  })

  it('rejects unsupported media and invalid base64, and does not report thought sketches as output', async () => {
    for (const inlineData of [{ mimeType: 'video/mp4', data: PNG },
      { mimeType: 'image/png', data: 'bad base64!' }, { mimeType: 'image/png', data: '' }]) {
      await expect(collect(translateAntigravityStream(events(frame([{ inlineData }])))))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    }
    const chunks = await collect(translateAntigravityStream(events(frame([
      { ...image(), thought: true }, { text: 'No final image was generated.' },
    ]))))
    expect(chunks.some(chunk => chunk.type === 'image-delta')).toBe(false)
  })

  it('keeps multiple images and accepts protobuf snake-case field names', async () => {
    const chunks = await collect(translateAntigravityStream(events(frame([
      image(), { inline_data: { mime_type: 'image/png', data: PNG } },
    ]))))
    expect(chunks.filter(chunk => chunk.type === 'image-delta')).toHaveLength(2)
    const images = chunks.flatMap(chunk => chunk.type === 'block-end' && chunk.block.type === 'image'
      ? [chunk.block] : [])
    expect(images).toHaveLength(2)
  })

  it('fails a stream that provides an image but no finish reason', async () => {
    await expect(collect(translateAntigravityStream(events(frame([image()], false)))))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('does not enable image generation on text-only models', () => {
    expect(serializeAntigravityRequest(request([], 'gemini-text')).generationConfig)
      .not.toHaveProperty('responseModalities')
  })

  it('does not apply an image signature to a history placeholder after bytes are pruned', async () => {
    const chunks = await collect(translateAntigravityStream(events(frame([image()]))))
    const finish = chunks.find(chunk => chunk.type === 'finish')!
    const assistant = createAssistantMessage({ content: [{ type: 'text', phase: 'commentary',
      text: '[A generated image was here; it is not kept in the conversation history.]' }],
    source: { provider: 'antigravity', model: MODEL, replayState: finish.replayState } })
    const wire = serializeAntigravityRequest(request([assistant]))
    expect(JSON.stringify(wire)).not.toContain('signed-image')
    expect(wire).toMatchObject({ contents: [{ role: 'model', parts: [{ text: expect.stringContaining('generated image') }] }] })
  })
})
