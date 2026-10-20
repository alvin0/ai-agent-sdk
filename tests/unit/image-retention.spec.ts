import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createTextMessage, createToolResultMessage } from '../../packages/core/src/message/message.ts'
import { ToolCallId } from '../../packages/core/src/primitives/brand.ts'
import {
  serializeResponsesRequest,
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'
import { serializeAnthropicRequest, DEFAULT_THINKING_BUDGETS } from '@alvin0/ai-agent-sdk-protocol-anthropic-messages'
import { serializeGeminiInteractionsRequest } from '@alvin0/ai-agent-sdk-protocol-gemini-interactions'
import { History } from '../../packages/core/src/agent/history/history.ts'
import { normalizeToolPairing } from '../../packages/core/src/agent/history/normalize.ts'
import {
  ContextCompactor, defineAgent, defineTool, History as RuntimeHistory, resolveCompactionConfig,
} from '@alvin0/ai-agent-sdk-core/agent'
import { SessionInputState } from '../../packages/core/src/agent/define/session/input-state.ts'
import {
  createTextMessage as createRuntimeTextMessage,
  ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId as RuntimeToolCallId,
} from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import {
  countImages,
  retainLatestImagesInMessages,
  resolveImageRetention,
} from '../../packages/core/src/agent/history/image-retention.ts'
import { providerRequest } from './fixtures.ts'

const responsesDialect: ResponsesDialect = {
  sampling: true, maxOutputTokens: true, structuredOutputs: true, store: false,
  include: ['reasoning.encrypted_content'],
}

function imageBlock(data: string) {
  return { type: 'image' as const, source: { kind: 'base64' as const, mediaType: 'image/png' as const, data } }
}

function imageMessage(data: string, prompt = 'Inspect this image.') {
  return { ...createTextMessage(prompt), content: [{ type: 'text' as const, text: prompt }, imageBlock(data)] }
}

function toolConversation() {
  const callId = ToolCallId('retention-call')
  return {
    callId,
    messages: [
      imageMessage('older-user-image'),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{}' }],
        source: { provider: 'test', model: 'test-model' },
      }),
      createToolResultMessage({ callId, content: [imageBlock('older-tool-image')], isError: false }),
      imageMessage('latest-user-image'),
    ],
  }
}

class RetentionScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }
}

function toolRound(id: string): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: RuntimeToolCallId(id), name: 'capture', arguments: '{}',
    } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function finalRound(): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text: 'Captured.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Captured.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

