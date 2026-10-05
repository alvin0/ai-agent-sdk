import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ModelInvocationContext, PreparedAdapterCall, StreamChunk } from '@alvin0/ai-agent-sdk-core/provider'
import { booleanQuestion, choiceQuestion, createDecisionRuntime, createDecisionTask, gateBoolean, gateChoice, llmDecisionAdapter, llmDecisionPlugin, scoreQuestion } from '@alvin0/ai-agent-sdk-decision-adapter'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'
import { anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'
import { geminiAdapter } from '@alvin0/ai-agent-sdk-provider-gemini'

const questions = {
  route: choiceQuestion('Choose a team', { billing: 'Refunds', support: 'Technical failures' }),
  urgency: scoreQuestion('Urgency', ['Routine', 'Today', 'Emergency']),
  refund: booleanQuestion('Is a refund requested?'),
}
const input = { state: { message: 'Refund please today' }, questions }
const answers = () => ({ route: { choice: 'billing' }, urgency: { score: 1 }, refund: { value: true } })
function success(value: unknown = { answers: answers() }): StreamChunk[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, 10) },
    { type: 'text-delta', index: 0, text: text.slice(10) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
class FakeLlm extends ModelAdapter {
  frames = success()
  readonly calls: GenerateOptions[] = []
  readonly contexts: (ModelInvocationContext | undefined)[] = []
  override async *stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    this.calls.push(options); this.contexts.push(context)
    yield* this.frames
  }
}
function setup(adapter: ModelAdapter = new FakeLlm(), evidence?: 'model-generated', outputMode?: 'tool') {
  const runtime = createDecisionRuntime({ providers: [llmDecisionPlugin({ id: 'llm', routes: ['llm'], adapter, ...(evidence ? { evidence } : {}), ...(outputMode ? { outputMode } : {}) })] })
  return { runtime, model: runtime.decisionModel({ provider: 'llm', model: 'unlisted-model' }) }
}