describe('image retention', () => {
  it('prunes duplicated additional tool context on resume and during repeated captures', () => {
    const source = new History()
    const appendCapture = (history: History, index: number) => {
      const callId = ToolCallId(`context-${index}`)
      const block = imageBlock(`CAPTURE_${index}_` + 'A'.repeat(8_000))
      history.append({ kind: 'tool-call', callId, name: 'capture', rawArguments: '{}' })
      history.append({ kind: 'tool-result', callId,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Captured; source/frame.jpg' }], isError: false }),
        result: { isError: false, value: 'Captured', content: [{ type: 'text', text: 'Captured; source/frame.jpg' }], additionalContext: [block] } })
      history.append({ kind: 'user', message: { ...createTextMessage('Review frame'),
        source: { kind: 'app', producer: 'tool:capture' }, content: [block] } })
    }
    appendCapture(source, 0)
    appendCapture(source, 1)
    const history = History.fromSnapshot(source.snapshot(), { maxBytes: 60_000, maxEntryBytes: 12_000 },
      { keepLatest: 2, persist: 'drop-pruned' })
    for (let index = 2; index < 30; index++) appendCapture(history, index)
    const snapshot = JSON.stringify(history.snapshot())
    expect(snapshot).not.toContain('CAPTURE_0_')
    expect(snapshot).not.toContain('CAPTURE_28_')
    expect(snapshot).toContain('CAPTURE_29_')
    expect(snapshot).toContain('source/frame.jpg')
    expect(countImages(history.snapshot().entries.map(entry => entry.event))).toBe(2)
    expect(Buffer.byteLength(snapshot)).toBeLessThan(60_000)
    expect(source.snapshot().entries.some(entry => JSON.stringify(entry).includes('CAPTURE_0_'))).toBe(true)
  })

  it('closes tool accounting and retains the actual failure when history rejects a capture result', async () => {
    const adapter = new RetentionScriptedAdapter([toolRound('capture-overflow')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const capture = defineTool({ name: 'capture', description: 'Capture evidence.', parameters: { type: 'object' },
      execute: () => 'RESULT'.repeat(1_000) })
    const session = defineAgent({ id: 'capture-limit', provider: 'test', model: 'scripted',
      instructions: 'Capture and review.', tools: [capture] }).createSession({ registry, compaction: false,
      historyLimits: { maxEntryBytes: 12_000, maxBytes: 12_000 },
      hooks: { onTerminalRecovery: () => 'Video remains unfinished.' } })
    const response = await session.run('Review ' + 'X'.repeat(8_000))
    expect(response.outcome.reason).toMatchObject({ kind: 'error', failure: { code: 'TURN_RUNTIME_ERROR' } })
    expect(response.report.operationCounts.tool).toMatchObject({ error: 1, unknown: 0 })
    expect(response.report.errors.some(error => error.code === 'OPERATION_TERMINAL_MISSING')).toBe(false)
    expect(response.report.errors.some(error => error.code === 'TURN_RUNTIME_ERROR')).toBe(true)
  })

  it('keeps the newest images and replaces old user and tool-result images with valid text blocks', () => {
    const { callId, messages } = toolConversation()
    const projected = retainLatestImagesInMessages(messages, resolveImageRetention({ keepLatest: 1 })!)
    const normalized = normalizeToolPairing(projected.messages)
    const toolResult = normalized.flatMap(message => message.content)
      .find(block => block.type === 'tool-result')

    expect(projected.metrics.imagesPruned).toBe(2)
    expect(countImages(normalized)).toBe(1)
    expect(projected.messages[0]?.content[1]).toEqual({ type: 'text', text: '[Image omitted by retention policy.]' })
    expect(toolResult).toMatchObject({
      type: 'tool-result', toolCallId: callId,
      content: [{ type: 'text', text: '[Image omitted by retention policy.]' }],
    })
    expect(normalized.at(-1)?.content.at(-1)).toEqual(imageBlock('latest-user-image'))
  })

  it('encodes placeholders and preserves tool-call/result pairing in all protocol request shapes', () => {
    const { callId, messages } = toolConversation()
    const retained = normalizeToolPairing(
      retainLatestImagesInMessages(messages, resolveImageRetention({ keepLatest: 1 })!).messages,
    )
    const request = providerRequest({ messages: retained as never })

    const responses = serializeResponsesRequest(request, responsesDialect)
    const responseCall = responses.input.findIndex(item => item.type === 'function_call')
    const responseResult = responses.input.findIndex(item => item.type === 'function_call_output')
    expect(responseCall).toBeGreaterThanOrEqual(0)
    expect(responseResult).toBeGreaterThan(responseCall)
    expect(responses.input[responseResult]).toMatchObject({ type: 'function_call_output', call_id: callId })
    expect(JSON.stringify(responses.input[responseResult])).toContain('[Image omitted by retention policy.]')

    const anthropic = serializeAnthropicRequest(request, { budgets: DEFAULT_THINKING_BUDGETS })
    const anthropicCall = anthropic.messages.flatMap(message => message.content)
      .findIndex(block => block.type === 'tool_use')
    const anthropicResult = anthropic.messages.flatMap(message => message.content)
      .findIndex(block => block.type === 'tool_result')
    expect(anthropicCall).toBeGreaterThanOrEqual(0)
    expect(anthropicResult).toBeGreaterThan(anthropicCall)
    expect(JSON.stringify(anthropic.messages)).toContain('[Image omitted by retention policy.]')

    const gemini = serializeGeminiInteractionsRequest(request, { store: false, thinkingSummaries: 'none' })
    const geminiCall = gemini.input.findIndex(item => item.type === 'function_call')
    const geminiResult = gemini.input.findIndex(item => item.type === 'function_result')
    expect(geminiCall).toBeGreaterThanOrEqual(0)
    expect(geminiResult).toBeGreaterThan(geminiCall)
    expect(gemini.input[geminiResult]).toMatchObject({ type: 'function_result', call_id: callId })
    expect(JSON.stringify(gemini.input[geminiResult])).toContain('[Image omitted by retention policy.]')
  })

  it('reprojects images after every tool round in one multi-step turn', async () => {
    const adapter = new RetentionScriptedAdapter([toolRound('capture-1'), toolRound('capture-2'), finalRound()])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    let capture = 0
    const tool = defineTool({ name: 'capture', description: 'Capture an image.', parameters: { type: 'object' },
      execute: () => `tool-image-${++capture}`, render: value => [imageBlock(String(value))] })
    const agent = defineAgent({ id: 'multi-round-image-retention', provider: 'test', model: 'scripted',
      instructions: 'Capture images and report.', tools: [tool] })
    const input = { ...createRuntimeTextMessage('Capture two images.'),
      content: [{ type: 'text' as const, text: 'Capture two images.' }, imageBlock('initial-user-image')] }
    const session = agent.createSession({ registry, compaction: false, imageRetention: { keepLatest: 1 } })

    await expect(session.run(input)).resolves.toMatchObject({ text: 'Captured.' })
    expect(adapter.requests).toHaveLength(3)
    expect(session.imageRetentionStats()).toMatchObject({ keepLatest: 1, requestImagesPruned: 3 })
    expect(adapter.requests.map(request => countImages(request.messages))).toEqual([1, 1, 1])

    const thirdMessages = adapter.requests[2]!.messages
    const toolResults = thirdMessages.flatMap(message => message.content)
      .filter(block => block.type === 'tool-result')
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]?.content).toEqual([{ type: 'text', text: '[Image omitted by retention policy.]' }])
    expect(toolResults[1]?.content).toEqual([imageBlock('tool-image-2')])
    expect(JSON.stringify(thirdMessages)).toContain('[Image omitted by retention policy.]')

    const request = providerRequest({ messages: thirdMessages })
    const responses = serializeResponsesRequest(request, responsesDialect)
    expect(responses.input.filter(item => item.type === 'function_call_output')).toHaveLength(2)
    const anthropic = serializeAnthropicRequest(request, { budgets: DEFAULT_THINKING_BUDGETS })
    expect(anthropic.messages.flatMap(message => message.content).filter(block => block.type === 'tool_result'))
      .toHaveLength(2)
    const gemini = serializeGeminiInteractionsRequest(request, { store: false, thinkingSummaries: 'none' })
    expect(gemini.input.filter(item => item.type === 'function_result')).toHaveLength(2)
  })

  it('drops old bytes from persisted snapshots before history byte limits and after compaction', () => {
    const source = new History()
    source.append({ kind: 'user', message: imageMessage('OLD_IMAGE_SECRET/'.repeat(100)) })
    source.append({ kind: 'user', message: imageMessage('latest-image') })

    const resumed = History.fromSnapshot(source.snapshot(),
      { maxEntryBytes: 1_000, maxBytes: 1_300 }, { keepLatest: 1, persist: 'drop-pruned' })
    const snapshotText = JSON.stringify(resumed.snapshot())
    expect(snapshotText).not.toContain('OLD_IMAGE_SECRET')
    expect(snapshotText).toContain('latest-image')
    expect(resumed.imageRetentionSnapshot()).toMatchObject({
      imagesRetained: 1, persistedImagesPruned: 1, persistedBytesSaved: expect.any(Number),
    })

    const compacted = new History({ maxEntryBytes: 1_000, maxBytes: 1_500 })
    compacted.configureImageRetention({ keepLatest: 1, persist: 'drop-pruned' })
    const old = compacted.append({ kind: 'user', message: imageMessage('COMPACTED_IMAGE_SECRET/'.repeat(20)) })
    compacted.append({ kind: 'user', message: imageMessage('current-image') }, {
      op: 'replace', from: old.seq, to: old.seq, targets: [old.seq],
    })
    expect(JSON.stringify(compacted.snapshot())).not.toContain('COMPACTED_IMAGE_SECRET')
    expect(compacted.messages()).toHaveLength(1)
    expect(compacted.imageRetentionSnapshot()).toMatchObject({
      imagesRetained: 1, persistedImagesPruned: 1,
    })
  })

  it('projects a 200-image history across 500 steps with bounded model requests', () => {
    const messages = Array.from({ length: 200 }, (_, index) => imageMessage(`image-${index}-payload`.repeat(8)))
    const policy = resolveImageRetention({ keepLatest: 4 })!
    const started = performance.now()
    let lastSize = 0
    for (let step = 0; step < 500; step++) {
      const requestMessages = retainLatestImagesInMessages(messages, policy).messages
      expect(countImages(requestMessages)).toBe(4)
      lastSize = new TextEncoder().encode(JSON.stringify(requestMessages)).byteLength
    }
    expect(lastSize).toBeLessThan(50_000)
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  it('caches placeholder size and rendering for 200 large images across 300 rounds', () => {
    const messages = Array.from({ length: 200 }, (_, index) => imageMessage(
      `${index}`.padStart(3, '0') + 'A'.repeat(150_000),
    ))
    const placeholder = vi.fn(() => '[Screen omitted.]')
    const policy = resolveImageRetention({ keepLatest: 0, placeholder })!
    const roundTimes: number[] = []

    for (let round = 0; round < 300; round++) {
      const started = performance.now()
      const request = retainLatestImagesInMessages(messages, policy)
      roundTimes.push(performance.now() - started)
      expect(request.metrics.imagesPruned).toBe(200)
    }

    const firstFiftyAverage = roundTimes.slice(0, 50).reduce((sum, value) => sum + value, 0) / 50
    const lastFiftyAverage = roundTimes.slice(-50).reduce((sum, value) => sum + value, 0) / 50
    expect(lastFiftyAverage).toBeLessThan(firstFiftyAverage * 3 + 0.25)
    expect(lastFiftyAverage).toBeLessThan(50)
    expect(placeholder).toHaveBeenCalledTimes(200)
  })

  it('keeps persisted image bytes bounded during 500 sequential appends', () => {
    const history = new History()
    history.configureImageRetention({ keepLatest: 4, persist: 'drop-pruned' })
    const started = performance.now()
    for (let step = 0; step < 500; step++) {
      history.append({ kind: 'user', message: imageMessage(`image-${step}-payload`.repeat(8)) })
    }

    const snapshotText = JSON.stringify(history.snapshot())
    expect(countImages(history.messages())).toBe(4)
    expect(snapshotText).not.toContain('image-0-payload')
    expect(snapshotText).toContain('image-499-payload')
    expect(snapshotText.length).toBeLessThan(200_000)
    expect(history.imageRetentionSnapshot()).toMatchObject({
      imagesRetained: 4, persistedImagesPruned: 496,
    })
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  it('re-resolves and re-validates a retention options object mutated after first use', () => {
    const options: { keepLatest: number; persist?: 'keep' | 'drop-pruned' } = { keepLatest: 2 }
    const first = resolveImageRetention(options)!
    expect(resolveImageRetention(options)).toBe(first)
    expect(resolveImageRetention(first)).toBe(first)

    options.keepLatest = 0
    options.persist = 'drop-pruned'
    expect(resolveImageRetention(options)).toMatchObject({ keepLatest: 0, persist: 'drop-pruned' })

    options.keepLatest = -1
    expect(() => resolveImageRetention(options)).toThrow(/keepLatest/)

    const history = new History()
    history.append({ kind: 'user', message: imageMessage('a') })
    history.append({ kind: 'user', message: imageMessage('b') })
    options.keepLatest = 2
    options.persist = 'keep'
    history.configureImageRetention(options)
    options.keepLatest = 1
    options.persist = 'drop-pruned'
    history.configureImageRetention(options)
    expect(history.imageRetentionSnapshot()).toMatchObject({ keepLatest: 1, persist: 'drop-pruned', imagesRetained: 1 })
  })

  it('checks resumed snapshot entry counts against the configured limit under drop-pruned retention', () => {
    const source = new History()
    for (let index = 0; index < 5; index++) {
      source.append({ kind: 'user', message: imageMessage(`entry-${index}`) })
    }
    expect(() => History.fromSnapshot(source.snapshot(), { maxEntries: 3 },
      { keepLatest: 1, persist: 'drop-pruned' })).toThrow(/3-entry limit/)
  })

  it('prunes images in the mid-round inject trial exactly like the live history', () => {
    const payload = 'IMAGE_PAYLOAD/'.repeat(200)
    const limits = { maxEntryBytes: 4_000, maxBytes: 5_000 }
    const history = new History(limits)
    history.configureImageRetention({ keepLatest: 1, persist: 'drop-pruned' })
    history.append({ kind: 'user', message: imageMessage(payload) })
    history.append({ kind: 'user', message: imageMessage(payload) })
    const state = new SessionInputState({
      history: () => history, historyLimits: () => limits, isRunning: () => true,
    })
    state.observeRoundBoundary({ type: 'span-start', kind: 'chat' } as never)

    expect(() => state.inject(imageMessage(payload, 'Another one.'))).not.toThrow()
    // The queued buffer must not apply the live byte limit to images the live history will prune.
    expect(() => state.inject(imageMessage(payload, 'And another.'))).not.toThrow()
    state.drainInjections()
    expect(countImages(history.messages())).toBe(1)
    expect(history.messages().at(-1)?.content).toContainEqual({ type: 'text', text: 'And another.' })
  })

  it('measures compaction pressure on the retained image view', async () => {
    const summary = '## Primary Request and Intent\n- Inspect screens.\n## Next Step\n- Continue.'
    const compactedTokens = async (keepLatest: number | undefined) => {
      const adapter = new RetentionScriptedAdapter([[
        { type: 'text-delta', index: 0, text: summary },
        { type: 'block-end', index: 0, block: { type: 'text', text: summary } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]])
      const registry = new ModelRegistry()
      registry.registerAdapter(['test'], adapter)
      const history = new RuntimeHistory()
      if (keepLatest !== undefined) history.configureImageRetention({ keepLatest })
      for (let index = 0; index < 20; index++) {
        history.append({ kind: 'user', message: {
          ...createRuntimeTextMessage(`Screen ${index} ${'notes '.repeat(40)}`),
          content: [{ type: 'text', text: `Screen ${index} ${'notes '.repeat(40)}` }, imageBlock(`screen-${index}`)],
        } })
      }
      const compactor = new ContextCompactor({
        registry, config: () => ({ provider: 'test', model: 'm' }), history: () => history,
        system: () => '', tools: () => [],
        policy: resolveCompactionConfig({ auto: false, maxInputTokens: 1_000_000, retainTokens: 10 }),
      })
      const result = await compactor.compactNow()
      const summarized = adapter.requests[0]?.messages ?? []
      return { before: result?.estimatedTokensBefore ?? 0, summarizedImages: countImages(summarized) }
    }

    const unretained = await compactedTokens(undefined)
    const retained = await compactedTokens(2)
    expect(retained.before).toBeLessThan(unretained.before / 2)
    expect(retained.summarizedImages).toBeLessThanOrEqual(2)
  })
})