describe('LLM decision bridge', () => {
  it('generates a closed schema for every primitive, retains literal types and leaves evidence absent', async () => {
    const llm = new FakeLlm()
    const { runtime, model } = setup(llm)
    const context = { recordProviderRetry: vi.fn() }
    const task = createDecisionTask(model, { questions })
    const result = await task.evaluate(input.state, {}, context)
    expectTypeOf(result.answers.route.choice).toEqualTypeOf<'billing' | 'support'>()
    expect(result).toEqual({ model: 'unlisted-model', answers: { route: { type: 'choice', choice: 'billing' }, urgency: { type: 'score', score: 1 }, refund: { type: 'boolean', value: true } }, usage: { inputTokens: 12, outputTokens: 8 } })
    expect(llm.contexts).toEqual([context])
    expect(llm.calls[0]).toMatchObject({ outputFormat: { type: 'json_schema', name: 'submit_decisions', schema: { additionalProperties: false, required: ['answers'], properties: { answers: { properties: { route: { properties: { choice: { enum: ['billing', 'support'] } } } } } } } } })
    expect(llm.calls[0]?.tools).toBeUndefined()
    expect(llm.calls[0]?.messages[0]?.content[0]).toMatchObject({ type: 'text', text: JSON.stringify({ questions: input.questions, state: input.state }) })
    expect(gateChoice(result.answers.route, { minProbability: 0.8 })).toHaveProperty('reason', 'missing-evidence')
    await runtime.close()
  })
  it('tags opt-in model estimates, validates consistency, and requires explicit gate opt-in', async () => {
    const llm = new FakeLlm()
    llm.frames = success({ answers: { route: { choice: 'billing', probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.8 }, urgency: { probabilities: { '0': 0, '1': 0.8, '2': 0.2 }, confidence: 0.7 }, refund: { value: true, probabilityTrue: 0.9 } } })
    const { runtime, model } = setup(llm, 'model-generated')
    const result = await model.evaluate(input)
    expect(result.answers.route.probabilitySource).toBe('model-generated')
    expect(result.answers.urgency.probabilitySource).toBe('model-generated')
    expect(result.answers.urgency.score).toBeCloseTo(1.2)
    expect(gateBoolean(result.answers.refund, { falseMax: 0.2, trueMin: 0.8 })).toHaveProperty('reason', 'untrusted-evidence')
    expect(gateChoice(result.answers.route, { minProbability: 0.8, allowedSources: ['model-generated'] })).toHaveProperty('status', 'accepted')
    await runtime.close()
  })
  it('captures a decision tool without running an agent tool loop or parsing its narration', async () => {
    const llm = new FakeLlm()
    llm.frames = [
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Here is my decision.' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('c'), name: 'submit_decisions', arguments: JSON.stringify({ answers: answers() }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const { runtime, model } = setup(llm, undefined, 'tool')
    expect((await model.evaluate(input)).answers.refund.value).toBe(true)
    expect(llm.calls[0]).toMatchObject({ toolChoice: { type: 'tool', name: 'submit_decisions' }, tools: [{ name: 'submit_decisions' }] })
    expect(llm.calls[0]?.outputFormat).toBeUndefined()
    expect(llm.calls).toHaveLength(1)
    await runtime.close()
  })
  it.each(['invalid-json', 'extra-root', 'extra-answer', 'missing-question', 'choice', 'score', 'boolean', 'spoof-evidence'])('rejects %s without repairing or silently downgrading', async kind => {
    const llm = new FakeLlm()
    const value: Record<string, unknown> = { answers: answers() }
    const a = value.answers as Record<string, unknown>
    if (kind === 'extra-root') value.model = 'spoofed'
    if (kind === 'extra-answer') a.route = { choice: 'billing', reason: 'extra' }
    if (kind === 'missing-question') delete a.refund
    if (kind === 'choice') a.route = { choice: 'unknown' }
    if (kind === 'score') a.urgency = { score: 5 }
    if (kind === 'boolean') a.refund = { value: 'true' }
    if (kind === 'spoof-evidence') a.route = { choice: 'billing', probabilitySource: 'provider', confidence: 1 }
    llm.frames = success(kind === 'invalid-json' ? '```json\n{}\n```' : value)
    const { runtime, model } = setup(llm)
    await expect(model.evaluate(input)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(llm.calls).toHaveLength(1)
    await runtime.close()
  })
  it.each(['choice', 'boolean', 'bounds', 'sum', 'extra-score'])('rejects inconsistent evidence: %s', async kind => {
      const llm = new FakeLlm()
      const route = { choice: 'billing', probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.8 }
      const urgency: Record<string, unknown> = { probabilities: { '0': 0, '1': 0.8, '2': 0.2 }, confidence: 0.8 }
      const refund = { value: true, probabilityTrue: 0.9 }
      if (kind === 'choice') route.probabilities = { billing: 0.1, support: 0.9 }
      if (kind === 'boolean') refund.value = false
      if (kind === 'bounds') refund.probabilityTrue = 2
      if (kind === 'sum') urgency.probabilities = { '0': 0, '1': 0.8, '2': 0.8 }
      if (kind === 'extra-score') urgency.score = 1
      llm.frames = success({ answers: { route, urgency, refund } })
      const { runtime, model } = setup(llm, 'model-generated')
      await expect(model.evaluate(input)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      await runtime.close()
  })
  it.each(['max-tokens', 'missing-finish', 'after-finish', 'duplicate-block', 'duplicate-usage'])('rejects incomplete or malformed stream: %s', async kind => {
    const llm = new FakeLlm()
    if (kind === 'max-tokens') llm.frames[llm.frames.length - 1] = { type: 'finish', reason: { kind: 'max-tokens' } }
    if (kind === 'missing-finish') llm.frames.pop()
    if (kind === 'after-finish') llm.frames.push({ type: 'text-delta', index: 0, text: 'extra' })
    if (kind === 'duplicate-block') llm.frames.splice(4, 0, llm.frames[3]!)
    if (kind === 'duplicate-usage') llm.frames.splice(5, 0, llm.frames[4]!)
    const { runtime, model } = setup(llm)
    await expect(model.evaluate(input)).rejects.toMatchObject({ code: kind === 'missing-finish' ? 'STREAM_CLOSED' : 'MALFORMED_RESPONSE' })
    await runtime.close()
  })
  it('propagates terminal failure facts and reuses a single prepared generation across retries', async () => {
    const llm = new FakeLlm()
    const prepared = vi.spyOn(llm, 'prepareCall')
    const stream = vi.spyOn(llm, 'stream')
    stream.mockImplementationOnce(async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'busy', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 1 } } } })
    const runtime = createDecisionRuntime({ providers: [llmDecisionPlugin({ id: 'l', routes: ['l'], adapter: llm })], retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } })
    await runtime.decisionModel({ provider: 'l', model: 'm' }).evaluate(input)
    expect(prepared).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(2)
    await runtime.close()
  })
  it('bounds noncooperative preparation and stream teardown, including direct calls', async () => {
    const llm = new FakeLlm()
    vi.spyOn(llm, 'prepareCall').mockImplementation(() => new Promise(() => {}))
    await expect(llmDecisionAdapter({ adapter: llm }).evaluate({ ...input, provider: 'p', model: 'm', timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    const stuck = new FakeLlm()
    const returnIterator = vi.fn(() => new Promise<IteratorResult<StreamChunk>>(() => {}))
    vi.spyOn(stuck, 'stream').mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: returnIterator }) })
    await expect(llmDecisionAdapter({ adapter: stuck }).evaluate({ ...input, provider: 'p', model: 'm', timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(returnIterator).toHaveBeenCalledTimes(1)
  })
  it('enforces output bounds without counting deltas and authoritative text twice', async () => {
    const llm = new FakeLlm()
    const bytes = new TextEncoder().encode(JSON.stringify({ answers: answers() })).byteLength
    await expect(llmDecisionAdapter({ adapter: llm, maxResponseBytes: bytes }).evaluate({ ...input, provider: 'p', model: 'm' })).resolves.toHaveProperty('model', 'm')
    await expect(llmDecisionAdapter({ adapter: llm, maxResponseBytes: bytes - 1 }).evaluate({ ...input, provider: 'p', model: 'm' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('rejects invalid usage and unexpected media before accepting decisions', async () => {
    const llm = new FakeLlm()
    llm.frames.splice(4, 1, { type: 'usage', usage: { inputTokens: NaN, outputTokens: 1 } })
    await expect(llmDecisionAdapter({ adapter: llm }).evaluate({ ...input, provider: 'p', model: 'm' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    llm.frames = [{ type: 'block-start', index: 0, blockType: 'image' }, ...success()]
    await expect(llmDecisionAdapter({ adapter: llm }).evaluate({ ...input, provider: 'p', model: 'm' })).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('snapshots plugin routes and generation options, preserving custom provider route ownership', async () => {
    const llm = new FakeLlm()
    const generation = { maxTokens: 500 }
    const routes = ['team']
    const plugin = llmDecisionPlugin({ id: 'team', routes, adapter: llm, generation })
    routes[0] = 'changed'; generation.maxTokens = 1
    const runtime = createDecisionRuntime({ providers: [plugin] })
    await runtime.decisionModel({ provider: 'team', model: 'm' }).evaluate(input)
    expect(llm.calls[0]).toMatchObject({ provider: 'team', maxTokens: 500 })
    await runtime.close()
  })
  it('captures the underlying prepared stream rather than re-reading mutable adapter state', async () => {
    const llm = new FakeLlm()
    vi.spyOn(llm, 'prepareCall').mockImplementation(async (provider, model): Promise<PreparedAdapterCall> => ({ model: { provider, id: model, name: model }, stream: async function* () { yield* success() } }))
    vi.spyOn(llm, 'stream').mockImplementation(() => { throw new Error('mutable stream must not run') })
    const { runtime, model } = setup(llm)
    await expect(model.evaluate(input)).resolves.toHaveProperty('answers.route.choice', 'billing')
    await runtime.close()
  })
})

function sse(frames: unknown[]): Response {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
describe('decision bridge through actual provider HTTP protocols', () => {
  it.each(['openai', 'chat-completions', 'anthropic', 'gemini'].flatMap(family => [
    { family, mode: 'json-schema' as const }, { family, mode: 'tool' as const },
  ]))('decodes decisions through $family in $mode mode', async ({ family, mode }) => {
    let wire: Record<string, unknown> = {}
    const text = JSON.stringify({ answers: answers() })
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      wire = JSON.parse(init!.body as string) as Record<string, unknown>
      if (mode === 'tool') {
        if (family === 'openai') return sse([
          { type: 'response.created', response: { id: 'r1' } },
          { type: 'response.output_item.added', item: { id: 'i1', type: 'function_call', call_id: 'c1', name: 'submit_decisions', arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: 'i1', delta: text },
          { type: 'response.output_item.done', item: { id: 'i1', type: 'function_call', call_id: 'c1', name: 'submit_decisions', arguments: text } },
          { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } },
        ])
        if (family === 'chat-completions') return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'submit_decisions', arguments: text } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        if (family === 'anthropic') return sse([
          { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 12 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c1', name: 'submit_decisions', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
          { type: 'message_stop' },
        ])
        return sse([
          { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'c1', name: 'submit_decisions', arguments: {} } },
          { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: text } },
          { event_type: 'step.stop', index: 0 },
          { event_type: 'interaction.completed', interaction: { status: 'requires_action', usage: { total_input_tokens: 12, total_output_tokens: 8, total_tokens: 20 } } },
        ])
      }
      if (family === 'openai') return sse([
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_item.added', item: { id: 'i1', type: 'message' } },
        { type: 'response.output_text.delta', item_id: 'i1', delta: text },
        { type: 'response.output_item.done', item: { id: 'i1', type: 'message', content: [{ type: 'output_text', text }] } },
        { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } } },
      ])
      if (family === 'chat-completions') return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      if (family === 'anthropic') return sse([
        { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 12 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
        { type: 'message_stop' },
      ])
      return sse([
        { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
        { event_type: 'step.delta', index: 0, delta: { type: 'text', text } },
        { event_type: 'step.stop', index: 0 },
        { event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 12, total_output_tokens: 8, total_tokens: 20 } } },
      ])
    })
    const adapter = family === 'anthropic' ? anthropicAdapter({ apiKey: 'test', fetch })
      : family === 'gemini' ? geminiAdapter({ apiKey: 'test', fetch })
      : openAiAdapter({ apiKey: 'test', fetch, ...(family === 'chat-completions' ? { api: 'chat-completions' as const } : {}) })
    const { runtime, model } = setup(adapter, undefined, mode === 'tool' ? 'tool' : undefined)
    const task = createDecisionTask(model, { questions })
    const rows = await task.evaluateBatch([input.state, input.state], { concurrency: 1 })
    expect(rows.map(row => row.status)).toEqual(['fulfilled', 'fulfilled'])
    if (rows[0]?.status === 'fulfilled') expect(rows[0].value).toMatchObject({ answers: { route: { choice: 'billing' }, refund: { value: true } }, usage: { inputTokens: 12, outputTokens: 8 } })
    expect(fetch).toHaveBeenCalledTimes(2)
    if (mode === 'tool') expect(wire).toHaveProperty('tools')
    else {
      if (family === 'openai') expect(wire).toMatchObject({ text: { format: { type: 'json_schema', strict: true } } })
      if (family === 'chat-completions') expect(wire).toMatchObject({ response_format: { type: 'json_schema', json_schema: { strict: true } } })
      if (family === 'anthropic') expect(wire).toMatchObject({ output_config: { format: { type: 'json_schema' } } })
      if (family === 'gemini') expect(wire).toMatchObject({ response_format: { mime_type: 'application/json', schema: { required: ['answers'] } } })
    }
    await runtime.close()
  })
})
